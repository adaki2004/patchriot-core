//! One Base USDC transfer at a time. Signed bytes commit before broadcast;
//! retries use those same bytes and never guess a replacement nonce.
use super::*;
use alloy_consensus::{SignableTransaction, Transaction, TxEip1559, TxEnvelope};
use alloy_eips::eip2718::{Decodable2718, Encodable2718};
use alloy_primitives::{Address, Bytes, Signature, TxKind, U256, keccak256};
use secp256k1::{Message, Secp256k1, SecretKey};
use std::{path::Path, str::FromStr};
use zeroize::Zeroizing;

const CHAIN: u64 = 8453;
const TOKEN: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

#[derive(FromRow)]
struct SavedTransaction {
    claim_id: Uuid,
    sender: String,
    nonce: i64,
    tx_hash: String,
    signed_bytes: String,
}

fn quantity(v: &Value) -> Result<u128, PaymentError> {
    let text = v
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or(PaymentError::InvalidResponse)?;
    let text = text.trim_start_matches('0');
    if text.is_empty() {
        return Ok(0);
    }
    u128::from_str_radix(text, 16).map_err(|_| PaymentError::InvalidResponse)
}
fn address(s: &str) -> Result<Address, PaymentError> {
    Address::from_str(s).map_err(|_| PaymentError::Configuration)
}
fn transfer(to: Address, amount: i64) -> Vec<u8> {
    let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
    data.extend([0u8; 12]);
    data.extend(to.as_slice());
    data.extend(U256::from(amount as u64).to_be_bytes::<32>());
    data
}

impl PayoutService {
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, PaymentError> {
        let body: Value = self
            .provider
            .response(
                self.provider
                    .client
                    .post(&self.config.rpc_url)
                    .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})),
            )
            .await?;
        if body["id"] != 1
            || body.get("error").is_some()
            || body["jsonrpc"].as_str().is_none_or(|s| s != "2.0")
        {
            return Err(PaymentError::ProviderUnavailable);
        }
        body.get("result")
            .cloned()
            .ok_or(PaymentError::InvalidResponse)
    }
    async fn check_chain(&self) -> Result<(), PaymentError> {
        if quantity(&self.rpc("eth_chainId", json!([])).await?)? != u128::from(CHAIN) {
            return Err(PaymentError::Configuration);
        }
        Ok(())
    }
    async fn token_balance(&self, block: &str) -> Result<i64, PaymentError> {
        let data = format!(
            "0x70a08231000000000000000000000000{}",
            &self.config.recipient[2..]
        );
        let amount = quantity(
            &self
                .rpc("eth_call", json!([{"to":TOKEN,"data":data},block]))
                .await?,
        )?;
        i64::try_from(amount).map_err(|_| PaymentError::InvalidResponse)
    }
    async fn status_for(&self, c: &Claim) -> Result<ProviderStatus, PaymentError> {
        let mut url = url::Url::parse(&format!("{}/v0/status", self.provider.origin))
            .map_err(|_| PaymentError::Configuration)?;
        url.query_pairs_mut().append_pair(
            "depositAddress",
            c.deposit_address
                .as_deref()
                .ok_or(PaymentError::InvalidResponse)?,
        );
        let status: ProviderStatus = self
            .provider
            .response(
                self.provider
                    .client
                    .get(url)
                    .header("X-API-Key", self.provider.api_key.clone()),
            )
            .await?;
        if c.quote.as_ref() != Some(&status.quote_response.quote)
            || !c
                .quote_request
                .as_ref()
                .is_some_and(|q| matches_status_request(q, &status.quote_response.quote_request))
            || status.updated_at > Utc::now() + Duration::seconds(30)
            || status.updated_at < c.created_at - Duration::seconds(30)
        {
            return Err(PaymentError::InvalidResponse);
        }
        Ok(status)
    }
}

/// A key is loaded only by this payout command. It is never added to AppState,
/// the browser process, the dispatcher, logs, or a relay environment.
struct TreasuryKey(SecretKey);
impl Drop for TreasuryKey {
    fn drop(&mut self) {
        self.0.non_secure_erase();
    }
}

fn load_key(path: &Path, treasury: &str) -> Result<TreasuryKey, PaymentError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| PaymentError::Configuration)?;
    if !metadata.is_file() || metadata.len() > 128 {
        return Err(PaymentError::Configuration);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(PaymentError::Configuration);
        }
    }
    let text =
        Zeroizing::new(std::fs::read_to_string(path).map_err(|_| PaymentError::Configuration)?);
    let bytes = Zeroizing::new(
        hex::decode(text.trim().strip_prefix("0x").unwrap_or(text.trim()))
            .map_err(|_| PaymentError::Configuration)?,
    );
    let key = TreasuryKey(
        SecretKey::from_byte_array(
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| PaymentError::Configuration)?,
        )
        .map_err(|_| PaymentError::Configuration)?,
    );
    if Address::from_secp256k1_secret_key(&key.0) != address(treasury)? {
        return Err(PaymentError::Configuration);
    }
    Ok(key)
}

#[derive(Serialize)]
pub struct Progress {
    status: &'static str,
}
fn progress(status: &'static str) -> Progress {
    Progress { status }
}

async fn mark(pool: &PgPool, id: Uuid, reason: &'static str) -> Result<Progress, PaymentError> {
    // Reservation and the treasury lane stay held. Inspect the saved transaction
    // before any recovery; a missing response is not proof that money stayed put.
    sqlx::query("UPDATE operator_claims SET state='needs_review',last_error=$2,updated_at=now() WHERE id=$1 AND state='signed'").bind(id).bind(reason).execute(pool).await?;
    Ok(progress(reason))
}

fn validate_saved(c: &Claim, s: &SavedTransaction) -> Result<(), PaymentError> {
    if s.signed_bytes.len() > 4096 {
        return Err(PaymentError::InvalidResponse);
    }
    let raw = hex::decode(
        s.signed_bytes
            .strip_prefix("0x")
            .ok_or(PaymentError::InvalidResponse)?,
    )
    .map_err(|_| PaymentError::InvalidResponse)?;
    let mut bytes = raw.as_slice();
    let tx = TxEnvelope::decode_2718(&mut bytes).map_err(|_| PaymentError::InvalidResponse)?;
    let signed = tx.as_eip1559().ok_or(PaymentError::InvalidResponse)?;
    if !bytes.is_empty()
        || format!("{:#x}", keccak256(&raw)) != s.tx_hash
        || tx.chain_id() != Some(CHAIN)
        || tx.to() != Some(address(TOKEN)?)
        || tx.value() != U256::ZERO
        || tx.nonce() != u64::try_from(s.nonce).map_err(|_| PaymentError::InvalidResponse)?
        || tx.input().as_ref()
            != transfer(
                address(
                    c.deposit_address
                        .as_deref()
                        .ok_or(PaymentError::InvalidResponse)?,
                )?,
                c.amount,
            )
        || signed
            .signature()
            .recover_address_from_prehash(&signed.signature_hash())
            .map_err(|_| PaymentError::InvalidResponse)?
            != address(&c.treasury)?
        || !s.sender.eq_ignore_ascii_case(&c.treasury)
        || s.claim_id != c.id
    {
        return Err(PaymentError::InvalidResponse);
    }
    Ok(())
}

async fn resume(
    state: &AppState,
    service: &PayoutService,
    c: &Claim,
    s: &SavedTransaction,
) -> Result<Progress, PaymentError> {
    validate_saved(c, s)?;
    let receipt = service
        .rpc("eth_getTransactionReceipt", json!([s.tx_hash]))
        .await?;
    if receipt.is_null() {
        if c.expires_at <= Utc::now() {
            return mark(&state.pool, c.id, "signed_transfer_unconfirmed").await;
        }
        // Re-send the identical saved transaction after a timeout/restart. The
        // chain can execute this nonce/hash only once; no new signature is made.
        let result = service
            .rpc("eth_sendRawTransaction", json!([s.signed_bytes]))
            .await;
        if result.is_ok_and(|value| value.as_str() == Some(&s.tx_hash)) {
            return Ok(progress("broadcast"));
        }
        return Ok(progress("broadcast_outcome_unknown"));
    }
    let finalized = service
        .rpc("eth_getBlockByNumber", json!(["finalized", false]))
        .await?;
    let receipt_block = quantity(&receipt["blockNumber"])?;
    if quantity(&finalized["number"])? < receipt_block {
        return Ok(progress("awaiting_finality"));
    }
    let canonical = service
        .rpc(
            "eth_getBlockByNumber",
            json!([receipt["blockNumber"], false]),
        )
        .await?;
    if canonical["hash"] != receipt["blockHash"] || receipt["transactionHash"] != s.tx_hash {
        return mark(&state.pool, c.id, "source_receipt_mismatch").await;
    }
    if receipt["status"] != "0x1" {
        return mark(&state.pool, c.id, "source_transaction_reverted").await;
    }
    let sender_topic = format!("0x{:0>64}", c.treasury[2..].to_lowercase());
    let recipient_topic = format!(
        "0x{:0>64}",
        c.deposit_address
            .as_ref()
            .ok_or(PaymentError::InvalidResponse)?[2..]
            .to_lowercase()
    );
    let matching = receipt["logs"].as_array().is_some_and(|logs| {
        logs.iter()
            .filter(|log| {
                log["address"]
                    .as_str()
                    .is_some_and(|a| a.eq_ignore_ascii_case(TOKEN))
                    && log["topics"].as_array().is_some_and(|t| t.len() == 3)
                    && log["topics"][0] == TRANSFER_TOPIC
                    && log["topics"][1] == sender_topic
                    && log["topics"][2] == recipient_topic
                    && quantity(&log["data"]).ok() == Some(c.amount as u128)
            })
            .count()
            == 1
    });
    if !matching {
        return mark(&state.pool, c.id, "source_transfer_mismatch").await;
    }
    let status = service.status_for(c).await?;
    if status.status != "SUCCESS" {
        if ["FAILED", "REFUNDED", "INCOMPLETE_DEPOSIT"].contains(&status.status.as_str()) {
            return mark(&state.pool, c.id, "provider_refund_requires_review").await;
        }
        return Ok(progress("awaiting_provider"));
    }
    let minimum = c
        .quote
        .as_ref()
        .and_then(|q| atom_amount(&q["minAmountOut"]))
        .ok_or(PaymentError::InvalidResponse)?;
    let amount =
        atom_amount(&status.swap_details["amountOut"]).ok_or(PaymentError::InvalidResponse)?;
    if amount < minimum
        || !transaction_evidence(&status.swap_details, &json!("DESTINATION_CHAIN"))
        || !status.swap_details["originChainTxHashes"]
            .as_array()
            .is_some_and(|hashes| {
                hashes.iter().any(|h| {
                    h["hash"]
                        .as_str()
                        .is_some_and(|h| h.eq_ignore_ascii_case(&s.tx_hash))
                })
            })
    {
        return mark(&state.pool, c.id, "payout_evidence_mismatch").await;
    }
    let mut tx = state.pool.begin().await?;
    let current: String =
        sqlx::query_scalar("SELECT state FROM operator_claims WHERE id=$1 FOR UPDATE")
            .bind(c.id)
            .fetch_one(&mut *tx)
            .await?;
    if current == "paid" {
        return Ok(progress("paid"));
    }
    if current != "signed" {
        return Ok(progress("needs_review"));
    }
    sqlx::query("INSERT INTO payout_receipts(claim_id,gross_amount,received_amount,source_tx,destination_txs,provider_updated_at) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(c.id).bind(c.amount).bind(amount).bind(&s.tx_hash).bind(&status.swap_details["destinationChainTxHashes"]).bind(status.updated_at).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE operator_claims SET state='paid',last_error=NULL,updated_at=now() WHERE id=$1",
    )
    .bind(c.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE treasury_lane SET claim_id=NULL WHERE id=true AND claim_id=$1")
        .bind(c.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(progress("paid"))
}

/// Invoke periodically in a separate service. Every call is bounded; only this
/// process needs the key. A confirmed user request is required before signing.
pub async fn run_once(state: &AppState, key_path: &Path) -> Result<Progress, PaymentError> {
    let service = state
        .payouts
        .as_deref()
        .ok_or(PaymentError::Configuration)?;
    service.check_chain().await?;
    let key = load_key(key_path, &service.config.recipient)?;
    let mut tx = state.pool.begin().await?;
    // Global row lock avoids two workers assigning a nonce. The bounded RPCs
    // below run before signing, and the transaction commits before broadcast.
    let lane: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT claim_id FROM treasury_lane WHERE id=true FOR UPDATE SKIP LOCKED",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(lane) = lane else {
        return Ok(progress("another_worker_active"));
    };
    let candidate:Option<Claim>=match lane {
        Some(id)=>sqlx::query_as("SELECT * FROM operator_claims WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?,
        None=>sqlx::query_as("SELECT * FROM operator_claims WHERE state='queued' ORDER BY created_at,id FOR UPDATE LIMIT 1").fetch_optional(&mut *tx).await?,
    };
    let Some(c) = candidate else {
        return Ok(progress("idle"));
    };
    if !c.treasury.eq_ignore_ascii_case(&service.config.recipient) {
        return Err(PaymentError::Configuration);
    }
    if ["paid", "cancelled"].contains(&c.state.as_str()) {
        sqlx::query("UPDATE treasury_lane SET claim_id=NULL WHERE id=true")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(progress("lane_released"));
    }
    if c.state == "needs_review" {
        return Ok(progress("needs_review"));
    }
    if c.state == "signed" {
        let saved: SavedTransaction =
            sqlx::query_as("SELECT * FROM payout_transactions WHERE claim_id=$1")
                .bind(c.id)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        return resume(state, service, &c, &saved).await;
    }
    if c.state != "queued" {
        return Err(PaymentError::InvalidResponse);
    }
    let enabled: bool =
        sqlx::query_scalar("SELECT NOT disabled FROM accounts WHERE id=$1 FOR SHARE")
            .bind(c.operator_id)
            .fetch_one(&mut *tx)
            .await?;
    if c.expires_at <= Utc::now() + Duration::seconds(20) || !enabled {
        sqlx::query("UPDATE operator_claims SET state='cancelled',last_error='unsigned_withdrawal_expired_or_disabled',updated_at=now() WHERE id=$1").bind(c.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE treasury_lane SET claim_id=NULL WHERE id=true")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(progress("unsigned_request_released"));
    }
    if c.amount > atom_amount(&json!(service.config.maximum_claim)).unwrap_or(0) {
        return Err(PaymentError::Configuration);
    }
    let provider = service.status_for(&c).await?;
    if provider.status != "PENDING_DEPOSIT" {
        return Err(PaymentError::InvalidResponse);
    }
    let finalized = service
        .rpc("eth_getBlockByNumber", json!(["finalized", false]))
        .await?;
    let balance = service
        .token_balance(
            finalized["number"]
                .as_str()
                .ok_or(PaymentError::InvalidResponse)?,
        )
        .await?
        .min(service.token_balance("latest").await?);
    let owed = liabilities(&mut tx).await?;
    let buffer =
        atom_amount(&json!(service.config.buffer_amount)).ok_or(PaymentError::Configuration)?;
    let enough = owed >= 0
        && owed
            .checked_add(buffer)
            .is_some_and(|needed| balance >= needed);
    sqlx::query("INSERT INTO treasury_observations(treasury,balance,liabilities,buffer,block_number,sufficient) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&c.treasury).bind(balance).bind(owed).bind(buffer).bind(i64::try_from(quantity(&finalized["number"])?).map_err(|_|PaymentError::InvalidResponse)?).bind(enough).execute(&mut *tx).await?;
    if !enough {
        sqlx::query("UPDATE operator_claims SET last_error='treasury_coverage_insufficient',updated_at=now() WHERE id=$1").bind(c.id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(progress("treasury_coverage_insufficient"));
    }
    let latest = quantity(
        &service
            .rpc("eth_getTransactionCount", json!([c.treasury, "latest"]))
            .await?,
    )?;
    let pending = quantity(
        &service
            .rpc("eth_getTransactionCount", json!([c.treasury, "pending"]))
            .await?,
    )?;
    if latest != pending {
        return Err(PaymentError::ProviderUnavailable);
    }
    let data = transfer(
        address(
            c.deposit_address
                .as_deref()
                .ok_or(PaymentError::InvalidResponse)?,
        )?,
        c.amount,
    );
    let call = json!({"from":c.treasury,"to":TOKEN,"value":"0x0","data":format!("0x{}",hex::encode(&data))});
    if quantity(&service.rpc("eth_call", json!([call, "latest"])).await?)? != 1 {
        return Err(PaymentError::InvalidResponse);
    }
    let estimate = quantity(&service.rpc("eth_estimateGas", json!([call])).await?)?;
    let gas = estimate
        .checked_mul(12)
        .and_then(|n| n.checked_div(10))
        .and_then(|n| n.checked_add(10_000))
        .filter(|n| *n <= 200_000)
        .ok_or(PaymentError::InvalidResponse)?;
    let price = quantity(&service.rpc("eth_gasPrice", json!([])).await?)?
        .checked_mul(2)
        .ok_or(PaymentError::InvalidResponse)?;
    let maximum = atom_amount(&json!(service.config.maximum_gas_wei))
        .ok_or(PaymentError::Configuration)? as u128;
    let native = quantity(
        &service
            .rpc("eth_getBalance", json!([c.treasury, "latest"]))
            .await?,
    )?;
    if price == 0
        || gas.checked_mul(price).is_none_or(|cost| cost > maximum)
        || native < maximum * 2
    {
        return Err(PaymentError::Configuration);
    }
    // Base also charges L1 data fees. Leave twice the configured execution-gas
    // budget in ETH; it is separate from the USDC used to back customer balances.
    let transaction = TxEip1559 {
        chain_id: CHAIN,
        nonce: u64::try_from(latest).map_err(|_| PaymentError::InvalidResponse)?,
        gas_limit: gas as u64,
        max_fee_per_gas: price,
        max_priority_fee_per_gas: price / 2,
        to: TxKind::Call(address(TOKEN)?),
        value: U256::ZERO,
        input: Bytes::from(data),
        access_list: Default::default(),
    };
    let mut context = Secp256k1::new();
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *seed).map_err(|_| PaymentError::Configuration)?;
    context.seeded_randomize(&seed);
    let signature = context
        .sign_ecdsa_recoverable(Message::from_digest(transaction.signature_hash().0), &key.0);
    let signed = transaction.into_signed(Signature::from(signature));
    let envelope: TxEnvelope = signed.into();
    let raw = envelope.encoded_2718();
    let hash = format!("{:#x}", keccak256(&raw));
    if c.expires_at <= Utc::now() + Duration::seconds(10) {
        return Err(PaymentError::InvalidResponse);
    }
    sqlx::query("INSERT INTO payout_transactions(claim_id,chain_id,sender,nonce,tx_hash,signed_bytes) VALUES($1,8453,$2,$3,$4,$5)")
        .bind(c.id).bind(&c.treasury).bind(i64::try_from(latest).map_err(|_|PaymentError::InvalidResponse)?).bind(&hash).bind(format!("0x{}",hex::encode(raw))).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE operator_claims SET state='signed',last_error=NULL,updated_at=now() WHERE id=$1",
    )
    .bind(c.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE treasury_lane SET claim_id=$1 WHERE id=true")
        .bind(c.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // A crash here is safe: the next invocation observes the saved transaction.
    Ok(progress("signed_and_saved"))
}
