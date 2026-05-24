use crate::model::{
    validate_profile, CommandResult, ConnectionStatus, ProfileAuth, SaveProfileRequest,
    StoredProfile, UiEvent,
};
use russh::client;
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct SessionRegistry {
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

impl SessionRegistry {
    pub async fn connect_profile(
        &self,
        profile: StoredProfile,
        cols: u32,
        rows: u32,
        events: mpsc::UnboundedSender<UiEvent>,
    ) -> CommandResult<String> {
        open_ssh_session(self.clone(), profile, cols, rows, events).await
    }

    pub async fn connect_ephemeral(
        &self,
        profile: SaveProfileRequest,
        cols: u32,
        rows: u32,
        events: mpsc::UnboundedSender<UiEvent>,
    ) -> CommandResult<String> {
        validate_profile(&profile)?;
        let stored = StoredProfile {
            id: Uuid::new_v4().to_string(),
            name: profile.name.trim().to_string(),
            host: profile.host.trim().to_string(),
            port: profile.port,
            username: profile.username.trim().to_string(),
            auth: profile.auth,
            updated_at: 0,
        };

        open_ssh_session(self.clone(), stored, cols, rows, events).await
    }

    pub async fn send_input(&self, session_id: &str, data: String) -> CommandResult<()> {
        let session = self.get_live_session(session_id).await?;
        session
            .writer
            .data_bytes(data.into_bytes())
            .await
            .map_err(|error| format!("Failed to send terminal input: {error}"))
    }

    pub async fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> CommandResult<()> {
        let session = self.get_live_session(session_id).await?;
        session
            .writer
            .window_change(cols.clamp(20, 500), rows.clamp(5, 200), 0, 0)
            .await
            .map_err(|error| format!("Failed to resize PTY: {error}"))
    }

    pub async fn disconnect_session(&self, session_id: &str) -> CommandResult<()> {
        let session = {
            let mut sessions = self.sessions.lock().await;
            sessions.remove(session_id)
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

    async fn get_live_session(&self, session_id: &str) -> CommandResult<Arc<LiveSession>> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| "SSH session is not active".to_string())
    }
}

async fn open_ssh_session(
    registry: SessionRegistry,
    profile: StoredProfile,
    cols: u32,
    rows: u32,
    events: mpsc::UnboundedSender<UiEvent>,
) -> CommandResult<String> {
    let session_id = Uuid::new_v4().to_string();
    emit_status(
        &events,
        &session_id,
        ConnectionStatus::Connecting,
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
        &events,
        &session_id,
        ConnectionStatus::Connected,
        Some("PTY shell opened".to_string()),
    );

    let registry_for_task = registry.clone();
    let read_session_id = session_id.clone();
    tokio::spawn(async move {
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let _ = events.send(UiEvent::TerminalData {
                        session_id: read_session_id.clone(),
                        data: data.to_vec(),
                    });
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    emit_status(
                        &events,
                        &read_session_id,
                        ConnectionStatus::Exited,
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
        emit_status(
            &events,
            &read_session_id,
            ConnectionStatus::Disconnected,
            None,
        );
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

fn emit_status(
    events: &mpsc::UnboundedSender<UiEvent>,
    session_id: &str,
    status: ConnectionStatus,
    message: Option<String>,
) {
    let _ = events.send(UiEvent::Status {
        session_id: session_id.to_string(),
        status,
        message,
    });
}
