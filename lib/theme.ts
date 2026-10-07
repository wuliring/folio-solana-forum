export const THEME_STORAGE_KEY = "folio:theme";
export type ThemePreference = "light" | "dark" | "system";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "system" ? value : "dark";
}

export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  const dark = preference === "dark" || (preference === "system" && systemDark);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePreference = preference;
  root.classList.toggle("dark", dark);
  document.getElementById("folio-theme-color")?.setAttribute("content", dark ? "#1b1b1d" : "#f4f2e9");
}

// Runs in the document head before the page paints. Keep the stored preference
// separate from the resolved theme so system appearance can continue to change.
export const THEME_INIT_SCRIPT = `(() => {
  let preference = "dark";
  try {
    const saved = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (saved === "light" || saved === "dark" || saved === "system") preference = saved;
  } catch {}
  const dark = preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePreference = preference;
  root.classList.toggle("dark", dark);
  document.getElementById("folio-theme-color")?.setAttribute("content", dark ? "#1b1b1d" : "#f4f2e9");
})();`;
