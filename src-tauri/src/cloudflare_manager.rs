use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::types::cloudflare::CloudflareConfig;

/// Find cloudflared binary path - checks common installation locations
/// GUI apps on macOS don't inherit terminal PATH, so we check manually
fn find_cloudflared_path() -> Option<String> {
    let possible_paths = [
        // Direct command (if in PATH)
        "cloudflared",
        // macOS Homebrew (Apple Silicon)
        "/opt/homebrew/bin/cloudflared",
        // macOS Homebrew (Intel)
        "/usr/local/bin/cloudflared",
        // Linux common paths
        "/usr/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        // Snap on Linux
        "/snap/bin/cloudflared",
        // Windows common paths
        "C:\\Program Files\\cloudflared\\cloudflared.exe",
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
        // User local bin
        &format!("{}/.local/bin/cloudflared", std::env::var("HOME").unwrap_or_default()),
    ];
    
    for path in possible_paths {
        if path == "cloudflared" {
            // Check if it's in PATH using `which` or `where`
            #[cfg(unix)]
            {
                if let Ok(output) = std::process::Command::new("which")
                    .arg("cloudflared")
                    .output()
                {
                    if output.status.success() {
                        let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        if !path_str.is_empty() {
                            return Some(path_str);
                        }
                    }
                }
            }
            #[cfg(windows)]
            {
                if let Ok(output) = std::process::Command::new("where")
                    .arg("cloudflared")
                    .output()
                {
                    if output.status.success() {
                        let path_str = String::from_utf8_lossy(&output.stdout)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !path_str.is_empty() {
                            return Some(path_str);
                        }
                    }
                }
            }
        } else if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    
    None
}

#[derive(Clone, serde::Serialize)]
struct CloudflareStatusUpdate {
    id: String,
    status: String,
    message: Option<String>,
    url: Option<String>,
}

struct RunningTunnel {
    notify_stop: Arc<Notify>,
    #[allow(dead_code)]
    handle: tauri::async_runtime::JoinHandle<()>,
}

pub struct CloudflareManager {
    tunnels: Arc<Mutex<HashMap<String, RunningTunnel>>>,
}

impl CloudflareManager {
    pub fn new() -> Self {
        Self {
            tunnels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn connect(&self, app: AppHandle, config: CloudflareConfig) {
        let tunnels = self.tunnels.clone();
        let config_id = config.id.clone();
        
        // Remove existing tunnel if any
        self.disconnect(&config.id);

        let notify_stop = Arc::new(Notify::new());
        let notify_clone = notify_stop.clone();
        let config_clone = config.clone();
        
        let emit_status = move |status: &str, msg: Option<String>, url: Option<String>| {
            let _ = app.emit("cloudflare-status-changed", CloudflareStatusUpdate {
                id: config_clone.id.clone(),
                status: status.to_string(),
                message: msg,
                url,
            });
        };

        let emit_status_clone = emit_status.clone();

        let handle = tauri::async_runtime::spawn(async move {
            emit_status_clone("connecting", Some("Starting tunnel...".into()), None);
            
            // Find cloudflared binary - check common installation paths
            // GUI apps on macOS don't inherit terminal PATH, so we need to check manually
            let cloudflared_path = find_cloudflared_path();
            
            if cloudflared_path.is_none() {
                emit_status_clone("error", Some("cloudflared not found. Please install it first.".into()), None);
                return;
            }
            let cloudflared_bin = cloudflared_path.unwrap();
            
            let mut retry_count = 0;
            const MAX_RETRIES: u32 = 3;
            
            loop {
                // For named tunnels with tokens from Cloudflare Dashboard:
                // The ingress rules (including URL routing) are configured in the dashboard
                // So we only need: cloudflared tunnel run --token <token>
                // 
                // For quick tunnels (no token, just expose a port):
                // cloudflared tunnel --url http://localhost:<port>
                let mut cmd = Command::new(&cloudflared_bin);
                
                if config.tunnel_token.is_empty() {
                    // Quick tunnel mode - expose local port directly
                    cmd.arg("tunnel");
                    cmd.arg("--url");
                    cmd.arg(format!("http://localhost:{}", config.local_port));
                } else {
                    // Named tunnel mode - use token from dashboard
                    // Ingress rules are configured in Cloudflare Zero Trust dashboard
                    cmd.arg("tunnel");
                    cmd.arg("run");
                    cmd.arg("--token");
                    cmd.arg(&config.tunnel_token);
                }

                emit_status_clone("connecting", Some(format!("Connecting to port {}...", config.local_port)), None);

                cmd.stdout(std::process::Stdio::piped())
                   .stderr(std::process::Stdio::piped())
                   .stdin(std::process::Stdio::null());
                   
                #[cfg(windows)]
                {
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }

                cmd.kill_on_drop(true);

                match cmd.spawn() {
                    Ok(mut child) => {
                        emit_status_clone("connecting", Some("Authenticating...".into()), None);
                        
                        let stderr = child.stderr.take();
                        let emit_output = emit_status_clone.clone();
                        let is_connected = Arc::new(AtomicBool::new(false));
                        let is_connected_clone = is_connected.clone();
                        
                        // Spawn a task to read stderr and detect connection status
                        let stderr_reader = tauri::async_runtime::spawn(async move {
                            use tokio::io::{AsyncBufReadExt, BufReader};
                            
                            let mut detected_url: Option<String> = None;
                            
                            if let Some(stderr) = stderr {
                                let reader = BufReader::new(stderr);
                                let mut lines = reader.lines();
                                
                                while let Ok(Some(line)) = lines.next_line().await {
                                    let line_lower = line.to_lowercase();
                                    
                                    // Debug: log all lines for troubleshooting
                                    #[cfg(debug_assertions)]
                                    println!("[cloudflared] {}", line);
                                    
                                    // Detect successful connection - cloudflared logs these on success:
                                    // "INF Connection ... registered connIndex=..."
                                    // "INF Registered tunnel connection connIndex=..."
                                    if line_lower.contains("registered") && 
                                       (line_lower.contains("connection") || line_lower.contains("connindex")) {
                                        is_connected_clone.store(true, Ordering::SeqCst);
                                        emit_output("connected", Some("Tunnel established".into()), detected_url.clone());
                                    } 
                                    // Quick tunnel URL detection
                                    else if line.contains(".trycloudflare.com") || line.contains(".cfargotunnel.com") {
                                        if let Some(url_start) = line.find("https://") {
                                            let url = line[url_start..].split_whitespace().next().unwrap_or("");
                                            detected_url = Some(url.to_string());
                                            is_connected_clone.store(true, Ordering::SeqCst);
                                            emit_output("connected", Some("Tunnel ready".into()), detected_url.clone());
                                        }
                                    }
                                    // Detect errors (but ignore config info containing "error" word)
                                    else if line_lower.contains("err ") || 
                                            (line_lower.contains("failed") && !line_lower.contains("failed to parse")) ||
                                            line_lower.contains("unable to") {
                                        emit_output("error", Some(line.clone()), None);
                                    }
                                    // Connector established
                                    else if line_lower.contains("initial protocol") || 
                                            line_lower.contains("connection established") {
                                        is_connected_clone.store(true, Ordering::SeqCst);
                                        emit_output("connected", Some("Tunnel connected".into()), detected_url.clone());
                                    }
                                }
                            }
                        });

                        // Wait for either: process exit, stop signal
                        tokio::select! {
                            exit_status = child.wait() => {
                                stderr_reader.abort();
                                match exit_status {
                                    Ok(status) => {
                                        if status.success() {
                                            emit_status_clone("disconnected", Some("Tunnel closed".into()), None);
                                        } else {
                                            let code = status.code().unwrap_or(-1);
                                            emit_status_clone("error", Some(format!("Exit code: {}", code)), None);
                                        }
                                    }
                                    Err(e) => {
                                        emit_status_clone("error", Some(format!("Process error: {}", e)), None);
                                    }
                                }
                                
                                // Only retry if we were connected (unexpected disconnect)
                                // or if we haven't exceeded retry count
                                if is_connected.load(Ordering::SeqCst) {
                                    // Was connected, retry to reconnect
                                    retry_count = 0;
                                    emit_status_clone("reconnecting", Some("Connection lost, reconnecting...".into()), None);
                                } else if retry_count < MAX_RETRIES {
                                    retry_count += 1;
                                    emit_status_clone("reconnecting", Some(format!("Retrying ({}/{})...", retry_count, MAX_RETRIES)), None);
                                } else {
                                    emit_status_clone("error", Some("Failed to connect after multiple attempts".into()), None);
                                    break;
                                }
                            }
                            _ = notify_clone.notified() => {
                                let _ = child.kill().await;
                                stderr_reader.abort();
                                emit_status_clone("disconnected", Some("Tunnel stopped".into()), None);
                                break;
                            }
                        }
                    },
                    Err(e) => {
                        let error_msg = if e.kind() == std::io::ErrorKind::NotFound {
                            "cloudflared not found. Please install it first.".to_string()
                        } else {
                            format!("Failed to start: {}", e)
                        };
                        emit_status_clone("error", Some(error_msg), None);
                        
                        // Don't retry if cloudflared is not found
                        if e.kind() == std::io::ErrorKind::NotFound {
                            break;
                        }
                        
                        retry_count += 1;
                        if retry_count >= MAX_RETRIES {
                            emit_status_clone("error", Some("Failed to start after multiple attempts".into()), None);
                            break;
                        }
                    }
                }
                
                // Wait before retry
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    _ = notify_clone.notified() => {
                        emit_status_clone("disconnected", Some("Tunnel stopped".into()), None);
                        break;
                    }
                }
            }
        });

        tunnels.lock().unwrap().insert(config_id, RunningTunnel {
            notify_stop,
            handle,
        });
    }

    pub fn disconnect(&self, id: &str) {
        let mut tunnels = self.tunnels.lock().unwrap();
        if let Some(tunnel) = tunnels.remove(id) {
            tunnel.notify_stop.notify_one();
        }
    }
    
    #[allow(dead_code)]
    pub fn disconnect_all(&self) {
        println!("[Cloudflare Manager] Shutting down all tunnels...");
        let mut tunnels = self.tunnels.lock().unwrap();
        for (id, tunnel) in tunnels.iter() {
            println!("[Cloudflare Manager] Stopping tunnel: {}", id);
            tunnel.notify_stop.notify_one();
        }
        tunnels.clear();
    }

    #[allow(dead_code)]
    pub fn get_status(&self, id: &str) -> String {
       let tunnels = self.tunnels.lock().unwrap();
       if tunnels.contains_key(id) {
           "active".to_string()
       } else {
           "inactive".to_string()
       }
    }
}
