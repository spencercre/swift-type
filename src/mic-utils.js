// Shared mic enumeration helpers used by mic-probe.html, settings.html,
// and onboarding.html. Loaded directly via <script src="mic-utils.js"> from
// each renderer page; no bundler involved.
//
// All three callers want the same virtual-device filter (Stereo Mix,
// VoiceMeeter, etc.) — keeping it here avoids drift if the deny-list grows.

(function () {
  const VIRTUAL_PATTERNS = [
    "stereo mix",
    "what u hear",
    "microsoft sound mapper",
    "primary sound capture driver",
    "voicemeeter",
    "vb-audio",
  ];

  function isVirtual(label) {
    const l = (label || "").toLowerCase();
    return VIRTUAL_PATTERNS.some((p) => l.includes(p));
  }

  function filterInputs(devices) {
    return devices.filter(
      (d) =>
        d.kind === "audioinput" &&
        !isVirtual(d.label) &&
        d.deviceId &&
        d.deviceId !== "default"
    );
  }

  // Convenience wrapper: requests permission (so labels resolve), enumerates,
  // filters, and stops the temporary permission stream. Callers that need
  // strict permission-failure handling (like mic-probe) should call
  // navigator.mediaDevices directly and use filterInputs().
  async function listInputDevices() {
    let permStream = null;
    try {
      permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn("[SwiftSpeak] mic permission denied:", e && e.message);
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    if (permStream) permStream.getTracks().forEach((t) => t.stop());
    return filterInputs(all);
  }

  window.SwiftSpeakMic = {
    VIRTUAL_PATTERNS,
    isVirtual,
    filterInputs,
    listInputDevices,
  };
})();
