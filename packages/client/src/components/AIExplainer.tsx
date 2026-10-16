import { useMemo, useState } from 'react';
import { BASE_RULES, STRATEGIC_RULES, createBattleshipKB, enforceCandidateConstraint, DEFAULT_RULES, type Rule, type Term } from '@battleship/engine';

/**
 * "How the AI works". Everything here describes the real implementation in
 * packages/engine/src/ai: rule texts are rendered from the exported rule objects and
 * the worked example is computed live by the same KnowledgeBase the AI uses.
 */

type Tab = 'overview' | 'rules' | 'example' | 'functions';

const PREDICATES: { group: string; items: [string, string][] }[] = [
  {
    group: 'Observations — asserted by observe() from the AI’s own view only',
    items: [
      ['Hit(x,y)', 'A shot (manual, airstrike or nuke) at (x,y) hit a ship.'],
      ['Miss(x,y)', 'A shot at (x,y) found open water.'],
      ['Detonated(x,y)', 'A shot at (x,y) hit a mine (also asserts MineAt).'],
      ['MineAt(x,y)', 'A mine is known at (x,y): detonated, defused, or seen by radar.'],
      ['RadarEvidence(x,y,e)', 'A radar sweep reported e ∈ {ship, empty} for (x,y).'],
      ['Sunk(s) / SunkCell(s,x,y)', 'Ship template s is sunk; its cells become public.'],
      ['Remaining(s)', 'Ship template s is still afloat (re-asserted every observation).'],
    ],
  },
  {
    group: 'Built-ins — computed, never stored',
    items: [
      ['Cell(x,y)', '(x,y) lies on the 15×15 board.'],
      ['Adjacent(x1,y1,x2,y2)', 'The two cells share an edge.'],
      ['Extend(x1,y1,x2,y2,u,v)', '(u,v) continues the straight line from (x1,y1) through (x2,y2).'],
    ],
  },
  {
    group: 'Derived — produced by forward chaining',
    items: [
      ['ShipAt / NotShipAt', 'A ship is known to be / known not to be at the cell.'],
      ['Tested(x,y)', 'The cell has already been shot.'],
      ['Resolved(x,y)', 'The cell belongs to a sunk ship.'],
      ['OpenHit(x,y)', 'A hit whose ship is not yet sunk — still worth chasing.'],
      ['Untested(x,y)', 'On the board and not yet shot (negation as failure).'],
      ['Candidate(u,v)', 'Untested neighbour of an open hit not known to be empty.'],
      ['LineCandidate(u,v)', 'Continues a line of two adjacent open hits.'],
      ['KnownShipTarget(x,y)', 'Radar confirmed a ship there and it is untested.'],
      ['PossiblePlacement(s,p) / Impossible(x,y)', 'Asserted by modelPlacements(): consistent placements, and untested cells no consistent placement covers.'],
    ],
  },
];

const FUNCTIONS: { name: string; sig: string; file: string; body: string }[] = [
  { name: 'new BattleshipAI', sig: '(playerId, size, difficulty = "strategic", seed = 12345)', file: 'ai/agent.ts', body: 'Creates the agent with its own knowledge base (createBattleshipKB) and a seeded RNG for reproducible tie-breaking. Difficulty selects the rule set: basic → BASE_RULES, strategic/advanced → STRATEGIC_RULES.' },
  { name: 'planSetup', sig: '(view: BattleView) → BattleAction[]', file: 'ai/agent.ts', body: 'Places the fleet with randomFleet (backtracking), and on Advanced lays one setup mine on empty water. Returns placeShips / placeMine / ready actions that go through the normal engine.' },
  { name: 'observe', sig: '(view: BattleView) → void', file: 'ai/agent.ts', body: 'Steps 1–2. Throws if the opponent board is revealed (anti-cheat). Converts shots, sunk ships, known mines and radar scans into ground facts (Hit, Miss, Detonated, MineAt, SunkCell, RadarEvidence, Remaining). Observations only ever grow.' },
  { name: 'infer', sig: '() → Map<ruleName, factsDerived>', file: 'ai/agent.ts', body: 'Step 3. Retracts all derived predicates, runs kb.forwardChain(rules) to a fixpoint, then enforceCandidateConstraint (R4). The returned trace is what the “AI inference” panel shows (e.g. “R1×3, R3×4”).' },
  { name: 'modelPlacements', sig: '() → { byShip, probability, targetWeight, total }', file: 'ai/agent.ts', body: 'Steps 4–5 (Strategic/Advanced). Enumerates every placement of each Remaining ship (R5, shape and bounds by construction), rejects any covering a NotShipAt or Resolved cell (R6), and accumulates per-cell density. When open hits exist, placements explaining more of them are weighted exponentially (40^covered). Cells covered by no placement are asserted Impossible. Ships are treated as independent — a standard approximation.' },
  { name: 'decide', sig: '(view: BattleView) → AIDecision | null', file: 'ai/agent.ts', body: 'The full pipeline: observe → infer → model → choose. If manual fire is unlocked it always fires (chooseTarget, with a first-untested-cell fallback, because End Turn is illegal while a shot remains). After a miss it tries chooseAbility, otherwise ends the turn. Returns the action plus its reasoning strings.' },
  { name: 'chooseTarget', sig: '(model, reasoning) → Coord | null', file: 'ai/agent.ts', body: 'Priority order: KnownShipTarget (R9) → LineCandidate (R7, not Basic) → Candidate (R3) → hunt mode. Hunting is random on Basic, checkerboard parity ranked by density on Strategic, maximum density on Advanced.' },
  { name: 'best', sig: '(cells, weight) → Coord | null', file: 'ai/agent.ts', body: 'Rule R8: picks the highest-weight cell; exact ties are sorted and broken with the seeded RNG so decisions are deterministic for a given seed and view.' },
  { name: 'chooseAbility', sig: '(view, model, balance, reasoning) → BattleAction | null', file: 'ai/agent.ts', body: 'Respects the same rule switches as humans. Advanced: Airstrike when a row/column’s expected ship cells ≥ 1.8, Nuke when a 2×2 ≥ 1.2. Strategic/Advanced: Radar while hunting (first ability of the turn, expected ≥ 0.6). Advanced then considers chooseMine.' },
  { name: 'chooseMine', sig: '(view, balance, reasoning) → BattleAction | null', file: 'ai/agent.ts', body: `Advanced only: lays a defensive mine on its own empty, never-attacked water (cost ${DEFAULT_RULES.abilityCosts.mine}), keeping a radar reserve and at most two active mines. Uses the ordinary placeMine action.` },
  { name: 'KnowledgeBase.forwardChain', sig: '(rules: Rule[]) → number', file: 'ai/logic.ts', body: 'Stratified forward chaining: rules are grouped by stratum and each stratum is run to a fixpoint before the next, which makes negation-as-failure safe. Records how many facts each rule derived in kb.trace.' },
  { name: 'KnowledgeBase.solve / match', sig: '(body: Literal[], bindings) → Iterable<Bindings>', file: 'ai/logic.ts', body: 'Left-to-right conjunctive query. Positive literals unify against stored facts (O(1) for ground lookups) or call a built-in; negated literals must be ground and succeed when the atom cannot be proven.' },
  { name: 'assert / retract / holds / all', sig: '(pred, ...args)', file: 'ai/logic.ts', body: 'Fact storage keyed by "Pred(args)". holds also answers built-ins. unify(pattern, ground, bindings) performs first-order matching of variables written as "?x".' },
  { name: 'createBattleshipKB', sig: '(size) → KnowledgeBase', file: 'ai/knowledge.ts', body: 'Creates a knowledge base with the Cell, Adjacent and Extend built-ins for the board size.' },
  { name: 'enforceCandidateConstraint', sig: '(kb) → removed', file: 'ai/knowledge.ts', body: 'Integrity constraint R4: Candidate / LineCandidate / KnownShipTarget must be Untested; anything else is retracted.' },
];

const fmt = (pred: string, args: Term[]) => `${pred}(${args.join(',')})`;

function useExample() {
  return useMemo(() => {
    // Step 1: one miss and one hit.
    const kb = createBattleshipKB(15);
    kb.assert('Miss', 2, 2);
    kb.assert('Hit', 5, 5);
    kb.forwardChain(STRATEGIC_RULES);
    enforceCandidateConstraint(kb);
    const step1 = {
      trace: [...kb.trace.entries()].filter(([, n]) => n > 0).map(([r, n]) => `${r}×${n}`),
      negative: kb.all('NotShipAt').map((a) => fmt('NotShipAt', a)),
      open: kb.all('OpenHit').map((a) => fmt('OpenHit', a)),
      candidates: kb.all('Candidate').map((a) => fmt('Candidate', a)),
    };
    // Step 2: the AI fires at a candidate and hits again → the orientation is now known.
    kb.assert('Hit', 6, 5);
    for (const p of ['ShipAt', 'NotShipAt', 'Tested', 'Resolved', 'OpenHit', 'Untested', 'Candidate', 'LineCandidate', 'KnownShipTarget']) kb.retractAll(p);
    kb.forwardChain(STRATEGIC_RULES);
    enforceCandidateConstraint(kb);
    const step2 = {
      trace: [...kb.trace.entries()].filter(([, n]) => n > 0).map(([r, n]) => `${r}×${n}`),
      line: kb.all('LineCandidate').map((a) => fmt('LineCandidate', a)),
      candidates: kb.all('Candidate').map((a) => fmt('Candidate', a)),
    };
    return { step1, step2 };
  }, []);
}

function RuleTable({ rules }: { rules: Rule[] }) {
  const inBase = new Set(BASE_RULES.map((r) => r.name));
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Rule</th><th>Stratum</th><th>Clause</th><th>Used by</th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.name}>
              <td className="rank">{r.name}</td>
              <td>{r.stratum}</td>
              <td style={{ whiteSpace: 'normal', minWidth: 260 }}><span className="rule-text">{r.text}</span></td>
              <td>{inBase.has(r.name) ? 'All levels' : 'Strategic, Advanced'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AIExplainer({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>('overview');
  const ex = useExample();
  const tabs: [Tab, string][] = [['overview', 'Decision process'], ['rules', 'Predicates & rules'], ['example', 'Worked example'], ['functions', 'Functions']];

  return (
    <section className="explainer" aria-labelledby="ai-explainer-title">
      <div className="stack" style={{ gap: 8 }}>
        <span className="caption">Predicate calculus · forward chaining</span>
        <h2 id="ai-explainer-title">How the AI thinks</h2>
        <p className="lead" style={{ fontSize: compact ? '1rem' : undefined }}>
          The opponent is a small first-order logic engine. It turns what it legitimately sees into facts, derives new facts with Horn-clause rules, then ranks
          the cells those facts leave open. It never sees your ships: it only receives the same public view of your board that a human opponent gets.
        </p>
      </div>
      <div className="tabs" role="tablist" aria-label="AI explanation sections">
        {tabs.map(([id, label]) => (
          <button key={id} id={`ai-tab-${id}`} role="tab" type="button" className="tab" aria-selected={tab === id} aria-controls={`ai-panel-${id}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div id="ai-panel-overview" role="tabpanel" aria-labelledby="ai-tab-overview" className="stack lg">
          <ol className="pipeline">
            <li><strong>Observe</strong><span className="small">viewBattle(state, aiId) → <code>observe(view)</code>. Shots, sunk ships, known mines and radar scans become facts.</span></li>
            <li><strong>Update knowledge</strong><span className="small">Observation facts accumulate; all derived facts are retracted so they can be recomputed.</span></li>
            <li><strong>Evaluate rules</strong><span className="small"><code>infer()</code> runs stratified forward chaining to a fixpoint, then the R4 integrity check.</span></li>
            <li><strong>Find candidates</strong><span className="small"><code>modelPlacements()</code> keeps only ship placements consistent with every fact (R5/R6) and scores cells.</span></li>
            <li><strong>Select a legal action</strong><span className="small"><code>chooseTarget()</code> / <code>chooseAbility()</code> rank options (R8). While a shot remains it must fire.</span></li>
            <li><strong>Execute</strong><span className="small">The action goes through <code>applyAction</code>, the same validator humans use. Illegal moves are impossible.</span></li>
            <li><strong>Repeat</strong><span className="small">A hit keeps the turn going, so the loop runs again with one more fact. After a miss it may use abilities, then ends the turn.</span></li>
          </ol>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Difficulty</th><th>Inference</th><th>Hunting</th><th>Abilities</th></tr></thead>
              <tbody>
                <tr><td className="rank">Basic</td><td style={{ whiteSpace: 'normal' }}>BASE_RULES (R1, R2, R2m, R2r±, T1–T3, S1, S2, U1, R3) + R4; no placement model</td><td style={{ whiteSpace: 'normal' }}>Random untested cell</td><td>None</td></tr>
                <tr><td className="rank">Strategic</td><td style={{ whiteSpace: 'normal' }}>+ R7 line, R9 radar targets, placement model</td><td style={{ whiteSpace: 'normal' }}>Checkerboard parity by density</td><td>Radar</td></tr>
                <tr><td className="rank">Advanced</td><td style={{ whiteSpace: 'normal' }}>Same rules as Strategic</td><td style={{ whiteSpace: 'normal' }}>Maximum placement density</td><td style={{ whiteSpace: 'normal' }}>Airstrike, Nuke, Radar, Mines</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'rules' && (
        <div id="ai-panel-rules" role="tabpanel" aria-labelledby="ai-tab-rules" className="stack lg">
          <p className="small">
            Each rule is a Horn clause <code>body → head</code>. Variables range over board coordinates; <code>¬</code> is negation as failure (“cannot be
            proven”), which is safe because rules run stratum by stratum. These rows are rendered from the <code>STRATEGIC_RULES</code> array itself.
          </p>
          <RuleTable rules={STRATEGIC_RULES} />
          <div className="grid-2">
            <div className="panel soft stack">
              <h3>Beyond the clauses</h3>
              <ul className="rules-list small">
                <li><b>R4</b> (integrity): every Candidate, LineCandidate and KnownShipTarget must be Untested — enforced by <code>enforceCandidateConstraint</code>.</li>
                <li><b>R5</b>: a placement must fit the ship’s shape and the board — guaranteed by enumerating <code>allPlacements</code>.</li>
                <li><b>R6</b>: a placement covering a NotShipAt or Resolved cell is rejected.</li>
                <li><b>R8</b>: rank by placement support, seeded tie-breaking.</li>
              </ul>
            </div>
            <div className="panel soft stack">
              <h3>Mines & radar in logic</h3>
              <ul className="rules-list small">
                <li><b>R2m</b>: a mine marks a cell as <code>¬ShipAt</code>, because mines may only be laid on empty water.</li>
                <li><b>T3</b>: a detonated mine counts as Tested, so it is never fired at again.</li>
                <li><b>R2r+ / R2r−</b>: radar evidence becomes <code>ShipAt</code> or <code>¬ShipAt</code>; <b>R9</b> turns an untested radar contact into a top-priority target.</li>
              </ul>
            </div>
          </div>
          {PREDICATES.map((g) => (
            <div key={g.group} className="stack" style={{ gap: 8 }}>
              <h3>{g.group}</h3>
              <div className="table-wrap">
                <table className="tbl">
                  <tbody>
                    {g.items.map(([p, d]) => (
                      <tr key={p}><td style={{ width: '32%' }}><span className="rule-text">{p}</span></td><td style={{ whiteSpace: 'normal' }}>{d}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'example' && (
        <div id="ai-panel-example" role="tabpanel" aria-labelledby="ai-tab-example" className="stack">
          <p className="small">Computed live by <code>createBattleshipKB(15)</code> + <code>forwardChain(STRATEGIC_RULES)</code> — exactly what the AI runs. Coordinates are (column, row) from 0.</p>
          <div className="example-step">
            <h3>1 · Observe a miss at (2,2) and a hit at (5,5)</h3>
            <div className="fact-list"><span className="fact obs">Miss(2,2)</span><span className="fact obs">Hit(5,5)</span></div>
            <p className="small">Rules fired: <span className="mono">{ex.step1.trace.join(', ')}</span></p>
            <div className="fact-list">
              {ex.step1.negative.map((f) => <span key={f} className="fact neg">{f}</span>)}
              {ex.step1.open.map((f) => <span key={f} className="fact">{f}</span>)}
            </div>
            <p className="small">R2 rules the missed cell out for every future placement. R1 and S2 make (5,5) an open hit, so R3 proposes its untested neighbours:</p>
            <div className="fact-list">{ex.step1.candidates.map((f) => <span key={f} className="fact cand">{f}</span>)}</div>
          </div>
          <div className="example-step">
            <h3>2 · Fire at a candidate and hit (6,5)</h3>
            <div className="fact-list"><span className="fact obs">Hit(6,5)</span></div>
            <p className="small">Rules fired: <span className="mono">{ex.step2.trace.join(', ')}</span></p>
            <p className="small">Two adjacent open hits reveal the orientation. R7 derives the cells that extend the line, and <code>chooseTarget</code> prefers them over plain candidates:</p>
            <div className="fact-list">{ex.step2.line.map((f) => <span key={f} className="fact cand">{f}</span>)}</div>
            <p className="small muted">Plain R3 candidates still derived (lower priority): {ex.step2.candidates.join(', ')}</p>
          </div>
          <div className="example-step">
            <h3>3 · Sink the ship</h3>
            <p className="small">When the ship sinks, its cells become <code>SunkCell</code> facts. S1 marks them Resolved, S2 no longer treats them as open hits, and the AI returns to hunt mode guided by the placement density.</p>
          </div>
        </div>
      )}

      {tab === 'functions' && (
        <div id="ai-panel-functions" role="tabpanel" aria-labelledby="ai-tab-functions" className="stack" style={{ gap: 8 }}>
          {FUNCTIONS.map((f) => (
            <details key={f.name} className="fn">
              <summary>
                <span className="rule-text">{f.name}<span className="muted">{f.sig}</span></span>
                <span className="caption">{f.file}</span>
              </summary>
              <div><p>{f.body}</p></div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
