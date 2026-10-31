//! Private, offline review of a saved website snapshot. Findings remain agent
//! claims: matching a citation is not proof that a vulnerability is exploitable.

use crate::{ReviewRole, websites::WebsiteSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WebsiteReviewer {
    pub device_id: Uuid,
    pub operator_id: Uuid,
    pub operator_name: String,
    pub device_name: String,
    pub declared_model: String,
    pub compute_group: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteReviewPlan {
    pub site_check_id: Uuid,
    pub snapshot_sha256: String,
    pub candidates: Vec<WebsiteReviewer>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateWebsiteReview {
    pub request_id: Uuid,
    pub snapshot_sha256: String,
    /// Ordered: investigator, reproducer, challenger. No replacement or broader
    /// operator pool is authorized by this consent.
    pub device_ids: Vec<Uuid>,
    pub accepts_operator_access: bool,
}

/// A service price chosen by core. Amounts are positive smallest-unit integers,
/// encoded as decimal strings so browser clients cannot round them.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewPrice {
    pub asset: String,
    pub amount: String,
}

impl ReviewPrice {
    pub fn valid(&self) -> bool {
        !self.asset.is_empty()
            && self.asset.len() <= 256
            && !self
                .asset
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            && !self.amount.is_empty()
            && self.amount.len() <= 19
            && !self.amount.starts_with('0')
            && self.amount.bytes().all(|b| b.is_ascii_digit())
            && self.amount.parse::<i64>().is_ok_and(|value| value > 0)
    }
}

/// Internal core → dispatcher admission. Core records the requester's consent
/// and supplies the price; a browser cannot choose its own payment requirement.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdmitWebsiteReview {
    pub consent: CreateWebsiteReview,
    pub price: ReviewPrice,
    pub payment_expires_at: i64,
}

/// Core sends this only after recording a verified provider settlement. The
/// dispatcher trusts authenticated core, not a wallet hash or agent assertion.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FundReview {
    pub request_id: Uuid,
    pub invoice_id: Uuid,
    pub price: ReviewPrice,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReviewPayment {
    pub price: ReviewPrice,
    pub expires_at: i64,
    pub invoice_id: Option<Uuid>,
    pub funded_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteReviewContext {
    pub site_check_id: Uuid,
    pub snapshot_sha256: String,
    pub reviewers: Vec<WebsiteReviewer>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteAssignment {
    pub site_check_id: Uuid,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReadWorkEvidence {
    pub lease_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PriorWebsiteReport {
    pub role: ReviewRole,
    pub evidence_complete: bool,
    pub assessment: Option<WebsiteAssessment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebsiteWorkEvidence {
    pub snapshot: WebsiteSnapshot,
    pub previous_reports: Vec<PriorWebsiteReport>,
}

pub fn snapshot_hash(snapshot: &WebsiteSnapshot) -> Result<String, serde_json::Error> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(snapshot)?)
    ))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebsiteResultKind {
    WebsiteAgentV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebsiteRunState {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteExecution {
    pub state: WebsiteRunState,
    pub declared_model: String,
    pub model: String,
    pub model_digest: String,
    pub image_digest: String,
    pub duration_ms: u64,
    pub inference_calls: u16,
    pub terminal_calls: u16,
    pub cleanup_confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteAgentResult {
    pub kind: WebsiteResultKind,
    pub execution: WebsiteExecution,
    pub snapshot_sha256: String,
    /// Digest observed by the fixed evidence-inspection tool, not model prose.
    pub inspected_snapshot_sha256: Option<String>,
    pub assessment: Option<WebsiteAssessment>,
    /// Bounded model output is kept when it cannot be parsed as an assessment.
    pub raw_summary: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteAssessment {
    pub summary: String,
    pub findings: Vec<WebsiteFinding>,
    pub limitations: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingSupport {
    /// A statement about the saved text, not a verified exploit or live behavior.
    ObservedInSnapshot,
    NeedsLiveTest,
    NotSupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteFinding {
    pub title: String,
    pub support: FindingSupport,
    pub explanation: String,
    pub suggested_action: String,
    pub citations: Vec<WebsiteCitation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WebsiteCitation {
    pub resource_sha256: String,
    /// An exact, non-empty excerpt from the saved body or one selected header.
    pub quote: String,
}

fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
}

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

impl WebsiteAgentResult {
    pub fn valid(&self) -> bool {
        let run = &self.execution;
        text(&run.declared_model, 160)
            && text(&run.model, 160)
            && digest(&run.model_digest)
            && run.image_digest.strip_prefix("sha256:").is_some_and(digest)
            && digest(&self.snapshot_sha256)
            && self.inspected_snapshot_sha256.as_deref().is_none_or(digest)
            && run.duration_ms <= 660_000
            && run.inference_calls <= 4
            && run.terminal_calls <= 16
            && (self.raw_summary.is_empty() || text(&self.raw_summary, 4000))
            && self
                .assessment
                .as_ref()
                .is_none_or(WebsiteAssessment::valid)
    }

    /// Checks provenance fields, execution evidence and citations. It deliberately
    /// does not decide whether the model's security reasoning or proposed fix is right.
    pub fn evidence_complete(&self, snapshot: &WebsiteSnapshot) -> bool {
        self.valid()
            && snapshot_hash(snapshot).is_ok_and(|hash| hash == self.snapshot_sha256)
            && self.inspected_snapshot_sha256.as_deref() == Some(&self.snapshot_sha256)
            && self.execution.state == WebsiteRunState::Completed
            && self.execution.cleanup_confirmed
            && self.execution.inference_calls > 0
            && self.execution.terminal_calls > 0
            && self.assessment.as_ref().is_some_and(|assessment| {
                assessment.findings.iter().all(|finding| {
                    finding.citations.iter().all(|citation| {
                        std::iter::once(&snapshot.homepage)
                            .chain(&snapshot.resources)
                            .any(|resource| {
                                resource.sha256 == citation.resource_sha256
                                    && (resource.text.contains(&citation.quote)
                                        || resource
                                            .headers
                                            .values()
                                            .any(|header| header.contains(&citation.quote)))
                            })
                    })
                })
            })
    }
}

impl WebsiteAssessment {
    pub fn valid(&self) -> bool {
        text(&self.summary, 1200)
            && self.findings.len() <= 3
            && (1..=5).contains(&self.limitations.len())
            && self.limitations.iter().all(|value| text(value, 500))
            && self.findings.iter().all(|finding| {
                text(&finding.title, 160)
                    && text(&finding.explanation, 1200)
                    && text(&finding.suggested_action, 800)
                    && (1..=3).contains(&finding.citations.len())
                    && finding.citations.iter().all(|citation| {
                        digest(&citation.resource_sha256) && text(&citation.quote, 300)
                    })
            })
    }
}

#[cfg(test)]
mod tests {
    use crate::{DeviceKey, WorkPoll, WorkResult, sign, verify};
    use serde_json::json;

    #[test]
    fn an_old_signed_poll_stays_identical_and_cannot_opt_in() {
        let old = json!({"sequence":7});
        let parsed: WorkPoll = serde_json::from_value(old.clone()).unwrap();
        assert!(!parsed.website_reviews);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), old);
        let key = DeviceKey::from_bytes(&[18; 32]);
        let signed = sign(&key, "test", "/work/poll", 100, old).unwrap();
        let decoded: crate::SignedRequest<WorkPoll> =
            serde_json::from_value(serde_json::to_value(signed).unwrap()).unwrap();
        assert!(verify(&decoded, "test", "/work/poll", 100).is_ok());
        let mut changed = decoded;
        changed.payload.website_reviews = true;
        assert!(verify(&changed, "test", "/work/poll", 100).is_err());
    }

    #[test]
    fn website_prose_cannot_parse_as_fixture_evidence() {
        let encoded = json!({"kind":"website_agent_v1", "execution":{"state":"completed", "declared_model":"local", "model":"local", "model_digest":"a".repeat(64), "image_digest":format!("sha256:{}", "b".repeat(64)), "duration_ms":1000, "inference_calls":1, "terminal_calls":0, "cleanup_confirmed":true}, "snapshot_sha256":"c".repeat(64), "inspected_snapshot_sha256":null, "assessment":null, "raw_summary":"Everything looks safe (unsubstantiated model prose)."});
        let result: WorkResult = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(result.mode(), crate::ReviewMode::WebsiteAgent);
        assert!(!result.matches_fixture());
        let WorkResult::Website(result) = result else {
            panic!("wrong result variant");
        };
        assert!(result.valid());
        let mut unknown = encoded;
        unknown["passed"] = json!(true);
        assert!(serde_json::from_value::<WorkResult>(unknown).is_err());
    }
}
