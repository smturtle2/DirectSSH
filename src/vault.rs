use crate::model::{
    validate_auth, validate_profile_fields, CommandResult, ProfileAuth, ProfileSummary,
    SaveProfileRequest, StoredProfile, Vault,
};
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone)]
pub struct VaultStore {
    data_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultEnvelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub terminal_font_size: i32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            terminal_font_size: 14,
        }
    }
}

impl VaultStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn list_profiles(&self) -> CommandResult<Vec<ProfileSummary>> {
        let mut profiles = self.load_vault()?.profiles;
        profiles.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(profiles.into_iter().map(ProfileSummary::from).collect())
    }

    pub fn save_profile(&self, profile: SaveProfileRequest) -> CommandResult<ProfileSummary> {
        validate_profile_fields(&profile)?;

        let mut vault = self.load_vault()?;
        let id = profile
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let auth = match profile.auth {
            ProfileAuth::Saved => vault
                .profiles
                .iter()
                .find(|item| item.id == id)
                .map(|item| item.auth.clone())
                .ok_or_else(|| "Saved credential is not available for this profile".to_string())?,
            auth => {
                validate_auth(&auth)?;
                auth
            }
        };

        let stored = StoredProfile {
            id: id.clone(),
            name: profile.name.trim().to_string(),
            host: profile.host.trim().to_string(),
            port: profile.port,
            username: profile.username.trim().to_string(),
            auth,
            updated_at: now_epoch(),
        };

        if let Some(existing) = vault.profiles.iter_mut().find(|item| item.id == id) {
            *existing = stored.clone();
        } else {
            vault.profiles.push(stored.clone());
        }

        self.save_vault(&vault)?;
        Ok(ProfileSummary::from(stored))
    }

    pub fn delete_profile(&self, profile_id: &str) -> CommandResult<()> {
        let mut vault = self.load_vault()?;
        vault.profiles.retain(|profile| profile.id != profile_id);
        self.save_vault(&vault)
    }

    pub fn get_profile(&self, profile_id: &str) -> CommandResult<StoredProfile> {
        self.load_vault()?
            .profiles
            .into_iter()
            .find(|item| item.id == profile_id)
            .ok_or_else(|| "Profile not found".to_string())
    }

    pub fn load_settings(&self) -> AppSettings {
        let path = self.settings_path();
        fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &AppSettings) -> CommandResult<()> {
        if let Some(parent) = self.settings_path().parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create data dir: {error}"))?;
        }

        fs::write(
            self.settings_path(),
            serde_json::to_vec_pretty(settings)
                .map_err(|error| format!("Failed to encode settings: {error}"))?,
        )
        .map_err(|error| format!("Failed to write settings: {error}"))
    }

    fn load_vault(&self) -> CommandResult<Vault> {
        let path = self.vault_path();
        if !path.exists() {
            return Ok(Vault::default());
        }

        let envelope: VaultEnvelope = serde_json::from_slice(
            &fs::read(&path).map_err(|error| format!("Failed to read vault: {error}"))?,
        )
        .map_err(|error| format!("Failed to parse vault envelope: {error}"))?;

        if envelope.version != 1 {
            return Err("Unsupported vault version".to_string());
        }

        let key = self.load_or_create_key()?;
        let nonce = BASE64
            .decode(envelope.nonce)
            .map_err(|error| format!("Invalid vault nonce: {error}"))?;
        let ciphertext = BASE64
            .decode(envelope.ciphertext)
            .map_err(|error| format!("Invalid vault ciphertext: {error}"))?;
        let plaintext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "Failed to initialize vault cipher".to_string())?
            .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| "Failed to decrypt vault".to_string())?;

        serde_json::from_slice(&plaintext)
            .map_err(|error| format!("Failed to parse vault: {error}"))
    }

    fn save_vault(&self, vault: &Vault) -> CommandResult<()> {
        let key = self.load_or_create_key()?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);

        let plaintext = serde_json::to_vec(vault)
            .map_err(|error| format!("Failed to encode vault: {error}"))?;
        let ciphertext = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "Failed to initialize vault cipher".to_string())?
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| "Failed to encrypt vault".to_string())?;

        let envelope = VaultEnvelope {
            version: 1,
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };

        if let Some(parent) = self.vault_path().parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create data dir: {error}"))?;
        }
        fs::write(
            self.vault_path(),
            serde_json::to_vec_pretty(&envelope)
                .map_err(|error| format!("Failed to encode vault envelope: {error}"))?,
        )
        .map_err(|error| format!("Failed to write vault: {error}"))
    }

    fn load_or_create_key(&self) -> CommandResult<[u8; 32]> {
        let path = self.key_path();
        if path.exists() {
            let bytes =
                fs::read(path).map_err(|error| format!("Failed to read vault key: {error}"))?;
            if bytes.len() != 32 {
                return Err("Vault key has invalid length".to_string());
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create data dir: {error}"))?;
        }

        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        fs::write(&path, key).map_err(|error| format!("Failed to write vault key: {error}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Failed to protect vault key: {error}"))?;
        }

        Ok(key)
    }

    fn vault_path(&self) -> PathBuf {
        self.data_dir.join("profiles.vault")
    }

    fn key_path(&self) -> PathBuf {
        self.data_dir.join("vault.key")
    }

    fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}
