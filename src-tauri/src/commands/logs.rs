//! Log viewer commands and helpers.

use crate::state::AppState;
use crate::types::{LogEntry, RequestLog};
use crate::{build_management_client, get_management_key, get_management_url};
use serde::Deserialize;
use tauri::State;
use std::sync::atomic::{AtomicU64, Ordering};

// API response structure for logs
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
struct LogsApiResponse {
    #[serde(default)]
    #[allow(dead_code)]
    latest_timestamp: Option<i64>,
    #[serde(default)]
    #[allow(dead_code)]
    line_count: Option<u32>,
    #[serde(default)]
    lines: Vec<String>,
}

// Parse request info from a GIN/new-format log line (simplified version of log_watcher logic)
fn parse_request_from_log_line(line: &str, counter: &AtomicU64) -> Option<RequestLog> {
    // Skip empty/internal lines
    if line.is_empty()
        || line.contains("/v0/management/")
        || line.contains("/v1/models")
        || line.contains("?uploadThread")
        || line.contains("?getCreditsByRequestId")
        || line.contains("?threadDisplayCostInfo")
        || line.contains("/api/internal")
        || line.contains("/api/telemetry")
        || line.contains("/api/otel")
    {
        return None;
    }

    lazy_static::lazy_static! {
        static ref NEW_FMT: regex::Regex = regex::Regex::new(
            r#"\|\s+([a-f0-9]{8}|-{8})\s+\|\s+(\d+)\s+\|\s+([^\s]+)\s+\|\s+[^\s]+\s+\|\s+(\w+)\s+\"([^\"]+)\""#
        ).unwrap();
        static ref GIN_FMT: regex::Regex = regex::Regex::new(
            r#"\[GIN\]\s+(\d{4}/\d{2}/\d{2})\s+-\s+(\d{2}:\d{2}:\d{2})\s+\|\s+(\d+)\s+\|\s+([^\s]+)\s+\|\s+[^\s]+\s+\|\s+(\w+)\s+\"([^\"]+)\"(?:\s+\|\s+model=(\S+))?"#
        ).unwrap();
        static ref TS_RE: regex::Regex = regex::Regex::new(
            r#"(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})"#
        ).unwrap();
    }

    // Extract timestamp helper
    let extract_ts = |l: &str| -> u64 {
        if let Some(caps) = TS_RE.captures(l) {
            let ds = format!("{} {}", &caps[1], &caps[2]);
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(&ds, "%Y-%m-%d %H:%M:%S") {
                return dt
                    .and_local_timezone(chrono::Local)
                    .earliest()
                    .unwrap_or_else(|| chrono::Local::now())
                    .timestamp_millis() as u64;
            }
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    };

    let parse_dur = |s: &str| -> u64 {
        if s.ends_with("ms") {
            s.trim_end_matches("ms").parse().unwrap_or(0)
        } else if s.ends_with('s') {
            let v: f64 = s.trim_end_matches('s').parse().unwrap_or(0.0);
            (v * 1000.0) as u64
        } else {
            0
        }
    };

    // Try new format
    if let Some(caps) = NEW_FMT.captures(line) {
        let status: u16 = caps.get(2)?.as_str().parse().ok()?;
        let duration_ms = parse_dur(caps.get(3)?.as_str());
        let method = caps.get(4)?.as_str().to_string();
        let path = caps.get(5)?.as_str().to_string();
        let timestamp = extract_ts(line);
        let model = crate::utils::extract_model_from_path(&path).unwrap_or_else(|| "unknown".to_string());
        let mp = crate::utils::detect_provider_from_model(&model);
        let provider = if mp != "unknown" { mp } else {
            crate::utils::detect_provider_from_path(&path).unwrap_or_else(|| "unknown".to_string())
        };
        let c = counter.fetch_add(1, Ordering::SeqCst);
        return Some(RequestLog {
            id: format!("srv_{}_{}", timestamp, c),
            timestamp,
            provider,
            model,
            method,
            path,
            status,
            duration_ms,
            tokens_in: None,
            tokens_out: None,
            tokens_cached: None,
            account: None,
        });
    }

    // Try GIN format
    if let Some(caps) = GIN_FMT.captures(line) {
        let date_str = caps.get(1)?.as_str();
        let time_str = caps.get(2)?.as_str();
        let status: u16 = caps.get(3)?.as_str().parse().ok()?;
        let duration_ms = parse_dur(caps.get(4)?.as_str());
        let method = caps.get(5)?.as_str().to_string();
        let path = caps.get(6)?.as_str().to_string();
        let dt_str = format!("{} {}", date_str.replace('/', "-"), time_str);
        let timestamp = chrono::NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%d %H:%M:%S")
            .ok()
            .map(|dt| dt.and_local_timezone(chrono::Local).earliest().unwrap_or_else(|| chrono::Local::now()).timestamp_millis() as u64)
            .unwrap_or_else(|| extract_ts(line));
        let model = caps.get(7).map(|m| m.as_str().to_string())
            .or_else(|| crate::utils::extract_model_from_path(&path))
            .unwrap_or_else(|| "unknown".to_string());
        let mp = crate::utils::detect_provider_from_model(&model);
        let provider = if mp != "unknown" { mp } else {
            crate::utils::detect_provider_from_path(&path).unwrap_or_else(|| "unknown".to_string())
        };
        let c = counter.fetch_add(1, Ordering::SeqCst);
        return Some(RequestLog {
            id: format!("srv_{}_{}", timestamp, c),
            timestamp,
            provider,
            model,
            method,
            path,
            status,
            duration_ms,
            tokens_in: None,
            tokens_out: None,
            tokens_cached: None,
            account: None,
        });
    }

    None
}

// Fetch request logs from the Go backend's logs API and parse into RequestLog entries
#[tauri::command]
pub async fn get_proxy_request_logs(
    state: State<'_, AppState>,
    lines: Option<u32>,
) -> Result<Vec<RequestLog>, String> {
    let port = state.config.lock().unwrap().port;
    let lines_param = lines.unwrap_or(2000);
    let url = format!("{}?lines={}", get_management_url(port, "logs"), lines_param);

    let client = build_management_client();
    let response = client
        .get(&url)
        .header("X-Management-Key", &get_management_key())
        .send()
        .await
        .map_err(|e| format!("Failed to get logs: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to get logs: {} - {}", status, text));
    }

    let api_response: LogsApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse logs response: {}", e))?;

    let counter = AtomicU64::new(0);
    let mut requests: Vec<RequestLog> = api_response
        .lines
        .iter()
        .filter_map(|line| parse_request_from_log_line(line, &counter))
        .collect();

    // If no requests were parsed from server logs, fall back to local history.json
    if requests.is_empty() {
        let history = crate::helpers::history::load_request_history();
        requests = history.requests;
    }

    Ok(requests)
}

// Get logs from the proxy server
#[tauri::command]
pub async fn get_logs(
    state: State<'_, AppState>,
    lines: Option<u32>,
) -> Result<Vec<LogEntry>, String> {
    let port = state.config.lock().unwrap().port;
    let lines_param = lines.unwrap_or(500);
    let url = format!("{}?lines={}", get_management_url(port, "logs"), lines_param);

    let client = build_management_client();
    let response = client
        .get(&url)
        .header("X-Management-Key", &get_management_key())
        .send()
        .await
        .map_err(|e| format!("Failed to get logs: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to get logs: {} - {}", status, text));
    }

    // Parse JSON response
    let api_response: LogsApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse logs response: {}", e))?;

    // Parse each line into a LogEntry
    let entries: Vec<LogEntry> = api_response
        .lines
        .iter()
        .filter(|line| !line.is_empty())
        .map(|line| parse_log_line(line))
        .collect();

    Ok(entries)
}

// Parse a log line into a LogEntry struct
// Expected formats from CLIProxyAPI:
// - "[2025-12-02 22:12:52] [info] [gin_logger.go:58] message"
// - "[2025-12-02 22:12:52] [info] message"
// - "2024-01-15T10:30:45.123Z [INFO] message"
fn parse_log_line(line: &str) -> LogEntry {
    let line = line.trim();

    // Format: [timestamp] [level] [source] message
    // or: [timestamp] [level] message
    if line.starts_with('[') {
        let mut parts = Vec::new();
        let mut current_start = 0;
        let mut in_bracket = false;

        for (i, c) in line.char_indices() {
            if c == '[' && !in_bracket {
                in_bracket = true;
                current_start = i + 1;
            } else if c == ']' && in_bracket {
                in_bracket = false;
                parts.push(&line[current_start..i]);
                current_start = i + 1;
            }
        }

        // Get the message (everything after the last bracket)
        let message_start = line.rfind(']').map(|i| i + 1).unwrap_or(0);
        let message = line[message_start..].trim();

        if parts.len() >= 2 {
            let timestamp = parts[0].to_string();
            let level = parts[1].to_uppercase();

            return LogEntry {
                timestamp,
                level: normalize_log_level(&level),
                message: message.to_string(),
            };
        }
    }

    // Try ISO timestamp format: "2024-01-15T10:30:45.123Z [INFO] message"
    if line.len() > 20 && (line.chars().nth(4) == Some('-') || line.chars().nth(10) == Some('T')) {
        if let Some(bracket_start) = line.find('[') {
            if let Some(bracket_end) = line[bracket_start..].find(']') {
                let timestamp = line[..bracket_start].trim().to_string();
                let level = line[bracket_start + 1..bracket_start + bracket_end].to_string();
                let message = line[bracket_start + bracket_end + 1..].trim().to_string();

                return LogEntry {
                    timestamp,
                    level: normalize_log_level(&level),
                    message,
                };
            }
        }
    }

    // Try "LEVEL: message" format
    for level in &["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] {
        if line.to_uppercase().starts_with(level) {
            let rest = &line[level.len()..];
            if rest.starts_with(':') || rest.starts_with(' ') {
                return LogEntry {
                    timestamp: String::new(),
                    level: level.to_string(),
                    message: rest.trim_start_matches(|c| c == ':' || c == ' ').to_string(),
                };
            }
        }
    }

    // Default: plain text as INFO
    LogEntry {
        timestamp: String::new(),
        level: "INFO".to_string(),
        message: line.to_string(),
    }
}

// Normalize log level to standard format
fn normalize_log_level(level: &str) -> String {
    match level.to_uppercase().as_str() {
        "ERROR" | "ERR" | "E" => "ERROR".to_string(),
        "WARN" | "WARNING" | "W" => "WARN".to_string(),
        "INFO" | "I" => "INFO".to_string(),
        "DEBUG" | "DBG" | "D" => "DEBUG".to_string(),
        "TRACE" | "T" => "TRACE".to_string(),
        _ => level.to_uppercase(),
    }
}

// Clear all logs
#[tauri::command]
pub async fn clear_logs(state: State<'_, AppState>) -> Result<(), String> {
    let port = state.config.lock().unwrap().port;
    let url = get_management_url(port, "logs");

    let client = build_management_client();
    let response = client
        .delete(&url)
        .header("X-Management-Key", &get_management_key())
        .send()
        .await
        .map_err(|e| format!("Failed to clear logs: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Failed to clear logs: {} - {}", status, text));
    }

    Ok(())
}

// Get list of error log files from the logs directory
#[tauri::command]
pub fn get_request_error_logs() -> Result<Vec<String>, String> {
    let logs_dir = crate::config::get_codex_manager_config_dir().join("logs");

    if !logs_dir.exists() {
        return Ok(vec![]);
    }

    let mut files: Vec<String> = std::fs::read_dir(&logs_dir)
        .map_err(|e| format!("Failed to read logs directory: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            // Only include files that contain "error" in the name
            if name.contains("error") && name.ends_with(".log") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    // Sort newest first
    files.sort_by(|a, b| b.cmp(a));
    Ok(files)
}

// Get the content of a specific error log file
#[tauri::command]
pub fn get_request_error_log_content(filename: String) -> Result<String, String> {
    // Sanitize filename to prevent path traversal
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err("Invalid filename".to_string());
    }

    let log_path = crate::config::get_codex_manager_config_dir()
        .join("logs")
        .join(&filename);

    if !log_path.exists() {
        return Err(format!("Log file not found: {}", filename));
    }

    std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read log file: {}", e))
}
