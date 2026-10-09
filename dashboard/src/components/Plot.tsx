import Plotly from 'plotly.js-dist-min'
import { useEffect, useRef } from 'react'

export interface SelectRange {
  x?: [number | string, number | string]
  y?: [number | string, number | string]
  xaxis: string
}

interface Props {
  data: object[]
  layout: Record<string, unknown>
  height: number
  onClickIndex?: (customdata: unknown) => void
  onSelectRange?: (r: SelectRange) => void
  filename?: string
}

/** Thin wrapper around Plotly.react: one div, re-rendered in place, events rebound each render. */
export function Plot({ data, layout, height, onClickIndex, onSelectRange, filename = 'chart' }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { on?: (ev: string, fn: (e: never) => void) => void; removeAllListeners?: (ev: string) => void }) | null
    if (!el) return
    Plotly.react(el, data, { ...layout, height, autosize: true }, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'autoScale2d', 'toggleSpikelines'],
      toImageButtonOptions: { format: 'png', filename, scale: 2 },
    })
    el.removeAllListeners?.('plotly_click')
    el.removeAllListeners?.('plotly_selected')
    if (onClickIndex)
      el.on?.('plotly_click', (e: { points: { customdata?: unknown }[] }) => {
        const p = e.points?.[0]
        if (p && p.customdata !== undefined && p.customdata !== null) onClickIndex(p.customdata)
      })
    if (onSelectRange)
      el.on?.('plotly_selected', (e: { range?: Record<string, [number, number]> } | undefined) => {
        if (!e?.range) return
        const xKey = Object.keys(e.range).find((k) => k.startsWith('x'))
        const yKey = Object.keys(e.range).find((k) => k.startsWith('y'))
        onSelectRange({ x: xKey ? e.range[xKey] : undefined, y: yKey ? e.range[yKey] : undefined, xaxis: xKey ?? 'x' })
      })
  }, [data, layout, height, onClickIndex, onSelectRange, filename])

  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) Plotly.purge(el)
    }
  }, [])

  return <div ref={ref} className="plot" style={{ minHeight: height }} />
}
