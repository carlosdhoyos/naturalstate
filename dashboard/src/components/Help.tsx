import { useEffect, useMemo, useRef, useState } from 'react'
import { GUIDE, HELP } from '../lib/help'
import { Icon } from './ui'

/**
 * One floating tooltip for the whole app. Any element with `data-tip` (and optional
 * `data-tip-title`) shows it on hover after a short delay, or immediately on keyboard focus.
 * Event delegation means no per-element wiring and no layout cost.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ title?: string; text: string; x: number; y: number; above: boolean } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const current = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const find = (t: EventTarget | null) => (t instanceof Element ? (t.closest('[data-tip]') as HTMLElement | null) : null)
    const show = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      const above = r.bottom + 160 > window.innerHeight
      setTip({
        title: el.dataset.tipTitle,
        text: el.dataset.tip ?? '',
        x: Math.min(Math.max(12, r.left + r.width / 2), window.innerWidth - 12),
        y: above ? r.top - 8 : r.bottom + 8,
        above,
      })
    }
    const over = (e: MouseEvent) => {
      const el = find(e.target)
      if (el === current.current) return
      window.clearTimeout(timer.current)
      current.current = el
      if (!el) return setTip(null)
      timer.current = window.setTimeout(() => show(el), 280)
    }
    const focus = (e: FocusEvent) => {
      const el = find(e.target)
      current.current = el
      window.clearTimeout(timer.current)
      if (el) show(el)
      else setTip(null)
    }
    const hide = () => {
      window.clearTimeout(timer.current)
      current.current = null
      setTip(null)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    document.addEventListener('mouseover', over)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', hide, true)
    document.addEventListener('mousedown', hide)
    return () => {
      document.removeEventListener('mouseover', over)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', hide, true)
      document.removeEventListener('mousedown', hide)
    }
  }, [])

  if (!tip || !tip.text) return null
  return (
    <div className={`tooltip ${tip.above ? 'above' : ''}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.title && <div className="tooltip-title">{tip.title}</div>}
      <div className="tooltip-text">{tip.text}</div>
    </div>
  )
}

/** Slide-over guide: every HELP entry, grouped by section, searchable. */
export function GuidePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])

  const sections = useMemo(() => {
    const s = q.toLowerCase()
    return GUIDE.map((g) => ({
      ...g,
      items: g.keys.map((k) => HELP[k]).filter((e) => !s || `${e.label} ${e.text}`.toLowerCase().includes(s)),
    })).filter((g) => g.items.length)
  }, [q])

  if (!open) return null
  return (
    <div className="guide-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="guide" role="dialog" aria-label="Guide">
        <header className="guide-head">
          <div>
            <div className="ds-eyebrow">Guide</div>
            <h2>What everything means</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="Close guide" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <p className="guide-intro">
          Every label in the explorer has the same explanation on hover (or keyboard focus). Column headers and column cards also show what each <em>data</em> column means — taken from the ODK form questions for the vegetation data, and from the BirdNET/Raven output format for the bird data.
        </p>
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input bare" autoFocus placeholder="Search the guide…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="guide-body">
          {sections.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <p className="muted small">{g.intro}</p>
              <dl>
                {g.items.map((e) => (
                  <div key={e.label} className="guide-item">
                    <dt>{e.label}</dt>
                    <dd>{e.text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </div>
  )
}
