import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("swiftType", {
  getSettings:        () => ipcRenderer.invoke("get-settings"),
  saveSettings:       (s: unknown) => ipcRenderer.invoke("save-settings", s),
  getAudioDevices:    () => ipcRenderer.invoke("get-audio-devices"),

  // Hotkey capture flow
  startHotkeyCapture: () => ipcRenderer.invoke("start-hotkey-capture"),
  confirmHotkey:      (accelerator: string) => ipcRenderer.invoke("confirm-hotkey", accelerator),
  onHotkeyCaptured:   (cb: (accelerator: string) => void) => {
    ipcRenderer.on("hotkey-captured", (_event, accelerator: string) => cb(accelerator));
  },
});
