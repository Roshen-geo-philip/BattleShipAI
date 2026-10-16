import { inBounds } from '../board';
import { KnowledgeBase, type Rule, atom, neg, pos, type Term, type Bindings } from './logic';

/**
 * Predicates used by the Battleship AI (x = column, y = row, 0-based, board 0..size-1):
 *
 *  Observations (asserted from the AI's legitimate view only):
 *    Hit(x,y)  Miss(x,y)  Detonated(x,y)  MineAt(x,y)  Sunk(s)  SunkCell(s,x,y)
 *    RadarEvidence(x,y,e)  e ∈ {ship, empty}   Remaining(s)  ShipLength(s,n)
 *  Built-ins:
 *    Cell(x,y)             (x,y) is on the board
 *    Adjacent(x1,y1,x2,y2) cells share an edge (both on board)
 *    Extend(x1,y1,x2,y2,u,v)  (u,v) continues the straight line x1y1→x2y2 by one cell
 *  Derived:
 *    ShipAt  NotShipAt  Tested  Resolved  OpenHit  Untested  Candidate
 *    LineCandidate  KnownShipTarget
 *  Placement layer (see reasoner.ts):
 *    PossiblePlacement(s,p)  Contains(p,x,y)  Impossible(x,y)
 */
export function createBattleshipKB(size: number): KnowledgeBase {
  const kb = new KnowledgeBase();
  const num = (t: Term) => (typeof t === 'number' ? t : NaN);

  kb.defineBuiltin('Cell', function* (args, b) {
    const [x, y] = args;
    for (let yy = 0; yy < size; yy++) {
      if (typeof y === 'number' && y !== yy) continue;
      for (let xx = 0; xx < size; xx++) {
        if (typeof x === 'number' && x !== xx) continue;
        yield bind(b, args, [xx, yy]);
      }
    }
  });

  kb.defineBuiltin('Adjacent', function* (args, b) {
    const [x1, y1] = args.map(num);
    if (Number.isNaN(x1) || Number.isNaN(y1)) throw new Error('Adjacent requires a bound first cell');
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const u = x1 + dx;
      const v = y1 + dy;
      if (!inBounds(size, u, v)) continue;
      const r = bindIfCompatible(b, args.slice(2), [u, v]);
      if (r) yield r;
    }
  });

  kb.defineBuiltin('Extend', function* (args, b) {
    const [x1, y1, x2, y2] = args.map(num);
    if ([x1, y1, x2, y2].some(Number.isNaN)) throw new Error('Extend requires two bound cells');
    const u = 2 * x2 - x1;
    const v = 2 * y2 - y1;
    if (!inBounds(size, u, v)) return;
    const r = bindIfCompatible(b, args.slice(4), [u, v]);
    if (r) yield r;
  });

  return kb;
}

function bind(b: Bindings, pattern: Term[], values: Term[]): Bindings {
  return bindIfCompatible(b, pattern, values) ?? b;
}

function bindIfCompatible(b: Bindings, pattern: Term[], values: Term[]): Bindings | null {
  const out: Record<string, Term> = { ...b };
  for (let i = 0; i < values.length; i++) {
    const p = pattern[i];
    if (typeof p === 'string' && p.startsWith('?')) {
      if (p in out && out[p] !== values[i]) return null;
      out[p] = values[i];
    } else if (p !== values[i]) return null;
  }
  return out;
}

/* ------------------------------ Rule base ------------------------------ */

export const RULE_HIT_SHIP: Rule = {
  name: 'R1', stratum: 1,
  text: 'Hit(x,y) → ShipAt(x,y)',
  body: [pos('Hit', '?x', '?y')], head: atom('ShipAt', '?x', '?y'),
};
export const RULE_MISS_EMPTY: Rule = {
  name: 'R2', stratum: 1,
  text: 'Miss(x,y) → ¬ShipAt(x,y)',
  body: [pos('Miss', '?x', '?y')], head: atom('NotShipAt', '?x', '?y'),
};
export const RULE_MINE_EMPTY: Rule = {
  name: 'R2m', stratum: 1,
  text: 'MineAt(x,y) → ¬ShipAt(x,y)   (mines are only placed on unoccupied cells)',
  body: [pos('MineAt', '?x', '?y')], head: atom('NotShipAt', '?x', '?y'),
};
export const RULE_RADAR_SHIP: Rule = {
  name: 'R2r+', stratum: 1,
  text: 'RadarEvidence(x,y,ship) → ShipAt(x,y)',
  body: [pos('RadarEvidence', '?x', '?y', 'ship')], head: atom('ShipAt', '?x', '?y'),
};
export const RULE_RADAR_EMPTY: Rule = {
  name: 'R2r-', stratum: 1,
  text: 'RadarEvidence(x,y,empty) → ¬ShipAt(x,y)',
  body: [pos('RadarEvidence', '?x', '?y', 'empty')], head: atom('NotShipAt', '?x', '?y'),
};
export const RULE_TESTED_HIT: Rule = {
  name: 'T1', stratum: 1, text: 'Hit(x,y) → Tested(x,y)',
  body: [pos('Hit', '?x', '?y')], head: atom('Tested', '?x', '?y'),
};
export const RULE_TESTED_MISS: Rule = {
  name: 'T2', stratum: 1, text: 'Miss(x,y) → Tested(x,y)',
  body: [pos('Miss', '?x', '?y')], head: atom('Tested', '?x', '?y'),
};
export const RULE_TESTED_MINE: Rule = {
  name: 'T3', stratum: 1, text: 'Detonated(x,y) → Tested(x,y)',
  body: [pos('Detonated', '?x', '?y')], head: atom('Tested', '?x', '?y'),
};
export const RULE_RESOLVED: Rule = {
  name: 'S1', stratum: 1, text: 'SunkCell(s,x,y) → Resolved(x,y)',
  body: [pos('SunkCell', '?s', '?x', '?y')], head: atom('Resolved', '?x', '?y'),
};
export const RULE_OPEN_HIT: Rule = {
  name: 'S2', stratum: 2, text: 'Hit(x,y) ∧ ¬Resolved(x,y) → OpenHit(x,y)',
  body: [pos('Hit', '?x', '?y'), neg('Resolved', '?x', '?y')], head: atom('OpenHit', '?x', '?y'),
};
export const RULE_UNTESTED: Rule = {
  name: 'U1', stratum: 2, text: 'Cell(x,y) ∧ ¬Tested(x,y) → Untested(x,y)',
  body: [pos('Cell', '?x', '?y'), neg('Tested', '?x', '?y')], head: atom('Untested', '?x', '?y'),
};
export const RULE_CANDIDATE: Rule = {
  name: 'R3', stratum: 3,
  text: 'OpenHit(x,y) ∧ Adjacent(x,y,u,v) ∧ Untested(u,v) ∧ ¬NotShipAt(u,v) → Candidate(u,v)',
  body: [
    pos('OpenHit', '?x', '?y'),
    pos('Adjacent', '?x', '?y', '?u', '?v'),
    pos('Untested', '?u', '?v'),
    neg('NotShipAt', '?u', '?v'),
  ],
  head: atom('Candidate', '?u', '?v'),
};
export const RULE_LINE: Rule = {
  name: 'R7', stratum: 3,
  text: 'OpenHit(a) ∧ Adjacent(a,b) ∧ OpenHit(b) ∧ Extend(a,b,c) ∧ Untested(c) ∧ ¬NotShipAt(c) → LineCandidate(c)',
  body: [
    pos('OpenHit', '?x1', '?y1'),
    pos('Adjacent', '?x1', '?y1', '?x2', '?y2'),
    pos('OpenHit', '?x2', '?y2'),
    pos('Extend', '?x1', '?y1', '?x2', '?y2', '?u', '?v'),
    pos('Untested', '?u', '?v'),
    neg('NotShipAt', '?u', '?v'),
  ],
  head: atom('LineCandidate', '?u', '?v'),
};
export const RULE_KNOWN_SHIP: Rule = {
  name: 'R9', stratum: 3,
  text: 'ShipAt(x,y) ∧ Untested(x,y) → KnownShipTarget(x,y)',
  body: [pos('ShipAt', '?x', '?y'), pos('Untested', '?x', '?y')],
  head: atom('KnownShipTarget', '?x', '?y'),
};

/** Integrity constraints checked after inference (R4: Candidate(x,y) → Untested(x,y)). */
export function enforceCandidateConstraint(kb: KnowledgeBase): number {
  let removed = 0;
  for (const pred of ['Candidate', 'LineCandidate', 'KnownShipTarget']) {
    for (const [x, y] of kb.all(pred)) {
      if (!kb.holds('Untested', x, y)) {
        kb.retract(pred, x, y);
        removed++;
      }
    }
  }
  return removed;
}

export const BASE_RULES: Rule[] = [
  RULE_HIT_SHIP, RULE_MISS_EMPTY, RULE_MINE_EMPTY, RULE_RADAR_SHIP, RULE_RADAR_EMPTY,
  RULE_TESTED_HIT, RULE_TESTED_MISS, RULE_TESTED_MINE, RULE_RESOLVED,
  RULE_OPEN_HIT, RULE_UNTESTED, RULE_CANDIDATE,
];

export const STRATEGIC_RULES: Rule[] = [...BASE_RULES, RULE_LINE, RULE_KNOWN_SHIP];
