import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
} from "electron";
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
  hotkey: string;
  microphone: string;
  model: "tiny" | "base" | "small";
}

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {
    // fall through to defaults
  }
  return { hotkey: "CommandOrControl+Shift+Space", microphone: "default", model: "base" };
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
    height: 380,
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

  // Write audio to a temp file via Python recorder
  audioTempPath = path.join(app.getPath("temp"), `swifttype-${Date.now()}.wav`);

  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "whisper_worker.py")
    : path.join(__dirname, "../src/whisper_worker.py");

  // Start recording subprocess (runs until stopRecording sends SIGTERM)
  const recArgs = [workerPath, "--record", audioTempPath];
  if (settings.microphone && settings.microphone !== "default") {
    recArgs.push("--device", settings.microphone);
  }
  const rec = spawn(PYTHON, recArgs, { detached: false });

  // Attach PID so stopRecording can kill it
  (global as Record<string, unknown>).__recorderPid = rec.pid;
  rec.on("error", () => { /* recorder not available in dev */ });
}

async function stopRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;

  // Kill the recorder subprocess
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
    // Clean up temp audio file
    try { fs.unlinkSync(audioTempPath); } catch { /* ignore */ }
    audioTempPath = null;
    setTrayState("idle");
  }
}

// ─── IPC handlers (used by settings window) ──────────────────────────────────

ipcMain.handle("get-settings", () => settings);

ipcMain.handle("save-settings", (_event, newSettings: Settings) => {
  // Re-register hotkey if it changed
  if (newSettings.hotkey !== settings.hotkey) {
    globalShortcut.unregisterAll();
    registerHotkey(newSettings.hotkey);
  }
  settings = newSettings;
  saveSettings(settings);
});

ipcMain.handle("start-hotkey-capture", () => {
  // Unregister all shortcuts so keydown events flow through to the renderer unblocked.
  // The renderer adds its own keydown listener after this returns.
  globalShortcut.unregisterAll();
  if (settingsWindow) settingsWindow.focus();
  return { ready: true };
});

ipcMain.handle("confirm-hotkey", (_event, accelerator: string) => {
  // Called by renderer once it has captured the key combo.
  // Register it immediately so the user can test it, update in-memory settings.
  // The full settings.json write happens when the user clicks Save.
  registerHotkey(accelerator);
  settings.hotkey = accelerator;
  // Echo back to renderer so it can update the display
  if (settingsWindow) {
    settingsWindow.webContents.send("hotkey-captured", accelerator);
  }
  return { ok: true };
});

ipcMain.handle("get-audio-devices", async () => {
  // Returns a list of mic device names via Python helper
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

// ─── Hotkey registration ──────────────────────────────────────────────────────

function registerHotkey(accelerator: string): void {
  const ok = globalShortcut.register(accelerator, () => {
    console.log(`[SwiftType] Hotkey fired: ${accelerator} — recording=${recordingActive}`);
    if (recordingActive) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  if (ok) {
    console.log(`[SwiftType] Hotkey registered: ${accelerator}`);
  } else {
    console.warn(`[SwiftType] FAILED to register hotkey: ${accelerator} — already in use by another app?`);
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Prevent app from showing in taskbar / dock — tray only
  if (process.platform === "darwin") app.dock?.hide();

  createTray();
  registerHotkey(settings.hotkey);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Keep process alive with no windows open (tray app)
app.on("window-all-closed", () => { /* intentional — tray-only app */ });
