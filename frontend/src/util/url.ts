// Helpers for handling the operator-configured agent API address, which
// can be entered as bare host:port or a full http(s) URL. Centralised so
// SettingsDialog, App, and any future consumer stay in sync.

export function hasHttpScheme(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

// If value already has a scheme, returns it untouched. Otherwise prepends
// the given scheme (e.g. `window.location.protocol`, which always ends in
// ":"). Empty input returns empty.
export function ensureHttpScheme(value: string, defaultScheme: string): string {
  const v = value.trim();
  if (!v) return '';
  if (hasHttpScheme(v)) return v;
  return `${defaultScheme}//${v}`;
}
