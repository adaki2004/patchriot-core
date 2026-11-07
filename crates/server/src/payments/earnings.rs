//! Allocate only completed, paid reviews. Payment is for the completed roles
//! required by the consented policy, not agreement or a finding count.
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
    http_requests: i32,
}

fn credits(view: &ReviewView, amount: i64) -> Result<Vec<RoleCredit>, &'static str> {
    let required = match &view.pentest {
        Some(context) => context
            .resolved_role_count()
            .ok_or("unresolved_review_policy")?,
        None => 3,
    };
    if view.state != "completed" || view.steps.len() != required || amount < 10 {
        return Err("review_not_complete");
    }
    let (people, hash) = match (&view.website, &view.source, &view.pentest) {
        (Some(c), None, None) => (&c.reviewers, &c.snapshot_sha256),
        (None, Some(c), None) => (&c.reviewers, &c.snapshot_sha256),
        (None, None, Some(c)) => (&c.reviewers, &c.scope_sha256),
        _ => return Err("earning_context_mismatch"),
    };
    if people.len()
        != view
            .pentest
            .as_ref()
            .map_or(3, |c| c.review_policy.team_size())
    {
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
    .take(required)
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
        let (state, cleanup, duration, model, inference, terminal, http) = match &step.result {
            Some(WorkResult::Website(r))
                if view.website.is_some()
                    && r.valid()
                    && r.snapshot_sha256 == *hash
                    && r.inspected_snapshot_sha256.as_ref() == Some(hash) =>
            {
                let run = &r.execution;
                (
                    run.state,
                    run.cleanup_confirmed,
                    run.duration_ms,
                    &run.model,
                    run.inference_calls,
                    run.terminal_calls,
                    0,
                )
            }
            Some(WorkResult::Source(r))
                if view.source.is_some()
                    && r.valid()
                    && r.snapshot_sha256 == *hash
                    && r.inspected_snapshot_sha256.as_ref() == Some(hash) =>
            {
                let run = &r.execution;
                (
                    run.state,
                    run.cleanup_confirmed,
                    run.duration_ms,
                    &run.model,
                    run.inference_calls,
                    run.terminal_calls,
                    0,
                )
            }
            Some(WorkResult::Pentest(r))
                if view
                    .pentest
                    .as_ref()
                    .is_some_and(|c| r.evidence_complete_for_role(&c.scope, role))
                    && r.scope_sha256 == *hash =>
            {
                let run = &r.execution;
                (
                    run.state,
                    run.cleanup_confirmed,
                    run.duration_ms,
                    &run.model,
                    run.inference_calls,
                    0,
                    run.http_requests,
                )
            }
            None if view.retention.as_ref().is_some_and(|r| r.content_deleted) => {
                // The authenticated dispatcher saved this bounded receipt when
                // it accepted the result. Findings can expire while accounting
                // is offline; deleting them must not delete earned work.
                let receipt = step.receipt.as_ref().ok_or("earning_receipt_missing")?;
                if !receipt.valid_for(&view.mode, hash) {
                    return Err("earning_receipt_mismatch");
                }
                (
                    receipt.state,
                    receipt.cleanup_confirmed,
                    receipt.duration_ms,
                    &receipt.model,
                    receipt.inference_calls,
                    receipt.terminal_calls,
                    receipt.http_requests,
                )
            }
            _ => return Err("earning_result_mismatch"),
        };
        if state != WebsiteRunState::Completed
            || !cleanup
            || inference == 0
            || (terminal == 0 && http == 0)
        {
            return Err("earning_execution_incomplete");
        }
        output.push(RoleCredit {
            role: role.as_str(),
            operator: person.operator_id,
            device: person.device_id,
            amount: total / required as i64 + i64::from((index as i64) < total % required as i64),
            reported_duration_ms: i64::try_from(duration)
                .map_err(|_| "earning_duration_invalid")?,
            reported_model: model.clone(),
            inference_calls: i32::from(inference),
            terminal_calls: i32::from(terminal),
            http_requests: i32::from(http),
        });
    }
    if output
        .iter()
        .map(|r| r.device)
        .collect::<std::collections::HashSet<_>>()
        .len()
        != required
    {
        return Err("earning_duplicate_device");
    }
    if let Some(context) = &view.pentest
        && context.review_policy
            == patchriot_protocol::pentests::LiveReviewPolicy::InvestigateVerifyV1
        && !view.retention.as_ref().is_some_and(|r| r.content_deleted)
    {
        let result = |role| {
            view.steps
                .iter()
                .find(|s| s.role == role)
                .and_then(|s| match &s.result {
                    Some(WorkResult::Pentest(r)) => Some(r),
                    _ => None,
                })
        };
        let decision = patchriot_protocol::pentests::review_policy::decide(
            &context.scope,
            result(ReviewRole::Investigator).ok_or("earning_result_mismatch")?,
            result(ReviewRole::Reproducer).ok_or("earning_result_mismatch")?,
        );
        if context.third_review.as_ref() != Some(&decision) {
            return Err("earning_policy_mismatch");
        }
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
    let mut tx = pool.begin().await?;
    // Serializes allocation with another worker; no network call holds this lock.
    let valid: bool = sqlx::query_scalar("SELECT i.state='settled' AND i.asset=$2 AND i.required_amount=$3 AND i.account_id=$4 AND l.amount=$3 AND l.credit='customer_funds' AND l.asset=$2 AND l.account_id=$4 AND f.delivery_state='delivered' AND o.review_id=$5 AND o.state='activated' AND o.account_id=$4 AND o.request_id=i.request_id AND f.request_id=i.request_id AND f.account_id=$4 AND f.asset=$2 AND f.amount=$3 FROM payment_invoices i JOIN payment_ledger l ON l.invoice_id=i.id JOIN payment_funding_events f ON f.invoice_id=i.id JOIN checkout_orders o ON o.invoice_id=i.id WHERE i.id=$1 FOR UPDATE OF i")
        .bind(candidate.invoice_id).bind(&candidate.asset).bind(candidate.amount).bind(candidate.account_id).bind(candidate.review_id)
        .fetch_optional(&mut *tx).await?.unwrap_or(false);
    if !valid {
        return Err(PaymentError::InvalidResponse);
    }
    let changed = write_allocation(
        &mut tx,
        candidate.invoice_id,
        view,
        &candidate.asset,
        candidate.amount,
        "invoice",
    )
    .await?;
    sqlx::query("UPDATE payment_funding_events SET earnings_next_check_at=NULL,earnings_error=NULL WHERE invoice_id=$1")
        .bind(candidate.invoice_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(changed)
}

/// Credit purchases use the same evidence checks and 90/10 split as an invoice.
/// Their funding reference names a reservation, not a second chain payment.
pub(super) async fn allocate_credit(
    pool: &PgPool,
    id: Uuid,
    view: &ReviewView,
) -> Result<bool, PaymentError> {
    let mut tx = pool.begin().await?;
    let amount = super::credits::for_allocation(&mut tx, id, view).await?;
    let changed = write_allocation(&mut tx, id, view, SETTLEMENT_ASSET, amount, "credits").await?;
    tx.commit().await?;
    Ok(changed)
}

async fn write_allocation(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    view: &ReviewView,
    asset: &str,
    amount: i64,
    funding_kind: &str,
) -> Result<bool, PaymentError> {
    let roles = credits(view, amount).map_err(|_| PaymentError::InvalidResponse)?;
    let result_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(view).map_err(|_| PaymentError::InvalidResponse)?,
    ));
    let existing: Option<String> =
        sqlx::query_scalar("SELECT result_hash FROM earning_allocations WHERE invoice_id=$1")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(previous) = existing {
        return if previous == result_hash {
            Ok(false)
        } else {
            Err(PaymentError::InvalidResponse)
        };
    }
    let policy = if view
        .pentest
        .as_ref()
        .is_some_and(|c| !c.review_policy.is_legacy())
    {
        "investigate_verify_90_10_v1"
    } else {
        "three_roles_90_10_v1"
    };
    sqlx::query("INSERT INTO earning_allocations(invoice_id,review_id,asset,gross_amount,platform_amount,operator_amount,result_hash,policy,completed_roles,funding_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(id).bind(view.id).bind(asset).bind(amount)
        .bind(amount/10).bind(amount-amount/10).bind(result_hash).bind(policy).bind(roles.len() as i16).bind(funding_kind).execute(&mut **tx).await?;
    for role in roles {
        sqlx::query("INSERT INTO operator_earnings(invoice_id,role,operator_id,device_id,amount,reported_duration_ms,reported_model,inference_calls,terminal_calls,http_requests) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
            .bind(id).bind(role.role).bind(role.operator).bind(role.device).bind(role.amount)
            .bind(role.reported_duration_ms).bind(role.reported_model).bind(role.inference_calls).bind(role.terminal_calls).bind(role.http_requests).execute(&mut **tx).await?;
    }
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
        let view = gateway::request_review_for_account::<()>(
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
    http_requests: i32,
    created_at: DateTime<Utc>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let amount: String = sqlx::query_scalar("SELECT COALESCE(sum(e.amount),0)::text FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 AND a.asset=$2")
        .bind(session.id).bind(SETTLEMENT_ASSET).fetch_one(&state.pool).await?;
    let work: Vec<WorkCredit> = sqlx::query_as("SELECT e.invoice_id,a.review_id,e.role,e.device_id,e.amount::text,e.reported_duration_ms,e.reported_model,e.inference_calls,e.terminal_calls,e.http_requests,a.created_at FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 ORDER BY a.created_at DESC,e.role LIMIT 100")
        .bind(session.id).fetch_all(&state.pool).await?;
    Ok(Json(
        serde_json::json!({"asset":SETTLEMENT_ASSET,"earned":amount,"minimum_claim":MINIMUM_CLAIM.to_string(),"work":work}),
    ))
}

#[cfg(test)]
#[path = "earnings_tests.rs"]
pub(super) mod tests;
