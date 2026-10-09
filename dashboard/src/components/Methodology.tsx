/** Challenge 1 methodology: one tab per paper, plus an overview of how they fit together. */
import { useState } from 'react'
import type { ThemeTokens } from '../lib/palette'
import { load, save } from '../lib/storage'
import { Clare } from './methods/Clare'
import { Navine } from './methods/Navine'
import { Overview } from './methods/Overview'
import { Schwinger } from './methods/Schwinger'
import { PAPERS } from './methods/shared'
import { Thompson } from './methods/Thompson'
import { Tseng } from './methods/Tseng'
import { WoodKahl } from './methods/WoodKahl'
import type { OpenView } from './Summary'

const TABS = [{ key: 'overview', short: 'Overview', role: '' }, ...PAPERS.map((p) => ({ key: p.key, short: p.short, role: p.role }))]

export function Methodology({ tokens, onOpen }: { tokens: ThemeTokens; onOpen: OpenView }) {
  const [tab, setTabState] = useState<string>(() => load('methodTab', 'wood'))
  const setTab = (k: string) => {
    setTabState(k)
    save('methodTab', k)
    window.scrollTo({ top: 0 })
  }
  return (
    <div className="method-page">
      <div className="paper-tabs" role="tablist" aria-label="Papers">
        {TABS.map((tb) => (
          <button key={tb.key} type="button" role="tab" aria-selected={tab === tb.key} className={`paper-tab ${tab === tb.key ? 'on' : ''}`} onClick={() => setTab(tb.key)} data-tip={tb.role ? `${PAPERS.find((p) => p.key === tb.key)?.oneLine}` : 'How the six papers relate, side by side.'} data-tip-title={tb.short}>
            <span>{tb.short}</span>
            {tb.role && <span className={`role-dot role-${tb.role.replace(' ', '-')}`}>{tb.role}</span>}
          </button>
        ))}
      </div>
      {tab === 'overview' && <Overview onOpen={setTab} />}
      {tab === 'wood' && <WoodKahl tokens={tokens} onOpen={onOpen} />}
      {tab === 'thompson' && <Thompson tokens={tokens} />}
      {tab === 'tseng' && <Tseng tokens={tokens} />}
      {tab === 'schwinger' && <Schwinger tokens={tokens} />}
      {tab === 'navine' && <Navine tokens={tokens} />}
      {tab === 'clare' && <Clare tokens={tokens} />}
    </div>
  )
}
