/**
 * Chart colors. Slot 1 is Natural State teal; the remaining hues were ordered by running the
 * dataviz palette validator over every permutation and keeping only orders that pass, in both
 * light (surface #ffffff) and dark (surface #13202a) modes:
 *   - lightness band, chroma floor, adjacent CVD ΔE ≥ 8, normal-vision ΔE ≥ 15  → PASS
 *   - first 3 slots also pass all-pairs (scatter); beyond 3 groups, marker symbols are added
 *   - yellow and magenta are < 3:1 on white → legends + table view always shown
 */
export type ThemeName = 'light' | 'dark'

export const SERIES: Record<ThemeName, string[]> = {
  light: ['#1f9e8c', '#eb6834', '#2a78d6', '#e34948', '#4a3aa7', '#eda100', '#e87ba4', '#7a8c00'],
  dark: ['#2aa894', '#d95926', '#3987e5', '#e66767', '#9085e9', '#c98500', '#d55181', '#8f9e1a'],
}

/** Folded tail ("Other") and missing values — neutral, never a hue. */
export const OTHER: Record<ThemeName, string> = { light: '#9aa8ae', dark: '#5f727b' }

export const SYMBOLS = ['circle', 'square', 'diamond', 'triangle-up', 'triangle-down', 'cross', 'x', 'star']

/** Single-hue sequential ramp (NS teal), light → dark. Reversed on the dark surface. */
export const SEQUENTIAL = ['#e3f5f2', '#bfe8e1', '#8fd6ca', '#5ec3b2', '#34ae9b', '#1f9583', '#18786a', '#115c51', '#0a4039']

export function sequentialScale(theme: ThemeName): [number, string][] {
  const ramp = theme === 'dark' ? [...SEQUENTIAL].reverse() : SEQUENTIAL
  return ramp.map((c, i) => [i / (ramp.length - 1), c])
}

export const MAX_SERIES = 8

export interface ThemeTokens {
  theme: ThemeName
  surface: string
  ink: string
  ink2: string
  muted: string
  grid: string
  axis: string
  font: string
}

export function readTokens(theme: ThemeName): ThemeTokens {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  return {
    theme,
    surface: v('--surface'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    muted: v('--muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    font: v('--font-sans'),
  }
}
