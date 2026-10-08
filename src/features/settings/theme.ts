export type Theme = "light" | "dark";

const THEME_KEY = "meshnote.theme";

export function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    // Storage can be unavailable in private mode or outside the browser.
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A persistence failure must not prevent an immediate UI update.
  }
}

export function initializeTheme(): Theme {
  const theme = readTheme();
  applyTheme(theme);
  return theme;
}
