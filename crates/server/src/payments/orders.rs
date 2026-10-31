//! Requester-only order history. Return saved payment facts, never a stored
//! provider quote: an old deposit address must not become new instructions.

use super::*;
use axum::{extract::Path, http::StatusCode};
use checkout::CheckoutError;
use patchriot_protocol::{CancelReview, website_reviews::ReviewPrice};

#[derive(Serialize)]
pub(crate) struct OrderView {
    id: Uuid,
    review_id: Option<Uuid>,
    state: String,
    price: ReviewPrice,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    payment: Option<PaymentView>,
    cancellation: Option<CancellationView>,
    requires_attention: bool,
    can_cancel: bool,
}

#[derive(Serialize)]
struct PaymentView {
    state: String,
    received_amount: Option<String>,
    deadline: DateTime<Utc>,
}

#[derive(Serialize)]
struct CancellationView {
    requested_at: DateTime<Utc>,
    confirmed_at: Option<DateTime<Utc>>,
    review_state: Option<String>,
}

#[derive(FromRow)]
struct OrderRow {
    id: Uuid,
    review_id: Option<Uuid>,
    state: String,
    price_asset: String,
    price_amount: String,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    payment_state: Option<String>,
    received_amount: Option<String>,
    payment_deadline: Option<DateTime<Utc>>,
    cancel_requested_at: Option<DateTime<Utc>>,
    cancel_confirmed_at: Option<DateTime<Utc>>,
    cancel_review_state: Option<String>,
    requires_attention: bool,
}

impl From<OrderRow> for OrderView {
    fn from(row: OrderRow) -> Self {
        Self {
            id: row.id,
            review_id: row.review_id,
            state: row.state,
            price: ReviewPrice {
                asset: row.price_asset,
                amount: row.price_amount,
            },
            created_at: row.created_at,
            expires_at: row.expires_at,
            payment: row
                .payment_state
                .zip(row.payment_deadline)
                .map(|(state, deadline)| PaymentView {
                    state,
                    received_amount: row.received_amount,
                    deadline,
                }),
            cancellation: row
                .cancel_requested_at
                .map(|requested_at| CancellationView {
                    requested_at,
                    confirmed_at: row.cancel_confirmed_at,
                    review_state: row.cancel_review_state,
                }),
            requires_attention: row.requires_attention,
            can_cancel: row.review_id.is_some() && row.cancel_requested_at.is_none(),
        }
    }
}

async fn read(pool: &PgPool, account: Uuid, id: Option<Uuid>) -> Result<Vec<OrderView>, ApiError> {
    // One bounded local query, including during a dispatcher/provider outage.
    // Amounts remain decimal strings so JavaScript cannot round ledger units.
    let rows = sqlx::query_as::<_, OrderRow>(
        "SELECT o.id, o.review_id, o.state, o.created_at, o.expires_at,
            o.terms #>> '{payment,destination_asset}' AS price_asset,
            o.terms #>> '{payment,required_amount}' AS price_amount,
            i.state AS payment_state, i.received_amount::text, i.deadline AS payment_deadline,
            o.cancel_requested_at, o.cancel_confirmed_at, o.cancel_review_state,
            (o.state = 'needs_review' OR COALESCE(i.state IN ('held','needs_review'), false)
                OR (o.invoice_id IS NOT NULL AND i.id IS NULL)
                OR (o.cancel_requested_at IS NOT NULL AND (
                    (o.cancel_confirmed_at IS NULL AND o.cancel_next_attempt_at IS NULL)
                    OR EXISTS (SELECT 1 FROM payment_ledger l WHERE l.invoice_id = o.invoice_id AND l.account_id = o.account_id)
                ))) AS requires_attention
        FROM checkout_orders o JOIN accounts a ON a.id = o.account_id
        LEFT JOIN payment_invoices i ON i.id = o.invoice_id AND i.account_id = o.account_id AND i.request_id = o.request_id
        WHERE o.account_id = $1 AND NOT a.disabled AND ($2::uuid IS NULL OR o.id = $2)
        ORDER BY o.created_at DESC, o.id DESC LIMIT 50",
    )
    .bind(account).bind(id).fetch_all(pool).await?;
    Ok(rows.into_iter().map(OrderView::from).collect())
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OrderView>>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    Ok(Json(read(&state.pool, session.id, None).await?))
}

pub(crate) async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<OrderView>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    owned(&state.pool, session.id, id).await.map(Json)
}

async fn owned(pool: &PgPool, account: Uuid, id: Uuid) -> Result<OrderView, ApiError> {
    read(pool, account, Some(id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found"))
}

pub(crate) async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_input): Json<CancelReview>,
) -> Result<Json<OrderView>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    cancellation::request(&state.pool, session.id, id)
        .await
        .map_err(|error| match error {
            CheckoutError::Closed => ApiError::new(StatusCode::NOT_FOUND, "not_found"),
            CheckoutError::AccountUnavailable => ApiError::denied(),
            CheckoutError::InProgress => ApiError::new(StatusCode::CONFLICT, "checkout_preparing"),
            _ => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable"),
        })?;
    // The cancellation worker confirms the remote state separately. This reply
    // means intent is saved, not that agents stopped or funds were refunded.
    owned(&state.pool, session.id, id).await.map(Json)
}
