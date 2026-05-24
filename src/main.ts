import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import type {
  AuthDraft,
  ProfileSummary,
  SaveProfileRequest,
  TerminalOutput,
  TerminalStatus,
} from "./types";

type MockHandler<T> = (payload: T) => void;
type AppView = "home" | "ssh";
type ConnectionState = TerminalStatus["status"] | "idle";
type FormAuthKind = Exclude<AuthDraft["kind"], "saved">;

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const mockDataHandlers = new Set<MockHandler<TerminalOutput>>();
const mockStatusHandlers = new Set<MockHandler<TerminalStatus>>();
const mockProfilesKey = "directssh.mockProfiles";
const terminalFontSizeKey = "directssh.terminalFontSize";
const minTerminalFontSize = 11;
const maxTerminalFontSize = 22;

const shortcutKeys = [
  { label: "Esc", key: "\x1b" },
  { label: "Tab", key: "\t" },
  { label: "Ctrl+C", key: "\x03" },
  { label: "Ctrl+D", key: "\x04" },
  { label: "/", key: "/" },
  { label: "-", key: "-" },
  { label: "|", key: "|" },
  { label: "Up", key: "\x1b[A" },
  { label: "Down", key: "\x1b[B" },
  { label: "Right", key: "\x1b[C" },
];

const state = {
  profiles: [] as ProfileSummary[],
  selectedProfileId: "",
  activeSessionId: "",
  activeProfileName: "No active session",
  activeProfileMeta: "Connect from Saved Sessions",
  authKind: "password" as FormAuthKind,
  view: "home" as AppView,
  status: "Ready",
  connectionState: "idle" as ConnectionState,
  terminalFontSize: readTerminalFontSize(),
};

let terminal: Terminal;
let fitAddon: FitAddon;
let resizeTimer = 0;

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("App root was not found");
}

const app = appRoot;

app.innerHTML = `
  <main class="client-shell view-home" data-connection="idle">
    <section class="home-screen" aria-label="Saved SSH sessions">
      <div class="home-panel">
        <header class="app-header">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">${icon("terminal")}</span>
            <div>
              <h1>DirectSSH</h1>
              <span id="home-status">Ready</span>
            </div>
          </div>
          <button type="button" id="add-profile" class="icon-primary" aria-label="Add SSH profile">
            ${icon("plus")}
          </button>
        </header>

        <div class="search-row">
          <label class="search-shell" for="session-search">
            ${icon("search")}
            <input id="session-search" autocomplete="off" placeholder="Search sessions" />
          </label>
          <button type="button" id="clear-search" class="icon-button" aria-label="Clear search">
            ${icon("sliders")}
          </button>
        </div>

        <section class="session-section" aria-label="Saved sessions">
          <div class="section-head">
            <h2>Saved Sessions</h2>
            <span id="profile-count">0 profiles</span>
          </div>
          <div id="session-list" class="session-list"></div>
        </section>
      </div>
    </section>

    <section class="ssh-screen" aria-label="SSH terminal">
      <nav class="terminal-rail" aria-label="Terminal navigation">
        <button type="button" id="rail-home" class="rail-button" aria-label="Back to sessions">
          ${icon("home")}
          <span class="rail-label">Sessions</span>
        </button>
        <button type="button" id="rail-terminal" class="rail-button rail-terminal-tab active" aria-label="Terminal">
          <span id="connection-dot" class="connection-dot" aria-hidden="true"></span>
          <span class="rail-copy">
            <strong id="active-profile-name">No active session</strong>
            <span id="active-profile-meta">Connect from Saved Sessions</span>
          </span>
        </button>
        <button type="button" id="rail-add" class="rail-button" aria-label="Add SSH profile">
          ${icon("plus")}
          <span class="rail-label">New</span>
        </button>
        <button type="button" id="disconnect-session" class="rail-disconnect" aria-label="Disconnect" disabled>
          ${icon("disconnect")}
        </button>
      </nav>

      <div class="terminal-pane">
        <span id="status-text" class="sr-only">Ready</span>

        <div id="terminal-root" class="terminal-root"></div>

        <div class="shortcut-bar" aria-label="Terminal shortcut keys">
          <div class="font-size-control" aria-label="Terminal font size">
            <button type="button" id="font-decrease" aria-label="Decrease terminal font size">A-</button>
            <span id="font-size-value">14</span>
            <button type="button" id="font-increase" aria-label="Increase terminal font size">A+</button>
          </div>
          ${shortcutKeys
            .map(
              (shortcut, index) =>
                `<button type="button" data-shortcut="${index}">${escapeHtml(shortcut.label)}</button>`,
            )
            .join("")}
        </div>
      </div>
    </section>

    <div id="profile-sheet" class="profile-sheet hidden" role="dialog" aria-modal="true" aria-label="SSH profile editor">
      <button type="button" id="sheet-backdrop" class="sheet-backdrop" aria-label="Close profile editor"></button>
      <form class="profile-form" id="profile-form">
        <div class="sheet-grip" aria-hidden="true"></div>
        <div class="sheet-head">
          <div>
            <strong id="sheet-title">Add SSH Profile</strong>
            <span>Credentials stay in the local encrypted vault.</span>
          </div>
          <button type="button" id="close-sheet" class="icon-button" aria-label="Close">
            ${icon("close")}
          </button>
        </div>

        <p id="form-error" class="form-error" role="alert"></p>
        <p id="credential-note" class="credential-note hidden">Saved credential available. Leave the secret field blank to keep it.</p>

        <div class="form-grid">
          <label>
            <span>Name</span>
            <input id="profile-name" name="name" autocomplete="off" placeholder="Production" />
          </label>
          <label>
            <span>Host</span>
            <input id="profile-host" name="host" autocomplete="off" placeholder="203.0.113.10" />
          </label>
          <label>
            <span>Port</span>
            <input id="profile-port" name="port" inputmode="numeric" value="22" />
          </label>
          <label>
            <span>Username</span>
            <input id="profile-user" name="username" autocomplete="username" placeholder="ubuntu" />
          </label>
        </div>

        <div class="auth-switch" role="tablist" aria-label="Authentication mode">
          <button type="button" class="auth-option active" data-auth="password">Password</button>
          <button type="button" class="auth-option" data-auth="key">Private Key</button>
        </div>

        <label id="password-field" class="secret-field">
          <span>Password</span>
          <input id="profile-password" name="password" type="password" autocomplete="current-password" />
        </label>

        <div id="key-fields" class="key-fields hidden">
          <label class="secret-field">
            <span>Private Key</span>
            <textarea id="profile-key" name="private_key" spellcheck="false" placeholder="Paste OpenSSH private key"></textarea>
          </label>
          <label class="secret-field">
            <span>Passphrase</span>
            <input id="profile-passphrase" name="passphrase" type="password" autocomplete="off" />
          </label>
        </div>

        <div class="form-actions">
          <button type="button" id="delete-selected" class="ghost-danger" disabled>Delete</button>
          <button type="button" id="connect-draft" class="secondary-action">Connect</button>
          <button type="submit" class="primary-action">Save</button>
        </div>
      </form>
    </div>
  </main>
`;

const shell = app.querySelector<HTMLElement>(".client-shell")!;
const form = app.querySelector<HTMLFormElement>("#profile-form")!;
const sessionList = app.querySelector<HTMLDivElement>("#session-list")!;
const profileCount = app.querySelector<HTMLElement>("#profile-count")!;
const statusText = app.querySelector<HTMLSpanElement>("#status-text")!;
const homeStatus = app.querySelector<HTMLSpanElement>("#home-status")!;
const connectionDot = app.querySelector<HTMLSpanElement>("#connection-dot")!;
const activeProfileName = app.querySelector<HTMLElement>("#active-profile-name")!;
const activeProfileMeta = app.querySelector<HTMLElement>("#active-profile-meta")!;
const disconnectButton = app.querySelector<HTMLButtonElement>("#disconnect-session")!;
const deleteButton = app.querySelector<HTMLButtonElement>("#delete-selected")!;
const credentialNote = app.querySelector<HTMLElement>("#credential-note")!;
const fontSizeValue = app.querySelector<HTMLElement>("#font-size-value")!;
const authButtons = [...app.querySelectorAll<HTMLButtonElement>(".auth-option")];
const passwordField = app.querySelector<HTMLElement>("#password-field")!;
const keyFields = app.querySelector<HTMLElement>("#key-fields")!;
const terminalRoot = app.querySelector<HTMLDivElement>("#terminal-root")!;
const profileSheet = app.querySelector<HTMLElement>("#profile-sheet")!;
const sheetTitle = app.querySelector<HTMLElement>("#sheet-title")!;
const searchInput = app.querySelector<HTMLInputElement>("#session-search")!;
const formError = app.querySelector<HTMLElement>("#form-error")!;

const fields = {
  name: app.querySelector<HTMLInputElement>("#profile-name")!,
  username: app.querySelector<HTMLInputElement>("#profile-user")!,
  host: app.querySelector<HTMLInputElement>("#profile-host")!,
  port: app.querySelector<HTMLInputElement>("#profile-port")!,
  password: app.querySelector<HTMLInputElement>("#profile-password")!,
  privateKey: app.querySelector<HTMLTextAreaElement>("#profile-key")!,
  passphrase: app.querySelector<HTMLInputElement>("#profile-passphrase")!,
};

async function boot() {
  setupTerminal();
  setupEvents();
  updateTerminalFontSizeControl();
  await attachBackendEvents();
  await refreshProfiles();
  writeBanner();
  updateConnectionHeader();
}

function setupTerminal() {
  fitAddon = new FitAddon();
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    fontFamily: "'Hack', 'Noto Sans Mono CJK KR', 'D2Coding', monospace",
    fontSize: state.terminalFontSize,
    lineHeight: 1.28,
    scrollback: 6000,
    theme: {
      background: "#fbfdff",
      foreground: "#111827",
      cursor: "#0f6fff",
      selectionBackground: "#cfe2ff",
      black: "#111827",
      blue: "#0f6fff",
      cyan: "#0891b2",
      green: "#15803d",
      red: "#dc2626",
      yellow: "#b45309",
      white: "#f8fafc",
    },
  });

  terminal.loadAddon(fitAddon);
  terminal.open(terminalRoot);
  queueFit();
  terminal.onData((data) => {
    if (state.activeSessionId) {
      invokeCommand<void>("send_input", { sessionId: state.activeSessionId, data }).catch(showError);
    }
  });
}

function setupEvents() {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCurrentProfile().catch(showError);
  });

  app.querySelector<HTMLButtonElement>("#rail-home")!.addEventListener("click", () => switchView("home"));
  app.querySelector<HTMLButtonElement>("#rail-terminal")!.addEventListener("click", () => switchView("ssh"));
  app.querySelector<HTMLButtonElement>("#rail-add")!.addEventListener("click", openNewProfileSheet);
  app.querySelector<HTMLButtonElement>("#font-decrease")!.addEventListener("click", () => {
    setTerminalFontSize(state.terminalFontSize - 1);
  });
  app.querySelector<HTMLButtonElement>("#font-increase")!.addEventListener("click", () => {
    setTerminalFontSize(state.terminalFontSize + 1);
  });
  app.querySelector<HTMLButtonElement>("#add-profile")!.addEventListener("click", openNewProfileSheet);
  app.querySelector<HTMLButtonElement>("#close-sheet")!.addEventListener("click", closeProfileSheet);
  app.querySelector<HTMLButtonElement>("#sheet-backdrop")!.addEventListener("click", closeProfileSheet);
  app.querySelector<HTMLButtonElement>("#connect-draft")!.addEventListener("click", () => connectDraft().catch(showError));
  app.querySelector<HTMLButtonElement>("#delete-selected")!.addEventListener("click", () => deleteSelectedProfile().catch(showError));
  app
    .querySelector<HTMLButtonElement>("#disconnect-session")!
    .addEventListener("click", () => disconnectActiveSession().catch(showError));
  app.querySelector<HTMLButtonElement>("#clear-search")!.addEventListener("click", () => {
    searchInput.value = "";
    renderProfiles();
    searchInput.focus();
  });
  searchInput.addEventListener("input", renderProfiles);

  authButtons.forEach((button) => {
    button.addEventListener("click", () => setAuthKind(button.dataset.auth === "key" ? "key" : "password"));
  });

  app.querySelectorAll<HTMLButtonElement>(".shortcut-bar button").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.activeSessionId) {
        return;
      }
      const shortcut = shortcutKeys[Number(button.dataset.shortcut)];
      if (!shortcut) {
        return;
      }
      invokeCommand<void>("send_input", {
        sessionId: state.activeSessionId,
        data: shortcut.key,
      }).catch(showError);
      terminal.focus();
    });
  });

  window.addEventListener("resize", queueFit);
  window.visualViewport?.addEventListener("resize", queueFit);
  window.visualViewport?.addEventListener("scroll", updateKeyboardState);
}

async function attachBackendEvents() {
  const unlistenData = await onSshData((payload) => {
    if (payload.session_id === state.activeSessionId) {
      terminal.write(payload.data);
    }
  });

  const unlistenStatus = await onSshStatus((payload) => {
    if (!state.activeSessionId || payload.session_id === state.activeSessionId) {
      const message = payload.message ? `${capitalize(payload.status)}: ${payload.message}` : capitalize(payload.status);
      setStatus(message);
      setConnectionState(payload.status);
    }
    if (payload.status === "disconnected" && payload.session_id === state.activeSessionId) {
      state.activeSessionId = "";
      setConnectionState("disconnected");
    }
  });

  window.addEventListener("beforeunload", () => {
    void unlistenData();
    void unlistenStatus();
  });
}

async function refreshProfiles() {
  state.profiles = await invokeCommand<ProfileSummary[]>("list_profiles");
  renderProfiles();
}

function renderProfiles() {
  const query = searchInput.value.trim().toLowerCase();
  const profiles = state.profiles.filter((profile) => {
    if (!query) {
      return true;
    }
    return `${profile.name} ${profile.host} ${profile.username} ${profile.port} ${profile.auth_label}`.toLowerCase().includes(query);
  });

  profileCount.textContent = profileLabel(state.profiles.length);

  if (profiles.length === 0) {
    sessionList.innerHTML = `
      <div class="empty-state">
        <strong>${query ? "No matching sessions" : "No saved sessions"}</strong>
        <span>${query ? "Clear the search to show all profiles." : "Add a host once, then connect from here."}</span>
        <button type="button" id="empty-add-profile">${query ? "Clear Search" : "Add SSH Profile"}</button>
      </div>
    `;
    sessionList.querySelector<HTMLButtonElement>("#empty-add-profile")!.addEventListener("click", () => {
      if (query) {
        searchInput.value = "";
        renderProfiles();
        return;
      }
      openNewProfileSheet();
    });
    return;
  }

  sessionList.innerHTML = profiles.map(renderProfileRow).join("");

  sessionList.querySelectorAll<HTMLDivElement>(".session-row").forEach((row) => {
    const profileId = row.dataset.profileId ?? "";
    row.querySelector<HTMLButtonElement>('[data-action="edit"]')!.addEventListener("click", () => selectProfile(profileId, true));
    row
      .querySelector<HTMLButtonElement>('[data-action="connect"]')!
      .addEventListener("click", () => connectProfile(profileId).catch(showError));
  });
}

function renderProfileRow(profile: ProfileSummary) {
  const active = profile.id === state.selectedProfileId ? " selected" : "";
  const authLabel = profile.auth_kind === "key" ? "Key" : "Password";
  return `
    <div class="session-row${active}" data-profile-id="${escapeAttribute(profile.id)}">
      <button type="button" class="session-main" data-action="edit" aria-label="Edit ${escapeAttribute(profile.name)}">
        <span class="session-avatar" aria-hidden="true">${escapeHtml(getInitials(profile.name))}</span>
        <span class="session-copy">
          <strong>${escapeHtml(profile.name)}</strong>
          <span>${escapeHtml(profile.username)}@${escapeHtml(profile.host)}:${profile.port}</span>
        </span>
      </button>
      <span class="auth-chip">${escapeHtml(profile.auth_label || authLabel)}</span>
      <button type="button" class="row-edit" data-action="edit" aria-label="Edit ${escapeAttribute(profile.name)}">
        ${icon("edit")}
      </button>
      <button type="button" class="connect-row" data-action="connect" aria-label="Connect ${escapeAttribute(profile.name)}">
        ${icon("terminal")}
        <span>Connect</span>
      </button>
    </div>
  `;
}

async function saveCurrentProfile() {
  setFormError("");
  const draft = buildProfileDraft();
  validateDraft(draft);
  const saved = await invokeCommand<ProfileSummary>("save_profile", { profile: draft });
  state.selectedProfileId = saved.id;
  await refreshProfiles();
  closeProfileSheet();
  setStatus(`Saved ${saved.name}`);
}

async function deleteSelectedProfile() {
  if (!state.selectedProfileId) {
    return;
  }
  await invokeCommand<void>("delete_profile", { profileId: state.selectedProfileId });
  clearForm();
  closeProfileSheet();
  await refreshProfiles();
  setStatus("Profile deleted");
}

async function disconnectActiveSession() {
  if (!state.activeSessionId) {
    return;
  }
  const sessionId = state.activeSessionId;
  await invokeCommand<void>("disconnect_session", { sessionId });
  state.activeSessionId = "";
  setConnectionState("disconnected");
  setStatus("Disconnected");
  terminal.write("\r\nDisconnected.\r\n");
}

async function connectDraft() {
  setFormError("");
  const draft = buildProfileDraft();
  validateDraft(draft);
  if (draft.auth.kind === "saved" && state.selectedProfileId) {
    await connectProfile(state.selectedProfileId);
    return;
  }
  await startSession(
    () => invokeCommand<string>("connect_ephemeral", connectionArgs({ profile: draft })),
    draft.name.trim(),
    `${draft.username.trim()}@${draft.host.trim()}:${draft.port}`,
  );
}

async function connectProfile(profileId: string) {
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Profile not found");
  }
  selectProfile(profileId, false);
  await startSession(
    () => invokeCommand<string>("connect_profile", connectionArgs({ profileId })),
    profile.name,
    `${profile.username}@${profile.host}:${profile.port}`,
  );
}

async function startSession(connect: () => Promise<string>, name: string, meta: string) {
  closeProfileSheet();
  switchView("ssh");
  state.activeProfileName = name || "SSH session";
  state.activeProfileMeta = meta;
  state.activeSessionId = "";
  setConnectionState("connecting");
  setStatus(`Connecting to ${meta}`);
  terminal.reset();
  terminal.write(`DirectSSH connecting to ${meta}\r\n`);
  queueFit();

  try {
    const sessionId = await connect();
    state.activeSessionId = sessionId;
    setConnectionState("connected");
    setStatus("Connected");
    queueFit();
  } catch (error) {
    state.activeSessionId = "";
    setConnectionState("error");
    showError(error);
  }
}

function selectProfile(profileId: string, openSheet: boolean) {
  state.selectedProfileId = profileId;
  const profile = state.profiles.find((item) => item.id === profileId);
  if (profile) {
    fields.name.value = profile.name;
    fields.username.value = profile.username;
    fields.host.value = profile.host;
    fields.port.value = String(profile.port);
    fields.password.value = "";
    fields.privateKey.value = "";
    fields.passphrase.value = "";
    setAuthKind(profile.auth_kind);
    sheetTitle.textContent = "Edit SSH Profile";
  }
  syncFormState();
  renderProfiles();
  if (openSheet) {
    openProfileSheet();
  }
}

function openNewProfileSheet() {
  clearForm();
  sheetTitle.textContent = "Add SSH Profile";
  openProfileSheet();
}

function openProfileSheet() {
  setFormError("");
  syncFormState();
  profileSheet.classList.remove("hidden");
  window.setTimeout(() => fields.name.focus(), 20);
}

function closeProfileSheet() {
  profileSheet.classList.add("hidden");
}

function clearForm() {
  state.selectedProfileId = "";
  fields.name.value = "";
  fields.username.value = "";
  fields.host.value = "";
  fields.port.value = "22";
  fields.password.value = "";
  fields.privateKey.value = "";
  fields.passphrase.value = "";
  setAuthKind("password");
  syncFormState();
  renderProfiles();
}

function setAuthKind(kind: FormAuthKind) {
  state.authKind = kind;
  authButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.auth === kind);
  });
  passwordField.classList.toggle("hidden", kind !== "password");
  keyFields.classList.toggle("hidden", kind !== "key");
}

function switchView(view: AppView) {
  state.view = view;
  shell.classList.toggle("view-home", view === "home");
  shell.classList.toggle("view-ssh", view === "ssh");

  if (view === "ssh") {
    window.setTimeout(queueFit, 40);
  }
}

function buildProfileDraft(): SaveProfileRequest {
  const port = Number.parseInt(fields.port.value, 10);
  let auth: AuthDraft;

  if (state.selectedProfileId && state.authKind === "password" && !fields.password.value) {
    auth = { kind: "saved" };
  } else if (state.selectedProfileId && state.authKind === "key" && !fields.privateKey.value.trim()) {
    auth = { kind: "saved" };
  } else {
    auth =
      state.authKind === "key"
        ? {
            kind: "key",
            private_key: fields.privateKey.value,
            passphrase: fields.passphrase.value || null,
          }
        : {
            kind: "password",
            password: fields.password.value,
          };
  }

  return {
    id: state.selectedProfileId || null,
    name: fields.name.value,
    host: fields.host.value,
    port: Number.isFinite(port) ? port : 22,
    username: fields.username.value,
    auth,
  };
}

function validateDraft(profile: SaveProfileRequest) {
  if (!profile.name.trim()) {
    throw new Error("Profile name is required");
  }
  if (!profile.host.trim()) {
    throw new Error("Host is required");
  }
  if (!profile.username.trim()) {
    throw new Error("Username is required");
  }
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }
  if (profile.auth.kind === "saved" && !state.selectedProfileId) {
    throw new Error("A saved credential is not available for this profile");
  }
  if (profile.auth.kind === "password" && !profile.auth.password) {
    throw new Error("Password is required");
  }
  if (profile.auth.kind === "key" && !profile.auth.private_key.trim()) {
    throw new Error("Private key content is required");
  }
}

function connectionArgs(args: { profile?: SaveProfileRequest; profileId?: string }) {
  return {
    ...args,
    cols: terminal.cols || 80,
    rows: terminal.rows || 24,
  };
}

function queueFit() {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    updateKeyboardState();
    const bounds = terminalRoot.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) {
      fitAddon.fit();
    }
    if (state.activeSessionId) {
      invokeCommand<void>("resize_pty", {
        sessionId: state.activeSessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(showError);
    }
  }, 60);
}

function updateKeyboardState() {
  const viewport = window.visualViewport;
  const viewportHeight = Math.round(viewport?.height ?? window.innerHeight);
  const viewportOffsetTop = Math.round(viewport?.offsetTop ?? 0);
  const keyboardHeight = Math.max(0, Math.round(window.innerHeight - viewportHeight - viewportOffsetTop));
  const keyboardOpen = keyboardHeight > 120;
  shell.style.setProperty("--app-height", `${viewportHeight}px`);
  shell.style.setProperty("--viewport-offset-top", `${viewportOffsetTop}px`);
  shell.style.setProperty("--keyboard-height", `${keyboardHeight}px`);
  shell.classList.toggle("keyboard-open", keyboardOpen);
}

function readTerminalFontSize() {
  const saved = Number.parseInt(localStorage.getItem(terminalFontSizeKey) ?? "", 10);
  return clampTerminalFontSize(Number.isFinite(saved) ? saved : 14);
}

function setTerminalFontSize(fontSize: number) {
  state.terminalFontSize = clampTerminalFontSize(fontSize);
  localStorage.setItem(terminalFontSizeKey, String(state.terminalFontSize));
  terminal.options.fontSize = state.terminalFontSize;
  updateTerminalFontSizeControl();
  queueFit();
  terminal.focus();
}

function updateTerminalFontSizeControl() {
  fontSizeValue.textContent = `${state.terminalFontSize}px`;
}

function clampTerminalFontSize(fontSize: number) {
  return Math.min(maxTerminalFontSize, Math.max(minTerminalFontSize, fontSize));
}

function writeBanner() {
  terminal.write("DirectSSH terminal ready. Choose a saved session or add a profile.\r\n");
  if (!isTauriRuntime) {
    terminal.write("Browser preview mode: SSH calls are simulated.\r\n");
  }
}

function setStatus(message: string) {
  state.status = message;
  statusText.textContent = message;
  homeStatus.textContent = message;
}

function setConnectionState(connectionState: ConnectionState) {
  state.connectionState = connectionState;
  shell.dataset.connection = connectionState;
  disconnectButton.disabled = !state.activeSessionId && connectionState !== "connected";
  updateConnectionHeader();
}

function updateConnectionHeader() {
  activeProfileName.textContent = state.activeProfileName;
  activeProfileMeta.textContent = state.activeProfileMeta;
  connectionDot.className = `connection-dot ${state.connectionState}`;
  disconnectButton.disabled = !state.activeSessionId;
}

function syncFormState() {
  deleteButton.disabled = !state.selectedProfileId;
  const hasSavedCredential = Boolean(state.selectedProfileId);
  credentialNote.classList.toggle("hidden", !hasSavedCredential);
  fields.password.placeholder = hasSavedCredential ? "Leave blank to keep saved password" : "";
  fields.privateKey.placeholder = hasSavedCredential ? "Leave blank to keep saved private key" : "Paste OpenSSH private key";
}

function setFormError(message: string) {
  formError.textContent = message;
  formError.classList.toggle("visible", Boolean(message));
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`Error: ${message}`);
  if (!profileSheet.classList.contains("hidden")) {
    setFormError(message);
  }
  if (state.view === "ssh") {
    terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
  }
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime) {
    return invoke<T>(command, args);
  }
  return mockInvoke<T>(command, args);
}

async function onSshData(handler: MockHandler<TerminalOutput>): Promise<UnlistenFn> {
  if (isTauriRuntime) {
    return listen<TerminalOutput>("ssh-data", (event) => handler(event.payload));
  }
  mockDataHandlers.add(handler);
  return () => {
    mockDataHandlers.delete(handler);
  };
}

async function onSshStatus(handler: MockHandler<TerminalStatus>): Promise<UnlistenFn> {
  if (isTauriRuntime) {
    return listen<TerminalStatus>("ssh-status", (event) => handler(event.payload));
  }
  mockStatusHandlers.add(handler);
  return () => {
    mockStatusHandlers.delete(handler);
  };
}

async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const profiles = readMockProfiles();

  if (command === "list_profiles") {
    return profiles as T;
  }

  if (command === "save_profile") {
    const profile = args?.profile as SaveProfileRequest;
    validateDraft(profile);
    const existingProfile = profiles.find((item) => item.id === profile.id);
    const summary =
      profile.auth.kind === "saved" && existingProfile
        ? {
            ...toSummary(profile),
            auth_kind: existingProfile.auth_kind,
            auth_label: existingProfile.auth_label,
          }
        : toSummary(profile);
    const nextProfiles = [summary, ...profiles.filter((item) => item.id !== summary.id)];
    localStorage.setItem(mockProfilesKey, JSON.stringify(nextProfiles));
    return summary as T;
  }

  if (command === "delete_profile") {
    const profileId = String(args?.profileId ?? "");
    localStorage.setItem(mockProfilesKey, JSON.stringify(profiles.filter((item) => item.id !== profileId)));
    return undefined as T;
  }

  if (command === "connect_profile" || command === "connect_ephemeral") {
    const sessionId = crypto.randomUUID();
    const profile =
      command === "connect_profile"
        ? profiles.find((item) => item.id === String(args?.profileId ?? ""))
        : toSummary(args?.profile as SaveProfileRequest);
    const promptUser = profile?.username || "user";
    const promptHost = profile?.name || profile?.host || "host";

    emitMockStatus(sessionId, "connected", "PTY shell opened");
    setTimeout(() => emitMockData(sessionId, "Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 6.5.0 x86_64)\r\n\r\n"), 80);
    setTimeout(() => emitMockData(sessionId, `Last login: Sun May 24 10:21:01 2026 from 203.0.113.45\r\n\r\n`), 160);
    setTimeout(() => emitMockData(sessionId, `\x1b[32m${promptUser}@${promptHost}:~$\x1b[0m ls -alh\r\n`), 240);
    setTimeout(
      () =>
        emitMockData(
          sessionId,
          "total 44K\r\ndrwx------  5 user user 4.0K May 24 10:21 .\r\ndrwxr-xr-x  3 root root 4.0K Apr 12 09:11 ..\r\n-rw-r--r--  1 user user 3.7K Apr 12 09:11 .bashrc\r\ndrwx------  2 user user 4.0K May 24 10:21 .ssh\r\n",
        ),
      340,
    );
    setTimeout(() => emitMockData(sessionId, `\r\n\x1b[32m${promptUser}@${promptHost}:~$\x1b[0m `), 520);
    return sessionId as T;
  }

  if (command === "send_input") {
    const sessionId = String(args?.sessionId ?? "");
    const data = String(args?.data ?? "");
    emitMockData(sessionId, data);
    return undefined as T;
  }

  if (command === "resize_pty" || command === "disconnect_session") {
    return undefined as T;
  }

  return undefined as T;
}

function readMockProfiles(): ProfileSummary[] {
  const raw = localStorage.getItem(mockProfilesKey);
  if (!raw) {
    return [];
  }
  return JSON.parse(raw) as ProfileSummary[];
}

function toSummary(profile: SaveProfileRequest): ProfileSummary {
  const authKind = profile.auth.kind === "key" ? "key" : "password";
  return {
    id: profile.id || crypto.randomUUID(),
    name: profile.name.trim() || "Untitled",
    host: profile.host.trim() || "127.0.0.1",
    port: profile.port || 22,
    username: profile.username.trim() || "user",
    auth_kind: authKind,
    auth_label: authKind === "key" ? "KEY" : "PW",
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function emitMockData(sessionId: string, data: string) {
  mockDataHandlers.forEach((handler) =>
    handler({
      session_id: sessionId,
      stream: "stdout",
      data,
    }),
  );
}

function emitMockStatus(sessionId: string, status: TerminalStatus["status"], message: string | null) {
  mockStatusHandlers.forEach((handler) =>
    handler({
      session_id: sessionId,
      status,
      message,
    }),
  );
}

function profileLabel(count: number) {
  return `${count} ${count === 1 ? "profile" : "profiles"}`;
}

function getInitials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "SSH";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function icon(name: string) {
  const icons: Record<string, string> = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    disconnect:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7H6a3 3 0 0 0-3 3v4a3 3 0 0 0 3 3h4"/><path d="M14 7h4a3 3 0 0 1 3 3v1"/><path d="M14 17h1"/><path d="m17 14 4 3-4 3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 6.5 4 4"/></svg>',
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="7"/></svg>',
    sliders:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 8 4 4-4 4"/><path d="M13 16h4"/><rect x="3" y="4" width="18" height="16" rx="3"/></svg>',
  };
  return icons[name] ?? "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

boot().catch(showError);
