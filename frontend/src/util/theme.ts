/**
 * Light/dark theme selection.
 *
 * The theme is an attribute on <html>, which is what the FlyonUI theme blocks
 * in styles/app.css key off.
 *
 * The inline script in index.html resolves it before paint (stored choice,
 * else the OS preference, else dark) and owns that order; this module reads
 * the applied attribute back rather than re-deriving it, so the UI can never
 * disagree with what is already on screen. Only the storage key is shared -
 * keep it in step with the literal in that script.
 */

export type Theme = 'light' | 'dark';

// Duplicated as a literal in index.html's pre-paint script; keep in step.
const THEME_STORAGE_KEY = 'mutiMetrooTheme';

/** The theme currently applied to the document. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Applies the theme to the document and persists it as an explicit choice. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persisting is best-effort; the applied attribute still holds for the
    // life of the page.
  }
}
