import { allPlacements, key, placementCells, randomFleet } from '../board';
import { createRng, type Rng } from '../rng';
import type { BattleAction, Coord, ShipPlacement } from '../types';
import type { BattleView } from '../views';
import { KnowledgeBase, type Rule } from './logic';
import { BASE_RULES, STRATEGIC_RULES, createBattleshipKB, enforceCandidateConstraint } from './knowledge';

export type Difficulty = 'basic' | 'strategic' | 'advanced';

export interface AIDecision {
  action: BattleAction;
  /** Short explanation of the logical reasoning behind the choice (for the UI). */
  reasoning: string[];
}

const OBSERVATION_PREDICATES = ['Hit', 'Miss', 'Detonated', 'MineAt', 'Sunk', 'SunkCell', 'RadarEvidence', 'Remaining', 'ShipLength'];
const DERIVED_PREDICATES = [
  'ShipAt', 'NotShipAt', 'Tested', 'Resolved', 'OpenHit', 'Untested', 'Candidate', 'LineCandidate',
  'KnownShipTarget', 'PossiblePlacement', 'Impossible',
];

interface PlacementModel {
  /** Consistent placements per remaining template. */
  byShip: Map<string, ShipPlacement[]>;
  /** Expected number of ship cells per cell (sum of per-ship marginals). */
  probability: Map<string, number>;
  /** Placement support weighted towards explaining open hits. */
  targetWeight: Map<string, number>;
  total: number;
}

/**
 * Logic-based Battleship AI.
 *
 * Fairness: the brain only ever receives a BattleView produced by viewBattle() for its own
 * player id, which strips unrevealed ship coordinates and mines. All actions it emits are
 * executed by the same authoritative engine as human actions.
 */
export class BattleshipAI {
  readonly kb: KnowledgeBase;
  private rng: Rng;
  private actionSeq = 0;
  private rules: Rule[];
  lastReasoning: string[] = [];

  constructor(
    readonly playerId: string,
    readonly size: number,
    readonly difficulty: Difficulty = 'strategic',
    seed = 12345,
  ) {
    this.kb = createBattleshipKB(size);
    this.rng = createRng(seed);
    this.rules = difficulty === 'basic' ? BASE_RULES : STRATEGIC_RULES;
  }

  private nextId(kind: string) {
    this.actionSeq += 1;
    return `ai:${this.playerId}:${kind}:${this.actionSeq}:${Math.floor(this.rng() * 1e9)}`;
  }

  /* ------------------------------ setup ------------------------------ */

  planSetup(view: BattleView): BattleAction[] {
    const placements = randomFleet(view.size, view.templateIds, this.rng);
    if (!placements) throw new Error('AI could not place fleet');
    const actions: BattleAction[] = [
      { type: 'placeShips', actionId: this.nextId('place'), playerId: this.playerId, placements },
    ];
    const me = view.players[this.playerId];
    const cost = view.rules.abilityCosts.mine;
    if (this.difficulty === 'advanced' && view.rules.allowMinesInSetup && me.balance >= cost) {
      const occupied = new Set(placements.flatMap((p) => placementCells(p).map((c) => key(c.x, c.y))));
      for (let tries = 0; tries < 200; tries++) {
        const x = Math.floor(this.rng() * view.size);
        const y = Math.floor(this.rng() * view.size);
        if (!occupied.has(key(x, y))) {
          actions.push({ type: 'placeMine', actionId: this.nextId('mine'), playerId: this.playerId, x, y });
          break;
        }
      }
    }
    actions.push({ type: 'ready', actionId: this.nextId('ready'), playerId: this.playerId });
    return actions;
  }

  /* --------------------------- observation --------------------------- */

  /** Step 1–2: observe the legitimate view and update the knowledge base. */
  observe(view: BattleView) {
    const oppId = view.playerOrder.find((id) => id !== this.playerId)!;
    const board = view.boards[oppId];
    if (board.revealed) throw new Error('AI must not receive a revealed opponent board');
    const kb = this.kb;
    for (const shot of board.shots) {
      if (shot.result === 'hit') kb.assert('Hit', shot.x, shot.y);
      else if (shot.result === 'miss') kb.assert('Miss', shot.x, shot.y);
      else {
        kb.assert('Detonated', shot.x, shot.y);
        kb.assert('MineAt', shot.x, shot.y);
      }
    }
    for (const m of board.mines) kb.assert('MineAt', m.x, m.y);
    const sunk = new Set<string>();
    for (const ship of board.ships) {
      if (!ship.sunk) continue;
      sunk.add(ship.templateId);
      kb.assert('Sunk', ship.templateId);
      for (const c of ship.cells) kb.assert('SunkCell', ship.templateId, c.x, c.y);
    }
    kb.retractAll('Remaining');
    for (const t of view.templateIds) {
      if (!sunk.has(t)) kb.assert('Remaining', t);
    }
    for (const scan of view.radar[this.playerId] ?? []) {
      for (const c of scan.cells) {
        kb.assert('RadarEvidence', c.x, c.y, c.ship ? 'ship' : 'empty');
        if (c.mine) kb.assert('MineAt', c.x, c.y);
      }
    }
  }

  /** Step 3: infer (clear previous derivations; observations are monotonic, derivations are not). */
  infer(): Map<string, number> {
    for (const p of DERIVED_PREDICATES) this.kb.retractAll(p);
    this.kb.forwardChain(this.rules);
    enforceCandidateConstraint(this.kb);
    return new Map(this.kb.trace);
  }

  /** Steps 4–6: enumerate, filter and rank placements of remaining ships (rules R5, R6, R8). */
  modelPlacements(): PlacementModel {
    const kb = this.kb;
    const openHits = kb.all('OpenHit').map(([x, y]) => key(x as number, y as number));
    const openSet = new Set(openHits);
    const byShip = new Map<string, ShipPlacement[]>();
    const probability = new Map<string, number>();
    const targetWeight = new Map<string, number>();
    let total = 0;

    for (const [templateId] of kb.all('Remaining')) {
      const t = templateId as string;
      const consistent: ShipPlacement[] = [];
      for (const p of allPlacements(this.size, t)) {
        // R5 (shape/bounds) holds by construction; R6: reject placements contradicting knowledge.
        const cells = placementCells(p);
        if (cells.some((c) => kb.holds('NotShipAt', c.x, c.y) || kb.holds('Resolved', c.x, c.y))) continue;
        consistent.push(p);
      }
      byShip.set(t, consistent);
      consistent.forEach((p, i) => kb.assert('PossiblePlacement', t, `${t}#${i}`));
      if (consistent.length === 0) continue;
      const share = 1 / consistent.length;
      for (const p of consistent) {
        const cells = placementCells(p);
        const covered = cells.filter((c) => openSet.has(key(c.x, c.y))).length;
        // Target weighting: placements explaining more open hits dominate (exponential).
        const w = openSet.size > 0 ? (covered > 0 ? Math.pow(40, covered) : 0.01) : 1;
        for (const c of cells) {
          const k = key(c.x, c.y);
          if (!kb.holds('Untested', c.x, c.y)) continue;
          probability.set(k, (probability.get(k) ?? 0) + share);
          targetWeight.set(k, (targetWeight.get(k) ?? 0) + w);
          total += w;
        }
      }
    }
    // Corollary of R6: an untested cell covered by no consistent placement cannot hold a ship.
    for (const [x, y] of kb.all('Untested')) {
      if (!targetWeight.has(key(x as number, y as number))) kb.assert('Impossible', x, y);
    }
    // In target mode, condition the estimate on the open hits: normalised target weight.
    if (openSet.size > 0) {
      const maxW = Math.max(0, ...targetWeight.values());
      if (maxW > 0) {
        for (const [k, w] of targetWeight) probability.set(k, Math.max(probability.get(k) ?? 0, w / maxW));
      }
    }
    for (const [x, y] of kb.all('KnownShipTarget')) probability.set(key(x as number, y as number), 1);
    return { byShip, probability, targetWeight, total };
  }

  /* ----------------------------- decision ---------------------------- */

  /** Full pipeline: observe → infer → enumerate → filter → rank → select. Returns null when not our turn. */
  decide(view: BattleView): AIDecision | null {
    if (view.phase !== 'active' || view.turn?.playerId !== this.playerId) return null;
    this.observe(view);
    const trace = this.infer();
    const reasoning: string[] = [];
    const fired = [...trace.entries()].filter(([, n]) => n > 0).map(([r, n]) => `${r}×${n}`);
    reasoning.push(`Inference fired: ${fired.join(', ') || 'none'}`);

    const model = this.difficulty === 'basic' ? null : this.modelPlacements();
    if (model) {
      const totalPlacements = [...model.byShip.values()].reduce((s, l) => s + l.length, 0);
      reasoning.push(`${totalPlacements} ship placements remain consistent with observations`);
    }

    const me = view.players[this.playerId];
    const locked = view.turn.manualLocked;
    const tested = new Set(view.boards[this.opponentId(view)].shots.map((s) => key(s.x, s.y)));

    if (!locked) {
      const target = this.chooseTarget(model, reasoning);
      if (target && !tested.has(key(target.x, target.y))) {
        return this.finish({ type: 'attack', actionId: this.nextId('attack'), playerId: this.playerId, x: target.x, y: target.y }, reasoning);
      }
    }

    // After a miss (or with nothing to shoot): consider abilities, otherwise end the turn.
    const ability = model ? this.chooseAbility(view, model, me.balance, reasoning) : null;
    if (ability) return this.finish(ability, reasoning);
    reasoning.push('No profitable action left — ending turn');
    return this.finish({ type: 'endTurn', actionId: this.nextId('end'), playerId: this.playerId }, reasoning);
  }

  private finish(action: BattleAction, reasoning: string[]): AIDecision {
    this.lastReasoning = reasoning;
    return { action, reasoning };
  }

  private opponentId(view: BattleView) {
    return view.playerOrder.find((id) => id !== this.playerId)!;
  }

  private cells(pred: string): Coord[] {
    return this.kb.all(pred).map(([x, y]) => ({ x: x as number, y: y as number }));
  }

  /** Rule R8: rank by placement support; deterministic seeded tie-breaking. */
  private best(cells: Coord[], weight: (c: Coord) => number): Coord | null {
    if (cells.length === 0) return null;
    let bestW = -Infinity;
    let ties: Coord[] = [];
    for (const c of cells) {
      const w = weight(c);
      if (w > bestW + 1e-9) {
        bestW = w;
        ties = [c];
      } else if (Math.abs(w - bestW) <= 1e-9) ties.push(c);
    }
    ties.sort((a, b) => a.y - b.y || a.x - b.x);
    return ties[Math.floor(this.rng() * ties.length)];
  }

  private chooseTarget(model: PlacementModel | null, reasoning: string[]): Coord | null {
    const kb = this.kb;
    const w = (c: Coord) => model?.targetWeight.get(key(c.x, c.y)) ?? 0;

    const known = this.cells('KnownShipTarget');
    if (known.length) {
      reasoning.push(`R9: radar confirmed ${known.length} untested ship cell(s)`);
      return this.best(known, w);
    }
    if (this.difficulty !== 'basic') {
      const line = this.cells('LineCandidate').filter((c) => !model || w(c) > 0);
      if (line.length) {
        reasoning.push(`R7: ship orientation known — extending line (${line.length} option(s))`);
        return this.best(line, w);
      }
    }
    const cand = this.cells('Candidate').filter((c) => !model || w(c) > 0);
    if (cand.length) {
      reasoning.push(`R3: ${cand.length} candidate cell(s) adjacent to open hits`);
      return this.difficulty === 'basic' ? this.best(cand, () => 0) : this.best(cand, w);
    }

    let untested = this.cells('Untested').filter((c) => !kb.holds('NotShipAt', c.x, c.y));
    if (untested.length === 0) untested = this.cells('Untested');
    if (this.difficulty === 'basic') {
      reasoning.push('Hunt mode: random untested cell not known to be empty');
      return this.best(untested, () => 0);
    }
    const possible = untested.filter((c) => !kb.holds('Impossible', c.x, c.y));
    let pool = possible.length ? possible : untested;
    if (this.difficulty === 'strategic') {
      const parity = pool.filter((c) => (c.x + c.y) % 2 === 0);
      if (parity.length) pool = parity;
      reasoning.push('Hunt mode: checkerboard parity ranked by placement density');
    } else {
      reasoning.push('Hunt mode: maximum placement density');
    }
    return this.best(pool, w);
  }

  private chooseAbility(view: BattleView, model: PlacementModel, balance: number, reasoning: string[]): BattleAction | null {
    const costs = view.rules.abilityCosts;
    const turn = view.turn!;
    if (turn.manualLocked && !view.rules.allowAbilitiesAfterMiss) return null;
    if (turn.abilitiesUsed > 0 && !view.rules.allowMultipleAbilitiesPerTurn) return null;
    const p = (x: number, y: number) => (this.kb.holds('Untested', x, y) ? model.probability.get(key(x, y)) ?? 0 : 0);
    const size = this.size;
    const hunting = this.kb.count('OpenHit') === 0 && this.kb.count('KnownShipTarget') === 0;

    if (this.difficulty === 'advanced') {
      if (balance >= costs.airstrike) {
        let best = { score: 0, axis: 'row' as 'row' | 'col', index: 0 };
        for (let i = 0; i < size; i++) {
          let row = 0;
          let col = 0;
          for (let j = 0; j < size; j++) {
            row += p(j, i);
            col += p(i, j);
          }
          if (row > best.score) best = { score: row, axis: 'row', index: i };
          if (col > best.score) best = { score: col, axis: 'col', index: i };
        }
        if (best.score >= 1.8) {
          reasoning.push(`Airstrike ${best.axis} ${best.index}: expected ${best.score.toFixed(2)} ship cells`);
          return { type: 'airstrike', actionId: this.nextId('air'), playerId: this.playerId, axis: best.axis, index: best.index };
        }
      }
      if (balance >= costs.nuke) {
        let best = { score: 0, x: 0, y: 0 };
        for (let y = 0; y + 1 < size; y++) {
          for (let x = 0; x + 1 < size; x++) {
            const sc = p(x, y) + p(x + 1, y) + p(x, y + 1) + p(x + 1, y + 1);
            if (sc > best.score) best = { score: sc, x, y };
          }
        }
        if (best.score >= 1.2) {
          reasoning.push(`Nuke at (${best.x},${best.y}): expected ${best.score.toFixed(2)} ship cells`);
          return { type: 'nuke', actionId: this.nextId('nuke'), playerId: this.playerId, x: best.x, y: best.y };
        }
      }
    }
    if (hunting && balance >= costs.radar && turn.abilitiesUsed === 0) {
      let best = { score: 0, x: 0, y: 0 };
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          let sc = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (this.kb.holds('RadarEvidence', x + dx, y + dy, 'ship') || this.kb.holds('RadarEvidence', x + dx, y + dy, 'empty')) continue;
              sc += p(x + dx, y + dy);
            }
          }
          if (sc > best.score) best = { score: sc, x, y };
        }
      }
      if (best.score >= 0.6) {
        reasoning.push(`Radar centred on (${best.x},${best.y}) to gather evidence (expected ${best.score.toFixed(2)})`);
        return { type: 'radar', actionId: this.nextId('radar'), playerId: this.playerId, x: best.x, y: best.y };
      }
    }
    return null;
  }
}
