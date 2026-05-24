use russh::keys::decode_secret_key;
use serde::{Deserialize, Serialize};

pub type CommandResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: ProfileAuth,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileAuth {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
    Saved,
}

#[derive(Debug, Clone)]
pub struct SaveProfileRequest {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: ProfileAuth,
}

#[derive(Debug, Clone)]
pub struct ProfileSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: String,
    pub auth_label: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Vault {
    pub profiles: Vec<StoredProfile>,
}

#[derive(Debug, Clone)]
pub enum UiEvent {
    TerminalData {
        session_id: String,
        data: Vec<u8>,
    },
    Status {
        session_id: String,
        status: ConnectionStatus,
        message: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connecting,
    Connected,
    Exited,
    Disconnected,
    Error,
}

impl ConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Exited => "exited",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Connecting => "Connecting",
            Self::Connected => "Connected",
            Self::Exited => "Exited",
            Self::Disconnected => "Disconnected",
            Self::Error => "Error",
        }
    }
}

impl From<StoredProfile> for ProfileSummary {
    fn from(profile: StoredProfile) -> Self {
        let (auth_kind, auth_label) = match &profile.auth {
            ProfileAuth::Password { .. } => ("password".to_string(), "PW".to_string()),
            ProfileAuth::Key {
                private_key,
                passphrase,
            } => {
                let label = decode_secret_key(private_key, passphrase.as_deref())
                    .map(|key| format!("KEY({})", key.algorithm()))
                    .unwrap_or_else(|_| "KEY".to_string());
                ("key".to_string(), label)
            }
            ProfileAuth::Saved => ("saved".to_string(), "SAVED".to_string()),
        };

        Self {
            id: profile.id,
            name: profile.name,
            host: profile.host,
            port: profile.port,
            username: profile.username,
            auth_kind,
            auth_label,
            updated_at: profile.updated_at,
        }
    }
}

pub fn validate_profile(profile: &SaveProfileRequest) -> CommandResult<()> {
    validate_profile_fields(profile)?;
    validate_auth(&profile.auth)
}

pub fn validate_profile_fields(profile: &SaveProfileRequest) -> CommandResult<()> {
    if profile.name.trim().is_empty() {
        return Err("Profile name is required".to_string());
    }
    if profile.host.trim().is_empty() {
        return Err("Host is required".to_string());
    }
    if profile.username.trim().is_empty() {
        return Err("Username is required".to_string());
    }
    if profile.port == 0 {
        return Err("Port must be greater than zero".to_string());
    }
    Ok(())
}

pub fn validate_auth(auth: &ProfileAuth) -> CommandResult<()> {
    match auth {
        ProfileAuth::Password { password } if password.is_empty() => {
            Err("Password is required".to_string())
        }
        ProfileAuth::Key { private_key, .. } if private_key.trim().is_empty() => {
            Err("Private key content is required".to_string())
        }
        ProfileAuth::Saved => {
            Err("Saved credential cannot be used for a new connection".to_string())
        }
        _ => Ok(()),
    }
}
