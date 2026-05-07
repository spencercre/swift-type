import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("swiftType", {
  getSettings:     () => ipcRenderer.invoke("get-settings"),
  saveSettings:    (s: unknown) => ipcRenderer.invoke("save-settings", s),
  getAudioDevices: () => ipcRenderer.invoke("get-audio-devices"),
  micProbeResult:  (r: unknown) => ipcRenderer.invoke("mic-probe-result", r),
  shouldFocusMic:  () => ipcRenderer.invoke("settings-focus-mic-flag"),
});
