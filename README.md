# Swift Speak

Hold a key. Speak. Done.

Swift Speak is a lightweight Windows tray app that transcribes your voice and types the result wherever your cursor is — no cloud, no account, no subscription.

![Swift Speak screenshot](docs/screenshot.png)
<!-- Add a screenshot here once captured. -->

---

## Features

- **One key, one gesture** — hold the Right Ctrl key, speak, release. Words appear in your active window.
- **Fully local** — audio never leaves your machine. No API keys, no internet required after first setup.
- **Whisper transcription** — powered by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and OpenAI's Whisper models. Choose Tiny (fastest) through Small (most accurate) in Settings.
- **Dictation pill** — a small floating indicator at the bottom of your screen shows recording, transcribing, and done states as you work.
- **Auto-mic detection** — Swift Speak finds your microphone automatically on first launch. Change it any time in Settings.
- **First-launch onboarding** — a short three-step tour gets you set up in under a minute. Replay it any time from the tray menu.
- **Single-instance** — launching a second copy does nothing; the running instance handles everything.

---

## Install

Download the latest installer from the [Releases](https://github.com/spencercre/swift-speak/releases) page.

Run `Swift Speak Setup x.x.x.exe`. It installs silently and places a small bird icon in your system tray.

> **Windows SmartScreen warning:** If you see "Windows protected your PC", click **More info** → **Run anyway**. Swift Speak is not yet code-signed with a commercial certificate. The source is fully open for review above.

**System requirements:**

- Windows 10 or 11 (64-bit)
- ~500 MB free disk space for the Whisper model (downloaded automatically on first use)
- A microphone

Python is **not** required for the installed app — it's bundled in the package.

---

## Usage

After installing, Swift Speak sits quietly in your system tray until you need it.

**To dictate:**

1. Click wherever you want text to appear — a document, a text field, a chat window, anything.
2. Hold the **Right Ctrl key** (bottom-right corner of most keyboards).
3. Speak clearly.
4. Release the key.

Your words appear at the cursor as if you'd typed them.

**What the dictation pill tells you:**

| Pill state | Meaning |
|---|---|
| Orange dot + "Recording…" | Mic is open and capturing audio |
| Spinner + "Transcribing…" | Processing your speech locally |
| Green check + "Done" | Text injected successfully |
| Red indicator | Something went wrong — check mic in Settings |

**Why Right Ctrl?**
Left Ctrl is busy with Ctrl+C, Ctrl+V, Ctrl+S, and everything else. Right Ctrl is effectively unused on most keyboards, which makes it a natural push-to-talk key with no conflicts. If any other key is pressed while Right Ctrl is held, Swift Speak cancels the recording immediately and the keypress passes through to the active window unchanged — normal Ctrl shortcuts are never interrupted.

---

## Configuration

Right-click the tray icon → **Settings**.

| Setting | Default | Notes |
|---|---|---|
| Microphone | Auto-detected | Pick any input device listed on your system |
| Transcription model | Base | Tiny (~75 MB) / Base (~150 MB, recommended) / Small (~500 MB) |
| Dictation pill | On | Toggle the floating status indicator |

**To replay the welcome tour:** Right-click the tray icon → **Show Welcome Tour**. It opens on the next launch.

---

## Troubleshooting

**The welcome notification didn't appear after install.**

Go to Windows Settings → System → Notifications. Make sure Swift Speak (or "Electron") notifications are enabled and that "Do not disturb" is off. Some system configurations suppress all app notifications by default.

**The wrong microphone is being used.**

Right-click the tray icon → Settings → Microphone. Select your preferred device and click Save. If your mic isn't listed, try unplugging and replugging it, then reopen Settings.

**Holding Right Ctrl doesn't start recording.**

Check that Swift Speak is actually running — the bird icon should be visible in your system tray. If you don't see it, click the **↑** overflow arrow near your clock to find it.

If it's running but not responding to the key, try quitting from the tray menu and relaunching from the Start Menu shortcut.

**Transcription is slow on first use.**

The Whisper model downloads automatically the first time you record. The Base model (~150 MB) typically takes 30–60 seconds on a decent connection. All subsequent uses are instant — the model is cached locally.

**The dictation pill doesn't appear.**

Open Settings and confirm the dictation pill checkbox is on. Also make sure no other always-on-top window is covering the bottom of your screen.

**Text appears twice.**

This can happen if Swift Speak is somehow running as two separate instances. Check Task Manager for multiple `Swift Speak.exe` entries and quit the extras. Starting with v2.2.2, Swift Speak enforces single-instance startup — this should not occur on a clean install.

---

## Privacy

Swift Speak runs entirely on your computer.

- Audio is **never** sent to any server.
- Transcription happens locally using downloaded Whisper model files stored on your machine.
- No telemetry. No analytics. No account. No internet connection required after the Whisper model downloads.

The only outbound network request Swift Speak ever makes is downloading the Whisper model file on first use (~75–500 MB depending on the model you select). After that, it runs offline indefinitely.

---

## Building from source

**Prerequisites:**

- Node.js 18+
- Python 3.10+ with `pip install faster-whisper sounddevice`

```bash
git clone https://github.com/spencercre/swift-speak.git
cd swift-speak
npm install
npm run dev        # launch in development mode (no packaging)
npm run dist:win   # build the Windows installer → release/
```

**Source layout:**

| Path | What it is |
|---|---|
| `src/main.ts` | Main process — tray, IPC, recording flow, hotkey hook |
| `src/preload.ts` | Context bridge between main and renderer |
| `src/whisper_worker.py` | Python subprocess for mic recording and Whisper transcription |
| `src/settings.html` | Settings window (renderer) |
| `src/onboarding.html` | First-launch tour (renderer) |
| `src/dictation-pill.html` | Floating dictation indicator (renderer) |
| `src/mic-probe.html` | Hidden mic permission + enumeration window |
| `assets/` | Tray icons |
| `build/installer.nsh` | NSIS installer customization (upgrade handling) |

TypeScript compiles to `dist/` via `npm run build`. The packaged app bundles everything into `release/Swift Speak Setup x.x.x.exe`.

---

## License

[MIT License](LICENSE) — © 2026 Remington Street Partners

---

## Credits

Swift Speak is built on top of some excellent open-source work:

- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — CTranslate2-based Whisper inference, significantly faster than the original
- [OpenAI Whisper](https://github.com/openai/whisper) — the underlying speech recognition models
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — cross-platform global keyboard hook (passive, no keylogging)
- [@jitsi/robotjs](https://github.com/jitsi/robotjs) — keyboard simulation for text injection via Ctrl+V
- [Electron](https://www.electronjs.org/) — the app shell
