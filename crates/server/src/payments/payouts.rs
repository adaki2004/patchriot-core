//! Owner-confirmed withdrawals from earned balances. Core saves and reserves
//! requests; a separate command holds the treasury key. No agent can choose a
//! transfer, alter balances, or mark itself paid.

use super::*;
use access::{Blockchain, PaymentToken};
use axum::{extract::Path, http::StatusCode};
use earnings::{MINIMUM_CLAIM, SETTLEMENT_ASSET};
use std::sync::Arc;

pub mod chain;

#[cfg(test)]
#[path = "payouts_tests.rs"]
mod tests;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TreasuryConfig {
    pub recipient: String,
    pub rpc_url: String,
    pub buffer_amount: String,
    pub maximum_claim: String,
    pub maximum_gas_wei: String,
}

pub struct PayoutService {
    pub(crate) config: TreasuryConfig,
    pub(crate) provider: OneClick,
}

impl PayoutService {
    pub fn configured(bytes: &[u8], api_key: &str) -> Result<Arc<Self>, PaymentError> {
        let config: TreasuryConfig =
            serde_json::from_slice(bytes).map_err(|_| PaymentError::Configuration)?;
        let url = url::Url::parse(&config.rpc_url).map_err(|_| PaymentError::Configuration)?;
        let local = url
            .host_str()
            .is_some_and(|host| ["127.0.0.1", "localhost", "[::1]"].contains(&host));
        if bytes.len() > 16 * 1024
            || !Blockchain::Base.accepts_address(&config.recipient)
            || !(url.scheme() == "https" || local && url.scheme() == "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || atom_amount(&json!(config.buffer_amount)).is_none_or(|v| v < 1_000_000)
            || atom_amount(&json!(config.maximum_claim))
                .is_none_or(|v| !(MINIMUM_CLAIM..=1_000_000_000).contains(&v))
            || atom_amount(&json!(config.maximum_gas_wei))
                .is_none_or(|v| !(1..=100_000_000_000_000).contains(&v))
        {
            return Err(PaymentError::Configuration);
        }
        Ok(Arc::new(Self {
            config,
            provider: OneClick::new(api_key)?,
        }))
    }
}
use serde_json::json;

pub(crate) fn destinations() -> Vec<PaymentToken> {
    [
        (
            "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
            "USDC",
            Blockchain::Eth,
        ),
        (
            "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
            "USDT",
            Blockchain::Eth,
        ),
        (
            "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
            "USDC",
            Blockchain::Sol,
        ),
        (
            "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
            "USDT",
            Blockchain::Sol,
        ),
    ]
    .into_iter()
    .map(|(asset, symbol, blockchain)| PaymentToken {
        asset_id: asset.into(),
        symbol: symbol.into(),
        decimals: 6,
        blockchain,
    })
    .collect()
}

#[derive(Clone, FromRow)]
pub(crate) struct Claim {
    id: Uuid,
    operator_id: Uuid,
    amount: i64,
    destination_asset: String,
    recipient: String,
    treasury: String,
    state: String,
    quote_request: Option<Value>,
    quote: Option<Value>,
    deposit_address: Option<String>,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
    last_error: Option<String>,
}

fn view(c: &Claim) -> Value {
    json!({"id":c.id,"amount":c.amount.to_string(),"destination_asset":c.destination_asset,
        "recipient":c.recipient,"state":c.state,"expires_at":c.expires_at,"created_at":c.created_at,
        "expected_amount":c.quote.as_ref().and_then(|q|q["amountOut"].as_str()),
        "minimum_amount":c.quote.as_ref().and_then(|q|q["minAmountOut"].as_str()),"last_error":c.last_error})
}

fn service(state: &AppState) -> Result<&PayoutService, ApiError> {
    state
        .payouts
        .as_deref()
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "withdrawals_unavailable"))
}

#[derive(FromRow, Serialize)]
pub(crate) struct Balance {
    pub earned: String,
    pub paid: String,
    pub reserved: String,
    pub available: String,
}
pub(crate) async fn balance(pool: &PgPool, account: Uuid) -> Result<Balance, sqlx::Error> {
    sqlx::query_as("WITH e AS(SELECT COALESCE(sum(e.amount),0) total FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 AND a.asset=$2),c AS(SELECT COALESCE(sum(amount) FILTER(WHERE state='paid'),0) paid,COALESCE(sum(amount) FILTER(WHERE state NOT IN('paid','cancelled')),0) reserved FROM operator_claims WHERE operator_id=$1) SELECT total::text earned,paid::text,reserved::text,(total-paid-reserved)::text available FROM e,c")
        .bind(account).bind(SETTLEMENT_ASSET).fetch_one(pool).await
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    let claims: Vec<Claim> = sqlx::query_as(
        "SELECT * FROM operator_claims WHERE operator_id=$1 ORDER BY created_at DESC LIMIT 50",
    )
    .bind(session.id)
    .fetch_all(&state.pool)
    .await?;
    let receipts: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('claim_id',r.claim_id,'amount',r.received_amount::text,'source_transaction',r.source_tx,'destination_transactions',r.destination_txs) FROM payout_receipts r JOIN operator_claims c ON c.id=r.claim_id WHERE c.operator_id=$1 ORDER BY r.created_at DESC LIMIT 50")
        .bind(session.id).fetch_all(&state.pool).await?;
    Ok(Json(
        json!({"enabled":state.payouts.is_some(),"balance":balance(&state.pool,session.id).await?,"minimum_claim":MINIMUM_CLAIM.to_string(),"destinations":destinations(),"claims":claims.iter().map(view).collect::<Vec<_>>(),"receipts":receipts}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateClaim {
    id: Uuid,
    amount: String,
    destination_asset: String,
    recipient: String,
}

async fn reserve(
    pool: &PgPool,
    account: Uuid,
    input: &CreateClaim,
    config: &TreasuryConfig,
) -> Result<Claim, ApiError> {
    let amount = atom_amount(&json!(input.amount))
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "invalid_withdrawal"))?;
    if input.id.is_nil()
        || amount < MINIMUM_CLAIM
        || amount > atom_amount(&json!(config.maximum_claim)).unwrap_or(0)
        || !destinations().iter().any(|token| {
            token.asset_id == input.destination_asset
                && token.blockchain.accepts_address(&input.recipient)
        })
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid_withdrawal"));
    }
    let mut tx = pool.begin().await?;
    let enabled: Option<bool> =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(account)
            .fetch_optional(&mut *tx)
            .await?;
    if enabled != Some(true) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "action_not_allowed"));
    }
    let previous: Option<Claim> = sqlx::query_as("SELECT * FROM operator_claims WHERE id=$1")
        .bind(input.id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(c) = previous {
        if c.operator_id == account
            && c.amount == amount
            && c.recipient == input.recipient
            && c.destination_asset == input.destination_asset
        {
            return Ok(c);
        }
        return Err(ApiError::new(StatusCode::CONFLICT, "request_conflict"));
    }
    let recent: i64 = sqlx::query_scalar("SELECT count(*) FROM operator_claims WHERE operator_id=$1 AND created_at>now()-interval '1 hour'").bind(account).fetch_one(&mut *tx).await?;
    if recent >= 10 {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "try_again_later",
        ));
    }
    let available:i64=sqlx::query_scalar("SELECT (COALESCE((SELECT sum(e.amount) FROM operator_earnings e JOIN earning_allocations a USING(invoice_id) WHERE e.operator_id=$1 AND a.asset=$2),0)-COALESCE((SELECT sum(amount) FROM operator_claims WHERE operator_id=$1 AND state<>'cancelled'),0))::bigint")
        .bind(account).bind(SETTLEMENT_ASSET).fetch_one(&mut *tx).await?;
    let open:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operator_claims WHERE operator_id=$1 AND state NOT IN('paid','cancelled'))").bind(account).fetch_one(&mut *tx).await?;
    if open || available < amount {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            if open {
                "withdrawal_in_progress"
            } else {
                "insufficient_earnings"
            },
        ));
    }
    let c:Claim=sqlx::query_as("INSERT INTO operator_claims(id,operator_id,amount,destination_asset,recipient,treasury,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'preparing',date_trunc('second',now())+interval '5 minutes') RETURNING *")
        .bind(input.id).bind(account).bind(amount).bind(&input.destination_asset).bind(&input.recipient).bind(config.recipient.to_lowercase()).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(c)
}

fn request(c: &Claim) -> Value {
    json!({"dry":false,"swapType":"EXACT_INPUT","slippageTolerance":100,"originAsset":SETTLEMENT_ASSET,
        "depositType":"ORIGIN_CHAIN","destinationAsset":c.destination_asset,"amount":c.amount.to_string(),
        "refundTo":c.treasury,"refundType":"ORIGIN_CHAIN","recipient":c.recipient,"recipientType":"DESTINATION_CHAIN",
        "deadline":c.expires_at.to_rfc3339(),"depositMode":"SIMPLE","quoteWaitingTimeMs":2000})
}
fn valid_quote(c: &Claim, q: &QuoteResponse) -> bool {
    let output = atom_amount(&q.quote["amountOut"]).unwrap_or(0);
    let minimum = atom_amount(&q.quote["minAmountOut"]).unwrap_or(0);
    matches_request(&request(c),&q.quote_request)
        && atom_amount(&q.quote["amountIn"])==Some(c.amount)
        && output>0 && minimum>0 && minimum<=output
        && minimum>=c.amount-c.amount/10 // Refuse more than 10% fees/slippage for these stablecoins.
        && date(&q.quote["deadline"]).is_some_and(|t|t>=c.expires_at && t<=c.expires_at+Duration::days(3))
        && q.quote["depositMemo"].is_null()
        && q.quote["depositAddress"].as_str().is_some_and(|a|Blockchain::Base.accepts_address(a) && !a.eq_ignore_ascii_case(&c.treasury))
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateClaim>,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    let service = service(&state)?;
    let c = reserve(&state.pool, session.id, &input, &service.config).await?;
    if c.state != "preparing" {
        return Ok(Json(view(&c)));
    }
    let token = Uuid::new_v4();
    let locked=sqlx::query("UPDATE operator_claims SET quote_token=$2 WHERE id=$1 AND state='preparing' AND quote_token IS NULL AND expires_at>now()+interval '45 seconds'")
        .bind(c.id).bind(token).execute(&state.pool).await?.rows_affected();
    if locked != 1 {
        return Ok(Json(view(&c)));
    }
    let result = service
        .provider
        .response::<QuoteResponse>(
            service
                .provider
                .client
                .post(format!("{}/v0/quote", service.provider.origin))
                .header("X-API-Key", service.provider.api_key.clone())
                .json(&request(&c)),
        )
        .await;
    match result {
        Ok(q) if valid_quote(&c, &q) => {
            sqlx::query("UPDATE operator_claims SET state='quoted',quote_request=$3,quote=$4,deposit_address=$5,quote_token=NULL,updated_at=now() WHERE id=$1 AND quote_token=$2 AND state='preparing' AND expires_at>now()")
                .bind(c.id).bind(token).bind(q.quote_request).bind(&q.quote).bind(q.quote["depositAddress"].as_str()).execute(&state.pool).await?;
        }
        _ => {
            sqlx::query("UPDATE operator_claims SET state='cancelled',quote_token=NULL,last_error='withdrawal_quote_unavailable',updated_at=now() WHERE id=$1 AND quote_token=$2 AND state='preparing'")
                .bind(c.id).bind(token).execute(&state.pool).await?;
        }
    }
    let c: Claim = sqlx::query_as("SELECT * FROM operator_claims WHERE id=$1 AND operator_id=$2")
        .bind(c.id)
        .bind(session.id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(view(&c)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Empty {}

pub(crate) async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<Empty>,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    service(&state)?;
    let changed=sqlx::query("UPDATE operator_claims SET state='queued',updated_at=now() WHERE id=$1 AND operator_id=$2 AND state='quoted' AND expires_at>now()+interval '30 seconds'").bind(id).bind(session.id).execute(&state.pool).await?.rows_affected();
    if changed == 0 {
        let repeated:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operator_claims WHERE id=$1 AND operator_id=$2 AND state IN('queued','signed','paid'))").bind(id).bind(session.id).fetch_one(&state.pool).await?;
        if !repeated {
            return Err(ApiError::new(StatusCode::CONFLICT, "withdrawal_changed"));
        }
    }
    Ok(Json(json!({"accepted":true})))
}

pub(crate) async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(_): Json<Empty>,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_write(&headers, &state).await?;
    let n=sqlx::query("UPDATE operator_claims c SET state='cancelled',quote_token=NULL,updated_at=now() WHERE id=$1 AND operator_id=$2 AND state IN('preparing','quoted','queued') AND NOT EXISTS(SELECT 1 FROM payout_transactions WHERE claim_id=c.id)")
        .bind(id).bind(session.id).execute(&state.pool).await?.rows_affected();
    if n == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "withdrawal_changed"));
    }
    Ok(Json(json!({"cancelled":true})))
}

/// Pending customer work, held receipts and unpaid operators all count. Active
/// reservations do not reduce the debt; only a completed payout does.
pub(crate) async fn liabilities(connection: &mut sqlx::PgConnection) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT (COALESCE((SELECT sum(amount) FROM payment_ledger WHERE asset=$1),0)-COALESCE((SELECT sum(platform_amount) FROM earning_allocations WHERE asset=$1),0)-COALESCE((SELECT sum(gross_amount) FROM payout_receipts),0))::bigint")
        .bind(SETTLEMENT_ASSET).fetch_one(connection).await
}

pub(crate) async fn desk(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let session = auth::require_session(&headers, &state).await?;
    if session.role != "admin" {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "admin_required"));
    }
    let mut conn = state.pool.acquire().await?;
    let owed = liabilities(&mut conn).await?;
    let revenue: String = sqlx::query_scalar(
        "SELECT COALESCE(sum(platform_amount),0)::text FROM earning_allocations WHERE asset=$1",
    )
    .bind(SETTLEMENT_ASSET)
    .fetch_one(&mut *conn)
    .await?;
    let observation:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('treasury',treasury,'balance',balance::text,'liabilities',liabilities::text,'buffer',buffer::text,'block_number',block_number,'sufficient',sufficient,'observed_at',observed_at) FROM treasury_observations ORDER BY id DESC LIMIT 1").fetch_optional(&mut *conn).await?;
    let claims:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',c.id,'operator',a.display_name,'amount',c.amount::text,'destination_asset',c.destination_asset,'recipient',c.recipient,'state',c.state,'last_error',c.last_error,'created_at',c.created_at) FROM operator_claims c JOIN accounts a ON a.id=c.operator_id ORDER BY c.created_at DESC LIMIT 50").fetch_all(&mut *conn).await?;
    let work:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('invoice_id',e.invoice_id,'operator_id',e.operator_id,'operator',a.display_name,'role',e.role,'amount',e.amount::text,'reported_duration_ms',e.reported_duration_ms,'reported_model',e.reported_model,'created_at',p.created_at) FROM operator_earnings e JOIN accounts a ON a.id=e.operator_id JOIN earning_allocations p USING(invoice_id) WHERE p.asset=$1 ORDER BY p.created_at DESC,e.role LIMIT 100")
        .bind(SETTLEMENT_ASSET).fetch_all(&mut *conn).await?;
    Ok(Json(
        json!({"liabilities":owed.to_string(),"platform_revenue":revenue,"observation":observation,"claims":claims,"work":work}),
    ))
}
