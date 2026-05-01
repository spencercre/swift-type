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
  console.log(`[SwiftType] recorder cmd: ${PYTHON} ${recArgs.join(" ")}`);
  const rec = spawn(PYTHON, recArgs, { detached: false });

  (global as Record<string, unknown>).__recorderPid = rec.pid;
  rec.stderr?.on("data", (d) => console.log(`[SwiftType] recorder: ${d.toString().trimEnd()}`));
  rec.on("error", (e) => console.error("[SwiftType] recorder spawn error:", e));
}

async function stopRecording(): Promise<void> {
  if (!recordingActive) return;
  recordingActive = false;

  const pid = (global as Record<string, unknown>).__recorderPid as number | undefined;
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  const wavExists = !!audioTempPath && fs.existsSync(audioTempPath);
  const wavSize   = wavExists ? fs.statSync(audioTempPath!).size : 0;
  console.log(`[SwiftType] WAV: path=${audioTempPath} exists=${wavExists} size=${wavSize}B`);

  if (!audioTempPath || !wavExists) {
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
  setupHook();
  runPreflight();
});

app.on("will-quit", () => {
  uIOhook.stop();
});

// Keep process alive with no windows open (tray app)
app.on("window-all-closed", () => { /* intentional — tray-only app */ });
