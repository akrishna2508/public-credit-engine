/**
 * Theme plumbing. Charts are canvas — they cannot inherit CSS variables, so
 * every chart reads its colours through `cssVar()` and re-reads them when the
 * theme flips. `onThemeChange` is the subscription that makes that happen.
 *
 * Three states, matching the CSS: an explicit "light"/"dark" choice stamps
 * data-theme on <html>; "system" removes the attribute and lets
 * prefers-color-scheme decide.
 */
const KEY = "pc-theme";
const listeners = new Set();
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function currentPreference() {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function isDark() {
  const p = currentPreference();
  return p === "dark" || (p === "system" && media.matches);
}

export function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === "system") {
    root.removeAttribute("data-theme");
    localStorage.removeItem(KEY);
  } else {
    root.setAttribute("data-theme", pref);
    localStorage.setItem(KEY, pref);
  }
  cache.clear();
  for (const fn of listeners) fn();
}

/** cycles light -> dark -> system */
export function cycleTheme() {
  const order = ["light", "dark", "system"];
  const next = order[(order.indexOf(currentPreference()) + 1) % order.length];
  applyTheme(next);
  return next;
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// a system-theme change must repaint the charts too
media.addEventListener("change", () => {
  if (currentPreference() === "system") {
    cache.clear();
    for (const fn of listeners) fn();
  }
});

/* ---------------- CSS variable readout (cached per theme) -------------- */
const cache = new Map();

export function cssVar(name, fallback = "#888") {
  if (cache.has(name)) return cache.get(name);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  cache.set(name, out);
  return out;
}

/** initialise from storage before first paint */
export function initTheme() {
  const pref = currentPreference();
  if (pref !== "system") document.documentElement.setAttribute("data-theme", pref);
  return pref;
}

export const THEME_ICON = { light: "☀", dark: "☾", system: "◐" };
