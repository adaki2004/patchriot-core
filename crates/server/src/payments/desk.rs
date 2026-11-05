//! Admin inspection of saved payment facts. No provider requests or money
//! actions: a cancellation, ledger credit or status flag is not a refund receipt.

use super::*;
use axum::http::StatusCode;

#[derive(FromRow, Serialize)]
pub(crate) struct PaymentRecord {
    invoice_id: Uuid,
    credit_topup_id: Option<Uuid>,
    account_id: Uuid,
    account_name: String,
    account_disabled: bool,
    asset: String,
    origin_asset: Option<String>,
    deposit_address: String,
    deposit_memo: Option<String>,
    recipient: String,
    recipient_type: Option<String>,
    payment_confirmed: bool,
    required_amount: String,
    received_amount: Option<String>,
    payment_state: String,
    payment_reason: Option<String>,
    poll_error: Option<String>,
    provider_updated_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    ledger_amount: Option<String>,
    ledger_credit: Option<String>,
    order_id: Option<Uuid>,
    order_state: Option<String>,
    order_error: Option<String>,
    review_id: Option<Uuid>,
    funding_state: Option<String>,
    funding_error: Option<String>,
    earnings_error: Option<String>,
    cancel_requested_at: Option<DateTime<Utc>>,
    cancel_confirmed_at: Option<DateTime<Utc>>,
    cancel_review_state: Option<String>,
    requires_attention: bool,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PaymentRecord>>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    // Bounded local history remains inspectable when the provider/dispatcher is
    // unavailable. Disabled customer accounts may still have funds to reconcile.
    // Show the saved deposit → order mapping to authorized staff. These are
    // historical facts, not fresh transfer instructions. Never return the raw
    // provider response, customer refund address or secrets.
    let rows = sqlx::query_as(
        "SELECT i.id AS invoice_id, t.id AS credit_topup_id, i.account_id, a.display_name AS account_name,
            a.disabled AS account_disabled, i.asset, i.required_amount::text,
            i.quote_request->>'originAsset' AS origin_asset,
            i.deposit_address, NULLIF(i.deposit_memo, '') AS deposit_memo,
            i.recipient, i.quote_request->>'recipientType' AS recipient_type,
            COALESCE(i.state = 'settled' AND l.account_id = i.account_id
                AND l.asset = i.asset AND l.amount = i.received_amount, false) AS payment_confirmed,
            i.received_amount::text, i.state AS payment_state, i.reason AS payment_reason,
            i.poll_error, i.provider_updated_at, i.created_at, i.updated_at,
            l.amount::text AS ledger_amount, l.credit AS ledger_credit,
            o.id AS order_id, o.state AS order_state, o.last_error AS order_error,
            o.review_id, f.delivery_state AS funding_state, f.delivery_error AS funding_error, f.earnings_error,
            o.cancel_requested_at, o.cancel_confirmed_at, o.cancel_review_state,
            (i.state IN ('held','needs_review') OR i.poll_error IS NOT NULL
                OR COALESCE(o.state = 'needs_review', false)
                OR COALESCE(f.delivery_state = 'needs_review', false)
                OR f.earnings_error IS NOT NULL
                OR COALESCE(o.cancel_requested_at IS NOT NULL AND (
                    l.id IS NOT NULL OR (o.cancel_confirmed_at IS NULL AND o.cancel_next_attempt_at IS NULL)
                ), false)
                OR (i.state = 'settled' AND (l.id IS NULL OR
                    (t.id IS NULL AND (o.id IS NULL OR f.invoice_id IS NULL)) OR
                    (t.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM credit_ledger c WHERE c.topup_id=t.id))))
                OR (l.id IS NOT NULL AND (l.account_id <> i.account_id OR l.asset <> i.asset
                    OR l.amount IS DISTINCT FROM i.received_amount))
                OR (o.id IS NOT NULL AND (o.account_id <> i.account_id OR o.request_id <> i.request_id))
                OR (f.invoice_id IS NOT NULL AND (f.account_id <> i.account_id OR f.request_id <> i.request_id
                    OR f.asset <> i.asset OR f.amount IS DISTINCT FROM i.received_amount))
            ) AS requires_attention
        FROM payment_invoices i JOIN accounts a ON a.id = i.account_id
        LEFT JOIN payment_ledger l ON l.invoice_id = i.id
        LEFT JOIN checkout_orders o ON o.invoice_id = i.id
        LEFT JOIN payment_funding_events f ON f.invoice_id = i.id
        LEFT JOIN credit_topups t ON t.invoice_id = i.id
        ORDER BY i.created_at DESC, i.id DESC LIMIT 50",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}
