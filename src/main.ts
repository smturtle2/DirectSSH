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

const isTauriRuntime = "__TAURI_INTERNALS__" in window;
const mockDataHandlers = new Set<MockHandler<TerminalOutput>>();
const mockStatusHandlers = new Set<MockHandler<TerminalStatus>>();
const mockProfilesKey = "directssh.mockProfiles";

const state = {
  profiles: [] as ProfileSummary[],
  selectedProfileId: "",
  activeSessionId: "",
  authKind: "password" as AuthDraft["kind"],
  view: "home" as AppView,
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
  <main class="app-shell view-home">
    <section class="home-screen" aria-label="HOME session manager">
      <div class="android-status">
        <span>10:30</span>
        <strong>DirectSSH</strong>
        <span>LTE 99%</span>
      </div>

      <nav class="top-tabs" aria-label="Primary navigation">
        <button type="button" id="home-tab" class="top-tab active">HOME</button>
        <button type="button" id="ssh-tab" class="top-tab">SSH</button>
        <button type="button" id="more-tab" class="top-tab icon-tab" aria-label="More">...</button>
      </nav>

      <div class="home-toolbar">
        <div class="search-shell">
          <span aria-hidden="true">⌕</span>
          <input id="session-search" autocomplete="off" placeholder="검색 (이름, 호스트, 태그)" />
        </div>
        <button type="button" class="filter-action" aria-label="Filter sessions">F</button>
      </div>

      <div class="session-summary">
        <span>Saved Sessions</span>
        <strong id="profile-count">0 hosts</strong>
      </div>

      <div id="session-list" class="session-list"></div>

      <div class="home-actions">
        <button type="button" id="add-profile" class="add-profile">+ 새 프로필</button>
        <span id="saved-count">0개 프로필</span>
        <button type="button" id="open-settings" class="settings-action" aria-label="Settings">⚙</button>
      </div>
    </section>

    <section class="ssh-screen" aria-label="SSH terminal">
      <div class="terminal-status">
        <span class="rail-measure">20px</span>
        <span id="status-text">Ready</span>
        <strong id="secure-label">Secure Stream</strong>
      </div>

      <div class="terminal-layout">
        <nav class="side-rail" aria-label="Terminal tabs">
          <button type="button" id="rail-home" class="rail-tab"><span>HOME</span></button>
          <button type="button" class="rail-tab active"><span>AWS</span></button>
          <button type="button" class="rail-tab"><span>LOC</span></button>
          <button type="button" id="rail-add" class="rail-tab"><span>+</span></button>
        </nav>

        <div class="terminal-stack">
          <div id="terminal-root" class="terminal-root"></div>
          <div class="shortcut-bar" aria-label="Terminal shortcut keys">
            <button type="button" data-key="\\u001b">ESC</button>
            <button type="button" data-key="\\t">TAB</button>
            <button type="button" data-key="\\u0003">CTRL+C</button>
            <button type="button" data-key="\\u0004">CTRL+D</button>
            <button type="button" data-key="-">-</button>
            <button type="button" data-key="/">/</button>
            <button type="button" data-key="|">|</button>
            <button type="button" data-key="\\u001b[A">↑</button>
            <button type="button" data-key="\\u001b[B">↓</button>
            <button type="button" data-key="\\u001b[C">→</button>
          </div>
        </div>
      </div>
    </section>

    <div id="profile-sheet" class="profile-sheet hidden" role="dialog" aria-modal="true" aria-label="SSH profile editor">
      <form class="profile-form" id="profile-form">
        <div class="sheet-head">
          <div>
            <strong id="sheet-title">새 프로필</strong>
            <span>연결 정보는 로컬 vault에 저장됩니다.</span>
          </div>
          <button type="button" id="close-sheet" class="icon-button" aria-label="Close">×</button>
        </div>

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
          <button type="button" id="delete-selected" class="danger-action">Delete</button>
        </div>
      </form>
    </div>
  </main>
`;

const shell = app.querySelector<HTMLElement>(".app-shell")!;
const form = app.querySelector<HTMLFormElement>("#profile-form")!;
const sessionList = app.querySelector<HTMLDivElement>("#session-list")!;
const profileCount = app.querySelector<HTMLElement>("#profile-count")!;
const savedCount = app.querySelector<HTMLElement>("#saved-count")!;
const statusText = app.querySelector<HTMLSpanElement>("#status-text")!;
const authButtons = [...app.querySelectorAll<HTMLButtonElement>(".auth-option")];
const passwordField = app.querySelector<HTMLElement>("#password-field")!;
const keyFields = app.querySelector<HTMLElement>("#key-fields")!;
const terminalRoot = app.querySelector<HTMLDivElement>("#terminal-root")!;
const profileSheet = app.querySelector<HTMLElement>("#profile-sheet")!;
const sheetTitle = app.querySelector<HTMLElement>("#sheet-title")!;
const searchInput = app.querySelector<HTMLInputElement>("#session-search")!;

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
    fontSize: 14,
    lineHeight: 1.2,
    scrollback: 6000,
    theme: {
      background: "#05080d",
      foreground: "#c8d1de",
      cursor: "#58c7ff",
      cyan: "#58c7ff",
      green: "#54d889",
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

  app.querySelector<HTMLButtonElement>("#home-tab")!.addEventListener("click", () => switchView("home"));
  app.querySelector<HTMLButtonElement>("#ssh-tab")!.addEventListener("click", () => switchView("ssh"));
  app.querySelector<HTMLButtonElement>("#rail-home")!.addEventListener("click", () => switchView("home"));
  app.querySelector<HTMLButtonElement>("#rail-add")!.addEventListener("click", openNewProfileSheet);
  app.querySelector<HTMLButtonElement>("#add-profile")!.addEventListener("click", openNewProfileSheet);
  app.querySelector<HTMLButtonElement>("#open-settings")!.addEventListener("click", openNewProfileSheet);
  app.querySelector<HTMLButtonElement>("#close-sheet")!.addEventListener("click", closeProfileSheet);
  app.querySelector<HTMLButtonElement>("#connect-draft")!.addEventListener("click", connectDraft);
  app.querySelector<HTMLButtonElement>("#delete-selected")!.addEventListener("click", deleteSelectedProfile);
  searchInput.addEventListener("input", renderProfiles);

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
  const query = searchInput.value.trim().toLowerCase();
  const profiles = state.profiles.filter((profile) => {
    if (!query) {
      return true;
    }
    return `${profile.name} ${profile.host} ${profile.username} ${profile.port} ${profile.auth_label}`.toLowerCase().includes(query);
  });

  profileCount.textContent = `${state.profiles.length} hosts`;
  savedCount.textContent = `${state.profiles.length}개 프로필`;

  if (profiles.length === 0) {
    sessionList.innerHTML = `<div class="empty-row">${query ? "검색 결과가 없습니다" : "저장된 세션이 없습니다"}</div>`;
    return;
  }

  sessionList.innerHTML = profiles.map(renderProfileRow).join("");

  sessionList.querySelectorAll<HTMLDivElement>(".session-row").forEach((row) => {
    const profileId = row.dataset.profileId ?? "";
    row.querySelector<HTMLButtonElement>('[data-action="edit"]')!.addEventListener("click", () => selectProfile(profileId, true));
    row.querySelector<HTMLButtonElement>('[data-action="connect"]')!.addEventListener("click", () => connectProfile(profileId));
  });
}

function renderProfileRow(profile: ProfileSummary) {
  const active = profile.id === state.selectedProfileId ? " selected" : "";
  const authClass = profile.auth_kind === "key" ? "key" : "pass";
  const authLabel = profile.auth_kind === "key" ? "KEY" : "PASS";
  return `
    <div class="session-row${active}" data-profile-id="${profile.id}">
      <button type="button" class="row-icon" data-action="edit" aria-label="Edit ${escapeHtml(profile.name)}">☆</button>
      <button type="button" class="session-main" data-action="edit">
        <span class="session-name">${escapeHtml(profile.name)}</span>
        <span class="session-host">${escapeHtml(profile.host)}</span>
        <span class="badge-row">
          <span class="badge port">${profile.port}</span>
          <span class="badge ${authClass}">${escapeHtml(profile.auth_label || authLabel)}</span>
        </span>
      </button>
      <button type="button" class="connect-row" data-action="connect" aria-label="Connect ${escapeHtml(profile.name)}">▶</button>
    </div>
  `;
}

async function saveCurrentProfile() {
  const saved = await invokeCommand<ProfileSummary>("save_profile", { profile: buildProfileDraft() });
  state.selectedProfileId = saved.id;
  await refreshProfiles();
  closeProfileSheet();
  setStatus(`saved: ${saved.name}`);
}

async function deleteSelectedProfile() {
  if (!state.selectedProfileId) {
    return;
  }
  await invokeCommand<void>("delete_profile", { profileId: state.selectedProfileId });
  clearForm();
  closeProfileSheet();
  await refreshProfiles();
  setStatus("profile deleted");
}

async function connectDraft() {
  const draft = buildProfileDraft();
  await startSession(() => invokeCommand<string>("connect_ephemeral", connectionArgs({ profile: draft })), draft.name, draft.port);
}

async function connectProfile(profileId: string) {
  const profile = state.profiles.find((item) => item.id === profileId);
  if (profile) {
    selectProfile(profileId, false);
  }
  await startSession(
    () => invokeCommand<string>("connect_profile", connectionArgs({ profileId })),
    profile?.name ?? "SSH",
    profile?.port ?? 22,
  );
}

async function startSession(connect: () => Promise<string>, label: string, port: number) {
  closeProfileSheet();
  switchView("ssh");
  queueFit();
  setStatus(`connecting: ${label} / Port: ${port}`);
  terminal.reset();
  terminal.write("\x1b[36mDirectSSH\x1b[0m opening socket...\r\n");
  const sessionId = await connect();
  state.activeSessionId = sessionId;
  queueFit();
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
    sheetTitle.textContent = "프로필 편집";
  }
  renderProfiles();
  if (openSheet) {
    openProfileSheet();
  }
}

function openNewProfileSheet() {
  clearForm();
  sheetTitle.textContent = "새 프로필";
  openProfileSheet();
}

function openProfileSheet() {
  profileSheet.classList.remove("hidden");
  fields.name.focus();
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

function switchView(view: AppView) {
  state.view = view;
  shell.classList.toggle("view-home", view === "home");
  shell.classList.toggle("view-ssh", view === "ssh");
  app.querySelector<HTMLButtonElement>("#home-tab")!.classList.toggle("active", view === "home");
  app.querySelector<HTMLButtonElement>("#ssh-tab")!.classList.toggle("active", view === "ssh");

  if (view === "ssh") {
    window.setTimeout(queueFit, 40);
  }
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
  terminal.write("\x1b[36mDirectSSH\x1b[0m ready. Choose a HOME session.\r\n");
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
  setStatus(`error: ${message}`);
  switchView("ssh");
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
    emitMockStatus(sessionId, "connected", "PTY shell opened");
    setTimeout(() => emitMockData(sessionId, "\x1b[32mLinux ip-10-0-0-15\x1b[0m 6.1.0-18-cloud-amd64 #1 SMP Debian x86_64\r\n"), 90);
    setTimeout(() => emitMockData(sessionId, "Last login: Sat May 24 10:21:01 2026 from 203.0.113.45\r\n\r\n"), 180);
    setTimeout(() => emitMockData(sessionId, "\x1b[32mubuntu@ip-10-0-0-15:~$\x1b[0m ls -alh\r\n"), 260);
    setTimeout(() => emitMockData(sessionId, "total 44K\r\ndrwx------  5 ubuntu ubuntu 4.0K May 24 10:21 .\r\ndrwxr-xr-x  3 root   root   4.0K Apr 12 09:11 ..\r\n-rw-r--r--  1 ubuntu ubuntu 3.7K Apr 12 09:11 .bashrc\r\n"), 360);
    setTimeout(() => emitMockData(sessionId, "\r\n\x1b[32mubuntu@ip-10-0-0-15:~$\x1b[0m "), 520);
    return sessionId as T;
  }

  if (command === "resize_pty" || command === "send_input" || command === "disconnect_session") {
    return undefined as T;
  }

  return undefined as T;
}

function readMockProfiles(): ProfileSummary[] {
  const raw = localStorage.getItem(mockProfilesKey);
  if (!raw) {
    return [
      {
        id: "demo-aws-production",
        name: "AWS - Production",
        host: "ec2-3-142-12-10.ap-northeast-2.compute.amazonaws.com",
        port: 2222,
        username: "ubuntu",
        auth_kind: "key",
        auth_label: "KEY",
        updated_at: 4,
      },
      {
        id: "demo-home-lab",
        name: "Home Lab",
        host: "192.168.0.23",
        port: 22,
        username: "admin",
        auth_kind: "password",
        auth_label: "PASS",
        updated_at: 3,
      },
      {
        id: "demo-docker-host",
        name: "Docker Host",
        host: "10.0.0.15",
        port: 2222,
        username: "ubuntu",
        auth_kind: "key",
        auth_label: "KEY",
        updated_at: 2,
      },
      {
        id: "demo-git-server",
        name: "Git Server",
        host: "git.example.com",
        port: 22,
        username: "git",
        auth_kind: "key",
        auth_label: "KEY",
        updated_at: 1,
      },
      {
        id: "demo-staging-server",
        name: "Staging Server",
        host: "staging.example.com",
        port: 2222,
        username: "deploy",
        auth_kind: "password",
        auth_label: "PASS",
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
    auth_label: profile.auth.kind === "key" ? "KEY" : "PASS",
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
