export const THEME_STORAGE_KEY = 'my-agent.theme';

export type ThemeId = 'classic' | 'botanical';

export const DEFAULT_THEME: ThemeId = 'classic';

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'classic' || value === 'botanical';
}

export function resolveThemePreference(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME;
}

export function initializeTheme(): ThemeId {
  const theme = resolveThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  applyTheme(theme);
  return theme;
}

export function currentTheme(): ThemeId {
  return resolveThemePreference(document.documentElement.dataset.theme);
}

export function selectTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}
