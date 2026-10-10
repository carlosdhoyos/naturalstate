import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_SPEC, type ChartSpec, type FilterSeed } from './charts/build'
import { PRESETS } from './charts/presets'
import { ChartBuilder, normalizeSpec } from './components/ChartBuilder'
import { FilterBar } from './components/FilterBar'
import { MapView } from './components/MapView'
import { ProfileView } from './components/ProfileView'
import { TableView } from './components/TableView'
import { GuidePanel, TooltipLayer } from './components/Help'
import { Methodology } from './components/Methodology'
import { BirdsQuality } from './components/BirdsQuality'
import { BirdsSummary, VegetationSummary, type OpenView } from './components/Summary'
import { Icon } from './components/ui'
import { describeColumn } from './data/dictionary'
import { enrichAll } from './data/enrich'
import { applyFilters, isDiscrete, newId, type Filter } from './data/filter'
import { buildDataset, parseCsv } from './data/load'
import { CHALLENGES, GROUPS, SOURCES, type Challenge } from './data/registry'
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
  for (const s of SOURCES) reg.set(s.id, buildDataset({ id: s.id, title: s.title, group: s.group, challenge: s.challenge, file: `${s.folder}/${s.file}`, description: s.description }, parseCsv(s.text)))
  // Attach the data dictionary (form questions, file formats) to every source column.
  for (const ds of reg.values()) for (const c of ds.columns) if (!c.derived) c.description = describeColumn(ds.id, c.name)
  enrichAll(reg)
  return reg
}

const GROUP_TIP: Record<string, HelpKey> = {
  'BirdNET files': 'nav.birdfiles',
  'Field submissions (ODK forms)': 'nav.submissions',
  'Plots & sampling design': 'nav.plots',
  Taxonomy: 'nav.taxonomy',
  Lookups: 'nav.lookups',
  Uploaded: 'nav.uploaded',
}

const SUMMARY = (c: Challenge) => `summary:${c}`
const METHOD = 'method:birds'
const QUALITY = 'quality:birds'
/** Pages that are not datasets: summary:<challenge>, method:birds. */
const challengeOf = (id: string): Challenge | null => {
  const m = /^(summary|method|quality):(birds|vegetation)$/.exec(id)
  return m ? (m[2] as Challenge) : null
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
  const [current, setCurrent] = useState<string>(() => readHash().id ?? load('current', SUMMARY('birds')))
  // Last page visited in each challenge, so switching challenges returns where you were.
  const [lastIn, setLastIn] = useState<Record<Challenge, string>>(() => load('lastIn', { birds: SUMMARY('birds'), vegetation: SUMMARY('vegetation') }))
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

  const summaryOf = challengeOf(current)
  const ds = summaryOf ? null : (reg?.get(current) ?? null)
  const challenge: Challenge = summaryOf ?? (ds && ds.challenge !== 'other' ? ds.challenge : (load<Challenge>('challenge', 'birds')))

  useEffect(() => {
    if (!reg) return
    if (!summaryOf && !reg.get(current)) setCurrent(SUMMARY('birds')) // stale id from an old session
  }, [reg, current, summaryOf])

  useEffect(() => {
    save('challenge', challenge)
    setLastIn((prev) => {
      if (prev[challenge] === current) return prev
      const next = { ...prev, [challenge]: current }
      save('lastIn', next)
      return next
    })
  }, [challenge, current])

  useEffect(() => {
    if (!summaryOf) return
    save('current', current)
    const h = `#/${current}`
    if (window.location.hash !== h) window.history.replaceState(null, '', h)
  }, [summaryOf, current])

  const openView: OpenView = useCallback(
    (id, patch) => {
      const target = reg?.get(id)
      if (!target) return
      setViews((prev) => {
        const base = prev[id] ?? { tab: 'overview', filters: [], spec: initialSpec(target) }
        const next = {
          ...prev,
          [id]: {
            ...base,
            ...(patch?.tab ? { tab: patch.tab } : {}),
            ...(patch?.spec ? { spec: normalizeSpec(target, { ...DEFAULT_SPEC, ...patch.spec }) } : {}),
          } as ViewState,
        }
        save('views', next)
        return next
      })
      setCurrent(id)
      setNavOpen(false)
    },
    [reg],
  )

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
    const d = buildDataset({ id, title: file.name, group: 'Uploaded', challenge: 'other', file: file.name, description: 'Uploaded in this browser session (not saved).' }, parseCsv(text))
    setReg((prev) => new Map(prev ?? []).set(id, d))
    setCurrent(id)
  }

  const groups = useMemo(() => {
    if (!reg) return []
    const all = [...reg.values()].filter((d) => (d.challenge === challenge || d.challenge === 'other') && `${d.title} ${d.file}`.toLowerCase().includes(q.toLowerCase()))
    return GROUPS.map((g) => ({ group: g, items: all.filter((d) => d.group === g) })).filter((g) => g.items.length)
  }, [reg, q, challenge])

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
            <div className="brand-eyebrow">Natural State</div>
            <div className="brand-title">Data Explorer</div>
          </div>
        </div>
        <div className="challenge-switch" role="tablist" aria-label="Challenge" {...tip('app.challenge')}>
          {(['birds', 'vegetation'] as Challenge[]).map((c) => (
            <button key={c} type="button" role="tab" aria-selected={challenge === c} className={challenge === c ? 'on' : ''} onClick={() => setCurrent(c === challenge ? SUMMARY(c) : lastIn[c] ?? SUMMARY(c))}>
              <span className="challenge-num">{CHALLENGES[c].number}</span>
              {CHALLENGES[c].short}
            </button>
          ))}
        </div>
        <div className="topbar-right">
          <button type="button" className="guide-btn" {...tip('app.guide')} onClick={() => setGuideOpen(true)}>
            <Icon name="book" size={15} /> Guide
          </button>
          <div className="author" {...tip('app.author')}>
            <span className="author-name">Carlos Hoyos</span>
            <span className="author-sub">Senior Data Scientist take-home</span>
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
          <div className="nav-challenge">
            <span className="challenge-num lg">{CHALLENGES[challenge].number}</span>
            <div>
              <div className="nav-challenge-eyebrow">Challenge {CHALLENGES[challenge].number}</div>
              <div className="nav-challenge-title">{CHALLENGES[challenge].title}</div>
            </div>
          </div>
          <button type="button" className={`nav-item summary ${current === SUMMARY(challenge) ? 'on' : ''}`} {...tip('nav.summary')} onClick={() => { setCurrent(SUMMARY(challenge)); setNavOpen(false) }}>
            <span className="nav-item-title">
              <Icon name="grid" size={14} /> Summary
            </span>
          </button>
          {challenge === 'birds' && (
            <button type="button" className={`nav-item summary ${current === METHOD ? 'on' : ''}`} {...tip('nav.method')} onClick={() => { setCurrent(METHOD); setNavOpen(false) }}>
              <span className="nav-item-title">
                <Icon name="book" size={14} /> Methodology
              </span>
              <span className="nav-item-sub">6 papers</span>
            </button>
          )}
          {challenge === 'birds' && (
            <button type="button" className={`nav-item summary ${current === QUALITY ? 'on' : ''}`} {...tip('nav.quality')} onClick={() => { setCurrent(QUALITY); setNavOpen(false) }}>
              <span className="nav-item-title">
                <Icon name="info" size={14} /> Data quality
              </span>
              <span className="nav-item-sub">checks</span>
            </button>
          )}
          <div className="search" {...tip('nav.find')}>
            <Icon name="search" size={14} />
            <input className="input bare" placeholder="Find a table…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {groups.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-group-title has-tip" {...tip(GROUP_TIP[g.group] ?? 'nav.lookups', true)}>
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
          <p className="sidebar-foot muted small">All {SOURCES.length} source CSVs ({SOURCES.filter((x) => x.challenge === 'birds').length} bird, {SOURCES.filter((x) => x.challenge === 'vegetation').length} vegetation) are embedded in this page. Nothing is uploaded anywhere.</p>
        </nav>

        <main className="main">
          {error && <div className="empty tall">Could not load data: {error}</div>}
          {!reg && !error && (
            <div className="loading">
              <div className="spinner" />
              <span>Parsing {SOURCES.length} CSV files…</span>
            </div>
          )}
          {reg && current === SUMMARY('birds') && <BirdsSummary reg={reg} tokens={tokens} onOpen={openView} />}
          {reg && current === METHOD && <Methodology tokens={tokens} onOpen={openView} />}
          {reg && current === QUALITY && <BirdsQuality reg={reg} tokens={tokens} onOpen={openView} />}
          {reg && current === SUMMARY('vegetation') && <VegetationSummary reg={reg} tokens={tokens} onOpen={openView} />}
          {ds && view && (
            <>
              <div className="ds-head">
                <div className="ds-eyebrow">
                  {ds.challenge !== 'other' && (
                    <>
                      <button type="button" className="crumb" onClick={() => setCurrent(SUMMARY(ds.challenge as Challenge))}>
                        Challenge {CHALLENGES[ds.challenge].number} · {CHALLENGES[ds.challenge].short}
                      </button>
                      <span className="crumb-sep">›</span>
                    </>
                  )}
                  <span className="has-tip" {...tip(GROUP_TIP[ds.group] ?? 'ds.group', true)}>
                    {ds.group}
                  </span>
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
