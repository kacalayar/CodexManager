use crate::config::save_config_to_file;
use crate::state::AppState;
use crate::types::{AvailableModel, ProviderTestResult};
use serde::Deserialize;
use tauri::State;

// Internal types for model API responses
#[derive(Debug, Deserialize)]
struct ModelsApiResponse {
    data: Vec<ModelsApiModel>,
}

#[derive(Debug, Deserialize)]
struct ModelsApiModel {
    id: String,
    owned_by: String,
}

#[tauri::command]
pub fn get_gpt_reasoning_models() -> Vec<String> {
    crate::GPT5_BASE_MODELS.iter().map(|s| s.to_string()).collect()
}

/// Build the set of all model IDs configured for copilot in proxy config.
/// This is deterministic and covers ALL aliases including reasoning suffix variants.
/// Must stay in sync with build_copilot_openai_entry_for_instance() in proxy.rs.
fn build_copilot_config_model_ids() -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();

    ids.insert("gpt-4.1".to_string());

    for model in crate::GPT5_BASE_MODELS {
        ids.insert(model.to_string());
        for suffix in crate::GPT5_REASONING_SUFFIXES {
            ids.insert(format!("{}({})", model, suffix));
        }
    }

    for name in ["gpt-4o", "gpt-4", "gpt-4-turbo", "o1", "o1-mini"] {
        ids.insert(name.to_string());
    }

    for name in [
        "grok-code-fast-1", "raptor-mini",
        "gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.1-pro-high", "gemini-3.1-pro-low",
        "claude-haiku-4.5", "claude-opus-4.1", "claude-sonnet-4", "claude-sonnet-4.5",
        "claude-opus-4.5", "claude-opus-4.6",
    ] {
        ids.insert(name.to_string());
    }

    ids
}

/// Fetch model IDs from copilot-api instances (for models not in our hardcoded list).
async fn fetch_copilot_api_model_ids(
    client: &reqwest::Client,
    config: &crate::config::AppConfig,
) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();

    for instance in &config.copilot.instances {
        if !instance.enabled {
            continue;
        }
        let url = format!("http://127.0.0.1:{}/v1/models", instance.port);
        if let Ok(resp) = client
            .get(&url)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(api_resp) = resp.json::<ModelsApiResponse>().await {
                    for model in api_resp.data {
                        ids.insert(model.id.to_lowercase());
                    }
                }
            }
        }
    }

    ids
}

/// Check if a model ID belongs to the copilot set.
/// Also checks base model name (before reasoning suffix parenthesis).
fn is_in_copilot_set(model_id: &str, copilot_ids: &std::collections::HashSet<String>) -> bool {
    let id = model_id.to_lowercase();
    if copilot_ids.contains(&id) {
        return true;
    }
    // Check base model before reasoning suffix: "gpt-5-codex(xhigh)" → "gpt-5-codex"
    if let Some(base) = id.split('(').next() {
        if base != id && copilot_ids.contains(base) {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn get_available_models(state: State<'_, AppState>) -> Result<Vec<AvailableModel>, String> {
    let config = state.config.lock().unwrap().clone();
    let proxy_running = state.proxy_status.lock().unwrap().running;

    if !proxy_running {
        return Ok(vec![]);
    }

    let has_gemini_api = !config.gemini_api_keys.is_empty();
    let has_copilot = config.copilot.instances.iter().any(|i| i.enabled);

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Build merged copilot model set: config-based (deterministic) + copilot-api query (dynamic)
    let copilot_model_ids = if has_copilot {
        let mut ids = build_copilot_config_model_ids();
        let api_ids = fetch_copilot_api_model_ids(&client, &config).await;
        ids.extend(api_ids);
        ids
    } else {
        std::collections::HashSet::new()
    };

    let endpoint = format!("http://localhost:{}/v1/models", config.port);

    let response = match client.get(&endpoint)
        .header("Authorization", format!("Bearer {}", config.proxy_api_key))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            {
                let mut status = state.proxy_status.lock().unwrap();
                status.running = false;
            }
            return Err(format!("Proxy not responding. Please restart the proxy. ({})", e));
        }
    };

    if !response.status().is_success() {
        return Err(format!("API returned status {}", response.status()));
    }

    let api_response: ModelsApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {}", e))?;

    let models: Vec<AvailableModel> = api_response.data
        .into_iter()
        .map(|m| {
            let is_in_copilot = has_copilot && is_in_copilot_set(&m.id, &copilot_model_ids);

            // Known providers (by owned_by) always keep their identity.
            // Unknown owned_by → check copilot set → fallback to owned_by.
            let (source, suffix) = match m.owned_by.as_str() {
                "google" => {
                    let src = if has_gemini_api { "gemini-api" } else { "oauth" };
                    (src.to_string(), " [Gemini]")
                },
                "anthropic" => {
                    let src = if !config.claude_api_keys.is_empty() { "api-key" } else { "oauth" };
                    (src.to_string(), " [Claude]")
                },
                "antigravity" => ("antigravity".to_string(), " [AG]"),
                "openai" => {
                    if is_in_copilot {
                        ("copilot".to_string(), " [Copilot]")
                    } else if !config.codex_api_keys.is_empty() {
                        ("api-key".to_string(), " [OpenAI]")
                    } else {
                        ("oauth".to_string(), " [OpenAI]")
                    }
                },
                // Unknown owned_by (e.g. "system" from copilot-api) → check copilot set
                _ => {
                    if is_in_copilot {
                        ("copilot".to_string(), " [Copilot]")
                    } else {
                        (m.owned_by.clone(), "")
                    }
                },
            };

            let display_name = format!("{}{}", m.id, suffix);

            AvailableModel {
                id: m.id,
                owned_by: m.owned_by,
                source,
                display_name,
            }
        })
        .collect();

    Ok(models)
}

#[tauri::command]
pub async fn test_provider_connection(
    model_id: String,
    state: State<'_, AppState>,
) -> Result<ProviderTestResult, String> {
    let (port, api_key) = {
        let config = state.config.lock().unwrap();
        (config.port, config.proxy_api_key.clone())
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let endpoint = format!("http://localhost:{}/v1/chat/completions", port);
    
    let payload = serde_json::json!({
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": "Say 'OK'"
            }
        ],
        "max_tokens": 5
    });

    let start = std::time::Instant::now();
    let response = client.post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&payload)
        .send()
        .await;
    
    let latency = start.elapsed().as_millis() as u64;

    match response {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() {
                Ok(ProviderTestResult {
                    success: true,
                    message: "Connection successful!".to_string(),
                    latency_ms: Some(latency),
                    models_found: None,
                })
            } else {
                let error_text = resp.text().await.unwrap_or_else(|_| "Unknown error".to_string());
                Ok(ProviderTestResult {
                    success: false,
                    message: format!("Error {}: {}", status, error_text),
                    latency_ms: Some(latency),
                    models_found: None,
                })
            }
        }
        Err(e) => {
            Ok(ProviderTestResult {
                success: false,
                message: format!("Connection failed: {}", e),
                latency_ms: Some(latency),
                models_found: None,
            })
        }
    }
}

#[tauri::command]
pub async fn test_openai_provider(base_url: String, api_key: String) -> Result<ProviderTestResult, String> {
    if base_url.is_empty() || api_key.is_empty() {
        return Ok(ProviderTestResult {
            success: false,
            message: "Base URL and API key are required".to_string(),
            latency_ms: None,
            models_found: None,
        });
    }
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    // Normalize base URL - remove trailing slash
    let base_url = base_url.trim_end_matches('/');
    
    // Try multiple endpoint patterns since providers have varying API structures:
    // 1. {baseUrl}/models - for providers where user specifies full path (e.g., .../v1 or .../v4)
    // 2. {baseUrl}/v1/models - for providers where user specifies root URL
    let endpoints = vec![
        format!("{}/models", base_url),
        format!("{}/v1/models", base_url),
    ];
    
    let start = std::time::Instant::now();
    
    for endpoint in &endpoints {
        let response = client.get(endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await;
        let latency = start.elapsed().as_millis() as u64;
        
        match response {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    // Try to count models
                    let models_count = if let Ok(json) = resp.json::<serde_json::Value>().await {
                        json.get("data")
                            .and_then(|d| d.as_array())
                            .map(|arr| arr.len() as u32)
                    } else {
                        None
                    };
                    
                    return Ok(ProviderTestResult {
                        success: true,
                        message: format!("Connection successful! ({}ms)", latency),
                        latency_ms: Some(latency),
                        models_found: models_count,
                    });
                } else if status.as_u16() == 401 || status.as_u16() == 403 {
                    return Ok(ProviderTestResult {
                        success: false,
                        message: "Authentication failed - check your API key".to_string(),
                        latency_ms: Some(latency),
                        models_found: None,
                    });
                }
                // For 404, try the next endpoint pattern
            }
            Err(e) => {
                // For connection errors, return immediately
                if e.is_timeout() {
                    return Ok(ProviderTestResult {
                        success: false,
                        message: "Connection timed out - check your base URL".to_string(),
                        latency_ms: Some(start.elapsed().as_millis() as u64),
                        models_found: None,
                    });
                } else if e.is_connect() {
                    return Ok(ProviderTestResult {
                        success: false,
                        message: "Could not connect - check your base URL".to_string(),
                        latency_ms: Some(start.elapsed().as_millis() as u64),
                        models_found: None,
                    });
                }
            }
        }
    }
    
    // All endpoints failed with 404 or similar
    let latency = start.elapsed().as_millis() as u64;
    Ok(ProviderTestResult {
        success: false,
        message: "Provider returned 404 Not Found - check your base URL (tried /models and /v1/models)".to_string(),
        latency_ms: Some(latency),
        models_found: None,
    })
}

// Fetch models from all configured OpenAI-compatible providers
#[tauri::command]
pub async fn fetch_openai_compatible_models(state: State<'_, AppState>) -> Result<Vec<crate::types::OpenAICompatibleProviderModels>, String> {
    // Get all configured OpenAI-compatible providers
    let providers = crate::commands::api_keys::get_openai_compatible_providers(state.clone()).await?;
    
    if providers.is_empty() {
        return Ok(Vec::new());
    }
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    
    let mut results = Vec::new();
    
    for provider in providers {
        let base_url = provider.base_url.trim_end_matches('/');
        let api_key = provider.api_key_entries.first()
            .map(|e| e.api_key.clone())
            .unwrap_or_default();
        
        if api_key.is_empty() {
            results.push(crate::types::OpenAICompatibleProviderModels {
                provider_name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                models: Vec::new(),
                error: Some("No API key configured".to_string()),
            });
            continue;
        }
        
        // Try multiple endpoint patterns
        let endpoints = vec![
            format!("{}/models", base_url),
            format!("{}/v1/models", base_url),
        ];
        
        let mut found_models = false;
        
        for endpoint in &endpoints {
            let response = client.get(endpoint)
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await;
            
            match response {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        let models: Vec<crate::types::OpenAICompatibleModel> = json
                            .get("data")
                            .and_then(|d| d.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| {
                                        let id = m.get("id")?.as_str()?.to_string();
                                        Some(crate::types::OpenAICompatibleModel {
                                            id,
                                            owned_by: m.get("owned_by").and_then(|v| v.as_str()).map(String::from),
                                            created: m.get("created").and_then(|v| v.as_i64()),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        
                        results.push(crate::types::OpenAICompatibleProviderModels {
                            provider_name: provider.name.clone(),
                            base_url: provider.base_url.clone(),
                            models,
                            error: None,
                        });
                        found_models = true;
                        break;
                    }
                }
                Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                    results.push(crate::types::OpenAICompatibleProviderModels {
                        provider_name: provider.name.clone(),
                        base_url: provider.base_url.clone(),
                        models: Vec::new(),
                        error: Some("Authentication failed".to_string()),
                    });
                    found_models = true;
                    break;
                }
                _ => continue, // Try next endpoint
            }
        }
        
        if !found_models {
            results.push(crate::types::OpenAICompatibleProviderModels {
                provider_name: provider.name.clone(),
                base_url: provider.base_url.clone(),
                models: Vec::new(),
                error: Some("Could not fetch models - endpoint not found".to_string()),
            });
        }
    }
    
    Ok(results)
}

// Get model context and output limits
pub(crate) fn get_model_limits(model_id: &str, owned_by: &str, source: &str) -> (u64, u64) {
    // Return (context_limit, output_limit)
    // First check model_id patterns (handles Antigravity Claude models like claude-opus-4-5-thinking)
    let model_lower = model_id.to_lowercase();
    
    // Claude models (direct or via Antigravity)
    if model_lower.contains("claude") {
        // Claude 4.5 models: 200K context, 64K output
        // Claude 3.5 haiku: 200K context, 8K output
        if model_lower.contains("3-5-haiku") || model_lower.contains("3-haiku") {
            return (200000, 8192);
        } else {
            // sonnet-4-5, opus-4-5, haiku-4-5, and other Claude 4.x models
            return (200000, 64000);
        }
    }
    
    // Gemini models
    if model_lower.contains("gemini") {
        // Gemini 2.5 models: 1M context, 65K output
        return (1000000, 65536);
    }
    
    // GPT/OpenAI models
    if model_lower.contains("gpt") || model_lower.starts_with("o1") || model_lower.starts_with("o3") {
        // o1, o3 reasoning models: 200K context, 100K output
        if model_lower.contains("o3") || model_lower.contains("o1") {
            return (200000, 100000);
        } else if model_lower.contains("gpt-5") || model_lower.contains("gpt5") {
            // GPT-5 via Copilot: 128K context (Copilot limit)
            // GPT-5 via ChatGPT/CodexManager: 400K context
            if source == "copilot" {
                return (128000, 32768);
            } else {
                return (400000, 32768);
            }
        } else {
            // gpt-4o, gpt-4o-mini, gpt-4.1: 128K context, 16K output
            return (128000, 16384);
        }
    }
    
    // Qwen models
    if model_lower.contains("qwen") {
        // Qwen3 Coder Plus: 1M context
        if model_lower.contains("coder") {
            return (1000000, 65536);
        } else {
            // Qwen3 models: 262K context (max), 65K output
            return (262144, 65536);
        }
    }
    
    // DeepSeek models
    if model_lower.contains("deepseek") {
        // deepseek-reasoner: 128K output, deepseek-chat: 8K output
        if model_lower.contains("reasoner") || model_lower.contains("r1") {
            return (128000, 128000);
        } else {
            return (128000, 8192);
        }
    }
    
    // Fallback to owned_by for any remaining models
    match owned_by {
        "anthropic" => (200000, 64000),
        "google" => (1000000, 65536),
        "openai" => (128000, 16384),
        "qwen" => (262144, 65536),
        "deepseek" => (128000, 8192),
        _ => (128000, 16384) // safe defaults
    }
}


#[tauri::command]
pub async fn set_claude_code_model(model_type: String, model_name: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let config_dir = home.join(".claude");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("settings.json");
    
    // Read existing config or create new
    let mut json: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    
    // Ensure env object exists
    if json.get("env").is_none() {
        json["env"] = serde_json::json!({});
    }
    
    // Map model_type to env var name
    let env_key = match model_type.as_str() {
        "haiku" => "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "opus" => "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "sonnet" => "ANTHROPIC_DEFAULT_SONNET_MODEL",
        _ => return Err(format!("Unknown model type: {}", model_type)),
    };
    
    // Update the model
    if let Some(env) = json.get_mut("env").and_then(|e| e.as_object_mut()) {
        env.insert(env_key.to_string(), serde_json::Value::String(model_name));
    }
    
    // Write back
    let config_str = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, config_str).map_err(|e| e.to_string())?;
    
    Ok(())
}

// Get force model mappings from Management API
#[tauri::command]
pub async fn get_force_model_mappings(state: State<'_, AppState>) -> Result<bool, String> {
    let port = state.config.lock().unwrap().port;
    let url = crate::get_management_url(port, "ampcode/force-model-mappings");
    
    let client = crate::build_management_client();
    let response = client
        .get(&url)
        .header("X-Management-Key", &crate::get_management_key())
        .send()
        .await
        .map_err(|e| format!("Failed to get force model mappings: {}", e))?;
    
    if !response.status().is_success() {
        return Ok(false); // Default to false
    }
    
    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json.get("force-model-mappings").and_then(|v| v.as_bool()).unwrap_or(false))
}

// Set force model mappings via Management API
#[tauri::command]
pub async fn set_force_model_mappings(state: State<'_, AppState>, value: bool) -> Result<(), String> {
    let port = state.config.lock().unwrap().port;
    let url = crate::get_management_url(port, "ampcode/force-model-mappings");
    
    let client = crate::build_management_client();
    let response = client
        .put(&url)
        .header("X-Management-Key", &crate::get_management_key())
        .json(&serde_json::json!({ "value": value }))
        .send()
        .await
        .map_err(|e| format!("Failed to set force model mappings: {}", e))?;
    
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to set force model mappings: {} - {}", status, text));
    }
    
    // Persist to Tauri config so it survives restart
    let mut config = state.config.lock().unwrap();
    config.force_model_mappings = value;
    save_config_to_file(&config).map_err(|e| format!("Failed to save config: {}", e))?;
    
    Ok(())
}
