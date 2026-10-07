export type Theme = 'light' | 'dark' | 'system';
export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem('pixelgate-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* Storage is optional. */
  }
  return 'system';
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}
export function saveTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem('pixelgate-theme', theme);
  } catch {
    /* Keep the session choice. */
  }
}
