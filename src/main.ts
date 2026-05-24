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

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const mockDataHandlers = new Set<MockHandler<TerminalOutput>>();
const mockStatusHandlers = new Set<MockHandler<TerminalStatus>>();
const mockProfilesKey = "directssh.mockProfiles";

const state = {
  profiles: [] as ProfileSummary[],
  selectedProfileId: "",
  activeSessionId: "",
  authKind: "password" as AuthDraft["kind"],
  status: "Ready",
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
  <main class="app-shell">
    <section class="session-panel" aria-label="SSH profiles">
      <div class="brand-strip">
        <strong>DirectSSH</strong>
        <span>Standalone socket client</span>
      </div>

      <form class="profile-form" id="profile-form">
        <div class="form-grid">
          <label>
            <span>Name</span>
            <input id="profile-name" name="name" autocomplete="off" placeholder="AWS Main" />
          </label>
          <label>
            <span>User</span>
            <input id="profile-user" name="username" autocomplete="username" placeholder="ubuntu" />
          </label>
          <label class="wide-field">
            <span>Host</span>
            <input id="profile-host" name="host" autocomplete="off" placeholder="54.180.22.19" />
          </label>
          <label>
            <span>Port</span>
            <input id="profile-port" name="port" inputmode="numeric" value="22" />
          </label>
        </div>

        <div class="auth-switch" role="tablist" aria-label="Authentication mode">
          <button type="button" class="auth-option active" data-auth="password">PW</button>
          <button type="button" class="auth-option" data-auth="key">KEY</button>
        </div>

        <label id="password-field" class="secret-field">
          <span>Password</span>
          <input id="profile-password" name="password" type="password" autocomplete="current-password" />
        </label>

        <div id="key-fields" class="key-fields hidden">
          <label class="secret-field">
            <span>Private key</span>
            <textarea id="profile-key" name="private_key" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
          </label>
          <label class="secret-field">
            <span>Passphrase</span>
            <input id="profile-passphrase" name="passphrase" type="password" autocomplete="off" />
          </label>
        </div>

        <div class="form-actions">
          <button type="submit" class="primary-action">Save</button>
          <button type="button" id="connect-draft" class="secondary-action">Connect</button>
          <button type="button" id="clear-form" class="ghost-action">Clear</button>
        </div>
      </form>

      <div class="session-list-head">
        <span>Sessions</span>
        <button type="button" id="delete-selected" class="text-action">Delete</button>
      </div>
      <div id="session-list" class="session-list"></div>
    </section>

    <section class="terminal-panel" aria-label="SSH terminal">
      <div class="phone-tabbar">
        <button type="button" class="home-tab active">HOME</button>
        <button type="button" class="session-tab">SSH</button>
      </div>

      <div class="terminal-frame">
        <nav class="tablet-rail" aria-label="Terminal tabs">
          <button type="button" class="rail-tab home-rail"><span>HOME</span></button>
          <button type="button" class="rail-tab active"><span>SSH</span></button>
          <button type="button" class="rail-tab"><span>LOG</span></button>
        </nav>

        <div class="terminal-stack">
          <div class="terminal-status">
            <span id="status-text">Ready</span>
            <button type="button" id="disconnect" class="disconnect-action">Disconnect</button>
          </div>
          <div id="terminal-root" class="terminal-root"></div>
          <div class="shortcut-bar" aria-label="Terminal shortcut keys">
            <button type="button" data-key="\\u001b">Esc</button>
            <button type="button" data-key="\\t">Tab</button>
            <button type="button" data-key="\\u0003">Ctrl+C</button>
            <button type="button" data-key="\\u0004">Ctrl+D</button>
            <button type="button" data-key="\\u001b[A">Up</button>
            <button type="button" data-key="\\u001b[B">Down</button>
          </div>
        </div>
      </div>
    </section>
  </main>
`;

const shell = app.querySelector<HTMLElement>(".app-shell")!;
const form = app.querySelector<HTMLFormElement>("#profile-form")!;
const sessionList = app.querySelector<HTMLDivElement>("#session-list")!;
const statusText = app.querySelector<HTMLSpanElement>("#status-text")!;
const authButtons = [...app.querySelectorAll<HTMLButtonElement>(".auth-option")];
const passwordField = app.querySelector<HTMLElement>("#password-field")!;
const keyFields = app.querySelector<HTMLElement>("#key-fields")!;
const terminalRoot = app.querySelector<HTMLDivElement>("#terminal-root")!;

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
  await attachBackendEvents();
  await refreshProfiles();
  writeBanner();
}

function setupTerminal() {
  fitAddon = new FitAddon();
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    fontFamily: "'Hack', 'Noto Sans Mono CJK KR', 'D2Coding', monospace",
    fontSize: 12,
    lineHeight: 1.14,
    scrollback: 6000,
    theme: {
      background: "#05070a",
      foreground: "#abb2bf",
      cursor: "#00bcd4",
      cyan: "#00bcd4",
      green: "#9ece6a",
      red: "#ef4444",
      yellow: "#facc15",
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
    await saveCurrentProfile();
  });

  app.querySelector<HTMLButtonElement>("#connect-draft")!.addEventListener("click", connectDraft);
  app.querySelector<HTMLButtonElement>("#clear-form")!.addEventListener("click", clearForm);
  app.querySelector<HTMLButtonElement>("#delete-selected")!.addEventListener("click", deleteSelectedProfile);
  app.querySelector<HTMLButtonElement>("#disconnect")!.addEventListener("click", disconnectActiveSession);

  authButtons.forEach((button) => {
    button.addEventListener("click", () => setAuthKind(button.dataset.auth === "key" ? "key" : "password"));
  });

  app.querySelectorAll<HTMLButtonElement>(".shortcut-bar button").forEach((button) => {
    button.addEventListener("click", () => {
      if (!state.activeSessionId) {
        return;
      }
      invokeCommand<void>("send_input", {
        sessionId: state.activeSessionId,
        data: button.dataset.key ?? "",
      }).catch(showError);
    });
  });

  window.addEventListener("resize", queueFit);
  window.visualViewport?.addEventListener("resize", updateKeyboardState);
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
      setStatus(payload.message ? `${payload.status}: ${payload.message}` : payload.status);
    }
    if (payload.status === "disconnected" && payload.session_id === state.activeSessionId) {
      state.activeSessionId = "";
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
  if (state.profiles.length === 0) {
    sessionList.innerHTML = `<div class="empty-row">No saved sessions</div>`;
    return;
  }

  sessionList.innerHTML = state.profiles
    .map((profile) => {
      const active = profile.id === state.selectedProfileId ? " selected" : "";
      const authClass = profile.auth_kind === "key" ? "sb-key" : "sb-pw";
      return `
        <div class="session-row${active}" data-profile-id="${profile.id}">
          <button type="button" class="session-main" data-action="select">
            <span class="session-name">${escapeHtml(profile.name)}</span>
            <span class="session-meta">@${escapeHtml(profile.host)}</span>
            <span class="badge sb-port">P:${profile.port}</span>
            <span class="badge ${authClass}">${escapeHtml(profile.auth_label)}</span>
          </button>
          <button type="button" class="connect-row" data-action="connect">Connect</button>
        </div>
      `;
    })
    .join("");

  sessionList.querySelectorAll<HTMLDivElement>(".session-row").forEach((row) => {
    const profileId = row.dataset.profileId ?? "";
    row.querySelector<HTMLButtonElement>('[data-action="select"]')!.addEventListener("click", () => selectProfile(profileId));
    row.querySelector<HTMLButtonElement>('[data-action="connect"]')!.addEventListener("click", () => connectProfile(profileId));
  });
}

async function saveCurrentProfile() {
  const saved = await invokeCommand<ProfileSummary>("save_profile", { profile: buildProfileDraft() });
  state.selectedProfileId = saved.id;
  await refreshProfiles();
  setStatus(`Saved ${saved.name}`);
}

async function deleteSelectedProfile() {
  if (!state.selectedProfileId) {
    return;
  }
  await invokeCommand<void>("delete_profile", { profileId: state.selectedProfileId });
  clearForm();
  await refreshProfiles();
  setStatus("Profile deleted");
}

async function connectDraft() {
  const draft = buildProfileDraft();
  await startSession(() => invokeCommand<string>("connect_ephemeral", connectionArgs({ profile: draft })));
}

async function connectProfile(profileId: string) {
  selectProfile(profileId);
  await startSession(() => invokeCommand<string>("connect_profile", connectionArgs({ profileId })));
}

async function startSession(connect: () => Promise<string>) {
  queueFit();
  setStatus("connecting");
  terminal.reset();
  terminal.write("\x1b[36mDirectSSH\x1b[0m opening socket...\r\n");
  const sessionId = await connect();
  state.activeSessionId = sessionId;
  queueFit();
}

async function disconnectActiveSession() {
  if (!state.activeSessionId) {
    return;
  }
  await invokeCommand<void>("disconnect_session", { sessionId: state.activeSessionId });
  state.activeSessionId = "";
  setStatus("Disconnected");
}

function selectProfile(profileId: string) {
  state.selectedProfileId = profileId;
  const profile = state.profiles.find((item) => item.id === profileId);
  if (profile) {
    fields.name.value = profile.name;
    fields.username.value = profile.username;
    fields.host.value = profile.host;
    fields.port.value = String(profile.port);
    setAuthKind(profile.auth_kind);
  }
  renderProfiles();
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
  renderProfiles();
}

function setAuthKind(kind: AuthDraft["kind"]) {
  state.authKind = kind;
  authButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.auth === kind);
  });
  passwordField.classList.toggle("hidden", kind !== "password");
  keyFields.classList.toggle("hidden", kind !== "key");
}

function buildProfileDraft(): SaveProfileRequest {
  const port = Number.parseInt(fields.port.value, 10);
  const auth: AuthDraft =
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

  return {
    id: state.selectedProfileId || null,
    name: fields.name.value,
    host: fields.host.value,
    port: Number.isFinite(port) ? port : 22,
    username: fields.username.value,
    auth,
  };
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
    fitAddon.fit();
    if (state.activeSessionId) {
      invokeCommand<void>("resize_pty", {
        sessionId: state.activeSessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(showError);
    }
    updateKeyboardState();
  }, 60);
}

function updateKeyboardState() {
  const viewport = window.visualViewport;
  const keyboardOpen = viewport ? window.innerHeight - viewport.height > 120 : false;
  shell.classList.toggle("keyboard-open", keyboardOpen);
}

function writeBanner() {
  terminal.write("\x1b[36mDirectSSH\x1b[0m ready. Select or create a session.\r\n");
  if (!isTauriRuntime) {
    terminal.write("Browser preview mode: SSH calls are simulated.\r\n");
  }
}

function setStatus(message: string) {
  state.status = message;
  statusText.textContent = message;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  terminal.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
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
    const summary = toSummary(profile);
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
    emitMockStatus(sessionId, "connected", "Preview PTY shell opened");
    setTimeout(() => emitMockData(sessionId, "ubuntu@directssh:~$ systemctl status sshd\r\n"), 120);
    setTimeout(() => emitMockData(sessionId, "Active: active (running) since Sun 2026-05-24 09:00:00 KST\r\n"), 260);
    setTimeout(() => emitMockData(sessionId, "ubuntu@directssh:~$ "), 420);
    return sessionId as T;
  }

  return undefined as T;
}

function readMockProfiles(): ProfileSummary[] {
  const raw = localStorage.getItem(mockProfilesKey);
  if (!raw) {
    return [
      {
        id: "demo-aws-main",
        name: "AWS Main",
        host: "54.180.22.19",
        port: 2222,
        username: "ubuntu",
        auth_kind: "key",
        auth_label: "KEY(ed25519)",
        updated_at: 1,
      },
      {
        id: "demo-office-nas",
        name: "Office NAS",
        host: "192.168.0.50",
        port: 22,
        username: "admin",
        auth_kind: "password",
        auth_label: "PW",
        updated_at: 0,
      },
    ];
  }
  return JSON.parse(raw) as ProfileSummary[];
}

function toSummary(profile: SaveProfileRequest): ProfileSummary {
  return {
    id: profile.id || crypto.randomUUID(),
    name: profile.name.trim() || "Untitled",
    host: profile.host.trim() || "127.0.0.1",
    port: profile.port || 22,
    username: profile.username.trim() || "user",
    auth_kind: profile.auth.kind,
    auth_label: profile.auth.kind === "key" ? "KEY" : "PW",
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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

boot().catch(showError);
