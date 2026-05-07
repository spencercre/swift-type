import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
} from "electron";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

const PYTHON = process.platform === "win32" ? "python" : "python3";

// ─── State ───────────────────────────────────────────────────────────────────

type TrayState = "idle" | "recording" | "transcribing" | "warning";

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let probeWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let onboardingShouldStartPulse = false;
let recordingActive = false;
let recordingStartEpoch = 0;

// ── Phase 2 pulse state — coral↔amber tray flicker after onboarding "I'm ready"
let pulseActive = false;
let pulseInterval: NodeJS.Timeout | null = null;
let pulseTimeoutHandle: NodeJS.Timeout | null = null;
let pulseToggle = false;

// Settings window opens directly on the mic dropdown when this flag is set
// (e.g. after a left-click on the warning tray icon).
let settingsFocusMicOnce = false;

// Persisted settings (written to disk on save)
interface ResolvedMic {
  label: string;
  deviceId: string;
}

interface Settings {
  microphone: ResolvedMic | null;
  micUserSelected: boolean;
  model: "tiny" | "base" | "small";
  onboardingCompleted: boolean;
}

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");
const LOG_PATH = path.join(app.getPath("userData"), "swift-speak.log");

// One-time migration: copy any pre-2.0 user data forward from %APPDATA%\swift-type
// (and the older productName-shaped %APPDATA%\Swift Type, just in case) into the
// new userData directory, then remove the legacy folder. Runs synchronously
// before settings load so we read from the right place on the first 2.0 launch.
//
// Returns whether a settings.json was found in the legacy location — used by
// the caller to mark onboarding complete (1.x users already know the app).
function migrateLegacyUserData(): { migratedSettings: boolean } {
  const newDir = app.getPath("userData");
  const appData = path.dirname(newDir);
  const legacyCandidates = [
    path.join(appData, "swift-type"),
    path.join(appData, "Swift Type"),
  ];

  let migratedSettings = false;

  for (const oldDir of legacyCandidates) {
    if (oldDir === newDir) continue;
    if (!fs.existsSync(oldDir)) continue;

    if (fs.existsSync(path.join(oldDir, "settings.json"))) {
      migratedSettings = true;
    }

    try {
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });

      const entries = fs.readdirSync(oldDir);
      for (const name of entries) {
        const src = path.join(oldDir, name);
        const dst = path.join(newDir, name);
        if (fs.existsSync(dst)) continue;
        try {
          const stat = fs.statSync(src);
          if (stat.isFile()) fs.copyFileSync(src, dst);
        } catch {
          // skip unreadable entries (locked Cache files, etc.)
        }
      }

      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }

      const ts = new Date().toISOString();
      const msg = `[${ts}] [SwiftSpeak] migrated user data ${oldDir} → ${newDir}\n`;
      try { fs.appendFileSync(LOG_PATH, msg); } catch { /* ignore */ }
      console.log(msg.trim());
    } catch (e) {
      console.warn(`[SwiftSpeak] legacy migration from ${oldDir} failed:`, e);
    }
  }

  return { migratedSettings };
}

const migration = migrateLegacyUserData();

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      let mic: ResolvedMic | null = null;
      if (raw.microphone && typeof raw.microphone === "object") {
        const lbl = typeof raw.microphone.label === "string" ? raw.microphone.label : "";
        const id  = typeof raw.microphone.deviceId === "string" ? raw.microphone.deviceId : "";
        if (lbl || id) mic = { label: lbl, deviceId: id };
      }
      // Legacy string microphone (e.g. "default" or device name) → treat as unresolved.
      const model = (raw.model === "tiny" || raw.model === "small") ? raw.model : "base";
      return {
        microphone: mic,
        micUserSelected: !!raw.micUserSelected,
        model,
        onboardingCompleted: !!raw.onboardingCompleted,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { microphone: null, micUserSelected: false, model: "base", onboardingCompleted: false };
}

function saveSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();

// Users upgrading from Swift Type 1.x already know how the app works — don't
// hit them with a welcome tour. Honour the migration even if their old
// settings.json had no onboardingCompleted field at all (1.x didn't have it).
if (migration.migratedSettings && !settings.onboardingCompleted) {
  settings.onboardingCompleted = true;
  saveSettings(settings);
  console.log("[SwiftSpeak] migrated 1.x user — marking onboarding complete");
}

// ─── Tray icons — loaded from assets/ ────────────────────────────────────────

function assetIcon(name: string): Electron.NativeImage {
  const assetDir = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(__dirname, "../assets");
  const iconPath = path.join(assetDir, name);
  return fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
}

const ICON: Record<TrayState, () => Electron.NativeImage> = {
  idle:         () => assetIcon("icon-idle.png"),
  recording:    () => assetIcon("icon-recording.png"),
  transcribing: () => assetIcon("icon-transcribing.png"),
  warning:      () => assetIcon("tray-warning.png"),
};

let trayState: TrayState = "idle";

function setTrayState(state: TrayState): void {
  trayState = state;
  if (!tray) return;
  // Don't fight the pulse — it owns the icon while running.
  if (pulseActive && state === "idle") return;
  tray.setImage(ICON[state]());
  if (state === "warning") {
    tray.setToolTip("Swift Speak: No microphone selected — right-click to open Settings");
    return;
  }
  const modelLabel = settings.model.charAt(0).toUpperCase() + settings.model.slice(1);
  const labels: Record<Exclude<TrayState, "warning">, string> = {
    idle:         `Swift Speak — ${modelLabel}`,
    recording:    "Swift Speak — Recording…",
    transcribing: "Swift Speak — Transcribing…",
  };
  tray.setToolTip(labels[state]);
}

// ─── Tray setup ──────────────────────────────────────────────────────────────

function createTray(): void {
  tray = new Tray(ICON.idle());

  const menu = Menu.buildFromTemplate([
    { label: "Swift Speak", enabled: false },
    { type: "separator" },
    { label: "Settings", click: () => openSettings() },
    { label: "Show Welcome Tour", click: () => resetOnboardingForNextLaunch() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (pulseActive) stopPulse("tray-click");
    openSettings({ focusMic: trayState === "warning" });
  });
}

function resetOnboardingForNextLaunch(): void {
  settings.onboardingCompleted = false;
  saveSettings(settings);
  console.log("[SwiftSpeak] welcome tour reset — will show on next launch");
  if (Notification.isSupported()) {
    try {
      new Notification({
        title: "Welcome tour reset",
        body: "It’ll appear the next time you start Swift Speak.",
        icon: assetIcon("icon-idle.png"),
        silent: true,
      }).show();
    } catch { /* notifications optional */ }
  }
}

// ─── Settings window ─────────────────────────────────────────────────────────

function openSettings(opts: { focusMic?: boolean } = {}): void {
  if (opts.focusMic) settingsFocusMicOnce = true;

  if (settingsWindow) {
    settingsWindow.focus();
    if (opts.focusMic) {
      settingsWindow.webContents.send("focus-mic-dropdown");
    }
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    title: "Swift Speak — Settings",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Allow mic permission prompts inside the settings window so device labels resolve.
  settingsWindow.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(permission === "media")
  );

  const settingsPath = app.isPackaged
    ? path.join(process.resourcesPath, "src", "settings.html")
    : path.join(__dirname, "../src/settings.html");
  settingsWindow.loadFile(settingsPath);
  settingsWindow.setIcon(assetIcon("icon-idle.png"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.setMenu(null);
}

// ─── Onboarding window (3-slide first-launch tour) ───────────────────────────

function openOnboarding(): void {
  if (onboardingWindow) {
    onboardingWindow.focus();
    return;
  }

  const primary = screen.getPrimaryDisplay().workArea;
  const width = 520;
  const height = 420;
  const x = Math.round(primary.x + (primary.width - width) / 2);
  const y = Math.round(primary.y + (primary.height - height) / 2);

  onboardingWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: "#00000000",
    title: "Welcome to Swift Speak",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Slide 2's "Test mic" needs media access.
  onboardingWindow.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(permission === "media")
  );

  const onboardingPath = app.isPackaged
    ? path.join(process.resourcesPath, "src", "onboarding.html")
    : path.join(__dirname, "../src/onboarding.html");
  onboardingWindow.loadFile(onboardingPath);
  onboardingWindow.setMenu(null);
  onboardingWindow.once("ready-to-show", () => onboardingWindow?.show());

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
    if (onboardingShouldStartPulse) {
      onboardingShouldStartPulse = false;
      startPulse();
    }
  });
}

// ─── Phase 2: post-onboarding pulse + native toast ──────────────────────────

function startPulse(): void {
  if (pulseActive) return;
  pulseActive = true;
  pulseToggle = false;

  // Fire the toast immediately. On click, settle the pulse and open settings.
  if (Notification.isSupported()) {
    try {
      const toast = new Notification({
        title: "Swift Speak is ready",
        body: "Hold Ctrl+` anywhere to start dictating. Click here to open settings.",
        icon: assetIcon("icon-idle.png"),
        silent: false,
      });
      toast.on("click", () => {
        if (pulseActive) stopPulse("toast-click");
        openSettings();
      });
      toast.show();
    } catch (e) {
      console.warn("[SwiftSpeak] toast failed:", e);
    }
  }

  // Slow ~1.5s coral↔amber swap. The existing `icon-idle.png` is already coral
  // (#E8735A) and `tray-warning.png` is amber (#F5A623), so reuse them.
  pulseInterval = setInterval(() => {
    if (!tray) return;
    pulseToggle = !pulseToggle;
    tray.setImage(assetIcon(pulseToggle ? "tray-warning.png" : "icon-idle.png"));
  }, 1500);

  pulseTimeoutHandle = setTimeout(() => stopPulse("timeout"), 60_000);

  console.log("[SwiftSpeak] post-onboarding pulse started");
}

function stopPulse(reason: string): void {
  if (!pulseActive) return;
  pulseActive = false;

  if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = null; }
  if (pulseTimeoutHandle) { clearTimeout(pulseTimeoutHandle); pulseTimeoutHandle = null; }

  // Settle to whatever steady state the app should be in (coral idle if we
  // have a mic, warning if we don't).
  if (tray) {
    const restState: TrayState = settings.microphone ? "idle" : "warning";
    trayState = restState;
    tray.setImage(ICON[restState]());
  }

  const ts = new Date().toISOString();
  const msg = `[${ts}] [SwiftSpeak] post-onboarding pulse ended: ${reason}\n`;
  try { fs.appendFileSync(LOG_PATH, msg); } catch { /* ignore */ }
  console.log(msg.trim());
}

// ─── Mic probe (runs at startup in a hidden window) ──────────────────────────

interface MicProbeResult {
  ok: boolean;
  mic: ResolvedMic | null;
  reason: string;
  detail?: string;
  attempted?: { label: string; deviceId: string };
}

function startMicProbe(): void {
  probeWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: false,
    },
  });

  probeWindow.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(permission === "media")
  );

  const probePath = app.isPackaged
    ? path.join(process.resourcesPath, "src", "mic-probe.html")
    : path.join(__dirname, "../src/mic-probe.html");
  probeWindow.loadFile(probePath);

  probeWindow.on("closed", () => { probeWindow = null; });

  // Fail-safe: if the probe never reports back (e.g. crashes), warn after 8s.
  setTimeout(() => {
    if (probeWindow && !probeWindow.isDestroyed()) {
      console.warn("[SwiftSpeak] mic probe timeout — entering warning state");
      handleMicProbeResult({ ok: false, mic: null, reason: "probe-timeout" });
      try { probeWindow.close(); } catch { /* ignore */ }
    }
  }, 8000);
}

function handleMicProbeResult(result: MicProbeResult): void {
  if (result.ok && result.mic) {
    const previous = settings.microphone;
    settings.microphone = result.mic;
    if (
      !previous ||
      previous.label !== result.mic.label ||
      previous.deviceId !== result.mic.deviceId
    ) {
      saveSettings(settings);
    }

    if (result.reason === "auto-picked-first-launch") {
      console.log(`[SwiftSpeak] Auto-selected mic on first launch: ${result.mic.label}`);
    } else if (result.reason === "matched-by-label") {
      console.log(`[SwiftSpeak] mic resolved by label: ${result.mic.label}`);
    } else if (result.reason === "matched-by-deviceId-fallback") {
      console.log(`[SwiftSpeak] mic resolved by deviceId fallback (label missing): ${result.mic.label}`);
    } else if (result.reason === "auto-picked-fallback") {
      console.log(`[SwiftSpeak] saved mic not found — auto-picked first available: ${result.mic.label}`);
    } else {
      console.log(`[SwiftSpeak] mic resolved (${result.reason}): ${result.mic.label}`);
    }
    setTrayState("idle");
  } else {
    settings.microphone = null;
    saveSettings(settings);
    console.warn(
      `[SwiftSpeak] mic unresolved (${result.reason})${result.detail ? ": " + result.detail : ""}`
    );
    setTrayState("warning");
  }
}

// ─── Whisper transcription subprocess ────────────────────────────────────────

function transcribeAudio(audioPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, "whisper_worker.py")
      : path.join(__dirname, "../src/whisper_worker.py");

    const args = [workerPath, audioPath, settings.model];
    console.log(`[SwiftSpeak] transcribe cmd: ${PYTHON} ${args.join(" ")}`);

    const proc = spawn(PYTHON, args, { timeout: 60_000 });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      out += chunk;
      console.log(`[SwiftSpeak] whisper stdout: ${chunk.trimEnd()}`);
    });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      err += chunk;
      console.log(`[SwiftSpeak] whisper stderr: ${chunk.trimEnd()}`);
    });

    proc.on("close", (code) => {
      console.log(`[SwiftSpeak] whisper exited code=${code}`);
      if (code !== 0) {
        reject(new Error(`whisper_worker exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(out.trim());
        const text = (result.text ?? "").trim();
        console.log(`[SwiftSpeak] transcribed text: "${text}"`);
        resolve(text);
      } catch {
        reject(new Error(`Bad JSON from whisper_worker: ${out}`));
      }
    });
  });
}

// ─── Text injection via clipboard ────────────────────────────────────────────

async function injectText(text: string): Promise<void> {
  if (!text) {
    console.log("[SwiftSpeak] injectText: empty text — skipping paste");
    return;
  }
  clipboard.writeText(text);
  console.log(`[SwiftSpeak] clipboard set: "${text.length > 80 ? text.slice(0, 80) + "…" : text}"`);

  // Small delay so the target window can receive focus back
  await new Promise((r) => setTimeout(r, 150));

  // On Windows, use robotjs or PowerShell to send Ctrl+V.
  // On Linux (dev), use xdotool.
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const robot = require("@jitsi/robotjs");
      robot.keyTap("v", ["control"]);
      console.log("[SwiftSpeak] paste sent via robotjs Ctrl+V");
    } catch {
      console.log("[SwiftSpeak] robotjs unavailable — clipboard pre-loaded, paste manually");
    }
  } else {
    spawn("xdotool", ["key", "ctrl+v"]).on("error", () => {
      console.log("[SwiftSpeak] xdotool unavailable — clipboard pre-loaded");
    });
    console.log("[SwiftSpeak] paste sent via xdotool Ctrl+V");
  }
}

// ─── Recording flow ───────────────────────────────────────────────────────────

let audioTempPath: string | null = null;
let recorderProc: ChildProcess | null = null;

async function startRecording(): Promise<void> {
  if (recordingActive) return;
  recordingActive = true;
  recordingStartEpoch = Date.now();
  setTrayState("recording");

  audioTempPath = path.join(app.getPath("temp"), `swiftspeak-${Date.now()}.wav`);

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "whisper_worker.py")
    : path.join(__dirname, "../src/whisper_worker.py");

  const recArgs = [workerPath, "--record", audioTempPath];
  if (settings.microphone && settings.microphone.label) {
    recArgs.push("--device", settings.microphone.label);
  }
  console.log(`[SwiftSpeak] recorder cmd: ${PYTHON} ${recArgs.join(" ")}`);
  const rec = spawn(PYTHON, recArgs, { detached: false });
  recorderProc = rec;

  rec.stderr?.on("data", (d) => console.log(`[SwiftSpeak] recorder: ${d.toString().trimEnd()}`));
  rec.on("error", (e) => console.error("[SwiftSpeak] recorder spawn error:", e));
}

async function stopRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;

  // Tell Python to stop via stop-file (works on Windows and Unix)
  if (audioTempPath) {
    const stopFile = audioTempPath + ".stop";
    try {
      fs.writeFileSync(stopFile, "stop");
      console.log(`[SwiftSpeak] stop-file created: ${stopFile}`);
    } catch (e) {
      console.warn("[SwiftSpeak] stop-file write failed:", e);
    }
  }

  // Wait for the recorder to exit cleanly so the WAV is fully written
  const proc = recorderProc;
  recorderProc = null;
  if (proc && proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[SwiftSpeak] recorder did not exit in 3s — force killing");
        try { proc.kill(); } catch { /* ignore */ }
        resolve();
      }, 3000);
      proc.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  // Clean up stop-file if Python didn't remove it
  if (audioTempPath) {
    try { fs.unlinkSync(audioTempPath + ".stop"); } catch { /* already removed */ }
  }

  const wavExists = !!audioTempPath && fs.existsSync(audioTempPath);
  const wavSize   = wavExists ? fs.statSync(audioTempPath!).size : 0;
  console.log(`[SwiftSpeak] WAV: path=${audioTempPath} exists=${wavExists} size=${wavSize}B`);

  if (!audioTempPath || !wavExists) {
    setTrayState(settings.microphone ? "idle" : "warning");
    return;
  }

  setTrayState("transcribing");

  try {
    const text = await transcribeAudio(audioTempPath);
    await injectText(text);
  } catch (e) {
    console.error("Transcription failed:", e);
  } finally {
    try { fs.unlinkSync(audioTempPath); } catch { /* ignore */ }
    audioTempPath = null;
    setTrayState(settings.microphone ? "idle" : "warning");
  }
}

// ─── Global keyboard hook (uIOhook) ──────────────────────────────────────────
//
// Ctrl+Backtick — hold to record, release to transcribe.
// Backtick (grave accent) is keycode 41 in uIOhook.

const BACKTICK = 41;

const COMBO_KEYS = new Set<number>([
  UiohookKey.Ctrl,       // 29
  UiohookKey.CtrlRight,  // 3613
  BACKTICK,              // 41 — ` (grave accent)
]);

const held = new Set<number>();

function comboHeld(): boolean {
  const hasCtrl     = held.has(UiohookKey.Ctrl) || held.has(UiohookKey.CtrlRight);
  const hasBacktick = held.has(BACKTICK);
  return hasCtrl && hasBacktick;
}

function setupHook(): void {
  uIOhook.on("keydown", (e) => {
    if (!COMBO_KEYS.has(e.keycode)) return;
    held.add(e.keycode);
    if (comboHeld() && !recordingActive) {
      if (pulseActive) stopPulse("hotkey-first-fire");
      console.log("[SwiftSpeak] Combo held — starting recording");
      startRecording();
    }
  });

  uIOhook.on("keyup", (e) => {
    if (!COMBO_KEYS.has(e.keycode)) return;
    const wasCombo = comboHeld();
    held.delete(e.keycode);
    if (wasCombo && !comboHeld() && recordingActive) {
      console.log("[SwiftSpeak] Combo released — stopping recording");
      stopRecording();
    }
  });

  uIOhook.start();
  console.log("[SwiftSpeak] uIOhook started — hold Ctrl+` to record");
}

// ─── IPC handlers (used by settings window) ──────────────────────────────────

ipcMain.handle("get-settings", () => settings);

ipcMain.handle("save-settings", (_event, newSettings: Partial<Settings>) => {
  // Use `in` checks so callers can do partial updates (onboarding only sends
  // microphone + micUserSelected). Without this, a partial save would clobber
  // the unset fields back to their defaults.
  const merged: Settings = {
    microphone: "microphone" in (newSettings || {})
      ? (newSettings.microphone ?? null)
      : settings.microphone,
    micUserSelected: "micUserSelected" in (newSettings || {})
      ? !!newSettings.micUserSelected
      : settings.micUserSelected,
    model: "model" in (newSettings || {}) && newSettings.model
      ? (newSettings.model as Settings["model"])
      : settings.model,
    onboardingCompleted: "onboardingCompleted" in (newSettings || {})
      ? !!newSettings.onboardingCompleted
      : settings.onboardingCompleted,
  };
  settings = merged;
  saveSettings(settings);
  if (!pulseActive) setTrayState(settings.microphone ? "idle" : "warning");
});

ipcMain.handle("get-audio-devices", async () => {
  return new Promise((resolve) => {
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, "whisper_worker.py")
      : path.join(__dirname, "../src/whisper_worker.py");

    const proc = spawn(PYTHON, [workerPath, "--list-devices"]);
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("close", () => {
      try { resolve(JSON.parse(out.trim())); }
      catch { resolve([]); }
    });
    proc.on("error", () => resolve([]));
  });
});

ipcMain.handle("mic-probe-result", (_event, result: MicProbeResult) => {
  handleMicProbeResult(result);
  if (probeWindow && !probeWindow.isDestroyed()) {
    try { probeWindow.close(); } catch { /* ignore */ }
  }
  return true;
});

ipcMain.handle("settings-focus-mic-flag", () => {
  const flag = settingsFocusMicOnce;
  settingsFocusMicOnce = false;
  return flag;
});

ipcMain.handle("onboarding-complete", () => {
  settings.onboardingCompleted = true;
  saveSettings(settings);
  onboardingShouldStartPulse = true;
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    try { onboardingWindow.close(); } catch { /* ignore */ }
  }
  return true;
});

ipcMain.handle("onboarding-skip", () => {
  settings.onboardingCompleted = true;
  saveSettings(settings);
  onboardingShouldStartPulse = false;
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    try { onboardingWindow.close(); } catch { /* ignore */ }
  }
  return true;
});

// ─── Model preflight ─────────────────────────────────────────────────────────
//
// On first run, faster-whisper downloads ~150 MB. Run it at startup (tray-visible
// but before the first recording) so the download doesn't stall a live session.

function runPreflight(): void {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "whisper_worker.py")
    : path.join(__dirname, "../src/whisper_worker.py");

  console.log(`[SwiftSpeak] preflight: checking model '${settings.model}'…`);
  const proc = spawn(PYTHON, [workerPath, "--preflight", settings.model]);
  proc.stderr?.on("data", (d) => console.log(`[SwiftSpeak] preflight: ${d.toString().trimEnd()}`));
  proc.on("close", (code) => {
    if (code === 0) {
      console.log(`[SwiftSpeak] preflight: model '${settings.model}' ready`);
    } else {
      console.warn(`[SwiftSpeak] preflight: exited ${code} — model may download on first transcription`);
    }
  });
  proc.on("error", (e) => console.warn("[SwiftSpeak] preflight spawn error:", e));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();
  createTray();
  setTrayState("idle");
  setupHook();
  runPreflight();
  startMicProbe();

  // Show onboarding on top of the now-visible tray. Slide 3's arrow points at
  // the tray, so the tray needs to exist before the window appears.
  if (!settings.onboardingCompleted) {
    openOnboarding();
  }
});

app.on("will-quit", () => {
  uIOhook.stop();
});

// Keep process alive with no windows open (tray app)
app.on("window-all-closed", () => { /* intentional — tray-only app */ });
