export type Theme = "system" | "light" | "dark";
export type Appearance = "classic" | "navy";

const KEY = "kairos.theme";
const APPEARANCE_KEY = "kairos.appearance";

/** Appearance is independent of the existing light/dark preference. */
export function readAppearance(): Appearance {
  try {
    return localStorage.getItem(APPEARANCE_KEY) === "classic" ? "classic" : "navy";
  } catch {
    return "navy";
  }
}

export function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.appearance = appearance;
}

export function saveAppearance(appearance: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {}
  applyAppearance(appearance);
  window.dispatchEvent(new Event("kairos:appearance"));
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  applyTheme(theme);
  window.dispatchEvent(new Event("kairos:theme"));
}
