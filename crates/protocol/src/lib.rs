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

/// The first queued review executes only compiled-in, owned fixtures. It carries
/// no URL, source archive, shell command, credentials or model instructions.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateReview {
    pub request_id: Uuid,
    pub scenario: FixtureScenario,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixtureScenario {
    AccessControlV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewRole {
    Investigator,
    Reproducer,
    Challenger,
}

impl ReviewRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Investigator => "investigator",
            Self::Reproducer => "reproducer",
            Self::Challenger => "challenger",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkPoll {
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkAssignment {
    pub lease_id: Uuid,
    pub review_id: Uuid,
    pub role: ReviewRole,
    pub scenario: FixtureScenario,
    pub expires_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkReply {
    pub assignment: Option<WorkAssignment>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixtureVersion {
    Original,
    Patched,
    Clean,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FixtureCheck {
    pub name: String,
    pub expected: bool,
    pub actual: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FixtureRun {
    pub version: FixtureVersion,
    pub completed: bool,
    pub checks: Vec<FixtureCheck>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FixtureResult {
    pub runs: Vec<FixtureRun>,
}

impl FixtureResult {
    /// Validate the specific fixture regression, not a claim about an arbitrary
    /// target or proof that a remote operator really executed these checks.
    pub fn matches_fixture(&self) -> bool {
        self.runs.len() == 3
            && self
                .runs
                .iter()
                .zip([
                    FixtureVersion::Original,
                    FixtureVersion::Patched,
                    FixtureVersion::Clean,
                ])
                .all(|(run, version)| {
                    run.version == version
                        && run.completed
                        && run.elapsed_ms <= 5_000
                        && run.checks.len() == 3
                        && run
                            .checks
                            .iter()
                            .zip([
                                ("owner_can_read", true),
                                ("another_user_can_read", false),
                                ("anonymous_can_read", false),
                            ])
                            .all(|(check, (name, expected))| {
                                check.name == name
                                    && check.expected == expected
                                    && check.actual
                                        == (expected
                                            || (version == FixtureVersion::Original
                                                && name == "another_user_can_read"))
                            })
                })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteWork {
    pub lease_id: Uuid,
    pub result: FixtureResult,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkAccepted {
    pub accepted: bool,
    pub replayed: bool,
    pub fixture_matches: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviewStepView {
    pub role: ReviewRole,
    pub state: String,
    pub attempts: i32,
    pub device_id: Option<Uuid>,
    pub operator_id: Option<Uuid>,
    pub compute_group: Option<String>,
    pub result: Option<FixtureResult>,
    pub fixture_matches: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviewView {
    pub id: Uuid,
    pub request_id: Uuid,
    pub scenario: FixtureScenario,
    pub mode: String,
    pub state: String,
    pub created_at: i64,
    pub deadline_at: i64,
    pub evidence_source: String,
    pub steps: Vec<ReviewStepView>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CancelReview {}

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

    #[test]
    fn fixture_verdict_requires_the_original_failure_and_both_passing_controls() {
        let mut result = FixtureResult {
            runs: [
                FixtureVersion::Original,
                FixtureVersion::Patched,
                FixtureVersion::Clean,
            ]
            .into_iter()
            .map(|version| FixtureRun {
                version,
                completed: true,
                elapsed_ms: 10,
                checks: [
                    ("owner_can_read", true),
                    ("another_user_can_read", false),
                    ("anonymous_can_read", false),
                ]
                .into_iter()
                .map(|(name, expected)| FixtureCheck {
                    name: name.into(),
                    expected,
                    actual: expected
                        || (version == FixtureVersion::Original && name == "another_user_can_read"),
                })
                .collect(),
            })
            .collect(),
        };
        assert!(result.matches_fixture());
        result.runs[0].checks[1].actual = false;
        assert!(
            !result.matches_fixture(),
            "a passing original is not a reproduced flaw"
        );
        result.runs[0].checks[1].actual = true;
        result.runs[1].checks[1].actual = true;
        assert!(!result.matches_fixture(), "the patch must close the flaw");
        result.runs[1].checks[1].actual = false;
        result.runs[2].completed = false;
        assert!(
            !result.matches_fixture(),
            "a failed control cannot be accepted"
        );
        result.runs[2].completed = true;
        result.runs.swap(0, 1);
        assert!(
            !result.matches_fixture(),
            "results must bind the expected versions"
        );
    }
}
