import { TRANSFORM_LABEL } from '../data/stats'
import type { Dataset } from '../data/types'
import type { ChartSpec } from './build'

/** One or two plain-language sentences on how to read the current chart. */
export function readingGuide(ds: Dataset, s: ChartSpec): string {
  const L = (n: string | null) => ds.columns.find((c) => c.name === n)?.label ?? n ?? ''
  const tr = (n: string | null, t: ChartSpec['xTransform']) => (t === 'none' ? L(n) : `${TRANSFORM_LABEL[t]}(${L(n)})`)
  const by = s.color ? `, one colour per ${L(s.color)}` : ''
  const facet = s.facet ? ` One panel per ${L(s.facet)}${s.sharedY ? ', all on the same y-axis' : ', each with its own y-axis'}.` : ''
  const isBinary = (n: string | null) => {
    const c = ds.columns.find((x) => x.name === n)
    return !!c && c.type === 'number' && c.distinct === 2
  }
  switch (s.kind) {
    case 'histogram':
      return `Each bar is a range of ${tr(s.x, s.xTransform)}; its height is the ${
        s.norm === 'percent' ? 'percentage of the group’s rows' : s.norm === 'density' ? 'density (share per unit of x)' : 'number of rows'
      } in that range${by}.${facet}`
    case 'bar': {
      const what =
        s.agg === 'count' || !s.y
          ? 'the number of rows'
          : s.agg === 'share'
            ? 'each colour’s share (%) of the rows in that bar'
            : `the ${s.agg} of ${L(s.y)}${s.agg === 'mean' ? (isBinary(s.y) ? ' (a proportion; whiskers = Wilson 95% interval)' : ' (whiskers = 95% interval)') : ''}`
      return `One bar per ${tr(s.x, s.xTransform)} value or range; its length is ${what}${by}.${facet}`
    }
    case 'line':
      return `Each point is a ${s.x && ds.columns.find((c) => c.name === s.x)?.type === 'datetime' ? s.timeUnit : 'bin'} of ${L(s.x)}; the line traces ${
        s.agg === 'count' || !s.y ? 'the number of rows' : `the ${s.agg} of ${L(s.y)}`
      }${by}.${facet}`
    case 'box':
      return `Distribution of ${tr(s.y, s.yTransform)}${s.x ? ` for each ${L(s.x)}` : ''}${by}: box = middle 50% of values, solid line = median, dashed = mean, whiskers to 1.5×IQR, dots = outliers.${facet}`
    case 'violin':
      return `Distribution of ${tr(s.y, s.yTransform)}${s.x ? ` for each ${L(s.x)}` : ''}${by}: the width shows how many rows have that value; the inner box marks the quartiles.${facet}`
    case 'strip':
      return `Every row is a dot at its ${tr(s.y, s.yTransform)}${s.x ? `, grouped by ${L(s.x)}` : ''}${by}. Sideways spread is random jitter, only to avoid overlap.${facet}`
    case 'scatter':
      return `Each dot is one row: ${tr(s.x, s.xTransform)} across, ${tr(s.y, s.yTransform)} up${by}.${s.jitterY || s.jitterX ? ' Points are jittered slightly so overlaps show; values are unchanged.' : ''}${
        s.trend ? ` Black diamonds = mean of ${L(s.y)} per bin of x${isBinary(s.y) ? ' (the observed proportion of 1s, e.g. precision)' : ''}, with 95% intervals.` : ''
      }${facet}`
    case 'ecdf':
      return `For each value of ${tr(s.x, s.xTransform)}, the line shows the % of rows at or below it${by}. A curve further right means larger values; a steep section means many rows share those values.${facet}`
    case 'heatmap':
      return `Rows: ${L(s.y)}. Columns: ${L(s.x)}. Colour = ${s.agg === 'count' || !s.z ? 'number of rows' : `${s.agg} of ${L(s.z)}`} in each combination (darker = more; blank = none).${facet}`
  }
}
