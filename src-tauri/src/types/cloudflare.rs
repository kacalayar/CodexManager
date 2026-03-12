use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareConfig {
    pub id: String,
    pub name: String,
    /// Tunnel token from Cloudflare dashboard (cloudflared service install <token>)
    pub tunnel_token: String,
    /// Local port to expose (usually 8320)
    pub local_port: u16,
    #[serde(default)]
    pub enabled: bool,
}
