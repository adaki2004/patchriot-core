//! Shared wire types, licensed separately under Apache-2.0.
//!
//! Signatures bind a device's key to the deployment audience, HTTP path and typed
//! payload. TLS is still required. Writes enforce replay rules in persistent state:
//! pairing codes can be claimed once; heartbeat sequences cannot move backwards.
//! A recent signature alone does not make an operation idempotent or authorized.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub use ed25519_dalek::SigningKey as DeviceKey;

pub const PAIRING_START_PATH: &str = "/v1/pairings/start";
pub const PAIRING_STATUS_PATH: &str = "/v1/pairings/status";
pub const SIGNATURE_MAX_AGE_SECONDS: i64 = 120;
pub const SIGNATURE_MAX_FUTURE_SECONDS: i64 = 30;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRequest<T> {
    pub public_key: String,
    pub signed_at: i64,
    pub payload: T,
    pub signature: String,
}

/// Canonical representation for these DTOs: JSON object keys sorted recursively
/// by serde_json's default map, with integer numbers only and no Unicode rewriting.
/// Shared DTOs avoid differences from optional/default fields across clients.
fn signing_bytes<T: Serialize>(
    audience: &str,
    path: &str,
    signed_at: i64,
    payload: &T,
) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&serde_json::json!([
        "patchriot.device.v1",
        audience,
        "POST",
        path,
        signed_at,
        payload
    ]))
}

pub fn sign<T: Serialize>(
    key: &SigningKey,
    audience: &str,
    path: &str,
    signed_at: i64,
    payload: T,
) -> Result<SignedRequest<T>, serde_json::Error> {
    let message = signing_bytes(audience, path, signed_at, &payload)?;
    Ok(SignedRequest {
        public_key: hex::encode(key.verifying_key().as_bytes()),
        signed_at,
        payload,
        signature: hex::encode(key.sign(&message).to_bytes()),
    })
}

/// Verify the proof, including strict Ed25519 checks and clock bounds. The caller
/// must also look up the device, check its status and apply the operation's replay rule.
pub fn verify<T: Serialize>(
    request: &SignedRequest<T>,
    audience: &str,
    path: &str,
    now: i64,
) -> Result<(), &'static str> {
    if request.signed_at < now.saturating_sub(SIGNATURE_MAX_AGE_SECONDS)
        || request.signed_at > now.saturating_add(SIGNATURE_MAX_FUTURE_SECONDS)
    {
        return Err("signature_expired");
    }
    let public_key: [u8; 32] = hex::decode(&request.public_key)
        .map_err(|_| "invalid_signature")?
        .try_into()
        .map_err(|_| "invalid_signature")?;
    let signature: [u8; 64] = hex::decode(&request.signature)
        .map_err(|_| "invalid_signature")?
        .try_into()
        .map_err(|_| "invalid_signature")?;
    if request.public_key != hex::encode(public_key) {
        return Err("invalid_signature");
    }
    let key = VerifyingKey::from_bytes(&public_key).map_err(|_| "invalid_signature")?;
    let message = signing_bytes(audience, path, request.signed_at, &request.payload)
        .map_err(|_| "invalid_signature")?;
    key.verify_strict(&message, &Signature::from_bytes(&signature))
        .map_err(|_| "invalid_signature")
}

pub fn payload_hash<T: Serialize>(payload: &T) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(&serde_json::to_value(payload)?)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    OwnedFixture,
    Hermes,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceIntroduction {
    pub label: String,
    pub runtime: RuntimeKind,
    pub runtime_version: String,
    pub declared_model: Option<String>,
    /// Operator-declared grouping for shared compute. It is not hardware attestation.
    pub compute_group: String,
    pub slots: u16,
}

impl DeviceIntroduction {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.label, &self.runtime_version, &self.compute_group] {
            if value.trim().is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
                return Err("invalid_device_details");
            }
        }
        if self
            .declared_model
            .as_ref()
            .is_some_and(|m| m.is_empty() || m.len() > 160 || m.chars().any(char::is_control))
        {
            return Err("invalid_model_declaration");
        }
        if self.slots != 1 {
            return Err("pilot_supports_one_slot_per_device");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PairingStarted {
    pub pairing_id: Uuid,
    pub user_code: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PairingStatusInput {
    pub pairing_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PairingStatus {
    pub state: String,
    pub device_id: Option<Uuid>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimPairing {
    pub user_code: String,
    pub display_name: String,
    pub hosting: String,
    pub accepts_private_work_rules: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    pub sequence: u64,
    pub paused: bool,
    pub running: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HeartbeatReply {
    pub state: String,
    pub sequence: u64,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeviceView {
    pub id: Uuid,
    pub operator_id: Uuid,
    pub operator_name: String,
    pub label: String,
    pub runtime: RuntimeKind,
    pub runtime_version: String,
    pub declared_model: Option<String>,
    pub compute_group: String,
    pub approval: String,
    pub state: String,
    pub last_seen_at: Option<i64>,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceDecision {
    pub action: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FleetSummary {
    pub online_devices: i64,
    pub online_operators: i64,
    pub online_compute_groups: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_bind_every_request_boundary_and_reject_old_proofs() {
        // A deterministic synthetic key for a local protocol test, never a service key.
        let key = DeviceKey::from_bytes(&[17; 32]);
        let mut request = sign(
            &key,
            "deployment-a",
            "/heartbeat",
            1000,
            Heartbeat {
                sequence: 1,
                paused: false,
                running: 0,
            },
        )
        .unwrap();
        assert!(verify(&request, "deployment-a", "/heartbeat", 1000).is_ok());
        assert!(verify(&request, "deployment-b", "/heartbeat", 1000).is_err());
        assert!(verify(&request, "deployment-a", "/approve", 1000).is_err());
        assert!(verify(&request, "deployment-a", "/heartbeat", 1121).is_err());
        assert!(verify(&request, "deployment-a", "/heartbeat", 969).is_err());
        request.payload.sequence = 2;
        assert!(verify(&request, "deployment-a", "/heartbeat", 1000).is_err());
    }

    #[test]
    fn invalid_keys_and_signatures_are_errors_not_panics() {
        let request = SignedRequest {
            public_key: "invalid".into(),
            signed_at: 1,
            payload: (),
            signature: "invalid".into(),
        };
        assert_eq!(verify(&request, "a", "/b", 1), Err("invalid_signature"));
    }

    #[test]
    fn unknown_input_fields_are_rejected() {
        assert!(
            serde_json::from_value::<Heartbeat>(
                serde_json::json!({"sequence": 1, "paused": false, "running": 0, "admin": true})
            )
            .is_err()
        );
    }
}
