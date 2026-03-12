use serde::{Deserialize, Serialize};

// Get available models from CLIProxyAPI /v1/models endpoint
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableModel {
    pub id: String,
    pub owned_by: String,
    /// Source of the model: "gemini-api", "vertex", "copilot", "api-key", "oauth", etc.
    /// Used to distinguish between different authentication sources for the same provider
    #[serde(default)]
    pub source: String,
    /// Display name with provider suffix (e.g. "gpt-5-codex [Copilot]")
    /// Used only for UI display, not for API requests
    #[serde(default)]
    pub display_name: String,
}

// Test connection to a custom OpenAI-compatible provider
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
    pub models_found: Option<u32>,
}

// Models fetched from an OpenAI-compatible provider
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICompatibleProviderModels {
    pub provider_name: String,
    pub base_url: String,
    pub models: Vec<OpenAICompatibleModel>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAICompatibleModel {
    pub id: String,
    #[serde(default)]
    pub owned_by: Option<String>,
    #[serde(default)]
    pub created: Option<i64>,
}
