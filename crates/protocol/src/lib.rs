//! Shared wire types, licensed separately under Apache-2.0.
//!
//! Signatures bind a device's key to the deployment audience, HTTP path and typed
//! payload. TLS is still required. Writes enforce replay rules in persistent state:
//! pairing codes can be claimed once; heartbeat sequences cannot move backwards.
//! A recent signature alone does not make an operation idempotent or authorized.

pub mod pentests;
pub mod sources;
pub mod website_reviews;
pub mod websites;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub use ed25519_dalek::SigningKey as DeviceKey;

pub const PAIRING_START_PATH: &str = "/v1/pairings/start";
pub const PAIRING_STATUS_PATH: &str = "/v1/pairings/status";
pub const SIGNATURE_MAX_AGE_SECONDS: i64 = 120;
pub const SIGNATURE_MAX_FUTURE_SECONDS: i64 = 30;

/// Both deployment and operator limits are explicit. Renewal cannot extend a
/// saved attempt, and the relay reserves one minute for cleanup/reporting.
pub const DEFAULT_AGENT_ATTEMPT_SECONDS: u64 = 600;
pub const MAX_AGENT_ATTEMPT_SECONDS: u64 = 1800;
pub const AGENT_CLEANUP_SECONDS: u64 = 60;
pub const MAX_AGENT_RESULT_DURATION_MS: u64 = (MAX_AGENT_ATTEMPT_SECONDS + 60) * 1000;

pub fn default_agent_attempt_seconds() -> u64 {
    DEFAULT_AGENT_ATTEMPT_SECONDS
}

pub fn agent_review_seconds(attempt_seconds: u64) -> u64 {
    attempt_seconds.saturating_mul(3).saturating_add(300)
}

pub fn default_agent_review_seconds() -> u64 {
    agent_review_seconds(DEFAULT_AGENT_ATTEMPT_SECONDS)
}

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
    /// Reported by the relay at initialization, not a machine attestation.
    /// Omission preserves signatures and saved identities from older relays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_os: Option<String>,
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
        if self.reported_os.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 32
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b == b'_' || b == b'-')
        }) {
            return Err("invalid_os_declaration");
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_os: Option<String>,
    pub compute_group: String,
    pub approval: String,
    #[serde(default)]
    pub private_work_approved: bool,
    #[serde(default)]
    pub website_reviews: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub live_tests: bool,
    pub state: String,
    pub last_seen_at: Option<i64>,
    pub sequence: u64,
    /// Received role reports, including incomplete evidence. Not verified
    /// findings or earnings. Older dispatchers/decision replies may omit this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports_received: Option<u64>,
}

/// Only these fields are shared with other admitted accounts. Keep operator
/// profiles, machine labels, keys and customer assignments out of this type.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentSummary {
    pub id: Uuid,
    pub reported_os: Option<String>,
    pub runtime: RuntimeKind,
    pub runtime_version: String,
    pub declared_model: Option<String>,
    pub state: String,
    pub last_seen_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PairingDeployment {
    pub audience: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceDecision {
    pub action: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FleetSummary {
    #[serde(default = "default_agent_review_seconds")]
    pub agent_review_timeout_seconds: u64,
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
    #[serde(default, skip_serializing_if = "ReviewMode::is_fixture")]
    pub mode: ReviewMode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewMode {
    #[default]
    OwnedFixture,
    OwnedAgent,
    WebsiteAgent,
    SourceAgent,
    PentestAgent,
}

impl ReviewMode {
    pub fn is_fixture(&self) -> bool {
        *self == Self::OwnedFixture
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnedFixture => "owned_fixture",
            Self::OwnedAgent => "owned_agent",
            Self::WebsiteAgent => "website_agent",
            Self::SourceAgent => "source_agent",
            Self::PentestAgent => "pentest_agent",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FixtureScenario {
    AccessControlV1,
    WebsiteSnapshotV1,
    SourceBundleV1,
    LiveHttpV1,
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
    /// Explicit opt-in to website_snapshot_v1. Omission keeps old signed payloads
    /// unchanged and cannot grant access to customer evidence.
    #[serde(default, skip_serializing_if = "is_false")]
    pub website_reviews: bool,
    /// Source uploads require a distinct signed opt-in. Website consent cannot
    /// authorize source delivery, including after an old relay restarts.
    #[serde(default, skip_serializing_if = "is_false")]
    pub source_reviews: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub live_tests: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkAssignment {
    pub lease_id: Uuid,
    pub review_id: Uuid,
    pub role: ReviewRole,
    pub scenario: FixtureScenario,
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "ReviewMode::is_fixture")]
    pub mode: ReviewMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<website_reviews::WebsiteAssignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<sources::SourceAssignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pentest: Option<pentests::PentestAssignment>,
}

/// A fresh sequence renews only the current, still-live lease. Retrying the same
/// sequence reads its existing expiry; it cannot add execution time.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenewWork {
    pub lease_id: Uuid,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<pentests::LiveProgress>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkRenewed {
    pub lease_id: Uuid,
    pub sequence: u64,
    pub expires_at: i64,
    pub deadline_at: i64,
    /// Remaining lifetime measured by the server, rounded down. The client uses
    /// a monotonic clock starting BEFORE this request and stops before it expires.
    pub valid_for_seconds: u64,
    pub replayed: bool,
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
    pub result: WorkResult,
}

/// Untagged only to preserve the original fixture wire format. Both variants
/// reject unknown fields; agent evidence has its own mandatory version marker.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum WorkResult {
    Fixture(FixtureResult),
    Agent(AgentResult),
    Website(website_reviews::WebsiteAgentResult),
    Source(sources::SourceAgentResult),
    Pentest(pentests::PentestResult),
}

impl WorkResult {
    pub fn mode(&self) -> ReviewMode {
        match self {
            Self::Fixture(_) => ReviewMode::OwnedFixture,
            Self::Agent(_) => ReviewMode::OwnedAgent,
            Self::Website(_) => ReviewMode::WebsiteAgent,
            Self::Source(_) => ReviewMode::SourceAgent,
            Self::Pentest(_) => ReviewMode::PentestAgent,
        }
    }

    pub fn matches_fixture(&self) -> bool {
        match self {
            Self::Fixture(result) => result.matches_fixture(),
            Self::Agent(result) => result.matches_fixture(),
            Self::Website(_) | Self::Source(_) | Self::Pentest(_) => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentResultKind {
    OwnedAgentV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentOutcome {
    Passed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentFixtureCheck {
    pub owner_reads: bool,
    pub blocks_other_user: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentFixtureObservation {
    pub original: AgentFixtureCheck,
    pub patched: AgentFixtureCheck,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentResult {
    pub kind: AgentResultKind,
    pub outcome: AgentOutcome,
    pub declared_model: String,
    pub model: String,
    pub model_digest: String,
    pub image_digest: String,
    pub duration_ms: u64,
    pub inference_calls: u16,
    pub terminal_calls: u16,
    pub cleanup_confirmed: bool,
    /// Parsed from a terminal tool result, never inferred from model prose.
    pub observation: Option<AgentFixtureObservation>,
    pub summary: String,
}

impl AgentResult {
    pub fn valid(&self) -> bool {
        fn label(value: &str) -> bool {
            !value.trim().is_empty() && value.len() <= 160 && !value.chars().any(char::is_control)
        }
        fn digest(value: &str) -> bool {
            value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
        }
        label(&self.declared_model)
            && label(&self.model)
            && digest(&self.model_digest)
            && self
                .image_digest
                .strip_prefix("sha256:")
                .is_some_and(digest)
            && self.duration_ms <= MAX_AGENT_RESULT_DURATION_MS
            && self.inference_calls <= 4
            && self.terminal_calls <= 16
            && self.summary.len() <= 4_000
            && !self
                .summary
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
    }

    /// These are operator-reported observations of our known example, not an
    /// attestation of model identity or an independent security verdict.
    pub fn matches_fixture(&self) -> bool {
        self.valid()
            && self.outcome == AgentOutcome::Passed
            && self.cleanup_confirmed
            && self.inference_calls > 0
            && self.terminal_calls > 0
            && self.observation.as_ref().is_some_and(|evidence| {
                evidence.original.owner_reads
                    && !evidence.original.blocks_other_user
                    && evidence.patched.owner_reads
                    && evidence.patched.blocks_other_user
            })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkAccepted {
    pub accepted: bool,
    pub replayed: bool,
    pub fixture_matches: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_complete: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviewStepView {
    pub role: ReviewRole,
    pub state: String,
    pub attempts: i32,
    pub device_id: Option<Uuid>,
    pub operator_id: Option<Uuid>,
    pub compute_group: Option<String>,
    pub result: Option<WorkResult>,
    pub fixture_matches: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<pentests::LiveProgressView>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<website_reviews::WebsiteReviewContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<sources::SourceReviewContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pentest: Option<pentests::PentestContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment: Option<website_reviews::ReviewPayment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CancelReview {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_device_introductions_keep_their_signed_bytes_and_new_os_is_bounded() {
        let old = serde_json::json!({"label":"legacy","runtime":"hermes","runtime_version":"1","declared_model":"local","compute_group":"machine","slots":1});
        let mut intro: DeviceIntroduction = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(serde_json::to_value(&intro).unwrap(), old);
        assert_eq!(
            signing_bytes("pilot", PAIRING_START_PATH, 1, &old).unwrap(),
            signing_bytes("pilot", PAIRING_START_PATH, 1, &intro).unwrap()
        );
        intro.reported_os = Some("linux".into());
        assert!(intro.validate().is_ok());
        assert_ne!(payload_hash(&intro).unwrap(), payload_hash(&old).unwrap());
        for invalid in ["", "linux\n", "https://my-host.example", "LINUX"] {
            intro.reported_os = Some(invalid.into());
            assert!(intro.validate().is_err());
        }
    }

    #[test]
    fn old_work_polls_keep_signed_bytes_and_each_private_opt_in_changes_the_signature() {
        for old in [
            serde_json::json!({"sequence":1}),
            serde_json::json!({"sequence":1,"website_reviews":true}),
        ] {
            let mut poll: WorkPoll = serde_json::from_value(old.clone()).unwrap();
            assert_eq!(
                signing_bytes("pilot", "/poll", 1, &old).unwrap(),
                signing_bytes("pilot", "/poll", 1, &poll).unwrap()
            );
            assert!(!poll.source_reviews);
            assert!(!poll.live_tests);
            poll.source_reviews = true;
            assert_ne!(payload_hash(&old).unwrap(), payload_hash(&poll).unwrap());
            poll.source_reviews = false;
            poll.live_tests = true;
            assert_ne!(payload_hash(&old).unwrap(), payload_hash(&poll).unwrap());
        }
    }

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
    fn existing_fixture_requests_and_outbox_keep_their_wire_format() {
        let id = Uuid::new_v4();
        let original = serde_json::json!({"request_id":id,"scenario":"access_control_v1"});
        let request: CreateReview = serde_json::from_value(original.clone()).unwrap();
        assert_eq!(request.mode, ReviewMode::OwnedFixture);
        assert_eq!(serde_json::to_value(request).unwrap(), original);
        let assignment = serde_json::json!({"lease_id":id,"review_id":id,"scenario":"access_control_v1","role":"investigator","expires_at":2000});
        let parsed: WorkAssignment = serde_json::from_value(assignment.clone()).unwrap();
        assert_eq!(parsed.mode, ReviewMode::OwnedFixture);
        assert_eq!(serde_json::to_value(parsed).unwrap(), assignment);
        let outbox = serde_json::json!({"lease_id":id,"result":{"runs":[]}});
        let parsed: CompleteWork = serde_json::from_value(outbox.clone()).unwrap();
        assert!(matches!(parsed.result, WorkResult::Fixture(_)));
        assert_eq!(serde_json::to_value(parsed).unwrap(), outbox);
        assert!(
            serde_json::from_value::<CompleteWork>(
                serde_json::json!({"lease_id":id,"result":{"runs":[],"kind":"owned_agent_v1"}})
            )
            .is_err()
        );
    }

    #[test]
    fn agent_evidence_needs_observed_checks_not_a_confident_answer() {
        let mut result = AgentResult {
            kind: AgentResultKind::OwnedAgentV1,
            outcome: AgentOutcome::Passed,
            declared_model: "local-model".into(),
            model: "local-profile".into(),
            model_digest: "a".repeat(64),
            image_digest: format!("sha256:{}", "b".repeat(64)),
            duration_ms: 500_000,
            inference_calls: 2,
            terminal_calls: 1,
            cleanup_confirmed: true,
            observation: None,
            summary: "The patch fixes the access-control problem.".into(),
        };
        assert!(result.valid());
        result.duration_ms = MAX_AGENT_RESULT_DURATION_MS;
        assert!(result.valid());
        result.duration_ms += 1;
        assert!(!result.valid());
        result.duration_ms = 500_000;
        assert!(!result.matches_fixture());
        result.observation = Some(AgentFixtureObservation {
            original: AgentFixtureCheck {
                owner_reads: true,
                blocks_other_user: false,
            },
            patched: AgentFixtureCheck {
                owner_reads: true,
                blocks_other_user: true,
            },
        });
        assert!(result.matches_fixture());
        result.terminal_calls = 0;
        assert!(!result.matches_fixture());
        result.terminal_calls = 1;
        result.cleanup_confirmed = false;
        assert!(!result.matches_fixture());
        result.cleanup_confirmed = true;
        result.outcome = AgentOutcome::TimedOut;
        assert!(!result.matches_fixture());
        result.outcome = AgentOutcome::Passed;
        result
            .observation
            .as_mut()
            .unwrap()
            .patched
            .blocks_other_user = false;
        assert!(!result.matches_fixture());
        result.summary = "x".repeat(4_001);
        assert!(!result.valid());
        result.summary.clear();
        result.model_digest = "not-a-digest".into();
        assert!(!result.valid());
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
