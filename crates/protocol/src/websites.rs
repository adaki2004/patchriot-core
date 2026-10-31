//! Saved website evidence. Text is untrusted content, never instructions or HTML
//! to render directly. A collected response is not a security verdict.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
