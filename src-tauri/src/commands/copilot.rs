use crate::state::AppState;
use crate::types::{CopilotApiDetection, CopilotApiInstallResult, CopilotStatus, CopilotStatusMap};
use tauri::{Emitter, Manager, State, AppHandle};
use tauri_plugin_shell::ShellExt;

// ============================================
// Copilot API Management (via copilot-api)
// ============================================

#[tauri::command]
pub fn get_copilot_status(state: State<AppState>) -> CopilotStatus {
    // For backwards compatibility, return the first instance's status
    let statuses = state.copilot_statuses.lock().unwrap();
    statuses.instances.values().next().cloned().unwrap_or_default()
}

#[tauri::command]
pub fn get_all_copilot_statuses(state: State<AppState>) -> CopilotStatusMap {
    state.copilot_statuses.lock().unwrap().clone()
}

/// Legacy start_copilot - starts the first/default instance
#[tauri::command]
pub async fn start_copilot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<CopilotStatus, String> {
    let config = state.config.lock().unwrap().clone();
    // Get first enabled instance, or first instance if none enabled
    let instance = config.copilot.instances.iter()
        .find(|i| i.enabled)
        .or_else(|| config.copilot.instances.first())
        .ok_or("No Copilot instances configured")?;
    
    start_copilot_instance(app, state, instance.id.clone()).await
}

/// Internal version for auto-start (doesn't need State wrapper)
pub async fn start_copilot_instance_internal(
    app: AppHandle,
    instance_id: String,
) -> Result<CopilotStatus, String> {
    let state = app.state::<AppState>();
    start_copilot_instance(app.clone(), state, instance_id).await
}

/// Start a specific Copilot instance by ID
#[tauri::command]
pub async fn start_copilot_instance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<CopilotStatus, String> {
    let config = state.config.lock().unwrap().clone();
    
    // Find the instance config
    let instance = config.copilot.get_instance(&instance_id)
        .ok_or_else(|| format!("Copilot instance '{}' not found", instance_id))?
        .clone();
    
    let port = instance.port;
    
    // Check if copilot is enabled
    if !instance.enabled {
        return Err(format!("Copilot instance '{}' is not enabled", instance.name));
    }
    
    // Check if we already have a tracked process for this instance (prevents double-spawn)
    {
        let processes = state.copilot_processes.lock().unwrap();
        if processes.contains_key(&instance_id) {
            let statuses = state.copilot_statuses.lock().unwrap();
            if let Some(status) = statuses.instances.get(&instance_id) {
                if status.running {
                    println!("[copilot:{}] Already has a tracked running process, skipping spawn", instance.name);
                    return Ok(status.clone());
                }
            }
        }
    }

    // Check if copilot-api is already running on this port (maybe externally)
    let client = crate::build_management_client();
    let health_url = format!("http://127.0.0.1:{}/v1/models", port);
    if let Ok(response) = client
        .get(&health_url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    {
        if response.status().is_success() {
            // Already running and healthy - just update status
            let new_status = {
                let mut statuses = state.copilot_statuses.lock().unwrap();
                let status = statuses.instances.entry(instance_id.clone()).or_insert_with(|| CopilotStatus::new(&instance_id, port));
                status.running = true;
                status.port = port;
                status.endpoint = format!("http://localhost:{}", port);
                status.authenticated = true;
                status.clone()
            };
            let _ = app.emit("copilot-status-changed", &new_status);
            let _ = app.emit("copilot-statuses-changed", state.copilot_statuses.lock().unwrap().clone());
            return Ok(new_status);
        }
    }
    
    // Kill any existing copilot process for this instance
    {
        let mut processes = state.copilot_processes.lock().unwrap();
        if let Some(child) = processes.remove(&instance_id) {
            let _ = child.kill(); // Ignore errors, process might already be dead
        }
    }
    
    // Small delay to let port be released
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    
    // Check if copilot-api is installed globally (faster startup)
    let detection = detect_copilot_api(app.clone()).await?;
    
    if !detection.node_available {
        let checked = detection.checked_node_paths.join(", ");
        return Err(format!(
            "Node.js is required for GitHub Copilot support.\n\n\
            Checked paths: {}\n\n\
            Please install Node.js from https://nodejs.org/ or via a version manager (nvm, volta, fnm) and restart CodexManager.",
            if checked.is_empty() { "none".to_string() } else { checked }
        ));
    }
    
    // Check Node.js version >= 20.16.0 (required for process.getBuiltinModule)
    if let Some(ref version_str) = detection.node_version {
        // Parse version like "v20.16.0" or "v18.19.0"
        let version_clean = version_str.trim_start_matches('v');
        let parts: Vec<&str> = version_clean.split('.').collect();
        if parts.len() >= 2 {
            let major: u32 = parts[0].parse().unwrap_or(0);
            let minor: u32 = parts[1].parse().unwrap_or(0);
            
            // Require Node.js >= 20.16.0
            if major < 20 || (major == 20 && minor < 16) {
                return Err(format!(
                    "Node.js version {} is too old for GitHub Copilot support.\n\n\
                    The copilot-api package requires Node.js 20.16.0 or later.\n\
                    Your current version: {}\n\n\
                    Please upgrade Node.js:\n\
                    • Download from https://nodejs.org/ (LTS recommended)\n\
                    • Or use a version manager: nvm install 22 / volta install node@22\n\n\
                    After upgrading, restart CodexManager.",
                    version_str, version_str
                ));
            }
        }
    }
    
    // Determine command and arguments based on installation status
    let (bin_path, mut args) = if detection.installed {
        // Use copilot-api directly
        let copilot_bin = detection.copilot_bin.clone()
            .ok_or_else(|| format!(
                "copilot-api binary path not found.\n\n\
                Checked paths: {}",
                detection.checked_copilot_paths.join(", ")
            ))?;
        println!("[copilot:{}] Using globally installed copilot-api: {}{}",
            instance.name,
            copilot_bin,
            detection.version.as_ref().map(|v| format!(" v{}", v)).unwrap_or_default());
        (copilot_bin, vec![])
    } else if let Some(bunx_bin) = detection.bunx_bin.clone() {
        // Prefer bunx since copilot-api is now a Bun package (requires Bun >= 1.2.x)
        println!("[copilot:{}] Using bunx: {} copilot-api start", instance.name, bunx_bin);
        (bunx_bin, vec!["copilot-api".to_string()])
    } else if let Some(npx_bin) = detection.npx_bin.clone() {
        // Fallback to npx (may work with older versions)
        println!("[copilot:{}] Using npx: {} copilot-api@latest", instance.name, npx_bin);
        (npx_bin, vec!["copilot-api@latest".to_string()])
    } else {
        return Err(
            "Could not start GitHub Copilot bridge.\n\n\
            The copilot-api package now requires Bun (recommended) or Node.js.\n\n\
            Option 1 - Install Bun (recommended):\n\
            • macOS/Linux: curl -fsSL https://bun.sh/install | bash\n\
            • Then restart CodexManager\n\n\
            Option 2 - Run manually in terminal:\n\
            • bunx copilot-api start --port 4141\n\
            • Or: npx copilot-api@latest start --port 4141\n\n\
            For more info: https://github.com/ericc-ch/copilot-api".to_string()
        );
    };
    
    // Add common arguments
    args.push("start".to_string());
    args.push("--port".to_string());
    args.push(port.to_string());
    
    // Add account type if specified
    if !instance.account_type.is_empty() {
        args.push("--account".to_string());
        args.push(instance.account_type.clone());
    }
    
    // Add GitHub token if specified (for direct authentication)
    if !instance.github_token.is_empty() {
        args.push("--github-token".to_string());
        args.push(instance.github_token.clone());
    }
    
    // Add rate limit if specified
    if let Some(rate_limit) = instance.rate_limit {
        args.push("--rate-limit".to_string());
        args.push(rate_limit.to_string());
    }
    
    // Add rate limit wait flag (copilot-api uses --wait)
    if instance.rate_limit_wait {
        args.push("--wait".to_string());
    }
    
    println!("[copilot:{}] Executing: {} {}", instance.name, bin_path, args.join(" "));
    
    let command = app.shell().command(&bin_path).args(&args);
    
    let (mut rx, child) = command.spawn().map_err(|e| format!("Failed to spawn copilot-api: {}. Make sure Node.js is installed.", e))?;
    
    // Store the child process for this instance
    {
        let mut processes = state.copilot_processes.lock().unwrap();
        processes.insert(instance_id.clone(), child);
    }
    
    // Update status to running (but not yet authenticated)
    {
        let mut statuses = state.copilot_statuses.lock().unwrap();
        let status = statuses.instances.entry(instance_id.clone()).or_insert_with(|| CopilotStatus::new(&instance_id, port));
        status.running = true;
        status.port = port;
        status.endpoint = format!("http://localhost:{}", port);
        status.authenticated = false;
    }
    
    // Listen for stdout/stderr in background task
    let app_handle = app.clone();
    let instance_id_clone = instance_id.clone();
    let instance_name = instance.name.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        
        println!("[copilot:{}] Starting stdout/stderr listener...", instance_name);
        
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    println!("[copilot-api:{}] {}", instance_name, text);
                    
                    // Check for successful login message
                    // copilot-api outputs "Listening on: http://localhost:PORT/" when ready
                    let text_lower = text.to_lowercase();
                    if text_lower.contains("listening on") || text.contains("Logged in as") || text.contains("Server running") {
                        // Update authenticated status
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            let mut statuses = state.copilot_statuses.lock().unwrap();
                            if let Some(status) = statuses.instances.get_mut(&instance_id_clone) {
                                status.authenticated = true;
                                let _ = app_handle.emit("copilot-status-changed", status.clone());
                                let _ = app_handle.emit("copilot-statuses-changed", statuses.clone());
                            }
                            println!("[copilot:{}] ✓ Authenticated via stdout detection", instance_name);
                        }
                    }
                    
                    // Check for auth URL in output
                    if text.contains("https://github.com/login/device") || text.contains("device code") {
                        // Emit auth required event
                        let _ = app_handle.emit("copilot-auth-required", serde_json::json!({
                            "instanceId": instance_id_clone,
                            "message": text.to_string()
                        }));
                        println!("[copilot:{}] Auth required - device code flow initiated", instance_name);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    eprintln!("[copilot-api:{}:ERROR] {}", instance_name, text);
                    
                    // Some processes log to stderr even for non-errors
                    // Check if it's actually a login/running message
                    let text_lower = text.to_lowercase();
                    if text_lower.contains("listening on") || text.contains("Logged in as") || text.contains("Server running") {
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            let mut statuses = state.copilot_statuses.lock().unwrap();
                            if let Some(status) = statuses.instances.get_mut(&instance_id_clone) {
                                status.authenticated = true;
                                let _ = app_handle.emit("copilot-status-changed", status.clone());
                                let _ = app_handle.emit("copilot-statuses-changed", statuses.clone());
                            }
                            println!("[copilot:{}] ✓ Authenticated via stderr detection", instance_name);
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    println!("[copilot-api:{}] Process terminated: {:?}", instance_name, payload);
                    // Update status when process dies
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        let mut statuses = state.copilot_statuses.lock().unwrap();
                        if let Some(status) = statuses.instances.get_mut(&instance_id_clone) {
                            status.running = false;
                            status.authenticated = false;
                            let _ = app_handle.emit("copilot-status-changed", status.clone());
                            let _ = app_handle.emit("copilot-statuses-changed", statuses.clone());
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    
    // Wait for copilot-api to be ready (up to 8 seconds)
    // bunx/npx may need to download packages on first run, which takes ~5s
    let client = crate::build_management_client();
    let health_url = format!("http://127.0.0.1:{}/v1/models", port);
    
    for i in 0..16 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        
        // Check if stdout listener already detected authentication
        {
            let statuses = state.copilot_statuses.lock().unwrap();
            let status = statuses.instances.get(&instance_id).cloned().unwrap_or_default();
            if status.authenticated {
                println!("[copilot:{}] ✓ Ready via stdout detection at {:.1}s", instance.name, (i + 1) as f32 * 0.5);
                let _ = app.emit("copilot-status-changed", &status);
                return Ok(status);
            }
            if !status.running {
                return Err(format!("Copilot instance '{}' stopped unexpectedly", instance.name));
            }
        }
        
        // Also check health endpoint
        if let Ok(response) = client
            .get(&health_url)
            .timeout(std::time::Duration::from_secs(1))
            .send()
            .await
        {
            if response.status().is_success() {
                println!("[copilot:{}] ✓ Ready via health check at {:.1}s", instance.name, (i + 1) as f32 * 0.5);
                let new_status = {
                    let mut statuses = state.copilot_statuses.lock().unwrap();
                    let status = statuses.instances.entry(instance_id.clone()).or_insert_with(|| CopilotStatus::new(&instance_id, port));
                    status.authenticated = true;
                    status.clone()
                };
                let _ = app.emit("copilot-status-changed", &new_status);
                let _ = app.emit("copilot-statuses-changed", state.copilot_statuses.lock().unwrap().clone());
                return Ok(new_status);
            }
        }
    }
    
    // Return with "running but not authenticated" status after timeout
    // The background task will continue polling and emit status updates
    let initial_status = {
        let statuses = state.copilot_statuses.lock().unwrap();
        statuses.instances.get(&instance_id).cloned().unwrap_or_default()
    };
    println!("[copilot:{}] Returning after 8s wait: running={}, authenticated={}", instance.name, initial_status.running, initial_status.authenticated);
    let _ = app.emit("copilot-status-changed", &initial_status);
    
    // Spawn background task to poll for authentication
    // This runs independently and emits status updates as authentication completes
    let app_handle = app.clone();
    let instance_id_poll = instance_id.clone();
    let instance_name_poll = instance.name.clone();
    tauri::async_runtime::spawn(async move {
        let client = crate::build_management_client();
        let health_url = format!("http://127.0.0.1:{}/v1/models", port);
        
        // Poll for up to 60 seconds to catch slower authentication (especially on first run)
        for i in 0..120 {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            
            // Check if stdout listener already detected authentication
            if let Some(state) = app_handle.try_state::<AppState>() {
                let statuses = state.copilot_statuses.lock().unwrap();
                let status = statuses.instances.get(&instance_id_poll).cloned().unwrap_or_default();
                if status.authenticated {
                    println!("✓ Copilot:{} authenticated via stdout detection at {:.1}s", instance_name_poll, i as f32 * 0.5);
                    return;
                }
                // If process stopped, exit polling
                if !status.running {
                    println!("⚠ Copilot:{} process stopped, ending auth poll", instance_name_poll);
                    return;
                }
            }
            
            // Also check health endpoint
            if let Ok(response) = client
                .get(&health_url)
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
            {
                if response.status().is_success() {
                    println!("✓ Copilot:{} authenticated via health check at {:.1}s", instance_name_poll, i as f32 * 0.5);
                    // Update status
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        let mut statuses = state.copilot_statuses.lock().unwrap();
                        if let Some(status) = statuses.instances.get_mut(&instance_id_poll) {
                            status.authenticated = true;
                            let _ = app_handle.emit("copilot-status-changed", status.clone());
                            let _ = app_handle.emit("copilot-statuses-changed", statuses.clone());
                        }
                    }
                    return;
                }
            }
            
            // Log progress every 10 seconds
            if i > 0 && i % 20 == 0 {
                println!("⏳ Waiting for Copilot:{} authentication... ({:.0}s elapsed)", instance_name_poll, i as f32 * 0.5);
            }
        }
        
        println!("⚠ Copilot:{} authentication poll timed out after 60s - user may need to complete GitHub auth manually", instance_name_poll);
    });
    
    Ok(initial_status)
}

/// Legacy stop_copilot - stops the first/default instance
#[tauri::command]
pub async fn stop_copilot(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<CopilotStatus, String> {
    let config = state.config.lock().unwrap().clone();
    let instance = config.copilot.instances.first()
        .ok_or("No Copilot instances configured")?;
    
    stop_copilot_instance(app, state, instance.id.clone()).await
}

/// Stop a specific Copilot instance by ID
#[tauri::command]
pub async fn stop_copilot_instance(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<CopilotStatus, String> {
    // Kill the child process for this instance
    {
        let mut processes = state.copilot_processes.lock().unwrap();
        if let Some(child) = processes.remove(&instance_id) {
            child.kill().map_err(|e| format!("Failed to kill copilot-api: {}", e))?;
        }
    }
    
    // Update status
    let new_status = {
        let mut statuses = state.copilot_statuses.lock().unwrap();
        let status = statuses.instances.entry(instance_id.clone()).or_insert_with(|| CopilotStatus::new(&instance_id, 4141));
        status.running = false;
        status.authenticated = false;
        status.clone()
    };
    
    // Emit status update
    let _ = app.emit("copilot-status-changed", &new_status);
    let _ = app.emit("copilot-statuses-changed", state.copilot_statuses.lock().unwrap().clone());
    
    Ok(new_status)
}

/// Stop all Copilot instances
#[tauri::command]
pub async fn stop_all_copilot_instances(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Get all instance IDs
    let instance_ids: Vec<String> = {
        let processes = state.copilot_processes.lock().unwrap();
        processes.keys().cloned().collect()
    };
    
    // Stop each instance
    for instance_id in instance_ids {
        let _ = stop_copilot_instance(app.clone(), state.clone(), instance_id).await;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn check_copilot_health(state: State<'_, AppState>) -> Result<CopilotStatus, String> {
    let config = state.config.lock().unwrap().clone();
    // Check first instance by default
    let instance = config.copilot.instances.first()
        .ok_or("No Copilot instances configured")?;
    let port = instance.port;
    
    let client = crate::build_management_client();
    let health_url = format!("http://127.0.0.1:{}/v1/models", port);
    
    let (running, authenticated) = match client
        .get(&health_url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(response) => (true, response.status().is_success()),
        Err(_) => (false, false),
    };
    
    // Update status
    let new_status = {
        let mut statuses = state.copilot_statuses.lock().unwrap();
        let status = statuses.instances.entry(instance.id.clone()).or_insert_with(|| CopilotStatus::new(&instance.id, port));
        status.running = running;
        status.authenticated = authenticated;
        if running {
            status.port = port;
            status.endpoint = format!("http://localhost:{}", port);
        }
        status.clone()
    };
    
    Ok(new_status)
}

#[tauri::command]
pub async fn detect_copilot_api(app: tauri::AppHandle) -> Result<CopilotApiDetection, String> {
    // Common Node.js installation paths on macOS/Linux
    // GUI apps don't inherit shell PATH, so we need to check common locations
    // Including version managers: Volta, nvm, fnm, asdf
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("~"));
    let home_str = home.to_string_lossy();
    
    // Helper: find nvm node binary by checking versions directory
    let find_nvm_node = |home: &std::path::Path| -> Option<String> {
        let nvm_versions = home.join(".nvm/versions/node");
        if nvm_versions.exists() {
            // Try to read the default alias first
            let default_alias = home.join(".nvm/alias/default");
            if let Ok(alias) = std::fs::read_to_string(&default_alias) {
                let alias = alias.trim();
                // Find matching version directory
                if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        let name_str = name.to_string_lossy();
                        if name_str.starts_with(&format!("v{}", alias)) || name_str == alias {
                            let node_path = entry.path().join("bin/node");
                            if node_path.exists() {
                                return Some(node_path.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
            // Fallback: use the most recent version (sorted alphabetically, last is usually newest)
            if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
                let mut versions: Vec<_> = entries
                    .flatten()
                    .filter(|e| e.path().join("bin/node").exists())
                    .collect();
                versions.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // Descending
                if let Some(entry) = versions.first() {
                    let node_path = entry.path().join("bin/node");
                    return Some(node_path.to_string_lossy().to_string());
                }
            }
        }
        None
    };
    
    let mut node_paths: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            // Version managers (most common for developers)
            format!("{}/.volta/bin/node", home_str),      // Volta
            format!("{}/.fnm/current/bin/node", home_str), // fnm
            format!("{}/.asdf/shims/node", home_str),      // asdf
            // System package managers
            "/opt/homebrew/bin/node".to_string(),      // Apple Silicon Homebrew
            "/usr/local/bin/node".to_string(),          // Intel Homebrew / manual install
            "/usr/bin/node".to_string(),                // System install
            "/opt/local/bin/node".to_string(),          // MacPorts
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            // Standard Windows Node.js installation paths
            "C:\\Program Files\\nodejs\\node.exe".to_string(),
            "C:\\Program Files (x86)\\nodejs\\node.exe".to_string(),
            // Version managers on Windows
            format!("{}/.volta/bin/node.exe", home_str),  // Volta
            format!("{}/AppData/Roaming/nvm/current/node.exe", home_str), // nvm-windows
            format!("{}/AppData/Local/fnm_multishells/node.exe", home_str), // fnm
            format!("{}/scoop/apps/nodejs/current/node.exe", home_str), // Scoop
            format!("{}/scoop/apps/nodejs-lts/current/node.exe", home_str), // Scoop LTS
            // Chocolatey installation path
            "C:\\ProgramData\\chocolatey\\bin\\node.exe".to_string(),
            // Windows Store / winget paths
            format!("{}/AppData/Local/Microsoft/WindowsApps/node.exe", home_str),
            // npm global bin (for detecting npm-installed tools)
            format!("{}/AppData/Roaming/npm/node.exe", home_str),
            // PowerShell profile paths (pnpm, yarn global)
            format!("{}/AppData/Local/pnpm/node.exe", home_str),
            // Fallback to PATH (works with any terminal: CMD, PowerShell, Windows Terminal)
            "node.exe".to_string(),
            "node".to_string(),
        ]
    } else {
        vec![
            // Version managers
            format!("{}/.volta/bin/node", home_str),
            format!("{}/.fnm/current/bin/node", home_str),
            format!("{}/.asdf/shims/node", home_str),
            // System paths
            "/usr/bin/node".to_string(),
            "/usr/local/bin/node".to_string(),
            "/home/linuxbrew/.linuxbrew/bin/node".to_string(),
        ]
    };
    
    // Add nvm path if found (nvm doesn't use a simple symlink structure)
    if cfg!(not(target_os = "windows")) {
        if let Some(nvm_node) = find_nvm_node(&home) {
            node_paths.insert(0, nvm_node); // Prioritize nvm
        }
    };
    
    // Find working node binary and get version
    let mut node_bin: Option<String> = None;
    let mut node_version: Option<String> = None;
    for path in &node_paths {
        let check = app.shell().command(path).args(["--version"]).output().await;
        if let Ok(ref output) = check {
            if output.status.success() {
                node_bin = Some(path.to_string());
                node_version = Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
                break;
            }
        }
    }
    
    // Also try just "node" in case PATH is available
    if node_bin.is_none() {
        let check = app.shell().command("node").args(["--version"]).output().await;
        if let Ok(ref output) = check {
            if output.status.success() {
                node_bin = Some("node".to_string());
                node_version = Some(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }
    }
    
    if node_bin.is_none() {
        // Even without Node, check if bunx is available (bun can run copilot-api)
        let bunx_paths: Vec<String> = if cfg!(target_os = "macos") {
            vec![
                format!("{}/.bun/bin/bunx", home_str),
                "/opt/homebrew/bin/bunx".to_string(),
                "/usr/local/bin/bunx".to_string(),
            ]
        } else if cfg!(target_os = "windows") {
            vec![
                format!("{}/.bun/bin/bunx.exe", home_str),
                format!("{}/AppData/Local/bun/bunx.exe", home_str),
            ]
        } else {
            vec![
                format!("{}/.bun/bin/bunx", home_str),
                "/usr/local/bin/bunx".to_string(),
            ]
        };
        
        let mut bunx_bin: Option<String> = None;
        for path in &bunx_paths {
            let check = app.shell().command(path).args(["--version"]).output().await;
            if check.as_ref().map(|o| o.status.success()).unwrap_or(false) {
                bunx_bin = Some(path.clone());
                println!("[copilot] Found bunx at: {} (no Node.js needed)", path);
                break;
            }
        }
        
        if bunx_bin.is_some() {
            // Bun available, can still run copilot-api via bunx
            return Ok(CopilotApiDetection {
                installed: false,
                version: None,
                copilot_bin: None,
                npx_bin: None,
                npm_bin: None,
                node_bin: None,
                node_version: None,
                bunx_bin,
                node_available: true, // Mark as available since bunx works
                checked_node_paths: node_paths,
                checked_copilot_paths: vec![],
            });
        }
        
        return Ok(CopilotApiDetection {
            installed: false,
            version: None,
            copilot_bin: None,
            npx_bin: None,
            npm_bin: None,
            node_bin: None,
            node_version: None,
            bunx_bin: None,
            node_available: false,
            checked_node_paths: node_paths,
            checked_copilot_paths: vec![],
        });
    }
    
    // Derive npm/npx paths from node path (handle Windows and Unix paths)
    let npx_bin = node_bin.as_ref().map(|n| {
        if cfg!(target_os = "windows") {
            if n == "node" || n == "node.exe" {
                "npx.cmd".to_string()
            } else {
                n.replace("\\node.exe", "\\npx.cmd")
                    .replace("/node.exe", "/npx.cmd")
                    .replace("\\node", "\\npx")
                    .replace("/node", "/npx")
            }
        } else {
            let n_trimmed = n.trim();
            if n_trimmed == "node" {
                "npx".to_string()
            } else if n_trimmed.ends_with("/node") {
                let node_len = "/node".len();
                format!("{}/npx", &n_trimmed[..n_trimmed.len() - node_len])
            } else {
                // Fallback: npx should be alongside node
                "npx".to_string()
            }
        }
    }).unwrap_or_else(|| if cfg!(target_os = "windows") { "npx.cmd".to_string() } else { "npx".to_string() });
    
    let npm_bin = node_bin.as_ref().map(|n| {
        if cfg!(target_os = "windows") {
            n.replace("\\node.exe", "\\npm.cmd")
                .replace("/node.exe", "/npm.cmd")
                .replace("\\node", "\\npm")
                .replace("/node", "/npm")
        } else {
            n.replace("/node", "/npm")
        }
    }).unwrap_or_else(|| if cfg!(target_os = "windows") { "npm.cmd".to_string() } else { "npm".to_string() });
    
    // Check for bun/bunx (preferred over npx - faster startup)
    let bunx_paths: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            format!("{}/.bun/bin/bunx", home_str),
            "/opt/homebrew/bin/bunx".to_string(),
            "/usr/local/bin/bunx".to_string(),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            format!("{}/.bun/bin/bunx.exe", home_str),
            format!("{}/AppData/Local/bun/bunx.exe", home_str),
        ]
    } else {
        vec![
            format!("{}/.bun/bin/bunx", home_str),
            "/usr/local/bin/bunx".to_string(),
        ]
    };
    
    let mut bunx_bin: Option<String> = None;
    for path in &bunx_paths {
        let check = app.shell().command(path).args(["--version"]).output().await;
        if check.as_ref().map(|o| o.status.success()).unwrap_or(false) {
            bunx_bin = Some(path.clone());
            println!("[copilot] Found bunx at: {}", path);
            break;
        }
    }
    
    // Try to find copilot-api binary directly first
    let copilot_paths: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            // Version managers (most common for developers)
            format!("{}/.volta/bin/copilot-api", home_str),
            format!("{}/.nvm/current/bin/copilot-api", home_str),
            format!("{}/.fnm/current/bin/copilot-api", home_str),
            format!("{}/.asdf/shims/copilot-api", home_str),
            // Package managers
            "/opt/homebrew/bin/copilot-api".to_string(),
            "/usr/local/bin/copilot-api".to_string(),
            "/usr/bin/copilot-api".to_string(),
            // pnpm/yarn global bins
            format!("{}/Library/pnpm/copilot-api", home_str),
            format!("{}/.local/share/pnpm/copilot-api", home_str),
            format!("{}/.yarn/bin/copilot-api", home_str),
            format!("{}/.config/yarn/global/node_modules/.bin/copilot-api", home_str),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            // npm global bin (most common location after npm install -g)
            format!("{}/AppData/Roaming/npm/copilot-api.cmd", home_str),
            // Version managers on Windows
            format!("{}/.volta/bin/copilot-api.exe", home_str),  // Volta
            format!("{}/AppData/Roaming/nvm/current/copilot-api.cmd", home_str), // nvm-windows
            format!("{}/scoop/apps/nodejs/current/bin/copilot-api.cmd", home_str), // Scoop
            // Fallback to PATH
            "copilot-api.cmd".to_string(),
            "copilot-api".to_string(),
        ]
    } else {
        vec![
            format!("{}/.volta/bin/copilot-api", home_str),
            format!("{}/.nvm/current/bin/copilot-api", home_str),
            format!("{}/.fnm/current/bin/copilot-api", home_str),
            format!("{}/.asdf/shims/copilot-api", home_str),
            "/usr/local/bin/copilot-api".to_string(),
            "/usr/bin/copilot-api".to_string(),
        ]
    };
    
    for path in &copilot_paths {
        let check = app.shell().command(path).args(["--version"]).output().await;
        if check.as_ref().map(|o| o.status.success()).unwrap_or(false) {
            return Ok(CopilotApiDetection {
                installed: true,
                version: None,
                copilot_bin: Some(path.to_string()),
                npx_bin: Some(npx_bin),
                npm_bin: Some(npm_bin),
                node_bin: node_bin.clone(),
                node_version: node_version.clone(),
                bunx_bin,
                node_available: true,
                checked_node_paths: node_paths,
                checked_copilot_paths: copilot_paths,
            });
        }
    }
    
    // Check if copilot-api is installed globally via npm
    let npm_list = app
        .shell()
        .command(&npm_bin)
        .args(["list", "-g", "copilot-api", "--depth=0", "--json"])
        .output()
        .await;
    
    if let Ok(output) = npm_list {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(deps) = json.get("dependencies") {
                    if let Some(copilot) = deps.get("copilot-api") {
                        let version = copilot.get("version")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        
                        // npm says it's installed, derive copilot-api path from npm prefix
                        let copilot_bin = node_bin.as_ref()
                            .map(|n| {
                                if cfg!(target_os = "windows") {
                                    // Windows: node.exe -> copilot-api.cmd
                                    n.replace("\\node.exe", "\\copilot-api.cmd")
                                        .replace("/node.exe", "/copilot-api.cmd")
                                        .replace("\\node", "\\copilot-api.cmd")
                                        .replace("/node", "/copilot-api.cmd")
                                } else {
                                    n.replace("/node", "/copilot-api")
                                }
                            })
                            .unwrap_or_else(|| {
                                if cfg!(target_os = "windows") {
                                    "copilot-api.cmd".to_string()
                                } else {
                                    "copilot-api".to_string()
                                }
                            });
                        
                        return Ok(CopilotApiDetection {
                            installed: true,
                            version,
                            copilot_bin: Some(copilot_bin),
                            npx_bin: Some(npx_bin),
                            npm_bin: Some(npm_bin),
                            node_bin: node_bin.clone(),
                            node_version: node_version.clone(),
                            bunx_bin,
                            node_available: true,
                            checked_node_paths: node_paths,
                            checked_copilot_paths: copilot_paths,
                        });
                    }
                }
            }
        }
    }
    
    // Not installed globally
    Ok(CopilotApiDetection {
        installed: false,
        version: None,
        copilot_bin: None,
        npx_bin: Some(npx_bin),
        npm_bin: Some(npm_bin),
        node_bin: node_bin.clone(),
        node_version,
        bunx_bin,
        node_available: true,
        checked_node_paths: node_paths,
        checked_copilot_paths: copilot_paths,
    })
}

#[tauri::command]
pub async fn install_copilot_api(app: tauri::AppHandle) -> Result<CopilotApiInstallResult, String> {
    // Find npm binary - GUI apps don't inherit shell PATH on macOS
    // Including version managers: Volta, nvm, fnm, asdf
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("~"));
    let home_str = home.to_string_lossy();
    
    let npm_paths: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            // Version managers (most common for developers)
            format!("{}/.volta/bin/npm", home_str),
            format!("{}/.nvm/current/bin/npm", home_str),
            format!("{}/.fnm/current/bin/npm", home_str),
            format!("{}/.asdf/shims/npm", home_str),
            // System package managers
            "/opt/homebrew/bin/npm".to_string(),
            "/usr/local/bin/npm".to_string(),
            "/usr/bin/npm".to_string(),
            "/opt/local/bin/npm".to_string(),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            // Standard Windows Node.js installation paths
            "C:\\Program Files\\nodejs\\npm.cmd".to_string(),
            "C:\\Program Files (x86)\\nodejs\\npm.cmd".to_string(),
            // Version managers on Windows
            format!("{}/.volta/bin/npm.exe", home_str),  // Volta
            format!("{}/AppData/Roaming/nvm/current/npm.cmd", home_str), // nvm-windows
            format!("{}/AppData/Local/fnm_multishells/npm.cmd", home_str), // fnm
            format!("{}/scoop/apps/nodejs/current/npm.cmd", home_str), // Scoop
            format!("{}/scoop/apps/nodejs-lts/current/npm.cmd", home_str), // Scoop LTS
            format!("{}/AppData/Roaming/npm/npm.cmd", home_str),
            // Fallback to PATH
            "npm.cmd".to_string(),
            "npm".to_string(),
        ]
    } else {
        vec![
            format!("{}/.volta/bin/npm", home_str),
            format!("{}/.nvm/current/bin/npm", home_str),
            format!("{}/.fnm/current/bin/npm", home_str),
            format!("{}/.asdf/shims/npm", home_str),
            "/usr/bin/npm".to_string(),
            "/usr/local/bin/npm".to_string(),
            "/home/linuxbrew/.linuxbrew/bin/npm".to_string(),
        ]
    };
    
    let mut npm_bin: Option<String> = None;
    for path in &npm_paths {
        let check = app.shell().command(path).args(["--version"]).output().await;
        if check.as_ref().map(|o| o.status.success()).unwrap_or(false) {
            npm_bin = Some(path.to_string());
            break;
        }
    }
    
    // Also try just "npm" in case PATH is available
    if npm_bin.is_none() {
        let check = app.shell().command("npm").args(["--version"]).output().await;
        if check.as_ref().map(|o| o.status.success()).unwrap_or(false) {
            npm_bin = Some("npm".to_string());
        }
    }
    
    let npm_bin = match npm_bin {
        Some(bin) => bin,
        None => {
            return Ok(CopilotApiInstallResult {
                success: false,
                message: "Node.js/npm is required. Please install Node.js from https://nodejs.org/".to_string(),
                version: None,
            });
        }
    };
    
    // Install copilot-api globally
    let install_output = app
        .shell()
        .command(&npm_bin)
        .args(["install", "-g", "copilot-api"])
        .output()
        .await
        .map_err(|e| format!("Failed to run npm install: {}", e))?;
    
    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr);
        return Ok(CopilotApiInstallResult {
            success: false,
            message: format!("Installation failed: {}", stderr),
            version: None,
        });
    }
    
    // Get the installed version
    let detection = detect_copilot_api(app).await?;
    
    if detection.installed {
        Ok(CopilotApiInstallResult {
            success: true,
            message: format!("Successfully installed copilot-api{}", 
                detection.version.as_ref().map(|v| format!(" v{}", v)).unwrap_or_default()),
            version: detection.version,
        })
    } else {
        Ok(CopilotApiInstallResult {
            success: false,
            message: "Installation completed but copilot-api was not found. You may need to restart your terminal.".to_string(),
            version: None,
        })
    }
}
