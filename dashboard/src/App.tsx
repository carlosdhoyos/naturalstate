import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_SPEC, type ChartSpec, type FilterSeed } from './charts/build'
import { PRESETS } from './charts/presets'
import { ChartBuilder, normalizeSpec } from './components/ChartBuilder'
import { FilterBar } from './components/FilterBar'
import { MapView } from './components/MapView'
import { ProfileView } from './components/ProfileView'
import { TableView } from './components/TableView'
import { GuidePanel, TooltipLayer } from './components/Help'
import { Icon } from './components/ui'
import { describeColumn } from './data/dictionary'
import { enrichAll } from './data/enrich'
import { applyFilters, isDiscrete, newId, type Filter } from './data/filter'
import { buildDataset, parseCsv } from './data/load'
import { GROUPS, SOURCES } from './data/registry'
import { fmtInt } from './data/stats'
import type { Column, Dataset } from './data/types'
import { tip, type HelpKey } from './lib/help'
import { load, save } from './lib/storage'
import { useTheme, type ThemePref } from './lib/theme'

type Tab = 'overview' | 'explore' | 'table' | 'map'
interface ViewState {
  tab: Tab
  filters: Filter[]
  spec: ChartSpec
}

function loadAll(): Map<string, Dataset> {
  const reg = new Map<string, Dataset>()
  for (const s of SOURCES) reg.set(s.id, buildDataset({ id: s.id, title: s.title, group: s.group, file: `${s.folder}/${s.file}`, description: s.description }, parseCsv(s.text)))
  // Attach the data dictionary (form questions, file formats) to every source column.
  for (const ds of reg.values()) for (const c of ds.columns) if (!c.derived) c.description = describeColumn(ds.id, c.name)
  enrichAll(reg)
  return reg
}

const GROUP_TIP: Record<string, HelpKey> = {
  Birds: 'nav.birds',
  'Vegetation · ODK exports': 'nav.odk',
  'Vegetation · Entity lists': 'nav.entities',
  Uploaded: 'nav.uploaded',
}

function readHash(): { id?: string; tab?: Tab } {
  const [, id, tab] = window.location.hash.split('/')
  return { id: id ? decodeURIComponent(id) : undefined, tab: tab as Tab | undefined }
}

function initialSpec(ds: Dataset): ChartSpec {
  const preset = PRESETS[ds.id]?.[0]
  return normalizeSpec(ds, { ...DEFAULT_SPEC, ...(preset?.spec ?? {}) })
}

export default function App() {
  const { pref, setPref, tokens } = useTheme()
  const [reg, setReg] = useState<Map<string, Dataset> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState<string>(() => readHash().id ?? load('current', 'birdnet_predictions'))
  const [views, setViews] = useState<Record<string, ViewState>>(() => {
    // The URL hash (#/<dataset>/<tab>) wins on first load so links open the right view.
    const v = load<Record<string, ViewState>>('views', {})
    const h = readHash()
    return h.id && h.tab ? { ...v, [h.id]: { ...v[h.id], tab: h.tab } } : v
  })
  const [filterRequest, setFilterRequest] = useState<{ column: string; nonce: number } | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [q, setQ] = useState('')

  // Parse after first paint so the loading state is visible.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        setReg(loadAll())
      } catch (e) {
        setError(String(e))
      }
    }, 30)
    return () => clearTimeout(t)
  }, [])

  const ds = reg?.get(current) ?? reg?.values().next().value ?? null

  const view: ViewState | null = useMemo(() => {
    if (!ds) return null
    const v = views[ds.id]
    const tab: Tab = v?.tab ?? 'overview'
    return {
      tab: tab === 'map' && !ds.geo.length ? 'overview' : tab,
      filters: (v?.filters ?? []).filter((f) => ds.columns.some((c) => c.name === f.column)),
      spec: v?.spec ? normalizeSpec(ds, v.spec) : initialSpec(ds),
    }
  }, [ds, views])

  const update = useCallback(
    (patch: Partial<ViewState>) => {
      if (!ds || !view) return
      setViews((prev) => {
        const next = { ...prev, [ds.id]: { ...view, ...prev[ds.id], ...patch } as ViewState }
        save('views', next)
        return next
      })
    },
    [ds, view],
  )

  useEffect(() => {
    if (!ds || !view) return
    save('current', ds.id)
    const h = `#/${encodeURIComponent(ds.id)}/${view.tab}`
    if (window.location.hash !== h) window.history.replaceState(null, '', h)
  }, [ds, view])

  useEffect(() => {
    const on = () => {
      const h = readHash()
      if (h.id) setCurrent(h.id)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const rows = useMemo(() => (ds && view ? applyFilters(ds, view.filters) : []), [ds, view])

  const addFilters = useCallback(
    (seeds: FilterSeed[]) => {
      if (!view) return
      // A click replaces any existing filter on the same column (drill-down, not contradiction).
      const cols = new Set(seeds.map((s) => s.column))
      const kept = view.filters.filter((f) => !cols.has(f.column))
      update({ filters: [...kept, ...seeds.map((s) => ({ ...s, id: newId() }) as Filter)] })
    },
    [view, update],
  )

  const plotColumn = (c: Column) => {
    if (!ds) return
    const kind = c.type === 'number' && !isDiscrete(c) ? 'histogram' : 'bar'
    const horizontal = kind === 'bar' && c.type !== 'datetime' && c.type !== 'number'
    const spec = normalizeSpec(ds, { ...DEFAULT_SPEC, kind, x: c.name, horizontal, timeUnit: 'day' })
    update({ tab: 'explore', spec })
  }
  const filterColumn = (c: Column) => {
    setFilterRequest({ column: c.name, nonce: Date.now() })
  }

  const onUpload = async (file: File) => {
    const text = await file.text()
    const id = `upload:${file.name.replace(/\.csv$/i, '')}`
    const d = buildDataset({ id, title: file.name, group: 'Uploaded', file: file.name, description: 'Uploaded in this browser session (not saved).' }, parseCsv(text))
    setReg((prev) => new Map(prev ?? []).set(id, d))
    setCurrent(id)
  }

  const groups = useMemo(() => {
    if (!reg) return []
    const all = [...reg.values()].filter((d) => `${d.title} ${d.file}`.toLowerCase().includes(q.toLowerCase()))
    return GROUPS.map((g) => ({ group: g, items: all.filter((d) => d.group === g) })).filter((g) => g.items.length)
  }, [reg, q])

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="icon-btn nav-toggle" aria-label="Datasets" onClick={() => setNavOpen(!navOpen)}>
          <Icon name="grid" />
        </button>
        <div className="brand" {...tip('app.brand', true)}>
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="9" />
            <path d="M6 19c3.2-8 6.8-8 10 0s6.8 8 10 0" />
          </svg>
          <div>
            <div className="brand-eyebrow">Natural State · Senior Data Scientist take-home</div>
            <div className="brand-title">Data Explorer</div>
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="guide-btn" {...tip('app.guide')} onClick={() => setGuideOpen(true)}>
            <Icon name="book" size={15} /> Guide
          </button>
          <div className="author" {...tip('app.author')}>
            <span className="author-name">Carlos Hoyos</span>
            <span className="author-sub">Birds &amp; vegetation challenges</span>
          </div>
          <div className="theme-switch" role="radiogroup" aria-label="Theme" {...tip('app.theme')}>
            {(['light', 'system', 'dark'] as ThemePref[]).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={pref === p} className={pref === p ? 'on' : ''} aria-label={`${p[0].toUpperCase()}${p.slice(1)} theme`} onClick={() => setPref(p)}>
                <Icon name={p === 'light' ? 'sun' : p === 'dark' ? 'moon' : 'auto'} size={14} />
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="shell">
        <nav className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Datasets">
          <div className="search" {...tip('nav.find')}>
            <Icon name="search" size={14} />
            <input className="input bare" placeholder="Find a dataset…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {groups.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-group-title has-tip" {...tip(GROUP_TIP[g.group] ?? 'nav.birds', true)}>
                {g.group}
              </div>
              {g.items.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`nav-item ${ds?.id === d.id ? 'on' : ''}`}
                  onClick={() => {
                    setCurrent(d.id)
                    setNavOpen(false)
                  }}
                  data-tip={`${d.description}\n\n${d.file}`}
                  data-tip-title={d.title}
                >
                  <span className="nav-item-title">{d.title}</span>
                  <span className="nav-item-sub" {...tip('nav.counts')}>
                    {fmtInt(d.rows.length)} × {d.columns.filter((c) => !c.derived).length}
                    {(views[d.id]?.filters?.length ?? 0) > 0 && <span className="dot" title="Has active filters" />}
                  </span>
                </button>
              ))}
            </div>
          ))}
          <label className="btn ghost sm upload" {...tip('nav.upload')}>
            <Icon name="upload" size={14} /> Open another CSV…
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
          </label>
          <p className="sidebar-foot muted small">All {SOURCES.length} source CSVs are embedded in this page. Nothing is uploaded anywhere.</p>
        </nav>

        <main className="main">
          {error && <div className="empty tall">Could not load data: {error}</div>}
          {!reg && !error && (
            <div className="loading">
              <div className="spinner" />
              <span>Parsing {SOURCES.length} CSV files…</span>
            </div>
          )}
          {ds && view && (
            <>
              <div className="ds-head">
                <div className="ds-eyebrow has-tip" {...tip(GROUP_TIP[ds.group] ?? 'ds.group', true)}>
                  {ds.group}
                </div>
                <h1>{ds.title}</h1>
                <p className="ds-desc">{ds.description}</p>
                <code className="ds-file has-tip" {...tip('ds.file', true)}>
                  {ds.file}
                </code>
              </div>
              <div className="tabs" role="tablist">
                {(
                  [
                    ['overview', 'Overview', 'grid'],
                    ['explore', 'Explore', 'chart'],
                    ['table', 'Table', 'table'],
                    ...(ds.geo.length ? [['map', 'Map', 'map']] : []),
                  ] as [Tab, string, 'grid'][]
                ).map(([t, label, icon]) => (
                  <button key={t} type="button" role="tab" aria-selected={view.tab === t} className={`tab ${view.tab === t ? 'on' : ''}`} {...tip(`tab.${t}` as HelpKey)} onClick={() => update({ tab: t })}>
                    <Icon name={icon} size={15} /> {label}
                  </button>
                ))}
              </div>
              <FilterBar ds={ds} filters={view.filters} shown={rows.length} onChange={(filters) => update({ filters })} request={filterRequest} />
              <div className="tab-body">
                {view.tab === 'overview' && <ProfileView ds={ds} rows={rows} onPlot={plotColumn} onFilter={filterColumn} />}
                {view.tab === 'explore' && <ChartBuilder ds={ds} rows={rows} spec={view.spec} onSpec={(spec) => update({ spec })} onAddFilters={addFilters} tokens={tokens} />}
                {view.tab === 'table' && <TableView ds={ds} rows={rows} />}
                {view.tab === 'map' && <MapView key={ds.id} ds={ds} rows={rows} tokens={tokens} />}
              </div>
            </>
          )}
          <GuidePanel open={guideOpen} onClose={() => setGuideOpen(false)} />
          <TooltipLayer />
          <footer className="footer muted small">
            Built by Carlos Hoyos for the Natural State take-home. Source data is shown as provided: derived columns are marked, and nothing is corrected.
          </footer>
        </main>
      </div>
    </div>
  )
}
