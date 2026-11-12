//! Operator-selected review pricing and payment assets. Configuration is read
//! once at startup; a browser, webpage or agent cannot choose treasury terms.

use super::*;
use patchriot_protocol::website_reviews::ReviewPrice;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub const PAYMENT_WINDOW_SECONDS: i64 = 300;
pub const SLIPPAGE_BPS: u16 = 100;

#[derive(Default, Clone)]
pub enum ReviewAccess {
    FreePilot,
    Coupons,
    #[default]
    Closed,
    Paid(Arc<CheckoutService>),
}

impl ReviewAccess {
    /// Missing paid configuration is an error, never a fallback to free work.
    pub fn configured(
        mode: &str,
        policy: Option<&[u8]>,
        key: Option<&str>,
    ) -> Result<Self, PaymentError> {
        match mode {
            "pilot" | "closed" | "coupons" if policy.is_none() => Ok(match mode {
                "pilot" => Self::FreePilot,
                "coupons" => Self::Coupons,
                _ => Self::Closed,
            }),
            "paid" => {
                let bytes = policy
                    .filter(|v| v.len() <= 16 * 1024)
                    .ok_or(PaymentError::Configuration)?;
                let mut policy: CheckoutPolicy =
                    serde_json::from_slice(bytes).map_err(|_| PaymentError::Configuration)?;
                // An EVM-controlled Intents account is its lowercase address.
                // It is an account inside intents.near, not an EVM withdrawal.
                if matches!(policy.recipient_type, RecipientType::Intents)
                    && policy.recipient.starts_with("0x")
                {
                    if !Blockchain::Eth.accepts_address(&policy.recipient) {
                        return Err(PaymentError::Configuration);
                    }
                    policy.recipient.make_ascii_lowercase();
                }
                policy.validate()?;
                Ok(Self::Paid(Arc::new(CheckoutService {
                    policy,
                    provider: OneClick::new(key.ok_or(PaymentError::Configuration)?)?,
                })))
            }
            _ => Err(PaymentError::Configuration),
        }
    }

    pub fn is_paid(&self) -> bool {
        matches!(self, Self::Paid(_))
    }
}

pub struct CheckoutService {
    pub(super) policy: CheckoutPolicy,
    pub(super) provider: OneClick,
}

/// Validate the address format for each offered payment/refund network. This
/// does not prove that the customer controls the address.
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Blockchain {
    Near,
    Sol,
    Eth,
    Base,
    Arb,
    Op,
    Pol,
    Bsc,
    Avax,
}

impl Blockchain {
    pub(super) fn accepts_address(self, address: &str) -> bool {
        if self == Self::Sol {
            if !(32..=44).contains(&address.len()) {
                return false;
            }
            let mut bytes = [0_u8; 32];
            return bs58::decode(address).onto(&mut bytes).ok() == Some(bytes.len())
                && bytes.iter().any(|byte| *byte != 0);
        }
        if self != Self::Near {
            return address.len() == 42
                && address.starts_with("0x")
                && address[2..].bytes().all(|b| b.is_ascii_hexdigit())
                && address[2..].bytes().any(|b| b != b'0');
        }
        if !(2..=64).contains(&address.len()) {
            return false;
        }
        let mut separator = true;
        for byte in address.bytes() {
            if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
                separator = false;
            } else if matches!(byte, b'.' | b'-' | b'_') && !separator {
                separator = true;
            } else {
                return false;
            }
        }
        !separator
    }
}

/// Pin metadata from the provider's supported-token catalog. Never infer token
/// identity from a symbol, or change the decimals of an existing order.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PaymentToken {
    pub asset_id: String,
    pub symbol: String,
    pub decimals: u8,
    pub blockchain: Blockchain,
}

impl PaymentToken {
    fn valid(&self) -> bool {
        self.asset_id.starts_with("nep141:")
            && self.asset_id.len() > 7
            && self.asset_id.len() <= 256
            && self
                .asset_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'-' | b'_'))
            && !self.symbol.is_empty()
            && self.symbol.len() <= 16
            && self
                .symbol
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            && self.decimals <= 30
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RecipientType {
    Intents,
    DestinationChain,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckoutPolicy {
    pub destination: PaymentToken,
    pub amount: String,
    pub recipient: String,
    pub recipient_type: RecipientType,
    pub inputs: Vec<PaymentToken>,
}

impl CheckoutPolicy {
    fn validate(&self) -> Result<(), PaymentError> {
        let amount = atom_amount(&Value::String(self.amount.clone())).unwrap_or(0);
        let chain = match self.recipient_type {
            RecipientType::Intents => Blockchain::Near,
            RecipientType::DestinationChain => self.destination.blockchain,
        };
        if !self.destination.valid()
            || amount <= 0
            || !chain.accepts_address(&self.recipient)
            || self.inputs.is_empty()
            || self.inputs.len() > 8
            || self.inputs.iter().any(|token| {
                !token.valid()
                    || token.asset_id == self.destination.asset_id && token != &self.destination
            })
            || self
                .inputs
                .iter()
                .map(|token| &token.asset_id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.inputs.len()
        {
            return Err(PaymentError::Configuration);
        }
        Ok(())
    }

    pub(super) fn id(&self) -> Result<String, PaymentError> {
        let bytes = serde_json::to_vec(&(1, self, PAYMENT_WINDOW_SECONDS, SLIPPAGE_BPS))
            .map_err(|_| PaymentError::Configuration)?;
        Ok(hex::encode(Sha256::digest(bytes)))
    }

    pub(super) fn offer(&self) -> Result<Value, PaymentError> {
        Ok(serde_json::json!({
            "id":self.id()?, "price":ReviewPrice { asset:self.destination.asset_id.clone(), amount:self.amount.clone() },
            "destination":self.destination, "inputs":self.inputs, "payment_window_seconds":PAYMENT_WINDOW_SECONDS,
        }))
    }
}

/// Saved beside the order, so a later config edit cannot relabel an existing
/// quote. Older internally-created orders have no browser presentation.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentPresentation {
    pub offer_id: String,
    pub input: PaymentToken,
    pub output: PaymentToken,
}

impl PaymentPresentation {
    pub(super) fn validate_quote(
        &self,
        terms: &InvoiceTerms,
        quote: &QuoteResponse,
    ) -> Result<(), PaymentError> {
        if !self.input.valid()
            || !self.output.valid()
            || terms.destination_asset != self.output.asset_id
            || terms.quote_request["originAsset"] != self.input.asset_id
            || !self
                .input
                .blockchain
                .accepts_address(quote.quote["depositAddress"].as_str().unwrap_or(""))
        {
            return Err(PaymentError::InvalidQuote);
        }
        Ok(())
    }
}

pub(crate) async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    auth::require_session(&headers, &state).await?;
    let (mode, offer) = match &state.review_access {
        ReviewAccess::FreePilot => ("pilot", None),
        ReviewAccess::Coupons => ("coupons", None),
        ReviewAccess::Closed => ("closed", None),
        ReviewAccess::Paid(service) => (
            "paid",
            Some(service.policy.offer().map_err(|_| {
                ApiError::new(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "checkout_unavailable",
                )
            })?),
        ),
    };
    Ok(Json(serde_json::json!({"mode":mode,"offer":offer})))
}
