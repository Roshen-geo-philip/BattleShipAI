import { describe, expect, it } from 'vitest';
import { applyAction, createBattle } from '../src/battle';
import type { BattleState } from '../src/types';
import { activeBattle, act, FLEET, id, must, placeAndReady, TEMPLATES } from './helpers';

const bal = (s: BattleState, p: string) => s.players[p].balance;
const score = (s: BattleState, p: string) => s.players[p].score;

describe('scoring', () => {
  it('every player begins with exactly 2 points', () => {
    const s = createBattle({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], seed: 5 });
    expect(bal(s, 'a')).toBe(2);
    expect(bal(s, 'b')).toBe(2);
  });

  it('a manual hit awards 1 point and keeps the turn active (example manual_hit)', () => {
    const { s, attacker } = activeBattle();
    const r = act(s, { type: 'attack', playerId: attacker, x: 0, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bal(r.state, attacker)).toBe(3);
    expect(r.state.turn!.playerId).toBe(attacker);
    expect(r.state.turn!.manualLocked).toBe(false);
    // may attack another untested cell
    expect(act(r.state, { type: 'attack', playerId: attacker, x: 0, y: 2 }).ok).toBe(true);
  });

  it('a manual miss awards 1 point, locks manual attacks but not the turn (example manual_miss)', () => {
    const { s, attacker } = activeBattle();
    const s1 = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 0, y: 0 }); // hit → 3
    const r = act(s1, { type: 'attack', playerId: attacker, x: 10, y: 10 }); // miss → 4
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bal(r.state, attacker)).toBe(4);
    expect(r.state.boards[r.state.playerOrder.find((p) => p !== attacker)!].shots['10,10'].result).toBe('miss');
    expect(r.state.turn!.manualLocked).toBe(true);
    expect(r.state.turn!.playerId).toBe(attacker); // miss does not advance the turn
    const again = act(r.state, { type: 'attack', playerId: attacker, x: 11, y: 11 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('MANUAL_LOCKED');
    // an otherwise legal ability is still allowed (radar costs 3, balance 4)
    expect(act(r.state, { type: 'radar', playerId: attacker, x: 7, y: 7 }).ok).toBe(true);
  });

  it('sinking a ship by manual attack awards 4 total to attacker and 2 to the owner (example ship_sunk)', () => {
    const { s, attacker, defender } = activeBattle();
    const s1 = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 0, y: 0 });
    const before = bal(s1, attacker);
    const r = act(s1, { type: 'attack', playerId: attacker, x: 1, y: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bal(r.state, attacker) - before).toBe(4);
    expect(bal(r.state, defender)).toBe(4);
    expect(r.state.boards[defender].ships.find((sh) => sh.templateId === 'patrol')!.sunk).toBe(true);
    expect(r.events.some((e) => e.kind === 'attack' && e.sunk.length === 1)).toBe(true);
  });

  it('cannot attack the same cell twice', () => {
    const { s, attacker } = activeBattle();
    const s1 = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 0, y: 0 });
    const r = act(s1, { type: 'attack', playerId: attacker, x: 0, y: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ALREADY_ATTACKED');
  });

  it('rejects out-of-bounds and non-integer coordinates', () => {
    const { s, attacker } = activeBattle();
    for (const [x, y] of [[-1, 0], [15, 0], [0.5, 1], [Number.NaN, 2]]) {
      const r = act(s, { type: 'attack', playerId: attacker, x, y });
      expect(r.ok).toBe(false);
    }
  });

  it('players cannot overspend', () => {
    const { s, attacker } = activeBattle();
    for (const a of [
      { type: 'airstrike', axis: 'row', index: 0 },
      { type: 'nuke', x: 0, y: 0 },
      { type: 'radar', x: 3, y: 3 },
    ] as const) {
      const r = act(s, { ...a, playerId: attacker } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INSUFFICIENT_POINTS');
    }
    expect(bal(s, attacker)).toBe(2);
  });

  it('records every point change in an event-level ledger that reconciles with balances', () => {
    const { s, attacker, defender } = activeBattle();
    let st = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 0, y: 0 });
    st = must(st, { type: 'attack', actionId: id(), playerId: attacker, x: 1, y: 0 });
    for (const p of [attacker, defender]) {
      const sum = st.transactions.filter((t) => t.playerId === p).reduce((a, t) => a + t.amount, 0);
      expect(sum).toBe(bal(st, p));
    }
  });
});

describe('abilities', () => {
  function rich(points = 20) {
    const b = activeBattle();
    b.s.players[b.attacker].balance = points;
    return b;
  }

  it('airstrike costs 6, hits a whole row and awards no manual-attack points', () => {
    const { s, attacker, defender } = rich(10);
    const r = act(s, { type: 'airstrike', playerId: attacker, axis: 'row', index: 9 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const board = r.state.boards[defender];
    expect(Object.values(board.shots).filter((sh) => sh.y === 9)).toHaveLength(15);
    // carrier on row 9 is fully destroyed → sink bonus +3 (configurable), no manual points
    expect(bal(r.state, attacker)).toBe(10 - 6 + 3);
    expect(bal(r.state, defender)).toBe(2 + 2);
    expect(r.state.transactions.some((t) => t.reason === 'manual-attack')).toBe(false);
    expect(r.state.turn!.manualLocked).toBe(false); // ability misses never lock manual attacks
  });

  it('airstrike along a column works', () => {
    const { s, attacker, defender } = rich(6);
    const r = act(s, { type: 'airstrike', playerId: attacker, axis: 'col', index: 14 });
    expect(r.ok && Object.keys(r.state.boards[defender].shots).length).toBe(15);
  });

  it('ability sinking bonus can be disabled through configuration', () => {
    const b = activeBattle({ abilitiesAwardSinkBonus: false });
    b.s.players[b.attacker].balance = 6;
    const r = act(b.s, { type: 'airstrike', playerId: b.attacker, axis: 'row', index: 0 });
    expect(r.ok && bal(r.state, b.attacker)).toBe(0);
  });

  it('nuke costs 5, resolves a 2x2 area and does not reward previously attacked cells (example nuke)', () => {
    const { s, attacker, defender } = rich(7);
    const s1 = must(s, { type: 'attack', actionId: id(), playerId: attacker, x: 0, y: 4 }); // corvette hit, +1 → 8
    const r = act(s1, { type: 'nuke', playerId: attacker, x: 0, y: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = r.events.find((e) => e.kind === 'attack');
    expect(ev && ev.kind === 'attack' && ev.cells.map((c) => c.result)).toEqual(['skipped', 'hit', 'hit', 'miss']);
    // corvette (0,4),(1,4),(0,5) sunk → +3 bonus
    expect(bal(r.state, attacker)).toBe(8 - 5 + 3);
    expect(r.state.boards[defender].ships.find((sh) => sh.templateId === 'corvette')!.sunk).toBe(true);
  });

  it('nuke must fit fully on the board', () => {
    const { s, attacker } = rich(10);
    const r = act(s, { type: 'nuke', playerId: attacker, x: 14, y: 3 });
    expect(r.ok).toBe(false);
    expect(bal(s, attacker)).toBe(10);
  });

  it('radar costs 3, reveals only its clamped 3x3 window and deals no damage', () => {
    const { s, attacker, defender } = rich(3);
    const r = act(s, { type: 'radar', playerId: attacker, x: 0, y: 0 }); // corner → window shifted to (0,0)
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scan = r.state.players[attacker].radar[0];
    expect(scan.cells).toHaveLength(9);
    expect(scan.cells.every((c) => c.x <= 2 && c.y <= 2)).toBe(true);
    expect(scan.cells.filter((c) => c.ship).map((c) => `${c.x},${c.y}`).sort()).toEqual(['0,0', '0,2', '1,0', '1,2', '2,2']);
    expect(Object.keys(r.state.boards[defender].shots)).toHaveLength(0);
    expect(bal(r.state, attacker)).toBe(0);
    expect(score(r.state, attacker)).toBe(0);
  });

  it('cost is deducted exactly once even when the message is duplicated', () => {
    const { s, attacker } = rich(10);
    const action = { type: 'nuke', actionId: 'dup-1', playerId: attacker, x: 5, y: 5 } as const;
    const r1 = applyAction(s, action);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = applyAction(r1.state, action);
    expect(r2.ok && r2.duplicate).toBe(true);
    expect(r2.ok && bal(r2.state, attacker)).toBe(5);
  });
});

describe('mines', () => {
  it('placing a mine costs 2 and stays hidden; trigger transfers rewards exactly once (example mine)', () => {
    let s = createBattle({ players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], size: 15, templateIds: TEMPLATES, seed: 2 });
    s = must(s, { type: 'placeShips', actionId: id(), playerId: 'p1', placements: FLEET });
    s.players.p1.balance = 4;
    s = must(s, { type: 'placeMine', actionId: id(), playerId: 'p1', x: 10, y: 10 });
    expect(s.players.p1.balance).toBe(2);
    s = must(s, { type: 'ready', actionId: id(), playerId: 'p1' });
    s = placeAndReady(s, 'p2');
    if (s.turn!.playerId !== 'p2') s = must(s, { type: 'endTurn', actionId: id(), playerId: 'p1' });
    const p2Before = s.players.p2.balance;
    const r = act(s, { type: 'attack', playerId: 'p2', x: 10, y: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.players.p2.balance).toBe(p2Before - 1); // no manual-attack point
    expect(r.state.players.p1.balance).toBe(2 + 3);
    expect(r.state.turn!.manualLocked).toBe(true); // counts as a miss
    const mine = r.state.boards.p1.mines[0];
    expect(mine.active).toBe(false);
    expect(r.state.transactions.filter((t) => t.reason === 'mine-reward')).toHaveLength(1);
  });

  it('penalty never drives the attacker negative', () => {
    let s = createBattle({ players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], size: 15, templateIds: TEMPLATES, seed: 2 });
    s = must(s, { type: 'placeShips', actionId: id(), playerId: 'p1', placements: FLEET });
    s = must(s, { type: 'placeMine', actionId: id(), playerId: 'p1', x: 12, y: 12 });
    s = placeAndReady(must(s, { type: 'ready', actionId: id(), playerId: 'p1' }), 'p2');
    if (s.turn!.playerId !== 'p2') s = must(s, { type: 'endTurn', actionId: id(), playerId: 'p1' });
    s.players.p2.balance = 0;
    const r = act(s, { type: 'attack', playerId: 'p2', x: 12, y: 12 });
    expect(r.ok && r.state.players.p2.balance).toBe(0);
  });

  it('rejects mines on ship cells, duplicates, out of bounds and without funds', () => {
    let s = createBattle({ players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], size: 15, templateIds: TEMPLATES, seed: 2 });
    s = must(s, { type: 'placeShips', actionId: id(), playerId: 'p1', placements: FLEET });
    s.players.p1.balance = 10;
    expect(act(s, { type: 'placeMine', playerId: 'p1', x: 0, y: 0 }).ok).toBe(false);
    expect(act(s, { type: 'placeMine', playerId: 'p1', x: 20, y: 0 }).ok).toBe(false);
    s = must(s, { type: 'placeMine', actionId: id(), playerId: 'p1', x: 8, y: 8 });
    expect(act(s, { type: 'placeMine', playerId: 'p1', x: 8, y: 8 }).ok).toBe(false);
    s.players.p1.balance = 1;
    const r = act(s, { type: 'placeMine', playerId: 'p1', x: 9, y: 9 });
    expect(!r.ok && r.code).toBe('INSUFFICIENT_POINTS');
  });

  it('opponents never see unrevealed mines; airstrike defuses them without points', async () => {
    const { viewBattle } = await import('../src/views');
    const { s, attacker, defender } = activeBattle();
    s.boards[defender].mines.push({ id: 'm1', x: 14, y: 14, active: true, knownBy: [] });
    expect(viewBattle(s, attacker).boards[defender].mines).toHaveLength(0);
    expect(viewBattle(s, defender).boards[defender].mines).toHaveLength(1);
    s.players[attacker].balance = 6;
    const r = act(s, { type: 'airstrike', playerId: attacker, axis: 'row', index: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.boards[defender].mines[0]).toMatchObject({ active: false, outcome: 'defused' });
    expect(bal(r.state, defender)).toBe(2);
    expect(viewBattle(r.state, attacker).boards[defender].mines).toHaveLength(1);
  });

  it('radar reveals mines inside its window only', async () => {
    const { viewBattle } = await import('../src/views');
    const { s, attacker, defender } = activeBattle();
    s.boards[defender].mines.push({ id: 'm1', x: 12, y: 12, active: true, knownBy: [] });
    s.boards[defender].mines.push({ id: 'm2', x: 5, y: 12, active: true, knownBy: [] });
    s.players[attacker].balance = 3;
    const r = act(s, { type: 'radar', playerId: attacker, x: 12, y: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mines = viewBattle(r.state, attacker).boards[defender].mines;
    expect(mines).toEqual([{ x: 12, y: 12, active: true, outcome: undefined }]);
  });
});

describe('turns', () => {
  it('End Turn advances exactly once and the previous player cannot act', () => {
    const { s, attacker, defender } = activeBattle();
    const end = { type: 'endTurn', actionId: 'end-1', playerId: attacker } as const;
    const r1 = applyAction(s, end);
    expect(r1.ok && r1.state.turn!.playerId).toBe(defender);
    if (!r1.ok) return;
    const dup = applyAction(r1.state, end);
    expect(dup.ok && dup.duplicate && dup.state.turn!.playerId).toBe(defender);
    const other = act(r1.state, { type: 'endTurn', playerId: attacker });
    expect(!other.ok && other.code).toBe('NOT_YOUR_TURN');
    const atk = act(r1.state, { type: 'attack', playerId: attacker, x: 5, y: 5 });
    expect(!atk.ok && atk.code).toBe('NOT_YOUR_TURN');
  });

  it('match only starts once both players are ready, and placement is rejected afterwards', () => {
    let s = createBattle({ players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], size: 15, templateIds: TEMPLATES, seed: 2 });
    expect(act(s, { type: 'ready', playerId: 'p1' }).ok).toBe(false); // ships not placed
    s = placeAndReady(s, 'p1');
    expect(s.phase).toBe('setup');
    expect(act(s, { type: 'attack', playerId: 'p1', x: 0, y: 0 }).ok).toBe(false);
    s = placeAndReady(s, 'p2');
    expect(s.phase).toBe('active');
    const r = act(s, { type: 'placeShips', playerId: 'p1', placements: FLEET });
    expect(!r.ok && r.code).toBe('WRONG_PHASE');
  });

  it('first player is chosen randomly (both outcomes occur across seeds)', () => {
    const firsts = new Set<string>();
    for (let seed = 0; seed < 20; seed++) firsts.add(activeBattle({}, seed).attacker);
    expect(firsts.size).toBe(2);
  });

  it('victory is detected immediately after the winning action and its score updates', () => {
    const { s, attacker, defender } = activeBattle();
    let st = s;
    const cells = st.boards[defender].ships.flatMap((sh) => sh.cells);
    for (const c of cells) st = must(st, { type: 'attack', actionId: id(), playerId: attacker, x: c.x, y: c.y });
    expect(st.phase).toBe('finished');
    expect(st.winnerId).toBe(attacker);
    // one point per manual hit + 5 sinks × 3
    expect(st.players[attacker].balance).toBe(2 + cells.length + 5 * 3);
    expect(st.players[defender].balance).toBe(2 + 5 * 2);
    expect(act(st, { type: 'attack', playerId: attacker, x: 14, y: 14 }).ok).toBe(false);
  });

  it('failed actions leave state untouched (atomicity)', () => {
    const { s, attacker } = activeBattle();
    const snapshot = JSON.stringify(s);
    act(s, { type: 'nuke', playerId: attacker, x: 0, y: 0 });
    act(s, { type: 'attack', playerId: 'nobody', x: 0, y: 0 } as never);
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it('forfeit ends the battle in favour of the opponent', () => {
    const { s, attacker, defender } = activeBattle();
    const r = act(s, { type: 'forfeit', playerId: defender });
    expect(r.ok && r.state.winnerId).toBe(attacker);
  });
});
