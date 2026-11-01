//! Bounded private source snapshots. Uploaded names are labels, never filesystem
//! destinations. Source text is data; no archive, install hook or build is run.

use crate::{
    ReviewRole,
    website_reviews::{WebsiteAssessment, WebsiteExecution, WebsiteReviewer, WebsiteRunState},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

pub const MAX_SOURCE_FILES: usize = 12;
pub const MAX_SOURCE_FILE_BYTES: usize = 16 * 1024;
pub const MAX_SOURCE_BYTES: usize = 48 * 1024;
pub const MAX_SOURCE_BODY_BYTES: usize = 384 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInputFile {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSourceUpload {
    pub request_id: Uuid,
    pub title: String,
    pub objective: String,
    pub permission_note: String,
    pub accepts_private_storage: bool,
    pub files: Vec<SourceInputFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceBundle {
    pub schema_version: u8,
    pub objective: String,
    pub files: Vec<SourceFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceFileInfo {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceUploadView {
    pub id: Uuid,
    pub request_id: Uuid,
    pub title: String,
    pub objective: String,
    pub permission_note: String,
    pub state: String,
    pub bundle_sha256: String,
    pub files: Vec<SourceFileInfo>,
    pub created_at: i64,
    pub expires_at: i64,
    pub decision_note: Option<String>,
    pub can_delete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DecideSourceUpload {
    pub approve: bool,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceReviewPlan {
    pub review_timeout_seconds: u64,
    pub source_id: Uuid,
    pub snapshot_sha256: String,
    pub candidates: Vec<WebsiteReviewer>,
    pub recommended_device_ids: Vec<Uuid>,
}

// The consent and price fields have the same meaning for either kind of saved
// material. Its authenticated endpoint binds the kind; a client cannot change it.
pub type CreateSourceReview = crate::website_reviews::CreateWebsiteReview;
pub type AdmitSourceReview = crate::website_reviews::AdmitWebsiteReview;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceReviewContext {
    pub source_id: Uuid,
    pub snapshot_sha256: String,
    pub reviewers: Vec<WebsiteReviewer>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceAssignment {
    pub source_id: Uuid,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PriorSourceReport {
    pub role: ReviewRole,
    pub evidence_complete: bool,
    pub assessment: Option<WebsiteAssessment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SourceWorkEvidence {
    pub bundle: SourceBundle,
    pub previous_reports: Vec<PriorSourceReport>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceResultKind {
    SourceAgentV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceAgentResult {
    pub kind: SourceResultKind,
    pub execution: WebsiteExecution,
    pub snapshot_sha256: String,
    pub inspected_snapshot_sha256: Option<String>,
    pub assessment: Option<WebsiteAssessment>,
    pub raw_summary: String,
}

fn text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value.chars().any(|c| {
            (c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
                || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

pub fn safe_source_path(path: &str) -> bool {
    if path.len() > 160
        || path.is_empty()
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
    {
        return false;
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.') || part.len() > 80)
    {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower.split('/').any(|p| {
        matches!(
            p,
            "node_modules"
                | "vendor"
                | "target"
                | "credentials"
                | "secrets"
                | "id_rsa"
                | "id_ed25519"
        ) || p.starts_with("secrets.")
            || p.starts_with("credentials.")
    }) {
        return false;
    }
    lower.rsplit('.').next().is_some_and(|ext| {
        matches!(
            ext,
            "rs" | "py"
                | "js"
                | "ts"
                | "jsx"
                | "tsx"
                | "sol"
                | "go"
                | "java"
                | "c"
                | "h"
                | "cpp"
                | "cs"
                | "rb"
                | "php"
                | "vue"
                | "svelte"
                | "html"
                | "css"
                | "json"
                | "toml"
                | "yaml"
                | "yml"
                | "md"
                | "txt"
                | "sh"
        )
    })
}

/// A conservative accidental-secret check, not a promise that source is clean.
/// Callers must still remove credentials before uploading.
pub fn likely_secret(value: &str) -> bool {
    value.contains("PRIVATE KEY-----")
        || value.contains("BEGIN PGP PRIVATE")
        || [
            "ghp_",
            "github_pat_",
            "sk-proj-",
            "sk-ant-",
            "AKIA",
            "xoxb-",
        ]
        .iter()
        .any(|prefix| {
            value.match_indices(prefix).any(|(at, _)| {
                value[at + prefix.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    .count()
                    >= 20
            })
        })
}

impl CreateSourceUpload {
    pub fn bundle(&self) -> Result<SourceBundle, &'static str> {
        if self.request_id.is_nil()
            || !self.accepts_private_storage
            || !text(&self.title, 120)
            || self.title.chars().any(char::is_control)
            || !text(&self.objective, 1200)
            || !text(&self.permission_note, 1500)
        {
            return Err("invalid_source_request");
        }
        if !(1..=MAX_SOURCE_FILES).contains(&self.files.len()) {
            return Err("source_file_count");
        }
        let mut names = HashSet::new();
        let mut bytes = 0;
        let mut files = Vec::new();
        if likely_secret(&self.objective)
            || likely_secret(&self.permission_note)
            || likely_secret(&self.title)
        {
            return Err("source_may_contain_secret");
        }
        for file in &self.files {
            if !safe_source_path(&file.path) || !names.insert(file.path.to_ascii_lowercase()) {
                return Err("invalid_source_path");
            }
            if !text(&file.text, MAX_SOURCE_FILE_BYTES) {
                return Err("invalid_source_text");
            }
            if likely_secret(&file.text) {
                return Err("source_may_contain_secret");
            }
            bytes += file.text.len();
            if bytes > MAX_SOURCE_BYTES {
                return Err("source_too_large");
            }
            files.push(SourceFile {
                path: file.path.clone(),
                text: file.text.clone(),
                sha256: format!("{:x}", Sha256::digest(file.text.as_bytes())),
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(SourceBundle {
            schema_version: 1,
            objective: self.objective.clone(),
            files,
        })
    }
}

impl SourceBundle {
    pub fn manifest(&self) -> Vec<SourceFileInfo> {
        self.files
            .iter()
            .map(|f| SourceFileInfo {
                path: f.path.clone(),
                bytes: f.text.len(),
                sha256: f.sha256.clone(),
            })
            .collect()
    }

    pub fn valid(&self) -> bool {
        let input = CreateSourceUpload {
            request_id: Uuid::from_u128(1),
            title: "Bundle validation".into(),
            objective: self.objective.clone(),
            permission_note: "Stored material".into(),
            accepts_private_storage: true,
            files: self
                .files
                .iter()
                .map(|f| SourceInputFile {
                    path: f.path.clone(),
                    text: f.text.clone(),
                })
                .collect(),
        };
        self.schema_version == 1
            && input.bundle().is_ok_and(|canonical| {
                serde_json::to_value(canonical).ok() == serde_json::to_value(self).ok()
            })
    }
}

pub fn bundle_hash(bundle: &SourceBundle) -> Result<String, serde_json::Error> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(bundle)?)))
}

impl SourceAgentResult {
    pub fn valid(&self) -> bool {
        // The execution/citation limits are shared; source results retain their
        // own mandatory kind and can never be mistaken for website evidence.
        crate::website_reviews::WebsiteAgentResult {
            kind: crate::website_reviews::WebsiteResultKind::WebsiteAgentV1,
            execution: self.execution.clone(),
            snapshot_sha256: self.snapshot_sha256.clone(),
            inspected_snapshot_sha256: self.inspected_snapshot_sha256.clone(),
            assessment: self.assessment.clone(),
            raw_summary: self.raw_summary.clone(),
        }
        .valid()
    }

    pub fn evidence_complete(&self, bundle: &SourceBundle) -> bool {
        self.valid()
            && bundle.valid()
            && bundle_hash(bundle).is_ok_and(|hash| hash == self.snapshot_sha256)
            && self.inspected_snapshot_sha256.as_deref() == Some(&self.snapshot_sha256)
            && self.execution.state == WebsiteRunState::Completed
            && self.execution.cleanup_confirmed
            && self.execution.inference_calls > 0
            && self.execution.terminal_calls > 0
            && self.assessment.as_ref().is_some_and(|a| {
                a.findings.iter().all(|f| {
                    f.citations.iter().all(|c| {
                        bundle.files.iter().any(|file| {
                            file.sha256 == c.resource_sha256 && file.text.contains(&c.quote)
                        })
                    })
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> CreateSourceUpload {
        CreateSourceUpload {
            request_id: Uuid::new_v4(),
            title: "Owned example".into(),
            objective: "Check access rules.".into(),
            permission_note: "I wrote this example.".into(),
            accepts_private_storage: true,
            files: vec![SourceInputFile {
                path: "src/main.rs".into(),
                text: "fn main() {}".into(),
            }],
        }
    }
    #[test]
    fn names_are_labels_and_unsafe_or_ambiguous_inputs_fail() {
        for path in [
            "../a.rs",
            "/a.rs",
            "a//b.rs",
            "a/./b.rs",
            "a\\b.rs",
            ".env",
            "a.zip",
            "a.PEM",
            "secrets.json",
            "node_modules/a.js",
            "target/b.rs",
            "a\0.rs",
            "a/",
            "a.rs:evil",
            "é.rs",
        ] {
            let mut upload = input();
            upload.files[0].path = path.into();
            assert!(upload.bundle().is_err(), "{path}");
        }
        let mut upload = input();
        upload.files.push(SourceInputFile {
            path: "SRC/main.rs".into(),
            text: "other".into(),
        });
        assert!(upload.bundle().is_err());
        let mut upload = input();
        upload.files[0].text = "\0binary".into();
        assert!(upload.bundle().is_err());
        upload.files[0].text = "hidden\u{202e}control".into();
        assert!(upload.bundle().is_err());
        upload.files[0].text = format!("{}PRIVATE KEY-----", "-----BEGIN ");
        assert!(upload.bundle().is_err());
        upload.files[0].text = format!("{}{}", "ghp_", "x".repeat(40));
        assert!(upload.bundle().is_err());
    }
    #[test]
    fn byte_count_file_count_and_digest_are_enforced_without_running_code() {
        let mut upload = input();
        upload.files[0].text = "é".repeat(MAX_SOURCE_FILE_BYTES / 2);
        assert!(upload.bundle().is_ok());
        upload.files[0].text.push('x');
        assert!(upload.bundle().is_err());
        upload.files = (0..4)
            .map(|n| SourceInputFile {
                path: format!("{n}.rs"),
                text: "x".repeat(MAX_SOURCE_FILE_BYTES),
            })
            .collect();
        assert!(upload.bundle().is_err());
        upload.files = (0..13)
            .map(|n| SourceInputFile {
                path: format!("{n}.sh"),
                text: "exit 1".into(),
            })
            .collect();
        assert!(upload.bundle().is_err());
        let mut bundle = input().bundle().unwrap();
        assert!(bundle.valid());
        let before = bundle_hash(&bundle).unwrap();
        bundle.files[0].text.push('!');
        assert!(!bundle.valid());
        assert_ne!(before, bundle_hash(&bundle).unwrap());
    }
}
