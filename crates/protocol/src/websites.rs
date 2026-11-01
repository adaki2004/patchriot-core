//! Saved website evidence. Text is untrusted content, never instructions or HTML
//! to render directly. A collected response is not a security verdict.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSiteCheck {
    pub request_id: Uuid,
    pub scope: WebsiteScope,
    pub authorized: bool,
    pub authority_note: String,
    /// Explicit permission to send this scope and note to JEV through OpenRouter.
    /// Older clients retain manual review without external screening.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub accepts_screening: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiteDecision {
    Approve,
    Reject,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DecideSiteCheck {
    pub action: SiteDecision,
    pub scope_sha256: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CancelSiteCheck {}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SiteCheckView {
    pub id: Uuid,
    pub request_id: Uuid,
    pub requester_id: Uuid,
    pub scope: WebsiteScope,
    pub scope_sha256: String,
    pub authority_note: String,
    pub state: String,
    pub created_at: i64,
    pub deadline_at: i64,
    pub decided_by: Option<Uuid>,
    pub decision_note: Option<String>,
    pub attempts: i32,
    pub error: Option<String>,
    pub summary: Option<WebsiteSummary>,
    pub evidence_available: bool,
    pub evidence_expires_at: Option<i64>,
    #[serde(default = "screening_not_requested")]
    pub screening_state: String,
    #[serde(default)]
    pub screening: Option<RequestScreening>,
}

fn screening_not_requested() -> String {
    "not_requested".into()
}

/// Advisory request classification. None of these fields grants permission,
/// expands scope, confirms ownership or establishes that a target is safe.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RequestScreening {
    pub policy_version: String,
    pub input_sha256: String,
    pub rubric_sha256: String,
    pub model: String,
    pub evaluated_at: i64,
    pub assessment: ScreeningAssessment,
    pub within_scope: f64,
    pub bypass_attempt: f64,
    pub harmful_intent: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScreeningAssessment {
    Routine,
    Review,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteSummary {
    pub homepage_sha256: String,
    pub external_scripts: u16,
    pub inline_scripts: u16,
    pub skipped_scripts: u16,
    pub script_limit_reached: bool,
    pub captured_response_bytes: u64,
    pub requests_made: u16,
    pub finished_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WebsiteScope {
    pub homepage: String,
    /// Exact additional HTTPS origins from which referenced scripts may be read.
    pub script_origins: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Homepage,
    ExternalScript,
    InlineScript,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WebsiteResource {
    pub kind: ResourceKind,
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
    pub content_type: String,
    /// Selected response headers. Repeated values are separated by newlines;
    /// cookies and authorization are omitted.
    pub headers: BTreeMap<String, String>,
    pub text: String,
    pub collected_at: i64,
    pub connected_ip: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptStatus {
    Collected,
    Skipped,
    DataOnly,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ScriptReference {
    pub index: u16,
    /// Normalized URL when valid; otherwise a bounded copy of the HTML attribute.
    /// Display as text, not an automatically trusted link.
    pub src: Option<String>,
    pub integrity: Option<String>,
    pub type_hint: Option<String>,
    pub status: ScriptStatus,
    pub artifact_sha256: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WebsiteSnapshot {
    pub schema_version: u8,
    pub scope: WebsiteScope,
    pub homepage: WebsiteResource,
    pub resources: Vec<WebsiteResource>,
    pub scripts: Vec<ScriptReference>,
    pub script_limit_reached: bool,
    pub requests_made: u16,
    /// Saved HTTP body bytes, excluding the inline snippets copied from HTML.
    /// This is not a measurement of network traffic or discarded responses.
    pub captured_response_bytes: u64,
    pub started_at: i64,
    pub finished_at: i64,
}

/// Differences between two retained captures of the same approved scope. This
/// describes saved bytes and selected headers, not live behavior or site safety.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteComparison {
    pub baseline_id: Uuid,
    pub current_id: Uuid,
    pub baseline_finished_at: i64,
    pub current_finished_at: i64,
    pub resources: Vec<ResourceComparison>,
    pub script_references_changed: bool,
    pub baseline_coverage: ComparisonCoverage,
    pub current_coverage: ComparisonCoverage,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ComparisonCoverage {
    pub captured_scripts: u16,
    pub skipped_scripts: u16,
    pub data_only_scripts: u16,
    pub script_limit_reached: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceChange {
    Unchanged,
    Changed,
    /// Absence from a capture does not establish addition or removal on a site.
    OnlyEarlier,
    OnlyLater,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ResourceComparison {
    pub kind: ResourceKind,
    /// Inline scripts match by their position in the HTML, not a stable identity.
    pub url: String,
    pub change: ResourceChange,
    pub before: Option<ResourceFingerprint>,
    pub after: Option<ResourceFingerprint>,
}

/// Intentionally excludes response bodies, IPs and collection times. A different
/// timestamp or CDN address alone is not reported as a content change.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ResourceFingerprint {
    pub sha256: String,
    pub bytes: u64,
    pub content_type: String,
    pub headers: BTreeMap<String, String>,
}
