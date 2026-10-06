export const SETTINGS_LABEL_MAX = 180;
export const SETTINGS_VALUE_MAX = 4096;

export function settingsLabelTooLong(label: string, max = SETTINGS_LABEL_MAX): boolean {
  return label.length > max;
}

export function sanitizeSettingValue(value: string, max = SETTINGS_VALUE_MAX): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}\n…truncated ${value.length - max} chars for settings UI`, truncated: true };
}

export const DIAGNOSTIC_SETTING_KEYS = [
  "fmSkillsManifest",
  "captainMemory",
  "captainContract",
  "fmScriptCount",
  "fmSkillCount",
  "fmHostId",
] as const;

export function shouldMoveDiagnosticToKv(key: string): boolean {
  return (DIAGNOSTIC_SETTING_KEYS as readonly string[]).includes(key);
}
