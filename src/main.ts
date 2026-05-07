import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
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
let recordingActive = false;
let recordingStartEpoch = 0;

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
}

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

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
      };
    }
  } catch {
    // fall through to defaults
  }
  return { microphone: null, micUserSelected: false, model: "base" };
}

function saveSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();

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
  tray.setImage(ICON[state]());
  if (state === "warning") {
    tray.setToolTip("Swift Type: No microphone selected — right-click to open Settings");
    return;
  }
  const modelLabel = settings.model.charAt(0).toUpperCase() + settings.model.slice(1);
  const labels: Record<Exclude<TrayState, "warning">, string> = {
    idle:         `Swift Type — ${modelLabel}`,
    recording:    "Swift Type — Recording…",
    transcribing: "Swift Type — Transcribing…",
  };
  tray.setToolTip(labels[state]);
}

// ─── Tray setup ──────────────────────────────────────────────────────────────

function createTray(): void {
  tray = new Tray(ICON.idle());

  const menu = Menu.buildFromTemplate([
    { label: "Swift Type", enabled: false },
    { type: "separator" },
    { label: "Settings", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);

  tray.on("click", () => {
    openSettings({ focusMic: trayState === "warning" });
  });
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
    title: "Swift Type — Settings",
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
      console.warn("[SwiftType] mic probe timeout — entering warning state");
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
      console.log(`[SwiftType] Auto-selected mic on first launch: ${result.mic.label}`);
    } else if (result.reason === "matched-by-label") {
      console.log(`[SwiftType] mic resolved by label: ${result.mic.label}`);
    } else if (result.reason === "matched-by-deviceId-fallback") {
      console.log(`[SwiftType] mic resolved by deviceId fallback (label missing): ${result.mic.label}`);
    } else if (result.reason === "auto-picked-fallback") {
      console.log(`[SwiftType] saved mic not found — auto-picked first available: ${result.mic.label}`);
    } else {
      console.log(`[SwiftType] mic resolved (${result.reason}): ${result.mic.label}`);
    }
    setTrayState("idle");
  } else {
    settings.microphone = null;
    saveSettings(settings);
    console.warn(
      `[SwiftType] mic unresolved (${result.reason})${result.detail ? ": " + result.detail : ""}`
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
    console.log(`[SwiftType] transcribe cmd: ${PYTHON} ${args.join(" ")}`);

    const proc = spawn(PYTHON, args, { timeout: 60_000 });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      out += chunk;
      console.log(`[SwiftType] whisper stdout: ${chunk.trimEnd()}`);
    });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      err += chunk;
      console.log(`[SwiftType] whisper stderr: ${chunk.trimEnd()}`);
    });

    proc.on("close", (code) => {
      console.log(`[SwiftType] whisper exited code=${code}`);
      if (code !== 0) {
        reject(new Error(`whisper_worker exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(out.trim());
        const text = (result.text ?? "").trim();
        console.log(`[SwiftType] transcribed text: "${text}"`);
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
    console.log("[SwiftType] injectText: empty text — skipping paste");
    return;
  }
  clipboard.writeText(text);
  console.log(`[SwiftType] clipboard set: "${text.length > 80 ? text.slice(0, 80) + "…" : text}"`);

  // Small delay so the target window can receive focus back
  await new Promise((r) => setTimeout(r, 150));

  // On Windows, use robotjs or PowerShell to send Ctrl+V.
  // On Linux (dev), use xdotool.
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const robot = require("@jitsi/robotjs");
      robot.keyTap("v", ["control"]);
      console.log("[SwiftType] paste sent via robotjs Ctrl+V");
    } catch {
      console.log("[SwiftType] robotjs unavailable — clipboard pre-loaded, paste manually");
    }
  } else {
    spawn("xdotool", ["key", "ctrl+v"]).on("error", () => {
      console.log("[SwiftType] xdotool unavailable — clipboard pre-loaded");
    });
    console.log("[SwiftType] paste sent via xdotool Ctrl+V");
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

  audioTempPath = path.join(app.getPath("temp"), `swifttype-${Date.now()}.wav`);

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "whisper_worker.py")
    : path.join(__dirname, "../src/whisper_worker.py");

  const recArgs = [workerPath, "--record", audioTempPath];
  if (settings.microphone && settings.microphone.label) {
    recArgs.push("--device", settings.microphone.label);
  }
  console.log(`[SwiftType] recorder cmd: ${PYTHON} ${recArgs.join(" ")}`);
  const rec = spawn(PYTHON, recArgs, { detached: false });
  recorderProc = rec;

  rec.stderr?.on("data", (d) => console.log(`[SwiftType] recorder: ${d.toString().trimEnd()}`));
  rec.on("error", (e) => console.error("[SwiftType] recorder spawn error:", e));
}

async function stopRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;

  // Tell Python to stop via stop-file (works on Windows and Unix)
  if (audioTempPath) {
    const stopFile = audioTempPath + ".stop";
    try {
      fs.writeFileSync(stopFile, "stop");
      console.log(`[SwiftType] stop-file created: ${stopFile}`);
    } catch (e) {
      console.warn("[SwiftType] stop-file write failed:", e);
    }
  }

  // Wait for the recorder to exit cleanly so the WAV is fully written
  const proc = recorderProc;
  recorderProc = null;
  if (proc && proc.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn("[SwiftType] recorder did not exit in 3s — force killing");
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
  console.log(`[SwiftType] WAV: path=${audioTempPath} exists=${wavExists} size=${wavSize}B`);

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
      console.log("[SwiftType] Combo held — starting recording");
      startRecording();
    }
  });

  uIOhook.on("keyup", (e) => {
    if (!COMBO_KEYS.has(e.keycode)) return;
    const wasCombo = comboHeld();
    held.delete(e.keycode);
    if (wasCombo && !comboHeld() && recordingActive) {
      console.log("[SwiftType] Combo released — stopping recording");
      stopRecording();
    }
  });

  uIOhook.start();
  console.log("[SwiftType] uIOhook started — hold Ctrl+` to record");
}

// ─── IPC handlers (used by settings window) ──────────────────────────────────

ipcMain.handle("get-settings", () => settings);

ipcMain.handle("save-settings", (_event, newSettings: Partial<Settings>) => {
  const merged: Settings = {
    microphone: newSettings.microphone ?? null,
    micUserSelected: newSettings.micUserSelected ?? settings.micUserSelected,
    model: (newSettings.model as Settings["model"]) ?? settings.model,
  };
  settings = merged;
  saveSettings(settings);
  setTrayState(settings.microphone ? "idle" : "warning");
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

// ─── Model preflight ─────────────────────────────────────────────────────────
//
// On first run, faster-whisper downloads ~150 MB. Run it at startup (tray-visible
// but before the first recording) so the download doesn't stall a live session.

function runPreflight(): void {
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "whisper_worker.py")
    : path.join(__dirname, "../src/whisper_worker.py");

  console.log(`[SwiftType] preflight: checking model '${settings.model}'…`);
  const proc = spawn(PYTHON, [workerPath, "--preflight", settings.model]);
  proc.stderr?.on("data", (d) => console.log(`[SwiftType] preflight: ${d.toString().trimEnd()}`));
  proc.on("close", (code) => {
    if (code === 0) {
      console.log(`[SwiftType] preflight: model '${settings.model}' ready`);
    } else {
      console.warn(`[SwiftType] preflight: exited ${code} — model may download on first transcription`);
    }
  });
  proc.on("error", (e) => console.warn("[SwiftType] preflight spawn error:", e));
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();
  createTray();
  setTrayState("idle");
  setupHook();
  runPreflight();
  startMicProbe();
});

app.on("will-quit", () => {
  uIOhook.stop();
});

// Keep process alive with no windows open (tray app)
app.on("window-all-closed", () => { /* intentional — tray-only app */ });
