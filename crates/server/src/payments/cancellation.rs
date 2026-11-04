//! Close checkout before requesting remote cancellation. A lost reply is retried
//! from the saved order; no ledger entry, refund or service verdict is invented.

use super::*;
use crate::gateway;
use checkout::{CheckoutError, CheckoutTerms, matches_review};
use patchriot_protocol::{CancelReview, ReviewView};

#[derive(FromRow, Serialize)]
pub struct CancellationStatus {
    pub order_id: Uuid,
    pub requested_at: Option<DateTime<Utc>>,
    pub confirmed_at: Option<DateTime<Utc>>,
    pub review_state: Option<String>,
    pub requires_attention: bool,
}

/// This status belongs only to the saved requester. It does not expose the
/// provider quote or imply that funds have been returned.
pub async fn status(
    pool: &PgPool,
    account: Uuid,
    order: Uuid,
) -> Result<CancellationStatus, CheckoutError> {
    sqlx::query_as("SELECT o.id AS order_id, cancel_requested_at AS requested_at, cancel_confirmed_at AS confirmed_at, cancel_review_state AS review_state, (o.state = 'needs_review' OR (cancel_requested_at IS NOT NULL AND ((cancel_confirmed_at IS NULL AND cancel_next_attempt_at IS NULL) OR EXISTS (SELECT 1 FROM payment_ledger l WHERE l.invoice_id = o.invoice_id AND l.account_id = o.account_id)))) AS requires_attention FROM checkout_orders o JOIN accounts a ON a.id = o.account_id WHERE o.id = $1 AND o.account_id = $2 AND NOT a.disabled")
        .bind(order).bind(account).fetch_optional(pool).await?.ok_or(CheckoutError::Closed)
}

/// Record intent before any HTTP call. Cancellation of an order still being
/// admitted returns InProgress: there is no known remote review to stop yet,
/// and no deposit instructions have been released for that order.
pub async fn request(
    pool: &PgPool,
    account: Uuid,
    order: Uuid,
) -> Result<CancellationStatus, CheckoutError> {
    let mut tx = pool.begin().await?;
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR SHARE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(CheckoutError::AccountUnavailable);
    }
    let saved: Option<(Option<Uuid>, Option<DateTime<Utc>>)> = sqlx::query_as("SELECT review_id, cancel_requested_at FROM checkout_orders WHERE id = $1 AND account_id = $2 FOR UPDATE")
        .bind(order).bind(account).fetch_optional(&mut *tx).await?;
    let (review, requested) = saved.ok_or(CheckoutError::Closed)?;
    if review.is_none() {
        return Err(CheckoutError::InProgress);
    }
    if requested.is_none() {
        // Invalidate an in-flight quote reply as well as new funding attempts.
        // The funding worker can still record a previously confirmed activation.
        sqlx::query("UPDATE checkout_orders SET state = 'cancelled', cancel_requested_at = now(), cancel_next_attempt_at = now(), operation_token = NULL, operation_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1")
            .bind(order).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    status(pool, account, order).await
}

#[derive(FromRow)]
struct Order {
    id: Uuid,
    account_id: Uuid,
    request_id: Uuid,
    review_id: Option<Uuid>,
    invoice_id: Option<Uuid>,
    terms: Value,
    expires_at: DateTime<Utc>,
    cancel_requested_at: Option<DateTime<Utc>>,
}

#[derive(Default, Serialize)]
pub struct CancellationSummary {
    pub checked: usize,
    pub confirmed: usize,
    pub retrying: usize,
    pub needs_review: usize,
}

enum Outcome {
    Stopped(String),
    Retry(&'static str),
    Review(&'static str),
}

/// Process up to ten due cancellations, including requests made before an
/// account was disabled. No transaction spans HTTP. Unconfirmed cancellation
/// after 24 hours needs operator attention; it is never assumed successful.
pub async fn deliver_once(state: &AppState) -> Result<CancellationSummary, PaymentError> {
    let mut summary = CancellationSummary::default();
    for _ in 0..10 {
        let token = Uuid::new_v4();
        let order: Option<Order> = sqlx::query_as("UPDATE checkout_orders SET operation_token = $1, operation_until = now() + interval '30 seconds' WHERE id = (SELECT id FROM checkout_orders WHERE cancel_requested_at IS NOT NULL AND cancel_confirmed_at IS NULL AND cancel_next_attempt_at <= now() AND (operation_until IS NULL OR operation_until < now()) ORDER BY cancel_next_attempt_at, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")
            .bind(token).fetch_optional(&state.pool).await?;
        let Some(order) = order else { break };
        let outcome = deliver_claimed(state, &order).await;
        if finish(&state.pool, &order, token, &outcome).await? {
            match &outcome {
                Outcome::Stopped(state)
                    if matches!(state.as_str(), "completed" | "needs_review") =>
                {
                    summary.needs_review += 1
                }
                Outcome::Stopped(_) => summary.confirmed += 1,
                Outcome::Retry(_) => summary.retrying += 1,
                Outcome::Review(_) => summary.needs_review += 1,
            }
        }
        summary.checked += 1;
    }
    Ok(summary)
}

fn matches(view: &ReviewView, order: &Order, terms: &CheckoutTerms) -> bool {
    terms.payment.account_id == order.account_id
        && terms.payment.request_id == order.request_id
        && terms.consent.request_id == order.request_id
        && Some(view.id) == order.review_id
        && matches_review(view, terms, order.expires_at.timestamp())
        && view.payment.as_ref().is_some_and(|payment| {
            match (payment.invoice_id, payment.funded_at) {
                (None, None) => true,
                (Some(id), Some(_)) => Some(id) == order.invoice_id,
                _ => false,
            }
        })
}

fn terminal(state: &str) -> bool {
    matches!(state, "cancelled" | "failed" | "completed" | "needs_review")
}

async fn deliver_claimed(state: &AppState, order: &Order) -> Outcome {
    if order
        .cancel_requested_at
        .is_none_or(|at| at + Duration::hours(24) <= Utc::now())
    {
        return Outcome::Review("cancellation_confirmation_window_elapsed");
    }
    let Ok(terms) = serde_json::from_value::<CheckoutTerms>(order.terms.clone()) else {
        return Outcome::Review("cancellation_terms_invalid");
    };
    let Some(review) = order.review_id else {
        return Outcome::Review("cancellation_review_missing");
    };
    let path = format!("/internal/reviews/{review}");
    let view = match gateway::request_review_for_account::<()>(
        state,
        reqwest::Method::GET,
        &path,
        order.account_id,
        None,
    )
    .await
    {
        Ok(Json(view)) => view,
        Err(error) if error.status.as_u16() == 404 => {
            return Outcome::Review("cancellation_review_missing");
        }
        Err(_) => return Outcome::Retry("cancellation_status_unavailable"),
    };
    if !matches(&view, order, &terms) {
        return Outcome::Review("cancellation_review_mismatch");
    }
    if terminal(&view.state) {
        return Outcome::Stopped(view.state);
    }
    if !matches!(
        view.state.as_str(),
        "awaiting_payment" | "queued" | "running"
    ) {
        return Outcome::Review("cancellation_unknown_review_state");
    }
    let view = match gateway::request_review_for_account::<_>(
        state,
        reqwest::Method::POST,
        &format!("{path}/cancel"),
        order.account_id,
        Some(&CancelReview {}),
    )
    .await
    {
        Ok(Json(view)) => view,
        Err(_) => return Outcome::Retry("cancellation_acknowledgment_unavailable"),
    };
    if !matches(&view, order, &terms) {
        return Outcome::Review("cancellation_acknowledgment_mismatch");
    }
    if !terminal(&view.state) {
        return Outcome::Retry("cancellation_not_confirmed");
    }
    Outcome::Stopped(view.state)
}

async fn finish(
    pool: &PgPool,
    order: &Order,
    token: Uuid,
    outcome: &Outcome,
) -> Result<bool, PaymentError> {
    let (review_state, error, retry, attention) = match outcome {
        Outcome::Stopped(state) => (
            Some(state.as_str()),
            if matches!(state.as_str(), "completed" | "needs_review") {
                Some("review_finished_before_cancellation")
            } else {
                None
            },
            false,
            matches!(state.as_str(), "completed" | "needs_review"),
        ),
        Outcome::Retry(reason) => (None, Some(*reason), true, false),
        Outcome::Review(reason) => (None, Some(*reason), false, true),
    };
    let changed = sqlx::query("UPDATE checkout_orders SET cancel_confirmed_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE NULL END, cancel_review_state = $3, cancel_next_attempt_at = CASE WHEN $5 THEN now() + interval '60 seconds' ELSE NULL END, state = CASE WHEN $6 THEN 'needs_review' ELSE state END, last_error = $4, operation_token = NULL, operation_until = NULL, updated_at = now() WHERE id = $1 AND operation_token = $2 AND operation_until > now() AND cancel_requested_at IS NOT NULL AND cancel_confirmed_at IS NULL")
        .bind(order.id).bind(token).bind(review_state).bind(error).bind(retry).bind(attention)
        .execute(pool).await?.rows_affected();
    Ok(changed == 1)
}
