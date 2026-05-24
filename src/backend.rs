use crate::model::{
    CommandResult, ConnectionStatus, ProfileAuth, ProfileSummary, SaveProfileRequest, UiEvent,
};
use crate::ssh::SessionRegistry;
use crate::terminal::TerminalBuffer;
use crate::vault::{AppSettings, VaultStore};
use crate::{AppWindow, ProfileRow};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel, Weak};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;

const MIN_FONT_SIZE: i32 = 11;
const MAX_FONT_SIZE: i32 = 22;

pub fn run(data_dir: PathBuf) -> Result<(), slint::PlatformError> {
    let runtime = Runtime::new().expect("failed to create Tokio runtime");
    let store = VaultStore::new(data_dir);
    let registry = SessionRegistry::default();
    let terminal = Arc::new(Mutex::new(TerminalBuffer::new(32, 100)));
    let active_session = Arc::new(Mutex::new(String::new()));
    let (events_tx, events_rx) = mpsc::unbounded_channel();

    let app = AppWindow::new()?;
    let settings = store.load_settings();
    app.set_terminal_font_size(clamp_font_size(settings.terminal_font_size));
    set_profiles(&app, &store, "");

    attach_callbacks(
        &app,
        runtime.handle().clone(),
        store.clone(),
        registry.clone(),
        terminal.clone(),
        active_session.clone(),
        events_tx.clone(),
    );
    attach_event_pump(
        app.as_weak(),
        runtime.handle().clone(),
        events_rx,
        terminal,
        active_session,
    );

    app.run()?;
    runtime.shutdown_background();
    Ok(())
}

fn attach_callbacks(
    app: &AppWindow,
    handle: tokio::runtime::Handle,
    store: VaultStore,
    registry: SessionRegistry,
    terminal: Arc<Mutex<TerminalBuffer>>,
    active_session: Arc<Mutex<String>>,
    events_tx: mpsc::UnboundedSender<UiEvent>,
) {
    let weak = app.as_weak();
    let store_for_refresh = store.clone();
    app.on_refresh_profiles(move || {
        if let Some(app) = weak.upgrade() {
            set_profiles(&app, &store_for_refresh, app.get_search_text().as_str());
        }
    });

    let weak = app.as_weak();
    let store_for_filter = store.clone();
    app.on_filter_profiles(move |query| {
        if let Some(app) = weak.upgrade() {
            set_profiles(&app, &store_for_filter, query.as_str());
        }
    });

    let weak = app.as_weak();
    let store_for_save = store.clone();
    app.on_save_profile(
        move |name, host, port, username, use_key, secret, passphrase| {
            if let Some(app) = weak.upgrade() {
                let selected_id = app.get_selected_profile_id().to_string();
                let draft = draft_from_form(ProfileForm {
                    selected_id,
                    name: name.to_string(),
                    host: host.to_string(),
                    port: port.to_string(),
                    username: username.to_string(),
                    use_key,
                    secret: secret.to_string(),
                    passphrase: passphrase.to_string(),
                });
                match draft.and_then(|profile| store_for_save.save_profile(profile)) {
                    Ok(saved) => {
                        app.set_selected_profile_id(saved.id.into());
                        app.set_editor_open(false);
                        app.set_status_text(format!("Saved {}", saved.name).into());
                        set_profiles(&app, &store_for_save, app.get_search_text().as_str());
                    }
                    Err(error) => set_error(&app, &error),
                }
            }
        },
    );

    let weak = app.as_weak();
    let store_for_delete = store.clone();
    app.on_delete_profile(move |profile_id| {
        if let Some(app) = weak.upgrade() {
            match store_for_delete.delete_profile(profile_id.as_str()) {
                Ok(()) => {
                    clear_form(&app);
                    app.set_editor_open(false);
                    app.set_status_text("Profile deleted".into());
                    set_profiles(&app, &store_for_delete, app.get_search_text().as_str());
                }
                Err(error) => set_error(&app, &error),
            }
        }
    });

    let weak = app.as_weak();
    let store_for_edit = store.clone();
    app.on_edit_profile(move |profile_id| {
        if let Some(app) = weak.upgrade() {
            match store_for_edit.get_profile(profile_id.as_str()) {
                Ok(profile) => {
                    app.set_selected_profile_id(profile.id.into());
                    app.set_form_name(profile.name.into());
                    app.set_form_host(profile.host.into());
                    app.set_form_port(profile.port.to_string().into());
                    app.set_form_user(profile.username.into());
                    app.set_form_secret("".into());
                    app.set_form_passphrase("".into());
                    app.set_use_key_auth(matches!(profile.auth, ProfileAuth::Key { .. }));
                    app.set_editor_open(true);
                }
                Err(error) => set_error(&app, &error),
            }
        }
    });

    let weak = app.as_weak();
    let handle_for_connect = handle.clone();
    let store_for_connect = store.clone();
    let registry_for_connect = registry.clone();
    let active_for_connect = active_session.clone();
    let terminal_for_connect = terminal.clone();
    let events_for_connect = events_tx.clone();
    app.on_connect_profile(move |profile_id| {
        if let Some(app) = weak.upgrade() {
            match store_for_connect.get_profile(profile_id.as_str()) {
                Ok(profile) => {
                    prepare_terminal(&app, &terminal_for_connect, &active_for_connect);
                    app.set_view("ssh".into());
                    app.set_active_name(profile.name.clone().into());
                    app.set_active_meta(
                        format!("{}@{}:{}", profile.username, profile.host, profile.port).into(),
                    );
                    app.set_connection_state(ConnectionStatus::Connecting.as_str().into());
                    app.set_status_text("Connecting".into());

                    let weak = app.as_weak();
                    let registry = registry_for_connect.clone();
                    let events = events_for_connect.clone();
                    let active = active_for_connect.clone();
                    handle_for_connect.spawn(async move {
                        match registry.connect_profile(profile, 100, 32, events).await {
                            Ok(session_id) => {
                                *active.lock().expect("active session poisoned") =
                                    session_id.clone();
                                invoke_status(&weak, ConnectionStatus::Connected, "Connected");
                            }
                            Err(error) => invoke_error(&weak, &error),
                        }
                    });
                }
                Err(error) => set_error(&app, &error),
            }
        }
    });

    let weak = app.as_weak();
    let handle_for_draft = handle.clone();
    let registry_for_draft = registry.clone();
    let active_for_draft = active_session.clone();
    let terminal_for_draft = terminal.clone();
    let events_for_draft = events_tx.clone();
    let store_for_draft = store.clone();
    app.on_connect_draft(
        move |name, host, port, username, use_key, secret, passphrase| {
            if let Some(app) = weak.upgrade() {
                let selected_id = app.get_selected_profile_id().to_string();
                if !selected_id.is_empty() && secret.trim().is_empty() {
                    app.invoke_connect_profile(selected_id.into());
                    return;
                }

                let draft = draft_from_form(ProfileForm {
                    selected_id: String::new(),
                    name: name.to_string(),
                    host: host.to_string(),
                    port: port.to_string(),
                    username: username.to_string(),
                    use_key,
                    secret: secret.to_string(),
                    passphrase: passphrase.to_string(),
                });
                match draft {
                    Ok(profile) => {
                        let name = profile.name.clone();
                        let meta =
                            format!("{}@{}:{}", profile.username, profile.host, profile.port);
                        prepare_terminal(&app, &terminal_for_draft, &active_for_draft);
                        app.set_view("ssh".into());
                        app.set_editor_open(false);
                        app.set_active_name(name.into());
                        app.set_active_meta(meta.into());
                        app.set_connection_state(ConnectionStatus::Connecting.as_str().into());
                        app.set_status_text("Connecting".into());

                        let weak = app.as_weak();
                        let registry = registry_for_draft.clone();
                        let events = events_for_draft.clone();
                        let active = active_for_draft.clone();
                        handle_for_draft.spawn(async move {
                            match registry.connect_ephemeral(profile, 100, 32, events).await {
                                Ok(session_id) => {
                                    *active.lock().expect("active session poisoned") = session_id;
                                    invoke_status(&weak, ConnectionStatus::Connected, "Connected");
                                }
                                Err(error) => invoke_error(&weak, &error),
                            }
                        });
                    }
                    Err(error) => set_error(&app, &error),
                }

                set_profiles(&app, &store_for_draft, app.get_search_text().as_str());
            }
        },
    );

    let handle_for_input = handle.clone();
    let registry_for_input = registry.clone();
    let active_for_input = active_session.clone();
    let weak = app.as_weak();
    app.on_terminal_input(move |text| {
        send_terminal_input(
            &handle_for_input,
            registry_for_input.clone(),
            active_for_input.clone(),
            weak.clone(),
            text.to_string(),
        );
    });

    let handle_for_shortcut = handle.clone();
    let registry_for_shortcut = registry.clone();
    let active_for_shortcut = active_session.clone();
    let weak = app.as_weak();
    app.on_terminal_shortcut(move |text| {
        send_terminal_input(
            &handle_for_shortcut,
            registry_for_shortcut.clone(),
            active_for_shortcut.clone(),
            weak.clone(),
            text.to_string(),
        );
    });

    let handle_for_disconnect = handle.clone();
    let registry_for_disconnect = registry.clone();
    let active_for_disconnect = active_session.clone();
    let weak = app.as_weak();
    app.on_disconnect_session(move || {
        let session_id = active_for_disconnect
            .lock()
            .expect("active session poisoned")
            .clone();
        if session_id.is_empty() {
            return;
        }

        let registry = registry_for_disconnect.clone();
        let active = active_for_disconnect.clone();
        let weak = weak.clone();
        handle_for_disconnect.spawn(async move {
            let result = registry.disconnect_session(&session_id).await;
            active.lock().expect("active session poisoned").clear();
            match result {
                Ok(()) => invoke_status(&weak, ConnectionStatus::Disconnected, "Disconnected"),
                Err(error) => invoke_error(&weak, &error),
            }
        });
    });

    let store_for_font = store.clone();
    let weak = app.as_weak();
    app.on_set_terminal_font_size(move |font_size| {
        if let Some(app) = weak.upgrade() {
            let font_size = clamp_font_size(font_size);
            app.set_terminal_font_size(font_size);
            if let Err(error) = store_for_font.save_settings(&AppSettings {
                terminal_font_size: font_size,
            }) {
                set_error(&app, &error);
            }
        }
    });

    let handle_for_resize = handle;
    let registry_for_resize = registry;
    let active_for_resize = active_session;
    let terminal_for_resize = terminal;
    let weak = app.as_weak();
    app.on_resize_terminal(move |cols, rows| {
        let cols = cols.clamp(20, 500) as u16;
        let rows = rows.clamp(5, 200) as u16;
        terminal_for_resize
            .lock()
            .expect("terminal poisoned")
            .resize(rows, cols);

        let session_id = active_for_resize
            .lock()
            .expect("active session poisoned")
            .clone();
        if session_id.is_empty() {
            return;
        }

        let registry = registry_for_resize.clone();
        let weak = weak.clone();
        handle_for_resize.spawn(async move {
            if let Err(error) = registry
                .resize_pty(&session_id, cols as u32, rows as u32)
                .await
            {
                invoke_error(&weak, &error);
            }
        });
    });
}

fn attach_event_pump(
    weak: Weak<AppWindow>,
    handle: tokio::runtime::Handle,
    mut events_rx: mpsc::UnboundedReceiver<UiEvent>,
    terminal: Arc<Mutex<TerminalBuffer>>,
    active_session: Arc<Mutex<String>>,
) {
    handle.spawn(async move {
        while let Some(event) = events_rx.recv().await {
            match event {
                UiEvent::TerminalData { session_id, data } => {
                    let active = active_session
                        .lock()
                        .expect("active session poisoned")
                        .clone();
                    if active != session_id {
                        continue;
                    }

                    let text = {
                        let mut terminal = terminal.lock().expect("terminal poisoned");
                        terminal.process(&data);
                        terminal.contents()
                    };
                    let weak = weak.clone();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = weak.upgrade() {
                            app.set_terminal_text(text.into());
                        }
                    });
                }
                UiEvent::Status {
                    session_id,
                    status,
                    message,
                } => {
                    let active = active_session
                        .lock()
                        .expect("active session poisoned")
                        .clone();
                    if !active.is_empty() && active != session_id {
                        continue;
                    }

                    let weak = weak.clone();
                    let label = message.unwrap_or_else(|| status.label().to_string());
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(app) = weak.upgrade() {
                            app.set_connection_state(status.as_str().into());
                            app.set_status_text(label.into());
                        }
                    });
                }
            }
        }
    });
}

fn set_profiles(app: &AppWindow, store: &VaultStore, query: &str) {
    match store.list_profiles() {
        Ok(profiles) => {
            let query = query.trim().to_lowercase();
            let rows = profiles
                .into_iter()
                .filter(|profile| profile_matches(profile, &query))
                .map(profile_row)
                .collect::<Vec<_>>();
            app.set_profiles(ModelRc::new(Rc::new(VecModel::from(rows))));
        }
        Err(error) => set_error(app, &error),
    }
}

fn profile_matches(profile: &ProfileSummary, query: &str) -> bool {
    query.is_empty()
        || format!(
            "{} {} {} {} {}",
            profile.name, profile.host, profile.username, profile.port, profile.auth_label
        )
        .to_lowercase()
        .contains(query)
}

fn profile_row(profile: ProfileSummary) -> ProfileRow {
    ProfileRow {
        id: profile.id.into(),
        name: profile.name.into(),
        host: profile.host.into(),
        port: i32::from(profile.port),
        username: profile.username.into(),
        auth_kind: profile.auth_kind.into(),
        auth_label: profile.auth_label.into(),
        updated_at: profile.updated_at.min(i32::MAX as u64) as i32,
    }
}

struct ProfileForm {
    selected_id: String,
    name: String,
    host: String,
    port: String,
    username: String,
    use_key: bool,
    secret: String,
    passphrase: String,
}

fn draft_from_form(form: ProfileForm) -> CommandResult<SaveProfileRequest> {
    let port = form
        .port
        .trim()
        .parse::<u16>()
        .map_err(|_| "Port must be between 1 and 65535".to_string())?;
    let auth = if !form.selected_id.is_empty() && form.secret.trim().is_empty() {
        ProfileAuth::Saved
    } else if form.use_key {
        ProfileAuth::Key {
            private_key: form.secret,
            passphrase: if form.passphrase.is_empty() {
                None
            } else {
                Some(form.passphrase)
            },
        }
    } else {
        ProfileAuth::Password {
            password: form.secret,
        }
    };

    Ok(SaveProfileRequest {
        id: if form.selected_id.is_empty() {
            None
        } else {
            Some(form.selected_id)
        },
        name: form.name,
        host: form.host,
        port,
        username: form.username,
        auth,
    })
}

fn prepare_terminal(
    app: &AppWindow,
    terminal: &Arc<Mutex<TerminalBuffer>>,
    active_session: &Arc<Mutex<String>>,
) {
    active_session
        .lock()
        .expect("active session poisoned")
        .clear();
    let mut terminal = terminal.lock().expect("terminal poisoned");
    terminal.reset();
    terminal.process(b"DirectSSH connecting...\r\n");
    app.set_terminal_text(terminal.contents().into());
}

fn send_terminal_input(
    handle: &tokio::runtime::Handle,
    registry: SessionRegistry,
    active_session: Arc<Mutex<String>>,
    weak: Weak<AppWindow>,
    text: String,
) {
    if text.is_empty() {
        return;
    }

    let session_id = active_session
        .lock()
        .expect("active session poisoned")
        .clone();
    if session_id.is_empty() {
        return;
    }

    handle.spawn(async move {
        if let Err(error) = registry.send_input(&session_id, text).await {
            invoke_error(&weak, &error);
        }
    });
}

fn clear_form(app: &AppWindow) {
    app.set_selected_profile_id("".into());
    app.set_form_name("".into());
    app.set_form_host("".into());
    app.set_form_port("22".into());
    app.set_form_user("".into());
    app.set_form_secret("".into());
    app.set_form_passphrase("".into());
    app.set_use_key_auth(false);
}

fn set_error(app: &AppWindow, error: &str) {
    app.set_connection_state(ConnectionStatus::Error.as_str().into());
    app.set_status_text(format!("Error: {error}").into());
}

fn invoke_status(weak: &Weak<AppWindow>, state: ConnectionStatus, status: &str) {
    let weak = weak.clone();
    let status = SharedString::from(status);
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = weak.upgrade() {
            app.set_connection_state(state.as_str().into());
            app.set_status_text(status);
        }
    });
}

fn invoke_error(weak: &Weak<AppWindow>, error: &str) {
    let weak = weak.clone();
    let error = error.to_string();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(app) = weak.upgrade() {
            set_error(&app, &error);
            let mut text = app.get_terminal_text().to_string();
            text.push('\n');
            text.push_str(&error);
            app.set_terminal_text(text.into());
        }
    });
}

fn clamp_font_size(font_size: i32) -> i32 {
    font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE)
}
