export const themeKey = 'tokenboard-theme'

export const themeChromeColors = {
  dark: '#10130f',
  light: '#f4f0e8'
} as const

export const themeColorSchemes = {
  dark: 'dark',
  light: 'only light'
} as const

export const initialColorScheme = themeColorSchemes.dark

export const mobileNightModeOptOutMeta = {
  name: 'nightmode',
  content: 'disable'
} as const

export type Theme = keyof typeof themeChromeColors

export function isTheme(value: string | null | undefined): value is Theme {
  return value === 'dark' || value === 'light'
}

export function getThemeToggleTargetLabel(theme: Theme) {
  return theme === 'light' ? '深色' : '浅色'
}
