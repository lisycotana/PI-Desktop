import type { AppSettings } from "@pi-desktop/shared";

let settings: AppSettings;
const modeKey = "pi-mobile-default-mode";

export function applyBrowserSettings(value: AppSettings): AppSettings {
  const mode = localStorage.getItem(modeKey);
  settings = mode === "agent" || mode === "plan" || mode === "goal"
    ? { ...value, defaultMode: mode } : value;
  return settings;
}

/** Composer defaults belong to this browser; host settings stay in Main. */
export function saveBrowserSettings(value: AppSettings) {
  settings = { ...settings, defaultMode: value.defaultMode };
  localStorage.setItem(modeKey, value.defaultMode);
  return { ok: true };
}

export function getBrowserSettings() { return settings; }
