/**
 * "How it works": interactive schematics of the code that solves each challenge: the architecture
 * (data flow through the modules), the logic (decision flows of the core rules) and a code map
 * (modules and imports). Deep links: #/how:birds/<diagram-id>, #/how:vegetation/<diagram-id>.
 */
import { useEffect, useState } from 'react'
import { BIRDS_DIAGRAMS } from './birds'
import { Schematic, type Diagram } from './Schematic'
import { VEG_DIAGRAMS } from './vegetation'

const INTRO = {
  birds: {
    eyebrow: 'Challenge 1 · How it works',
    title: 'From BirdNET scores to observations: the code, step by step',
    text: 'The architecture shows how predictions and validations flow through the deployable package (ns_observations) and the research analysis (run_challenge1.py); the logic diagrams show the two decisions that matter, whether a species gets a threshold and how each prediction is labelled; the code map shows which module does what. Every box opens its code location, functions and numbers on the take-home data.',
  },
  vegetation: {
    eyebrow: 'Challenge 2 · How it works',
    title: 'From ODK tables to flags, marts and the dashboard: the code, step by step',
    text: 'The architecture shows the batch run, from the input contract to staged publication; the logic diagrams show how one rule decides, which survey counts, how a record’s taxon is resolved and when effort metrics may be read as evidence; the code map shows the modules of challenge2/src. Every box opens its code location, functions and numbers on the take-home data.',
  },
}

const groupOf = (d: Diagram) => (d.id.endsWith('arch') ? 'Architecture' : d.id.endsWith('code') ? 'Code map' : 'Logic')

export function HowItWorks({ challenge }: { challenge: 'birds' | 'vegetation' }) {
  const diagrams = challenge === 'birds' ? BIRDS_DIAGRAMS : VEG_DIAGRAMS
  const fromHash = () => {
    const m = new RegExp(`^#/how:${challenge}/([\\w-]+)`).exec(window.location.hash)
    return diagrams.find((d) => d.id === m?.[1])?.id ?? diagrams[0].id
  }
  const [id, setIdState] = useState(fromHash)
  const setId = (next: string) => {
    setIdState(next)
    window.history.replaceState(null, '', `#/how:${challenge}/${next}`)
  }
  useEffect(() => {
    setIdState(fromHash())
    const on = () => setIdState(fromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge])
  const d = diagrams.find((x) => x.id === id) ?? diagrams[0]
  const intro = INTRO[challenge]
  const groups = ['Architecture', 'Logic', 'Code map']
  return (
    <div className="summary">
      <div className="task-card">
        <div className="ds-eyebrow">{intro.eyebrow}</div>
        <h1>{intro.title}</h1>
        <p className="task-sub">{intro.text}</p>
      </div>
      <div className="paper-tabs" role="tablist" aria-label="Diagrams">
        {groups.map((g) =>
          diagrams
            .filter((x) => groupOf(x) === g)
            .map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={x.id === d.id} className={`paper-tab ${x.id === d.id ? 'on' : ''}`} onClick={() => setId(x.id)}>
                <span>{g === 'Logic' ? x.title.replace(/^Logic:\s*/, '') : g}</span>
                <span className="role-dot">{g.toLowerCase()}</span>
              </button>
            )),
        )}
      </div>
      <section className="sum-section">
        <div className="sum-section-head">
          <div>
            <h2>{d.title}</h2>
            <p className="muted">{d.sub}</p>
          </div>
        </div>
        <Schematic diagram={d} />
      </section>
    </div>
  )
}
