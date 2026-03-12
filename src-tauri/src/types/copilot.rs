use serde::{Deserialize, Serialize};

/// Unique identifier for a Copilot instance
pub type CopilotInstanceId = String;

/// Configuration for a single Copilot instance
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotInstanceConfig {
    /// Unique identifier for this instance
    pub id: CopilotInstanceId,
    /// Display name for this instance (e.g., "Personal", "Work")
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_copilot_port")]
    pub port: u16,
    #[serde(default)]
    pub account_type: String,
    /// GitHub username (populated after authentication)
    #[serde(default)]
    pub github_username: String,
    #[serde(default)]
    pub github_token: String,
    #[serde(default)]
    pub rate_limit: Option<u16>,
    #[serde(default)]
    pub rate_limit_wait: bool,
}

fn default_copilot_port() -> u16 {
    4141
}

impl Default for CopilotInstanceConfig {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".to_string(),
            enabled: false,
            port: 4141,
            account_type: "individual".to_string(),
            github_username: String::new(),
            github_token: String::new(),
            rate_limit: None,
            rate_limit_wait: false,
        }
    }
}

/// Configuration container for all Copilot instances
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotConfig {
    /// List of Copilot instances
    #[serde(default = "default_instances")]
    pub instances: Vec<CopilotInstanceConfig>,
}

fn default_instances() -> Vec<CopilotInstanceConfig> {
    vec![CopilotInstanceConfig::default()]
}

impl Default for CopilotConfig {
    fn default() -> Self {
        Self {
            instances: default_instances(),
        }
    }
}

impl CopilotConfig {
    /// Get an instance by ID
    pub fn get_instance(&self, id: &str) -> Option<&CopilotInstanceConfig> {
        self.instances.iter().find(|i| i.id == id)
    }

    /// Get a mutable instance by ID
    #[allow(dead_code)]
    pub fn get_instance_mut(&mut self, id: &str) -> Option<&mut CopilotInstanceConfig> {
        self.instances.iter_mut().find(|i| i.id == id)
    }

    /// Get the next available port (starting from 4141)
    #[allow(dead_code)]
    pub fn next_available_port(&self) -> u16 {
        let used_ports: std::collections::HashSet<u16> = self.instances.iter().map(|i| i.port).collect();
        let mut port = 4141u16;
        while used_ports.contains(&port) {
            port += 1;
        }
        port
    }
}

/// Status of a single Copilot instance
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotStatus {
    pub id: CopilotInstanceId,
    pub running: bool,
    pub port: u16,
    pub endpoint: String,
    pub authenticated: bool,
    /// GitHub username if authenticated
    #[serde(default)]
    pub github_username: Option<String>,
}

impl Default for CopilotStatus {
    fn default() -> Self {
        Self {
            id: String::new(),
            running: false,
            port: 4141,
            endpoint: "http://localhost:4141".to_string(),
            authenticated: false,
            github_username: None,
        }
    }
}

impl CopilotStatus {
    pub fn new(id: &str, port: u16) -> Self {
        Self {
            id: id.to_string(),
            running: false,
            port,
            endpoint: format!("http://localhost:{}", port),
            authenticated: false,
            github_username: None,
        }
    }
}

/// Container for all Copilot instance statuses
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotStatusMap {
    pub instances: std::collections::HashMap<CopilotInstanceId, CopilotStatus>,
}

impl CopilotStatusMap {
     #[allow(dead_code)]
     pub fn get(&self, id: &str) -> Option<&CopilotStatus> {
         self.instances.get(id)
     }
 
     #[allow(dead_code)]
     pub fn get_mut(&mut self, id: &str) -> Option<&mut CopilotStatus> {
         self.instances.get_mut(id)
     }
 }
 
 #[derive(Debug, Clone, Serialize, Deserialize)]
 #[serde(rename_all = "camelCase")]
 pub struct CopilotApiDetection {
     pub installed: bool,
     pub version: Option<String>,
     pub copilot_bin: Option<String>,
     pub npx_bin: Option<String>,
     pub npm_bin: Option<String>,
     pub node_bin: Option<String>,
     pub node_version: Option<String>,
     pub bunx_bin: Option<String>,
     pub node_available: bool,
     pub checked_node_paths: Vec<String>,
     pub checked_copilot_paths: Vec<String>,
 }
 
 #[derive(Debug, Clone, Serialize, Deserialize)]
 #[serde(rename_all = "camelCase")]
 pub struct CopilotApiInstallResult {
     pub success: bool,
     pub message: String,
     pub version: Option<String>,
 }
