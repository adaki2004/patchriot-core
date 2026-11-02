//! Allocate only completed, paid reviews. Payment is for three completed role
//! reports, not agreement with a verdict or a count of alleged vulnerabilities.
//! Runtime is an operator report, never a multiplier for earnings.

use super::*;
use crate::gateway;
use patchriot_protocol::{ReviewRole, ReviewView, WorkResult, website_reviews::WebsiteRunState};
use sha2::{Digest, Sha256};

pub const SETTLEMENT_ASSET: &str =
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
pub const MINIMUM_CLAIM: i64 = 10_000_000;

#[derive(FromRow)]
struct Candidate {
    invoice_id: Uuid,
    account_id: Uuid,
    review_id: Uuid,
    terms: Value,
    expires_at: DateTime<Utc>,
    asset: String,
    amount: i64,
}

#[derive(Serialize)]
struct RoleCredit {
    role: &'static str,
    operator: Uuid,
    device: Uuid,
    amount: i64,
    reported_duration_ms: i64,
    reported_model: String,
    inference_calls: i32,
    terminal_calls: i32,
}

fn credits(view: &ReviewView, amount: i64) -> Result<Vec<RoleCredit>, &'static str> {
    if view.state != "completed" || view.steps.len() != 3 || amount < 10 {
        return Err("review_not_complete");
    }
    let (people, hash) = match (&view.website, &view.source) {
        (Some(c), None) => (&c.reviewers, &c.snapshot_sha256),
        (None, Some(c)) => (&c.reviewers, &c.snapshot_sha256),
        _ => return Err("earning_context_mismatch"),
    };
    if people.len() != 3 {
        return Err("earning_team_mismatch");
    }
    let total = amount - amount / 10;
    let mut output = Vec::new();
    for (index, role) in [
        ReviewRole::Investigator,
        ReviewRole::Reproducer,
        ReviewRole::Challenger,
    ]
    .into_iter()
    .enumerate()
    {
        let step = view
            .steps
            .iter()
            .find(|s| s.role == role)
            .ok_or("earning_role_missing")?;
        let person = &people[index];
        if step.state != "completed"
            || step.evidence_complete != Some(true)
            || step.device_id != Some(person.device_id)
            || step.operator_id != Some(person.operator_id)
            || person.device_id.is_nil()
            || person.operator_id.is_nil()
        {
            return Err("earning_role_mismatch");
        }
        let run = match &step.result {
            Some(WorkResult::Website(r))
                if view.website.is_some()
                    && r.valid()
                    && r.snapshot_sha256 == *hash
                    && r.inspected_snapshot_sha256.as_ref() == Some(hash) =>
            {
                &r.execution
            }
            Some(WorkResult::Source(r))
                if view.source.is_some()
                    && r.valid()
                    && r.snapshot_sha256 == *hash
                    && r.inspected_snapshot_sha256.as_ref() == Some(hash) =>
            {
                &r.execution
            }
            _ => return Err("earning_result_mismatch"),
        };
        if run.state != WebsiteRunState::Completed
            || !run.cleanup_confirmed
            || run.inference_calls == 0
            || run.terminal_calls == 0
        {
            return Err("earning_execution_incomplete");
        }
        output.push(RoleCredit {
            role: role.as_str(),
            operator: person.operator_id,
            device: person.device_id,
            amount: total / 3 + i64::from((index as i64) < total % 3),
            reported_duration_ms: i64::try_from(run.duration_ms)
                .map_err(|_| "earning_duration_invalid")?,
            reported_model: run.model.clone(),
            inference_calls: i32::from(run.inference_calls),
            terminal_calls: i32::from(run.terminal_calls),
        });
    }
    if output
        .iter()
        .map(|r| r.device)
        .collect::<std::collections::HashSet<_>>()
        .len()
        != 3
    {
        return Err("earning_duplicate_device");
    }
    Ok(output)
}

async fn allocate(
    pool: &PgPool,
    candidate: &Candidate,
    view: &ReviewView,
) -> Result<bool, PaymentError> {
    let terms: checkout::CheckoutTerms = serde_json::from_value(candidate.terms.clone())
        .map_err(|_| PaymentError::InvalidResponse)?;
    if view.id != candidate.review_id
        || !checkout::matches_review(view, &terms, candidate.expires_at.timestamp())
        || terms.payment.account_id != candidate.account_id
        || terms.payment.destination_asset != candidate.asset
        || terms.payment.required_amount != candidate.amount
        || view
            .payment
            .as_ref()
            .is_none_or(|p| p.invoice_id != Some(candidate.invoice_id) || p.funded_at.is_none())
    {
        return Err(PaymentError::InvalidResponse);
    }
    let roles = credits(view, candidate.amount).map_err(|_| PaymentError::InvalidResponse)?;
    let result_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(view).map_err(|_| PaymentError::InvalidResponse)?,
    ));
    let mut tx = pool.begin().await?;
    // Serializes allocation with another worker; no network call holds this lock.
    let valid: bool = sqlx::query_scalar("SELECT i.state='settled' AND i.asset=$2 AND i.required_amount=$3 AND i.account_id=$4 AND l.amount=$3 AND l.credit='customer_funds' AND l.asset=$2 AND l.account_id=$4 AND f.delivery_state='delivered' AND o.review_id=$5 AND o.state='activated' AND o.account_id=$4 AND o.request_id=i.request_id AND f.request_id=i.request_id AND f.account_id=$4 AND f.asset=$2 AND f.amount=$3 FROM payment_invoices i JOIN payment_ledger l ON l.invoice_id=i.id JOIN payment_funding_events f ON f.invoice_id=i.id JOIN checkout_orders o ON o.invoice_id=i.id WHERE i.id=$1 FOR UPDATE OF i")
        .bind(candidate.invoice_id).bind(&candidate.asset).bind(candidate.amount).bind(candidate.account_id).bind(candidate.review_id)
        .fetch_optional(&mut *tx).await?.unwrap_or(false);
    if !valid {
        return Err(PaymentError::InvalidResponse);
    }
    let existing: Option<String> =
        sqlx::query_scalar("SELECT result_hash FROM earning_allocations WHERE invoice_id=$1")
            .bind(candidate.invoice_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(previous) = existing {
        return if previous == result_hash {
            Ok(false)
        } else {
            Err(PaymentError::InvalidResponse)
        };
    }
    sqlx::query("INSERT INTO earning_allocations(invoice_id,review_id,asset,gross_amount,platform_amount,operator_amount,result_hash,policy) VALUES($1,$2,$3,$4,$5,$6,$7,'three_roles_90_10_v1')")
        .bind(candidate.invoice_id).bind(candidate.review_id).bind(&candidate.asset).bind(candidate.amount)
        .bind(candidate.amount/10).bind(candidate.amount-candidate.amount/10).bind(result_hash).execute(&mut *tx).await?;
    for role in roles {
        sqlx::query("INSERT INTO operator_earnings(invoice_id,role,operator_id,device_id,amount,reported_duration_ms,reported_model,inference_calls,terminal_calls) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
            .bind(candidate.invoice_id).bind(role.role).bind(role.operator).bind(role.device).bind(role.amount)
            .bind(role.reported_duration_ms).bind(role.reported_model).bind(role.inference_calls).bind(role.terminal_calls).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE payment_funding_events SET earnings_next_check_at=NULL,earnings_error=NULL WHERE invoice_id=$1")
        .bind(candidate.invoice_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

#[derive(Default, Serialize)]
pub struct AllocationSummary {
    pub checked: usize,
    pub allocated: usize,
    pub waiting: usize,
    pub needs_review: usize,
}

pub async fn allocate_once(state: &AppState) -> Result<AllocationSummary, PaymentError> {
    let mut summary = AllocationSummary::default();
    for _ in 0..10 {
        // A short scheduling delay bounds polling. Allocation itself uses an
        // invoice lock and unique keys, so delayed/concurrent reads cannot pay twice.
        let id: Option<Uuid> = sqlx::query_scalar("UPDATE payment_funding_events SET earnings_next_check_at=now()+interval '60 seconds' WHERE invoice_id=(SELECT invoice_id FROM payment_funding_events WHERE delivery_state='delivered' AND earnings_next_check_at<=now() ORDER BY earnings_next_check_at,invoice_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING invoice_id")
            .fetch_optional(&state.pool).await?;
        let Some(id) = id else { break };
        summary.checked += 1;
        let c: Candidate = sqlx::query_as("SELECT f.invoice_id,f.account_id,o.review_id,o.terms,o.expires_at,f.asset,f.amount FROM payment_funding_events f JOIN checkout_orders o ON o.invoice_id=f.invoice_id WHERE f.invoice_id=$1")
            .bind(id).fetch_one(&state.pool).await?;
        let view = gateway::request_for_account::<(), ReviewView>(
            state,
            reqwest::Method::GET,
            &format!("/internal/reviews/{}", c.review_id),
            c.account_id,
            None,
        )
        .await;
        let result = match view {
            Ok(Json(view)) if ["queued", "running"].contains(&view.state.as_str()) => {
                summary.waiting += 1;
                continue;
            }
            Ok(Json(view)) if c.asset == SETTLEMENT_ASSET => allocate(&state.pool, &c, &view).await,
            Ok(_) => Err(PaymentError::InvalidResponse),
            Err(_) => {
                summary.waiting += 1;
                continue;
            }
        };
        match result {
            Ok(new) => summary.allocated += usize::from(new),
            Err(PaymentError::Database) => return Err(PaymentError::Database),
            Err(_) => {
                sqlx::query("UPDATE payment_funding_events SET earnings_next_check_at=NULL,earnings_error='completed_work_requires_review' WHERE invoice_id=$1 AND NOT EXISTS(SELECT 1 FROM earning_allocations WHERE invoice_id=$1)")
                    .bind(id).execute(&state.pool).await?;
                summary.needs_review += 1;
            }
        }
    }
    Ok(summary)
}

#[derive(FromRow, Serialize)]
struct WorkCredit {
    invoice_id: Uuid,
    review_id: Uuid,
    role: String,
    device_id: Uuid,
    amount: String,
    reported_duration_ms: i64,
    reported_model: String,
    inference_calls: i32,
    terminal_calls: i32,
    created_at: DateTime<Utc>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let amount: String = sqlx::query_scalar("SELECT COALESCE(sum(e.amount),0)::text FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 AND a.asset=$2")
        .bind(session.id).bind(SETTLEMENT_ASSET).fetch_one(&state.pool).await?;
    let work: Vec<WorkCredit> = sqlx::query_as("SELECT e.invoice_id,a.review_id,e.role,e.device_id,e.amount::text,e.reported_duration_ms,e.reported_model,e.inference_calls,e.terminal_calls,a.created_at FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 ORDER BY a.created_at DESC,e.role LIMIT 100")
        .bind(session.id).fetch_all(&state.pool).await?;
    Ok(Json(
        serde_json::json!({"asset":SETTLEMENT_ASSET,"earned":amount,"minimum_claim":MINIMUM_CLAIM.to_string(),"work":work}),
    ))
}

#[cfg(test)]
#[path = "earnings_tests.rs"]
pub(super) mod tests;
