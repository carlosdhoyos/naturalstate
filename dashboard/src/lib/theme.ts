import { useEffect, useMemo, useState } from 'react'
import { readTokens, type ThemeName, type ThemeTokens } from './palette'
import { load, save } from './storage'

export type ThemePref = 'system' | 'light' | 'dark'

/** Theme preference (system / light / dark) → resolved theme + chart tokens read from CSS. */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void; theme: ThemeName; tokens: ThemeTokens } {
  const [pref, setPrefState] = useState<ThemePref>(() => load<ThemePref>('theme', 'system'))
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const theme: ThemeName = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref

  useEffect(() => {
    const el = document.documentElement
    if (pref === 'system') el.removeAttribute('data-theme')
    else el.setAttribute('data-theme', pref)
  }, [pref])

  // Tokens are read after the attribute is applied, so they always match the rendered CSS.
  const [tick, setTick] = useState(0)
  useEffect(() => setTick((n) => n + 1), [theme])
  const tokens = useMemo(() => readTokens(theme), [theme, tick])

  const setPref = (p: ThemePref) => {
    setPrefState(p)
    save('theme', p)
  }
  return { pref, setPref, theme, tokens }
}
