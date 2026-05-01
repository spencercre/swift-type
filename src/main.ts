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
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";

const PYTHON = process.platform === "win32" ? "python" : "python3";

// ─── State ───────────────────────────────────────────────────────────────────

type TrayState = "idle" | "recording" | "transcribing";

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let recordingActive = false;
let recordingStartEpoch = 0;

// Persisted settings (written to disk on save)
interface Settings {
  microphone: string;
  model: "tiny" | "base" | "small";
}

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      return { microphone: raw.microphone ?? "default", model: raw.model ?? "base" };
    }
  } catch {
    // fall through to defaults
  }
  return { microphone: "default", model: "base" };
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
};

function setTrayState(state: TrayState): void {
  if (!tray) return;
  tray.setImage(ICON[state]());
  const labels: Record<TrayState, string> = {
    idle: "Swift Type — Idle",
    recording: "Swift Type — Recording…",
    transcribing: "Swift Type — Transcribing…",
  };
  tray.setToolTip(labels[state]);
}

// ─── Tray setup ──────────────────────────────────────────────────────────────

function createTray(): void {
  tray = new Tray(ICON.idle());
  tray.setToolTip("Swift Type — Idle");

  const menu = Menu.buildFromTemplate([
    { label: "Swift Type", enabled: false },
    { type: "separator" },
    { label: "Settings", click: openSettings },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ─── Settings window ─────────────────────────────────────────────────────────

function openSettings(): void {
  if (settingsWindow) {
    settingsWindow.focus();
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

  const settingsPath = app.isPackaged
    ? path.join(process.resourcesPath, "src", "settings.html")
    : path.join(__dirname, "../src/settings.html");
  settingsWindow.loadFile(settingsPath);
  settingsWindow.setIcon(assetIcon("icon-idle.png"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
  settingsWindow.setMenu(null);
}

// ─── Whisper transcription subprocess ────────────────────────────────────────

function transcribeAudio(audioPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, "whisper_worker.py")
      : path.join(__dirname, "../src/whisper_worker.py");

    const proc = spawn(PYTHON, [workerPath, audioPath, settings.model], {
      timeout: 60_000,
    });

    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper_worker exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(out.trim());
        resolve((result.text ?? "").trim());
      } catch {
        reject(new Error(`Bad JSON from whisper_worker: ${out}`));
      }
    });
  });
}

// ─── Text injection via clipboard ────────────────────────────────────────────

async function injectText(text: string): Promise<void> {
  if (!text) return;
  clipboard.writeText(text);

  // Small delay so the target window can receive focus back
  await new Promise((r) => setTimeout(r, 150));

  // On Windows, use robotjs or PowerShell to send Ctrl+V.
  // On Linux (dev), use xdotool.
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const robot = require("@jitsi/robotjs");
      robot.keyTap("v", ["control"]);
    } catch {
      // robotjs not available — clipboard is pre-loaded, user can paste manually
    }
  } else {
    spawn("xdotool", ["key", "ctrl+v"]).on("error", () => {
      // xdotool not installed — clipboard is pre-loaded
    });
  }
}

// ─── Recording flow ───────────────────────────────────────────────────────────

let audioTempPath: string | null = null;

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
  if (settings.microphone && settings.microphone !== "default") {
    recArgs.push("--device", settings.microphone);
  }
  const rec = spawn(PYTHON, recArgs, { detached: false });

  (global as Record<string, unknown>).__recorderPid = rec.pid;
  rec.on("error", () => { /* recorder not available in dev */ });
}

async function stopRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;

  const pid = (global as Record<string, unknown>).__recorderPid as number | undefined;
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  if (!audioTempPath || !fs.existsSync(audioTempPath)) {
    setTrayState("idle");
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
    setTrayState("idle");
  }
}

// ─── Global keyboard hook (uIOhook) ──────────────────────────────────────────
//
// Three-finger left hand combo — Ctrl+Win+Alt
// Hold all three to start recording, release any one to stop.

const COMBO_KEYS = new Set<number>([
  UiohookKey.Ctrl,       // 29
  UiohookKey.CtrlRight,  // 3613
  UiohookKey.Meta,       // 3675 — left Win
  UiohookKey.MetaRight,  // 3676 — right Win
  UiohookKey.Alt,        // 56
  UiohookKey.AltRight,   // 3640
]);

const held = new Set<number>();

function comboHeld(): boolean {
  const hasCtrl = held.has(UiohookKey.Ctrl)  || held.has(UiohookKey.CtrlRight);
  const hasMeta = held.has(UiohookKey.Meta)  || held.has(UiohookKey.MetaRight);
  const hasAlt  = held.has(UiohookKey.Alt)   || held.has(UiohookKey.AltRight);
  return hasCtrl && hasMeta && hasAlt;
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
  console.log("[SwiftType] uIOhook started — hold Ctrl+Win+Alt to record");
}

// ─── IPC handlers (used by settings window) ──────────────────────────────────

ipcMain.handle("get-settings", () => settings);

ipcMain.handle("save-settings", (_event, newSettings: Settings) => {
  settings = newSettings;
  saveSettings(settings);
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

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide();
  createTray();
  setupHook();
});

app.on("will-quit", () => {
  uIOhook.stop();
});

// Keep process alive with no windows open (tray app)
app.on("window-all-closed", () => { /* intentional — tray-only app */ });
