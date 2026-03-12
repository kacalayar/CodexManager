use tauri::{AppHandle, State, command};
use crate::cloudflare_manager::CloudflareManager;
use crate::config::{save_config_to_file, load_config};
use crate::types::cloudflare::CloudflareConfig;

#[command]
pub async fn get_cloudflare_configs() -> Result<Vec<CloudflareConfig>, String> {
    let config = load_config();
    Ok(config.cloudflare_configs)
}

#[command]
pub async fn save_cloudflare_config(cf_config: CloudflareConfig) -> Result<Vec<CloudflareConfig>, String> {
    let mut current_config = load_config();
    
    if let Some(idx) = current_config.cloudflare_configs.iter().position(|c| c.id == cf_config.id) {
        current_config.cloudflare_configs[idx] = cf_config;
    } else {
        current_config.cloudflare_configs.push(cf_config);
    }
    
    save_config_to_file(&current_config)?;
    Ok(current_config.cloudflare_configs)
}

#[command]
pub async fn delete_cloudflare_config(_app: AppHandle, state: State<'_, CloudflareManager>, id: String) -> Result<Vec<CloudflareConfig>, String> {
    let mut current_config = load_config();
    
    // Stop if running
    state.disconnect(&id);
    
    current_config.cloudflare_configs.retain(|c| c.id != id);
    save_config_to_file(&current_config)?;
    Ok(current_config.cloudflare_configs)
}

#[command]
pub async fn set_cloudflare_connection(
    app: AppHandle,
    state: State<'_, CloudflareManager>,
    id: String,
    enable: bool
) -> Result<(), String> {
    let mut config = load_config();
    if let Some(c) = config.cloudflare_configs.iter_mut().find(|c| c.id == id) {
        c.enabled = enable;
        let target_config = c.clone();
        
        // Save persistent state
        save_config_to_file(&config)?;
        
        if enable {
            state.connect(app, target_config);
        } else {
            state.disconnect(&id);
        }
        Ok(())
    } else {
        Err("Config not found".to_string())
    }
}
