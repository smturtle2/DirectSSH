use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use russh::client;
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Default)]
struct SessionRegistry {
    sessions: Arc<Mutex<HashMap<String, Arc<LiveSession>>>>,
}

struct LiveSession {
    client: Mutex<client::Handle<SshClient>>,
    writer: Arc<ChannelWriteHalf<client::Msg>>,
}

#[derive(Clone)]
struct SshClient;

impl client::Handler for SshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredProfile {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth: ProfileAuth,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ProfileAuth {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
    Saved,
}

#[derive(Debug, Deserialize)]
struct SaveProfileRequest {
    id: Option<String>,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth: ProfileAuth,
}

#[derive(Debug, Serialize)]
struct ProfileSummary {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: String,
    auth_label: String,
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct Vault {
    profiles: Vec<StoredProfile>,
}

#[derive(Debug, Serialize, Deserialize)]
struct VaultEnvelope {
    version: u8,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Serialize)]
struct TerminalOutput {
    session_id: String,
    stream: String,
    data: String,
}

#[derive(Clone, Debug, Serialize)]
struct TerminalStatus {
    session_id: String,
    status: String,
    message: Option<String>,
}

#[tauri::command]
async fn list_profiles(app: AppHandle) -> CommandResult<Vec<ProfileSummary>> {
    let mut profiles = load_vault(&app)?.profiles;
    profiles.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(profiles.into_iter().map(ProfileSummary::from).collect())
}

#[tauri::command]
async fn save_profile(
    app: AppHandle,
    profile: SaveProfileRequest,
) -> CommandResult<ProfileSummary> {
    validate_profile_fields(&profile)?;

    let mut vault = load_vault(&app)?;
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

    save_vault(&app, &vault)?;
    Ok(ProfileSummary::from(stored))
}

#[tauri::command]
async fn delete_profile(app: AppHandle, profile_id: String) -> CommandResult<()> {
    let mut vault = load_vault(&app)?;
    vault.profiles.retain(|profile| profile.id != profile_id);
    save_vault(&app, &vault)
}

#[tauri::command]
async fn connect_profile(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    profile_id: String,
    cols: u32,
    rows: u32,
) -> CommandResult<String> {
    let vault = load_vault(&app)?;
    let profile = vault
        .profiles
        .into_iter()
        .find(|item| item.id == profile_id)
        .ok_or_else(|| "Profile not found".to_string())?;

    open_ssh_session(app, registry.inner().clone(), profile, cols, rows).await
}

#[tauri::command]
async fn connect_ephemeral(
    app: AppHandle,
    registry: State<'_, SessionRegistry>,
    profile: SaveProfileRequest,
    cols: u32,
    rows: u32,
) -> CommandResult<String> {
    validate_profile(&profile)?;
    let stored = StoredProfile {
        id: Uuid::new_v4().to_string(),
        name: profile.name.trim().to_string(),
        host: profile.host.trim().to_string(),
        port: profile.port,
        username: profile.username.trim().to_string(),
        auth: profile.auth,
        updated_at: now_epoch(),
    };

    open_ssh_session(app, registry.inner().clone(), stored, cols, rows).await
}

#[tauri::command]
async fn send_input(
    registry: State<'_, SessionRegistry>,
    session_id: String,
    data: String,
) -> CommandResult<()> {
    let session = get_live_session(registry.inner(), &session_id).await?;
    session
        .writer
        .data_bytes(data.into_bytes())
        .await
        .map_err(|error| format!("Failed to send terminal input: {error}"))
}

#[tauri::command]
async fn resize_pty(
    registry: State<'_, SessionRegistry>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> CommandResult<()> {
    let session = get_live_session(registry.inner(), &session_id).await?;
    session
        .writer
        .window_change(cols.clamp(20, 500), rows.clamp(5, 200), 0, 0)
        .await
        .map_err(|error| format!("Failed to resize PTY: {error}"))
}

#[tauri::command]
async fn disconnect_session(
    registry: State<'_, SessionRegistry>,
    session_id: String,
) -> CommandResult<()> {
    let session = {
        let mut sessions = registry.sessions.lock().await;
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        let _ = session.writer.close().await;
        let _ = session
            .client
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }

    Ok(())
}

async fn open_ssh_session(
    app: AppHandle,
    registry: SessionRegistry,
    profile: StoredProfile,
    cols: u32,
    rows: u32,
) -> CommandResult<String> {
    let session_id = Uuid::new_v4().to_string();
    emit_status(
        &app,
        &session_id,
        "connecting",
        Some(format!(
            "{}@{}:{}",
            profile.username, profile.host, profile.port
        )),
    );

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let mut client = client::connect(config, (profile.host.as_str(), profile.port), SshClient)
        .await
        .map_err(|error| format!("SSH connection failed: {error}"))?;

    authenticate(&mut client, &profile).await?;

    let channel = client
        .channel_open_session()
        .await
        .map_err(|error| format!("Failed to open SSH channel: {error}"))?;

    channel
        .request_pty(
            false,
            "xterm-256color",
            cols.clamp(20, 500),
            rows.clamp(5, 200),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("Failed to request PTY: {error}"))?;

    channel
        .request_shell(false)
        .await
        .map_err(|error| format!("Failed to request shell: {error}"))?;

    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let live = Arc::new(LiveSession {
        client: Mutex::new(client),
        writer: writer.clone(),
    });

    registry
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), live);

    emit_status(
        &app,
        &session_id,
        "connected",
        Some("PTY shell opened".to_string()),
    );

    let app_for_task = app.clone();
    let registry_for_task = registry.clone();
    let read_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    let _ = app_for_task.emit(
                        "ssh-data",
                        TerminalOutput {
                            session_id: read_session_id.clone(),
                            stream: "stdout".to_string(),
                            data: String::from_utf8_lossy(&data).to_string(),
                        },
                    );
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    let _ = app_for_task.emit(
                        "ssh-data",
                        TerminalOutput {
                            session_id: read_session_id.clone(),
                            stream: "stderr".to_string(),
                            data: String::from_utf8_lossy(&data).to_string(),
                        },
                    );
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    emit_status(
                        &app_for_task,
                        &read_session_id,
                        "exited",
                        Some(format!("Remote shell exited with status {exit_status}")),
                    );
                }
                _ => {}
            }
        }

        registry_for_task
            .sessions
            .lock()
            .await
            .remove(&read_session_id);
        emit_status(&app_for_task, &read_session_id, "disconnected", None);
    });

    Ok(session_id)
}

async fn authenticate(
    client: &mut client::Handle<SshClient>,
    profile: &StoredProfile,
) -> CommandResult<()> {
    let auth_result = match &profile.auth {
        ProfileAuth::Password { password } => client
            .authenticate_password(profile.username.clone(), password.clone())
            .await
            .map_err(|error| format!("Password authentication failed: {error}"))?,
        ProfileAuth::Key {
            private_key,
            passphrase,
        } => {
            let key = decode_secret_key(private_key, passphrase.as_deref())
                .map_err(|error| format!("Private key parse failed: {error}"))?;
            let hash = client
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("Failed to negotiate RSA hash: {error}"))?
                .flatten();
            client
                .authenticate_publickey(
                    profile.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|error| format!("Private key authentication failed: {error}"))?
        }
        ProfileAuth::Saved => return Err("Saved credential could not be resolved".to_string()),
    };

    if auth_result.success() {
        Ok(())
    } else {
        Err("SSH authentication was rejected by the server".to_string())
    }
}

async fn get_live_session(
    registry: &SessionRegistry,
    session_id: &str,
) -> CommandResult<Arc<LiveSession>> {
    registry
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SSH session is not active".to_string())
}

fn validate_profile(profile: &SaveProfileRequest) -> CommandResult<()> {
    validate_profile_fields(profile)?;
    validate_auth(&profile.auth)
}

fn validate_profile_fields(profile: &SaveProfileRequest) -> CommandResult<()> {
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

fn validate_auth(auth: &ProfileAuth) -> CommandResult<()> {
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

fn load_vault(app: &AppHandle) -> CommandResult<Vault> {
    let path = vault_path(app)?;
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

    let key = load_or_create_key(app)?;
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

    serde_json::from_slice(&plaintext).map_err(|error| format!("Failed to parse vault: {error}"))
}

fn save_vault(app: &AppHandle, vault: &Vault) -> CommandResult<()> {
    let key = load_or_create_key(app)?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);

    let plaintext =
        serde_json::to_vec(vault).map_err(|error| format!("Failed to encode vault: {error}"))?;
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Failed to initialize vault cipher".to_string())?
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "Failed to encrypt vault".to_string())?;

    let envelope = VaultEnvelope {
        version: 1,
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    };

    let path = vault_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create data dir: {error}"))?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&envelope)
            .map_err(|error| format!("Failed to encode vault envelope: {error}"))?,
    )
    .map_err(|error| format!("Failed to write vault: {error}"))
}

fn load_or_create_key(app: &AppHandle) -> CommandResult<[u8; 32]> {
    let path = key_path(app)?;
    if path.exists() {
        let bytes = fs::read(path).map_err(|error| format!("Failed to read vault key: {error}"))?;
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

fn vault_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?.join("profiles.vault"))
}

fn key_path(app: &AppHandle) -> CommandResult<PathBuf> {
    Ok(app_data_dir(app)?.join("vault.key"))
}

fn app_data_dir(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn emit_status(app: &AppHandle, session_id: &str, status: &str, message: Option<String>) {
    let _ = app.emit(
        "ssh-status",
        TerminalStatus {
            session_id: session_id.to_string(),
            status: status.to_string(),
            message,
        },
    );
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionRegistry::default())
        .invoke_handler(tauri::generate_handler![
            list_profiles,
            save_profile,
            delete_profile,
            connect_profile,
            connect_ephemeral,
            send_input,
            resize_pty,
            disconnect_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DirectSSH");
}
