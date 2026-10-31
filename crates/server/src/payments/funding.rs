//! Deliver saved settlement events to their admitted reviews. Only the invoice
//! recorded by core can activate its order. This worker cannot sign payments,
//! pay a contributor, release held funds or mark a review successfully completed.

use super::*;
use crate::gateway;
use checkout::{CheckoutTerms, matches_review};
use patchriot_protocol::{
    ReviewView,
    website_reviews::{FundReview, ReviewPrice},
};

#[derive(Default, Serialize)]
pub struct DeliverySummary {
    pub checked: usize,
    pub delivered: usize,
    pub retrying: usize,
    pub needs_review: usize,
}

#[derive(FromRow)]
struct Event {
    invoice_id: Uuid,
    account_id: Uuid,
    request_id: Uuid,
    asset: String,
    amount: i64,
    delivery_token: Option<Uuid>,
    delivery_until: Option<DateTime<Utc>>,
    delivery_state: String,
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
}

enum Outcome {
    Delivered,
    Retry(&'static str),
    Review(&'static str),
}

/// At most ten due events per invocation. Every network call follows a commit;
/// a short claim and the dispatcher's invoice key make restart/concurrency safe.
/// Unavailable or rejected work keeps its recorded funds for operator review.
pub async fn deliver_once(state: &AppState) -> Result<DeliverySummary, PaymentError> {
    let mut summary = DeliverySummary::default();
    for _ in 0..10 {
        let token = Uuid::new_v4();
        let event: Option<Event> = sqlx::query_as("UPDATE payment_funding_events SET delivery_token = $1, delivery_until = now() + interval '30 seconds' WHERE invoice_id = (SELECT invoice_id FROM payment_funding_events WHERE delivery_state = 'pending' AND next_delivery_at <= now() AND (delivery_until IS NULL OR delivery_until < now()) ORDER BY next_delivery_at, invoice_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *")
            .bind(token).fetch_optional(&state.pool).await?;
        let Some(event) = event else { break };
        let outcome = deliver_claimed(state, &event, token).await?;
        if finish(&state.pool, &event, token, &outcome).await? {
            match outcome {
                Outcome::Delivered => summary.delivered += 1,
                Outcome::Retry(_) => summary.retrying += 1,
                Outcome::Review(_) => summary.needs_review += 1,
            }
        }
        summary.checked += 1;
    }
    Ok(summary)
}

fn binds(event: &Event, invoice: &Invoice, order: &Order, terms: &CheckoutTerms) -> bool {
    event.invoice_id == invoice.id
        && event.account_id == invoice.account_id
        && event.request_id == invoice.request_id
        && event.asset == invoice.asset
        && event.amount == invoice.required_amount
        && order.invoice_id == Some(event.invoice_id)
        && order.account_id == event.account_id
        && order.request_id == event.request_id
        && order.review_id.is_some_and(|id| !id.is_nil())
        && terms.payment.account_id == event.account_id
        && terms.payment.request_id == event.request_id
        && terms.consent.request_id == event.request_id
        && terms.payment.destination_asset == event.asset
        && terms.payment.required_amount == event.amount
        && terms.payment.recipient == invoice.recipient
        && terms.payment.quote_request == invoice.quote_request
        && terms.consent.accepts_operator_access
}

fn confirmed(view: &ReviewView, event: &Event) -> bool {
    matches!(
        view.state.as_str(),
        "queued" | "running" | "completed" | "needs_review" | "cancelled" | "failed"
    ) && view.payment.as_ref().is_some_and(|payment| {
        payment.invoice_id == Some(event.invoice_id) && payment.funded_at.is_some()
    })
}

async fn deliver_claimed(
    state: &AppState,
    event: &Event,
    token: Uuid,
) -> Result<Outcome, PaymentError> {
    let order: Option<Order> =
        sqlx::query_as("SELECT * FROM checkout_orders WHERE invoice_id = $1")
            .bind(event.invoice_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(order) = order else {
        return Ok(Outcome::Review("checkout_order_missing"));
    };
    let invoice: Invoice = sqlx::query_as("SELECT * FROM payment_invoices WHERE id = $1")
        .bind(event.invoice_id)
        .fetch_one(&state.pool)
        .await?;
    let Ok(terms) = serde_json::from_value::<CheckoutTerms>(order.terms.clone()) else {
        return Ok(Outcome::Review("checkout_terms_invalid"));
    };
    let ledger_matches: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM payment_ledger WHERE invoice_id = $1 AND account_id = $2 AND asset = $3 AND amount = $4 AND credit = 'customer_funds')")
        .bind(event.invoice_id).bind(event.account_id).bind(&event.asset).bind(event.amount)
        .fetch_one(&state.pool).await?;
    if invoice.state != "settled" || !ledger_matches || !binds(event, &invoice, &order, &terms) {
        return Ok(Outcome::Review("funding_binding_mismatch"));
    }
    if invoice.watch_until <= Utc::now() {
        // An unknown prior activation is not automatically safe to refund.
        return Ok(Outcome::Review("funding_confirmation_window_elapsed"));
    }
    let review_id = order.review_id.ok_or(PaymentError::Database)?;
    let path = format!("/internal/reviews/{review_id}");
    // Read first even after expiry or account disable: a previous POST might
    // have succeeded while its reply was lost. This never starts new work.
    let view = match gateway::request_for_account::<(), ReviewView>(
        state,
        reqwest::Method::GET,
        &path,
        event.account_id,
        None,
    )
    .await
    {
        Ok(Json(view)) => view,
        Err(error) if error.status.as_u16() == 404 => {
            return Ok(Outcome::Review("admitted_review_missing"));
        }
        Err(_) => return Ok(Outcome::Retry("funding_status_unavailable")),
    };
    if view.id != review_id || !matches_review(&view, &terms, order.expires_at.timestamp()) {
        return Ok(Outcome::Review("funding_review_mismatch"));
    }
    if confirmed(&view, event) {
        return Ok(Outcome::Delivered);
    }
    if view
        .payment
        .as_ref()
        .is_none_or(|payment| payment.invoice_id.is_some() || payment.funded_at.is_some())
    {
        return Ok(Outcome::Review("funding_invoice_mismatch"));
    }
    if view.state != "awaiting_payment" || order.expires_at <= Utc::now() {
        return Ok(Outcome::Review("review_no_longer_payable"));
    }
    // Check local cancellation/account disable immediately before POST. Save
    // that an attempt may have reached dispatcher before making the call.
    if let Some(reason) = authorize_attempt(&state.pool, event, &order, token).await? {
        return Ok(Outcome::Review(reason));
    }
    let input = FundReview {
        request_id: event.request_id,
        invoice_id: event.invoice_id,
        price: ReviewPrice {
            asset: event.asset.clone(),
            amount: event.amount.to_string(),
        },
    };
    let view = match gateway::request_for_account::<_, ReviewView>(
        state,
        reqwest::Method::POST,
        &format!("{path}/fund"),
        event.account_id,
        Some(&input),
    )
    .await
    {
        Ok(Json(view)) => view,
        // A rejection may mean a temporarily offline selected device. The next
        // pass reads again; terminal/expired work cannot be revived by retries.
        Err(_) => return Ok(Outcome::Retry("funding_acknowledgment_unavailable")),
    };
    if view.id != review_id
        || !matches_review(&view, &terms, order.expires_at.timestamp())
        || !confirmed(&view, event)
    {
        return Ok(Outcome::Review("funding_acknowledgment_mismatch"));
    }
    Ok(Outcome::Delivered)
}

async fn authorize_attempt(
    pool: &PgPool,
    event: &Event,
    order: &Order,
    token: Uuid,
) -> Result<Option<&'static str>, PaymentError> {
    let mut tx = pool.begin().await?;
    let claimed: Event =
        sqlx::query_as("SELECT * FROM payment_funding_events WHERE invoice_id = $1 FOR UPDATE")
            .bind(event.invoice_id)
            .fetch_one(&mut *tx)
            .await?;
    if !current(&claimed, token) {
        return Ok(Some("funding_claim_changed"));
    }
    let enabled: bool =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id = $1 FOR SHARE")
            .bind(event.account_id)
            .fetch_one(&mut *tx)
            .await?;
    if !enabled {
        return Ok(Some("funding_account_disabled"));
    }
    let payable: bool = sqlx::query_scalar("SELECT state = 'awaiting_payment' AND expires_at > now() AND invoice_id = $2 AND review_id = $3 FROM checkout_orders WHERE id = $1 FOR UPDATE")
        .bind(order.id).bind(event.invoice_id).bind(order.review_id).fetch_one(&mut *tx).await?;
    if !payable {
        return Ok(Some("checkout_no_longer_payable"));
    }
    sqlx::query(
        "UPDATE payment_funding_events SET delivery_attempted_at = now() WHERE invoice_id = $1",
    )
    .bind(event.invoice_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(None)
}

fn current(event: &Event, token: Uuid) -> bool {
    event.delivery_state == "pending"
        && event.delivery_token == Some(token)
        && event.delivery_until.is_some_and(|until| until > Utc::now())
}

async fn finish(
    pool: &PgPool,
    event: &Event,
    token: Uuid,
    outcome: &Outcome,
) -> Result<bool, PaymentError> {
    let mut tx = pool.begin().await?;
    let claimed: Event =
        sqlx::query_as("SELECT * FROM payment_funding_events WHERE invoice_id = $1 FOR UPDATE")
            .bind(event.invoice_id)
            .fetch_one(&mut *tx)
            .await?;
    if !current(&claimed, token) {
        return Ok(false);
    }
    let (delivery, error) = match outcome {
        Outcome::Delivered => ("delivered", None),
        Outcome::Retry(reason) => ("pending", Some(*reason)),
        Outcome::Review(reason) => ("needs_review", Some(*reason)),
    };
    if !matches!(outcome, Outcome::Retry(_)) {
        // A confirmed activation remains a fact even if the local order was
        // closed during HTTP. Flag that race; do not pretend no work started.
        sqlx::query("UPDATE checkout_orders SET state = CASE WHEN $2 AND state IN ('awaiting_payment','activated') THEN 'activated' ELSE 'needs_review' END, last_error = CASE WHEN $2 AND state NOT IN ('awaiting_payment','activated') THEN 'funded_after_checkout_closed' ELSE $3 END, updated_at = now() WHERE invoice_id = $1 AND account_id = $4 AND request_id = $5")
            .bind(event.invoice_id).bind(matches!(outcome, Outcome::Delivered)).bind(error)
            .bind(event.account_id).bind(event.request_id).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE payment_funding_events SET delivery_state = $2, consumed_at = CASE WHEN $2 = 'delivered' THEN now() ELSE NULL END, delivery_error = $3, delivery_token = NULL, delivery_until = NULL, next_delivery_at = now() + interval '60 seconds' WHERE invoice_id = $1")
        .bind(event.invoice_id).bind(delivery).bind(error).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
