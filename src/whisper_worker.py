#!/usr/bin/env python3
"""
whisper_worker.py — Swift Type audio backend

Modes:
  --list-devices
      Prints JSON array of available input devices to stdout.

  --preflight <model>
      Loads (and downloads if missing) the Whisper model. Run at app startup
      so the first real recording doesn't stall waiting for a 150 MB download.

  --record <output.wav> [--device <name>]
      Records from microphone until SIGTERM, writes WAV to output path.

  <audio.wav> <model>
      Transcribes audio file, prints {"text": "..."} JSON to stdout.
"""

import json
import os
import signal
import sys
import wave

# Shared cache dir — same location used for both preflight and transcription.
# Defaults to ~/.cache/huggingface/hub (HuggingFace standard, writable everywhere).
CACHE_DIR = os.path.expanduser("~/.cache/huggingface/hub")


def model_cache_path(model_size: str) -> str:
    """Returns the expected cache directory for a given model size."""
    return os.path.join(CACHE_DIR, f"models--Systran--faster-whisper-{model_size}")


# ─── List devices ─────────────────────────────────────────────────────────────

def list_devices():
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        result = []
        for i, d in enumerate(devices):
            if d["max_input_channels"] > 0:
                result.append({
                    "index": i,
                    "name": d["name"],
                    "label": f"{d['name']} ({int(d['default_samplerate'])} Hz)",
                })
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps([]), file=sys.stdout)
        print(f"list_devices error: {e}", file=sys.stderr)


# ─── Preflight ────────────────────────────────────────────────────────────────

def preflight(model_size: str):
    """Load (downloading if needed) the Whisper model before the first recording."""
    cached = os.path.isdir(model_cache_path(model_size))
    sys.stderr.write(f"[preflight] model='{model_size}' cached={cached} cache_dir={CACHE_DIR}\n")

    if not cached:
        sys.stderr.write(f"[preflight] Downloading model '{model_size}' (~150 MB) — please wait…\n")

    try:
        from faster_whisper import WhisperModel
        WhisperModel(model_size, device="cpu", compute_type="auto", download_root=CACHE_DIR)
        sys.stderr.write(f"[preflight] Model '{model_size}' ready.\n")
        sys.exit(0)
    except ImportError:
        sys.stderr.write("[preflight] faster-whisper not installed. Run: pip install faster-whisper\n")
        sys.exit(1)
    except Exception as e:
        sys.stderr.write(f"[preflight] Failed: {e}\n")
        sys.exit(1)


# ─── Record ───────────────────────────────────────────────────────────────────

def record(output_path: str, device: str | None = None):
    """
    Record mic audio to a WAV file.
    Runs until SIGTERM — Electron main process kills this when the hotkey is released.
    """
    try:
        import sounddevice as sd
        import numpy as np
    except ImportError:
        sys.stderr.write("sounddevice not installed. Run: pip install sounddevice\n")
        sys.exit(1)

    SAMPLE_RATE = 16_000  # faster-whisper expects 16 kHz
    CHANNELS = 1
    DTYPE = "int16"

    frames = []
    recording = True

    def handle_sigterm(*_):
        nonlocal recording
        recording = False

    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)

    # Resolve device index
    device_index = None
    if device and device != "default":
        try:
            for i, d in enumerate(sd.query_devices()):
                if d["name"] == device and d["max_input_channels"] > 0:
                    device_index = i
                    break
        except Exception:
            pass

    def callback(indata, frame_count, time_info, status):
        if recording:
            frames.append(indata.copy())

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype=DTYPE,
        device=device_index,
        callback=callback,
    ):
        sys.stderr.write(f"Recording to {output_path}…\n")
        while recording:
            signal.pause()

    # Write WAV
    if frames:
        import numpy as np
        audio = np.concatenate(frames, axis=0)
        with wave.open(output_path, "wb") as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)  # int16 = 2 bytes
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio.tobytes())
        sys.stderr.write(f"Wrote {len(audio)} samples to {output_path}\n")
    else:
        sys.stderr.write("No audio frames captured.\n")


# ─── Transcribe ───────────────────────────────────────────────────────────────

def transcribe(audio_path: str, model_size: str = "base"):
    if not os.path.exists(audio_path):
        print(json.dumps({"text": "", "error": f"File not found: {audio_path}"}))
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({
            "text": "",
            "error": "faster-whisper not installed. Run: pip install faster-whisper",
        }))
        sys.exit(1)

    try:
        model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="auto",
            download_root=CACHE_DIR,
        )

        segments, _info = model.transcribe(
            audio_path,
            language="en",
            vad_filter=True,          # skip silence automatically
            vad_parameters={"min_silence_duration_ms": 300},
        )

        text = " ".join(seg.text.strip() for seg in segments)
        print(json.dumps({"text": text}))

    except Exception as e:
        print(json.dumps({"text": "", "error": str(e)}))
        sys.exit(1)


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if not args or args[0] == "--help":
        print(__doc__)
        sys.exit(0)

    if args[0] == "--list-devices":
        list_devices()

    elif args[0] == "--preflight":
        model_size = args[1] if len(args) > 1 else "base"
        preflight(model_size)

    elif args[0] == "--record":
        if len(args) < 2:
            sys.stderr.write("Usage: whisper_worker.py --record <output.wav> [--device <name>]\n")
            sys.exit(1)
        output_path = args[1]
        device = None
        if "--device" in args:
            device = args[args.index("--device") + 1]
        record(output_path, device)

    else:
        # Transcription mode: <audio.wav> <model>
        audio_path = args[0]
        model_size = args[1] if len(args) > 1 else "base"
        transcribe(audio_path, model_size)


if __name__ == "__main__":
    main()
