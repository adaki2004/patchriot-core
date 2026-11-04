//! Small work receipts survive deletion of private findings. They describe
//! accepted operator reports, not independent proof that a target is safe.
use crate::{WorkResult, website_reviews::WebsiteRunState};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReportRetention {
    /// First requester-initiated export accepted by the server, not proof that
    /// the browser saved a file. Further exports never extend this deadline.
    pub first_downloaded_at: i64,
    pub expires_at: i64,
    pub content_deleted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkReceipt {
    pub mode: String,
    pub binding_sha256: String,
    pub state: WebsiteRunState,
    pub model: String,
    pub duration_ms: u64,
    pub inference_calls: u16,
    pub terminal_calls: u16,
    pub http_requests: u16,
    pub cleanup_confirmed: bool,
}

impl WorkReceipt {
    /// The dispatcher calls this only for an accepted result, or when exporting
    /// an older saved result. No prose, URLs, headers or credentials are copied.
    pub fn from_result(result: &WorkResult) -> Option<Self> {
        let (hash, run) = match result {
            WorkResult::Website(r) => (&r.snapshot_sha256, &r.execution),
            WorkResult::Source(r) => (&r.snapshot_sha256, &r.execution),
            WorkResult::Pentest(r) => {
                return Some(Self {
                    mode: result.mode().as_str().into(),
                    binding_sha256: r.scope_sha256.clone(),
                    state: r.execution.state,
                    model: r.execution.model.clone(),
                    duration_ms: r.execution.duration_ms,
                    inference_calls: r.execution.inference_calls,
                    terminal_calls: 0,
                    http_requests: r.execution.http_requests,
                    cleanup_confirmed: r.execution.cleanup_confirmed,
                });
            }
            _ => return None,
        };
        Some(Self {
            mode: result.mode().as_str().into(),
            binding_sha256: hash.clone(),
            state: run.state,
            model: run.model.clone(),
            duration_ms: run.duration_ms,
            inference_calls: run.inference_calls,
            terminal_calls: run.terminal_calls,
            http_requests: 0,
            cleanup_confirmed: run.cleanup_confirmed,
        })
    }

    pub fn valid_for(&self, mode: &str, binding: &str) -> bool {
        self.mode == mode
            && matches!(mode, "website_agent" | "source_agent" | "pentest_agent")
            && self.binding_sha256 == binding
            && binding.len() == 64
            && binding.bytes().all(|b| b.is_ascii_hexdigit())
            && !self.model.trim().is_empty()
            && self.model.len() <= 240
            && !self.model.chars().any(char::is_control)
            && self.duration_ms <= crate::MAX_AGENT_RESULT_DURATION_MS
            && if mode == "pentest_agent" {
                self.inference_calls <= crate::pentests::MAX_LIVE_INFERENCE_CALLS
                    && usize::from(self.http_requests) <= crate::pentests::MAX_HTTP_REQUESTS
                    && self.terminal_calls == 0
            } else {
                self.inference_calls <= 4 && self.terminal_calls <= 16 && self.http_requests == 0
            }
    }
}
