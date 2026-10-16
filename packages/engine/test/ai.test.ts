import { describe, expect, it } from 'vitest';
import { BattleshipAI, type Difficulty } from '../src/ai/agent';
import { createBattleshipKB, BASE_RULES, STRATEGIC_RULES } from '../src/ai/knowledge';
import { KnowledgeBase, atom, neg, pos } from '../src/ai/logic';
import { applyAction, createBattle } from '../src/battle';
import { randomFleet } from '../src/board';
import { createRng } from '../src/rng';
import type { BattleState } from '../src/types';
import { viewBattle } from '../src/views';
import { activeBattle, id, must, TEMPLATES } from './helpers';

describe('logic engine', () => {
  it('performs stratified forward chaining with negation-as-failure', () => {
    const kb = new KnowledgeBase();
    kb.assert('Parent', 'a', 'b');
    kb.assert('Parent', 'b', 'c');
    kb.assert('Dead', 'c');
    kb.forwardChain([
      { name: 'G', stratum: 1, text: '', body: [pos('Parent', '?x', '?y'), pos('Parent', '?y', '?z')], head: atom('Grand', '?x', '?z') },
      { name: 'A', stratum: 2, text: '', body: [pos('Grand', '?x', '?z'), neg('Dead', '?x')], head: atom('LivingGrand', '?x') },
    ]);
    expect(kb.holds('Grand', 'a', 'c')).toBe(true);
    expect(kb.holds('LivingGrand', 'a')).toBe(true);
  });
});

describe('FOPC rules', () => {
  it('Hit(3,4) yields ShipAt and adjacent untested candidates; misses are excluded (example ai_reasoning)', () => {
    const kb = createBattleshipKB(15);
    kb.assert('Hit', 3, 4);
    kb.assert('Miss', 3, 3);
    kb.forwardChain(BASE_RULES);
    expect(kb.holds('ShipAt', 3, 4)).toBe(true);
    expect(kb.holds('NotShipAt', 3, 3)).toBe(true);
    const cands = kb.all('Candidate').map((a) => a.join(',')).sort();
    expect(cands).toEqual(['2,4', '3,5', '4,4']);
  });

  it('R7 prefers extensions of a known line', () => {
    const kb = createBattleshipKB(15);
    kb.assert('Hit', 5, 5);
    kb.assert('Hit', 6, 5);
    kb.forwardChain(STRATEGIC_RULES);
    expect(kb.all('LineCandidate').map((a) => a.join(',')).sort()).toEqual(['4,5', '7,5']);
  });

  it('sunk ships resolve their hits so they no longer generate candidates', () => {
    const kb = createBattleshipKB(15);
    kb.assert('Hit', 0, 0);
    kb.assert('Hit', 1, 0);
    kb.assert('SunkCell', 'patrol', 0, 0);
    kb.assert('SunkCell', 'patrol', 1, 0);
    kb.forwardChain(BASE_RULES);
    expect(kb.count('Candidate')).toBe(0);
  });
});

function playTurnWithAI(state: BattleState, ai: BattleshipAI, maxActions = 400): BattleState {
  let s = state;
  for (let i = 0; i < maxActions && s.phase === 'active' && s.turn!.playerId === ai.playerId; i++) {
    const d = ai.decide(viewBattle(s, ai.playerId))!;
    const r = applyAction(s, d.action);
    if (!r.ok) throw new Error(`AI made illegal move ${d.action.type}: ${r.error}`);
    s = r.state;
    if (d.action.type === 'endTurn') break;
  }
  return s;
}

describe('AI agent', () => {
  it('filters placements that contradict misses and sunk ships', () => {
    const { s, attacker } = activeBattle();
    let st = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 7, y: 7 }); // miss
    const ai = new BattleshipAI(attacker, 15, 'advanced', 1);
    ai.observe(viewBattle(st, attacker));
    ai.infer();
    const model = ai.modelPlacements();
    for (const list of model.byShip.values()) {
      for (const p of list) {
        expect(p).toBeDefined();
      }
    }
    // no remaining placement covers the missed cell
    expect(model.targetWeight.has('7,7')).toBe(false);
    expect(ai.kb.holds('Miss', 7, 7)).toBe(true);
    st = must(st, { type: 'endTurn', actionId: id(), playerId: attacker });
  });

  it('never inspects hidden ships: identical observations on different fleets give identical decisions', () => {
    const decisions: string[] = [];
    for (const fleetSeed of [11, 22, 33]) {
      let s = createBattle({ players: [{ id: 'ai', name: 'AI' }, { id: 'h', name: 'H' }], size: 15, templateIds: TEMPLATES, seed: 4 });
      const fleet = randomFleet(15, TEMPLATES, createRng(fleetSeed))!;
      s = must(s, { type: 'placeShips', actionId: id(), playerId: 'h', placements: fleet });
      s = must(s, { type: 'placeShips', actionId: id(), playerId: 'ai', placements: randomFleet(15, TEMPLATES, createRng(1))! });
      s = must(s, { type: 'ready', actionId: id(), playerId: 'h' });
      s = must(s, { type: 'ready', actionId: id(), playerId: 'ai' });
      if (s.turn!.playerId !== 'ai') s = must(s, { type: 'endTurn', actionId: id(), playerId: 'h' });
      const ai = new BattleshipAI('ai', 15, 'advanced', 99);
      const view = viewBattle(s, 'ai');
      expect(view.boards.h.ships).toHaveLength(0);
      expect(JSON.stringify(view.boards.h)).not.toContain(fleet[0].templateId + '"');
      const d = ai.decide(view)!;
      decisions.push(JSON.stringify({ ...d.action, actionId: undefined }));
    }
    expect(new Set(decisions).size).toBe(1);
  });

  it('refuses a revealed opponent board', () => {
    const { s, attacker, defender } = activeBattle();
    const ai = new BattleshipAI(attacker, 15, 'basic', 1);
    expect(() => ai.observe(viewBattle(s, attacker, [attacker, defender]))).toThrow();
  });

  for (const difficulty of ['basic', 'strategic', 'advanced'] as Difficulty[]) {
    it(`${difficulty} AI plays a full game legally, never repeating a cell and obeying costs`, () => {
      let s = createBattle({ players: [{ id: 'ai1', name: 'AI 1' }, { id: 'ai2', name: 'AI 2' }], size: 15, seed: 7 });
      const a1 = new BattleshipAI('ai1', 15, difficulty, 3);
      const a2 = new BattleshipAI('ai2', 15, 'basic', 4);
      for (const ai of [a1, a2]) for (const a of ai.planSetup(viewBattle(s, ai.playerId))) s = must(s, a);
      expect(s.phase).toBe('active');
      let turns = 0;
      while (s.phase === 'active' && turns < 600) {
        const ai = s.turn!.playerId === 'ai1' ? a1 : a2;
        const shotsBefore = Object.keys(s.boards[ai.playerId === 'ai1' ? 'ai2' : 'ai1'].shots).length;
        s = playTurnWithAI(s, ai);
        // every turn must make progress or end; no negative balances ever
        for (const p of Object.values(s.players)) expect(p.balance).toBeGreaterThanOrEqual(0);
        expect(Object.keys(s.boards[ai.playerId === 'ai1' ? 'ai2' : 'ai1'].shots).length).toBeGreaterThanOrEqual(shotsBefore);
        turns++;
      }
      expect(s.phase).toBe('finished');
      // manual repeats are impossible: the engine would have rejected them and the helper would throw
    });
  }

  it('strategic AI beats basic AI on average (inference strength matters)', () => {
    const shotsToWin = (difficulty: Difficulty, seed: number) => {
      let s = createBattle({ players: [{ id: 'ai', name: 'AI' }, { id: 'dummy', name: 'D' }], size: 15, seed });
      const ai = new BattleshipAI('ai', 15, difficulty, seed);
      const dummyFleet = randomFleet(15, s.templateIds, createRng(seed + 1))!;
      for (const a of ai.planSetup(viewBattle(s, 'ai'))) s = must(s, a);
      s = must(s, { type: 'placeShips', actionId: id(), playerId: 'dummy', placements: dummyFleet });
      s = must(s, { type: 'ready', actionId: id(), playerId: 'dummy' });
      let manual = 0;
      while (s.phase === 'active') {
        if (s.turn!.playerId === 'dummy') {
          s = must(s, { type: 'endTurn', actionId: id(), playerId: 'dummy' });
          continue;
        }
        const d = ai.decide(viewBattle(s, 'ai'))!;
        if (d.action.type === 'attack') manual++;
        s = must(s, d.action);
      }
      return manual;
    };
    let basic = 0;
    let strategic = 0;
    for (let seed = 1; seed <= 6; seed++) {
      basic += shotsToWin('basic', seed);
      strategic += shotsToWin('strategic', seed);
    }
    expect(strategic).toBeLessThan(basic);
  });

  it('makes a legal decision when no adjacent candidates remain', () => {
    const { s, attacker, defender } = activeBattle();
    // surround a hit with tested cells so R3 yields nothing
    let st = s;
    for (const [x, y] of [[13, 13], [12, 14], [14, 14]]) st.boards[defender].shots[`${x},${y}`] = { x, y, result: 'miss', source: 'manual', turn: 1 };
    st.boards[defender].shots['13,14'] = { x: 13, y: 14, result: 'miss', source: 'manual', turn: 1 };
    const ai = new BattleshipAI(attacker, 15, 'strategic', 1);
    const d = ai.decide(viewBattle(st, attacker))!;
    const r = applyAction(st, d.action);
    expect(r.ok).toBe(true);
  });

  it('AI ends the turn after a miss when it cannot afford abilities', () => {
    const { s, attacker } = activeBattle();
    const st = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 14, y: 0 }); // miss
    st.players[attacker].balance = 0;
    const ai = new BattleshipAI(attacker, 15, 'advanced', 1);
    expect(ai.decide(viewBattle(st, attacker))!.action.type).toBe('endTurn');
  });
});
