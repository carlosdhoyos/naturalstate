/**
 * Interactive schematic: a small, dependency-free graph renderer for architecture, logic and code-map
 * diagrams. Nodes sit on a grid (col, row); edges are routed as curves between node sides. Clicking a
 * node traces everything upstream and downstream of it and opens its details; "Walk through" steps the
 * diagram's `order` like a guided tour. Content lives in birds.ts / vegetation.ts, not here.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'

export type Kind = 'input' | 'step' | 'decision' | 'output' | 'store' | 'external' | 'module' | 'test' | 'stop'
export type Tag = 'package' | 'research' | 'data' | 'platform' | 'dashboard' | 'pipeline' | 'reference' | 'config' | 'spec'

export interface Detail {
  what: ReactNode
  code?: string[]
  functions?: string[]
  inputs?: string[]
  outputs?: string[]
  decisions?: string[]
  checks?: string[]
  numbers?: string
}

export interface SNode {
  id: string
  label: string
  sub?: string
  kind: Kind
  tag?: Tag
  col: number
  row: number
  w?: number // width in grid columns (default 1)
  detail: Detail
}

export interface SEdge {
  from: string
  to: string
  label?: string
  dashed?: boolean
}

export interface Diagram {
  id: string
  title: string
  sub: string
  nodes: SNode[]
  edges: SEdge[]
  order?: string[]
  bands?: { label: string; row0: number; row1: number }[]
}

const CW = 190 // column pitch
const RH = 96 // row pitch
const NW = 164 // node width (one column)
const NH = 62 // node height
const PAD = 24
const TOP = 40 // room above the first row for a band title

const TAG_LABEL: Record<Tag, string> = {
  package: 'deployable package',
  research: 'research analysis',
  data: 'data',
  platform: 'platform (specified)',
  dashboard: 'dashboard',
  pipeline: 'pipeline',
  reference: 'cached reference',
  config: 'configuration',
  spec: 'specified, not built',
}

function geom(n: SNode) {
  const w = (n.w ?? 1) * CW - (CW - NW)
  const x = PAD + n.col * CW
  const y = TOP + n.row * RH
  return { x, y, w, h: NH, cx: x + w / 2, cy: y + NH / 2 }
}

type Route = { d: string; lx: number; ly: number; anchor: 'start' | 'middle' | 'end' }
type Box = { x: number; y: number; w: number; h: number }

const cubic = (p0: number[], p1: number[], p2: number[], p3: number[]) =>
  Array.from({ length: 25 }, (_, i) => {
    const t = i / 24
    const u = 1 - t
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k])
  })
/** True when a sampled path enters a box other than its own two ends (boxes shrunk by 3 px, so touching is fine). */
const crosses = (pts: number[][], boxes: Box[]) => pts.some(([x, y]) => boxes.some((b) => x > b.x + 3 && x < b.x + b.w - 3 && y > b.y + 3 && y < b.y + b.h - 3))

/** Curve between two nodes. Neighbours connect bottom→top (or side→side); an edge that drops several
 * rows AND shifts sideways leaves from the side of its source. If that curve would pass behind another
 * box, the edge is routed through the empty gutters between rows and columns instead, so no line ever
 * runs under a box it does not belong to. `lane` spreads edges that share a gutter by a few pixels. */
function route(a: SNode, b: SNode, others: Box[], lane: number): Route {
  const A = geom(a)
  const B = geom(b)
  const dx = B.cx - A.cx
  let d: string
  let pts: number[][]
  let lx: number, ly: number
  let anchor: Route['anchor'] = 'start'
  if (B.y >= A.y + A.h - 4 && Math.abs(dx) > CW * 0.6 && B.y - (A.y + A.h) > RH * 0.6) {
    const x1 = dx < 0 ? A.x : A.x + A.w
    const y1 = A.cy
    const x2 = B.cx
    const y2 = B.y
    d = `M${x1},${y1} C${x2},${y1} ${x2},${y1} ${x2},${y2}`
    pts = cubic([x1, y1], [x2, y1], [x2, y1], [x2, y2])
    ;[lx, ly] = [x1 + (dx < 0 ? -8 : 8), y1 - 6]
    anchor = dx < 0 ? 'end' : 'start' // label just outside the box, reading away from it
  } else if (B.y >= A.y + A.h - 4 || B.y + B.h <= A.y + 4) {
    const down = B.y >= A.y + A.h - 4
    const [x1, y1, x2, y2] = down ? [A.cx, A.y + A.h, B.cx, B.y] : [A.cx, A.y, B.cx, B.y + B.h]
    const k = Math.max(24, Math.abs(y2 - y1) / 2)
    const sgn = Math.sign(y2 - y1)
    d = `M${x1},${y1} C${x1},${y1 + sgn * k} ${x2},${y2 - sgn * k} ${x2},${y2}`
    pts = cubic([x1, y1], [x1, y1 + sgn * k], [x2, y2 - sgn * k], [x2, y2])
    if (Math.abs(x2 - x1) < 10) [lx, ly] = [x1 + 7, y1 + (y2 - y1) * 0.5 + 4] // a straight drop gets its label beside the line
    else {
      // a leftward edge's label reads leftwards, so it never crosses a line dropping from the same box
      ;[lx, ly] = [x1 + (x2 - x1) * 0.25 + (x2 < x1 ? -4 : 4), y1 + (y2 - y1) * 0.3]
      if (x2 < x1) anchor = 'end'
    }
  } else {
    const right = B.x >= A.x + A.w
    const [x1, y1, x2, y2] = right ? [A.x + A.w, A.cy, B.x, B.cy] : [A.x, A.cy, B.x + B.w, B.cy]
    const k = Math.max(30, Math.abs(x2 - x1) / 2)
    const sgn = Math.sign(x2 - x1)
    d = `M${x1},${y1} C${x1 + sgn * k},${y1} ${x2 - sgn * k},${y2} ${x2},${y2}`
    pts = cubic([x1, y1], [x1 + sgn * k, y1], [x2 - sgn * k, y2], [x2, y2])
    ;[lx, ly] = [x1 + (x2 - x1) * 0.3, Math.min(y1, y2) - 6]
  }
  if (!crosses(pts, others)) return { d, lx, ly, anchor }
  // gutter route: out of A into the row gap, along a column gutter, into the row gap next to B, into B
  const gapY = (RH - NH) / 2
  const off = ((lane % 5) - 2) * 3
  const down = B.y > A.y
  const xa = A.cx + off
  const xb = B.cx + off
  const ya = down ? A.y + A.h + gapY + off : A.y - gapY + off
  const yb = down ? B.y - gapY + off : B.y + B.h + gapY + off
  const y0 = down ? A.y + A.h : A.y
  const y3 = down ? B.y : B.y + B.h
  if (Math.abs(ya - yb) < 1 || (B.y === A.y && Math.abs(dx) > 0)) {
    // adjacent rows, or the same row: one horizontal run in the shared gap (above both when on one row)
    const yy = B.y === A.y ? A.y - gapY + off : ya
    const yStart = B.y === A.y ? A.y : y0
    const yEnd = B.y === A.y ? B.y : y3
    d = `M${xa},${yStart} L${xa},${yy} L${xb},${yy} L${xb},${yEnd}`
    return { d, lx: (xa + xb) / 2, ly: yy - 3, anchor: 'middle' }
  }
  const gutters = Array.from({ length: 12 }, (_, k) => PAD + k * CW - (CW - NW) / 2)
  const mid = (A.cx + B.cx) / 2
  // the nearest gutter whose vertical run is clear (a box two columns wide covers the gutter between them)
  const clear = (x: number) => !crosses(Array.from({ length: 25 }, (_, i) => [x, ya + ((yb - ya) * i) / 24]), others)
  const byDistance = [...gutters].sort((g1, g2) => Math.abs(g1 - mid) - Math.abs(g2 - mid))
  const xg = (byDistance.find((g) => clear(g + off)) ?? byDistance[0]) + off
  d = `M${xa},${y0} L${xa},${ya} L${xg},${ya} L${xg},${yb} L${xb},${yb} L${xb},${y3}`
  return { d, lx: (xa + xg) / 2, ly: ya - 3, anchor: 'middle' }
}

function reach(edges: SEdge[], start: string, dir: 'up' | 'down'): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const v = stack.pop()!
    for (const e of edges) {
      const [from, to] = dir === 'down' ? [e.from, e.to] : [e.to, e.from]
      if (from === v && !seen.has(to)) {
        seen.add(to)
        stack.push(to)
      }
    }
  }
  return seen
}

export function Schematic({ diagram }: { diagram: Diagram }) {
  const { nodes, edges } = diagram
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes])
  const [sel, setSel] = useState<string | null>(diagram.order?.[0] ?? null)
  const [hover, setHover] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    setSel(diagram.order?.[0] ?? null)
    setPlaying(false)
  }, [diagram])
  const order = (diagram.order ?? nodes.map((n) => n.id)).filter((id) => byId[id]) // a stale id never becomes an empty step
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setSel((s) => {
        const i = s ? order.indexOf(s) : -1
        if (i >= order.length - 1) {
          setPlaying(false)
          return s
        }
        return order[i + 1]
      })
    }, 1800)
    return () => clearInterval(t)
  }, [playing, order])

  const focus = hover ?? sel
  const lit = useMemo(() => {
    if (!focus) return null
    return new Set([focus, ...reach(edges, focus, 'up'), ...reach(edges, focus, 'down')])
  }, [focus, edges])
  const up = useMemo(() => (focus ? reach(edges, focus, 'up') : new Set<string>()), [focus, edges])
  const down = useMemo(() => (focus ? reach(edges, focus, 'down') : new Set<string>()), [focus, edges])
  /** An edge is lit when it lies on a path into the focused box (both ends upstream or the box itself),
   * or out of it (both ends downstream or the box itself). */
  const edgeOn = (e: SEdge) => {
    const inUp = (id: string) => id === focus || up.has(id)
    const inDown = (id: string) => id === focus || down.has(id)
    return (inUp(e.from) && inUp(e.to) && e.from !== focus) || (inDown(e.from) && inDown(e.to) && e.to !== focus)
  }

  const W = PAD * 2 + Math.max(...nodes.map((n) => n.col + (n.w ?? 1))) * CW - (CW - NW)
  const H = TOP + PAD + (Math.max(...nodes.map((n) => n.row)) + 1) * RH - (RH - NH)
  const s = sel ? byId[sel] : null
  const step = sel ? order.indexOf(sel) : -1

  return (
    <div className="sch">
      <div className="sch-bar">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            if (!playing && step >= order.length - 1) setSel(order[0]) // a finished tour starts again from step 1
            setPlaying(!playing)
          }}
        >
          {playing ? '❚❚ Pause' : '▶ Walk through'}
        </button>
        <button type="button" className="btn ghost sm" disabled={step <= 0} onClick={() => setSel(order[Math.max(0, step - 1)])}>
          ‹ Previous
        </button>
        <button type="button" className="btn ghost sm" disabled={step >= order.length - 1} onClick={() => setSel(order[Math.min(order.length - 1, step + 1)])}>
          Next ›
        </button>
        <span className="muted small">
          {step >= 0 ? `Step ${step + 1} of ${order.length}` : 'Click a box'} · click any box to trace what feeds it (darker) and what it feeds; click the background to clear
        </span>
      </div>
      <div className="sch-wrap">
        <div className="sch-canvas">
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: Math.min(W, 760), height: 'auto' }} role="group" aria-label={diagram.title} onClick={() => { setSel(null); setPlaying(false) }}>
            <defs>
              <marker id={`arrow-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="sch-arrow" />
              </marker>
            </defs>
            {(diagram.bands ?? []).map((b, i) => (
              <g key={i} className="sch-band">
                <rect x={4} y={TOP + b.row0 * RH - 24} width={W - 8} height={(b.row1 - b.row0 + 1) * RH - (RH - NH) + 34} rx={10} />
              </g>
            ))}
            {edges.map((e, i) => {
              const a = byId[e.from]
              const b = byId[e.to]
              if (!a || !b) return null
              const r = route(a, b, nodes.filter((n) => n !== a && n !== b).map(geom), i)
              const on = lit ? edgeOn(e) : false
              return (
                <g key={i} className={`sch-edge ${lit ? (on ? 'on' : 'dim') : ''} ${e.dashed ? 'dashed' : ''}`}>
                  <path d={r.d} markerEnd={`url(#arrow-${diagram.id})`} />
                  {e.label && (
                    <text x={r.lx} y={r.ly} textAnchor={r.anchor}>
                      {e.label}
                    </text>
                  )}
                </g>
              )
            })}
            {/* band titles drawn over the edges, on a halo, so no line runs through them */}
            {(diagram.bands ?? []).map((b, i) => (
              <text key={`bt${i}`} className="sch-band-title" x={12} y={TOP + b.row0 * RH - 10}>
                {b.label}
              </text>
            ))}
            {nodes.map((n) => {
              const g = geom(n)
              const cls = `sch-node k-${n.kind} ${n.tag ? `t-${n.tag}` : ''} ${sel === n.id ? 'sel' : ''} ${lit ? (lit.has(n.id) ? (up.has(n.id) ? 'up' : 'on') : 'dim') : ''}`
              return (
                <g
                  key={n.id}
                  className={cls}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.label}${n.sub ? `: ${n.sub}` : ''}`}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setSel(n.id)
                    setPlaying(false)
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault() // Space must not scroll the page
                    setSel(n.id)
                    setPlaying(false)
                  }}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  {n.kind === 'decision' ? (
                    <polygon points={`${g.cx},${g.y - 6} ${g.x + g.w + 6},${g.cy} ${g.cx},${g.y + g.h + 6} ${g.x - 6},${g.cy}`} />
                  ) : (
                    <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={n.kind === 'input' || n.kind === 'output' ? 16 : n.kind === 'stop' ? 30 : 8} />
                  )}
                  {/* a diamond's text stays inside its middle two thirds */}
                  <foreignObject x={n.kind === 'decision' ? g.x + g.w * 0.16 : g.x + 6} y={g.y + 4} width={n.kind === 'decision' ? g.w * 0.68 : g.w - 12} height={g.h - 8}>
                    <div className={`sch-label ${n.kind === 'decision' ? 'dec' : ''}`}>
                      <b>{n.label}</b>
                      {n.sub && <span>{n.sub}</span>}
                    </div>
                  </foreignObject>
                </g>
              )
            })}
          </svg>
        </div>
        <aside className="sch-detail">
          {s ? (
            <>
              <div className="sch-detail-head">
                <span className={`sch-chip k-${s.kind}`}>{s.kind === 'decision' ? 'decision' : s.kind === 'stop' ? 'outcome' : s.kind}</span>
                {s.tag && <span className={`sch-chip t-${s.tag}`}>{TAG_LABEL[s.tag]}</span>}
              </div>
              <h3>{s.label}</h3>
              {s.sub && <p className="muted small">{s.sub}</p>}
              <div className="sch-what">{s.detail.what}</div>
              <DetailList title="Code" items={s.detail.code} mono />
              <DetailList title="Key functions" items={s.detail.functions} mono />
              <DetailList title="Reads" items={s.detail.inputs} />
              <DetailList title="Writes" items={s.detail.outputs} />
              <DetailList title="Decisions" items={s.detail.decisions} />
              <DetailList title="How it is checked" items={s.detail.checks} />
              {s.detail.numbers && (
                <p className="sch-numbers">
                  <b>On the take-home data:</b> {s.detail.numbers}
                </p>
              )}
              <ConnList label="Fed by" ids={edges.filter((e) => e.to === s.id).map((e) => e.from)} byId={byId} onPick={setSel} />
              <ConnList label="Feeds" ids={edges.filter((e) => e.from === s.id).map((e) => e.to)} byId={byId} onPick={setSel} />
            </>
          ) : (
            <p className="muted">Click a box in the diagram, or press “Walk through”, to see what it does, where its code lives and what it reads and writes.</p>
          )}
        </aside>
      </div>
      <Legend nodes={nodes} />
    </div>
  )
}

function DetailList({ title, items, mono }: { title: string; items?: string[]; mono?: boolean }) {
  if (!items?.length) return null
  return (
    <div className="sch-list">
      <div className="sch-list-title">{title}</div>
      <ul>
        {items.map((it) => (
          <li key={it}>{mono ? <code>{it}</code> : it}</li>
        ))}
      </ul>
    </div>
  )
}

function ConnList({ label, ids, byId, onPick }: { label: string; ids: string[]; byId: Record<string, SNode>; onPick: (id: string) => void }) {
  if (!ids.length) return null
  return (
    <div className="sch-conn">
      <span className="muted small">{label}:</span>
      {ids.map((id) => (
        <button key={id} type="button" className="link-btn small" onClick={() => onPick(id)}>
          {byId[id]?.label ?? id}
        </button>
      ))}
    </div>
  )
}

function Legend({ nodes }: { nodes: SNode[] }) {
  const kinds = [...new Set(nodes.map((n) => n.kind))]
  const tags = [...new Set(nodes.map((n) => n.tag).filter(Boolean))] as Tag[]
  const KIND: Record<Kind, string> = { input: 'input data', step: 'processing step', decision: 'decision', output: 'output', store: 'stored artefact / config', external: 'external / network', module: 'code module', test: 'tests', stop: 'outcome' }
  return (
    <div className="sch-legend small">
      {kinds.map((k) => (
        <span key={k}>
          <i className={`sch-swatch k-${k}`} /> {KIND[k]}
        </span>
      ))}
      {tags.length > 0 && <span className="muted">· outline: </span>}
      {tags.map((t) => (
        <span key={t}>
          <i className={`sch-swatch outline t-${t}`} /> {TAG_LABEL[t]}
        </span>
      ))}
    </div>
  )
}
