import { describe, expect, it } from 'vitest';
import { randomFleet } from '../src/board';
import {
  applyMatchAction,
  assignSlots,
  createMatch,
  teamScores,
  validateSchedule,
  viewMatch,
  type LobbyPlayer,
  type MatchState,
} from '../src/match/match';
import { createRng } from '../src/rng';

const lobby = (n: number, prefs: (number | null)[] = []): LobbyPlayer[] =>
  Array.from({ length: n * 2 }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    team: i < n ? 'A' : 'B',
    preferredSlot: prefs[i] ?? null,
  }));

let k = 0;
function setupAll(m: MatchState) {
  for (const sb of m.schedule.filter((b) => b.round === m.round)) {
    for (const pid of [sb.playerA, sb.playerB]) {
      const b = m.battles[sb.id];
      const fleet = randomFleet(b.size, b.templateIds, createRng(++k))!;
      expect(applyMatchAction(m, { type: 'placeShips', actionId: `x${++k}`, playerId: pid, placements: fleet }).ok).toBe(true);
      expect(applyMatchAction(m, { type: 'ready', actionId: `x${++k}`, playerId: pid }).ok).toBe(true);
    }
  }
}

/** Current player of each battle sinks everything by brute-force manual attacks. */
function finishRound(m: MatchState) {
  for (const sb of m.schedule.filter((b) => b.round === m.round)) {
    const b = m.battles[sb.id];
    const attacker = b.turn!.playerId;
    const def = b.playerOrder.find((p) => p !== attacker)!;
    for (const ship of b.boards[def].ships) {
      for (const c of ship.cells) {
        const r = applyMatchAction(m, { type: 'attack', actionId: `x${++k}`, playerId: attacker, x: c.x, y: c.y });
        expect(r.ok).toBe(true);
      }
    }
  }
}

describe('team slots and schedules', () => {
  it('honours unique preferences and resolves clashes into a permutation', () => {
    const players = lobby(5, [1, 1, 3, null, 5]).slice(0, 5);
    const slots = assignSlots(players, 5, createRng(1));
    expect([...slots.values()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(slots.get('p2')).toBe(3);
    expect(slots.get('p4')).toBe(5);
    expect([slots.get('p0'), slots.get('p1')]).toContain(1);
  });

  it('2v2 schedule is a round robin of two rounds with no double booking', () => {
    const m = createMatch({ id: 'm', mode: 'online2v2', players: lobby(2), seed: 3 });
    expect(m.schedule).toHaveLength(4);
    expect(m.rounds).toBe(2);
    expect(validateSchedule(m.schedule, m.players)).toBeNull();
    const pairs = new Set(m.schedule.map((b) => [b.playerA, b.playerB].sort().join('-')));
    expect(pairs.size).toBe(4);
  });

  it('5v5 pairs equal slots, shuffles order and every round is valid', () => {
    for (let seed = 0; seed < 20; seed++) {
      const m = createMatch({ id: 'm', mode: 'online5v5', players: lobby(5, [1, 2, 3, 4, 5, 5, 4, 3, 2, 1]), seed });
      expect(m.schedule).toHaveLength(5);
      expect(validateSchedule(m.schedule, m.players)).toBeNull();
      for (const b of m.schedule) {
        const a = m.players.find((p) => p.id === b.playerA)!;
        const bb = m.players.find((p) => p.id === b.playerB)!;
        expect(a.slot).toBe(bb.slot);
      }
    }
  });
});

describe('team match flow', () => {
  it('2v2 runs all rounds, team score = sum of individual earned scores applied once', () => {
    const m = createMatch({ id: 'm', mode: 'online2v2', players: lobby(2), seed: 9 });
    setupAll(m);
    finishRound(m);
    expect(m.round).toBe(2); // individual battle end does not end the team match
    expect(m.phase).toBe('in-round');
    setupAll(m);
    finishRound(m);
    expect(m.phase).toBe('finished');
    const scores = teamScores(m);
    const manual = Object.values(m.battles).reduce((s, b) => s + b.players[b.playerOrder[0]].score + b.players[b.playerOrder[1]].score, 0);
    expect(scores.A + scores.B).toBe(manual);
    expect(m.result).not.toBeNull();
    expect(['A', 'B', null]).toContain(m.result!.winner);
  });

  it('rejects actions from players without an active battle and duplicate messages', () => {
    const m = createMatch({ id: 'm', mode: 'online5v5', players: lobby(5), seed: 1 });
    const idle = m.players.find((p) => !m.schedule.some((b) => b.round === 1 && (b.playerA === p.id || b.playerB === p.id)))!;
    expect(applyMatchAction(m, { type: 'ready', actionId: 'q', playerId: idle.id }).ok).toBe(false);
    setupAll(m);
    const sb = m.schedule.find((b) => b.round === 1)!;
    const b = m.battles[sb.id];
    const att = b.turn!.playerId;
    const act = { type: 'attack', actionId: 'same', playerId: att, x: 0, y: 0 } as const;
    applyMatchAction(m, act);
    const before = JSON.stringify(m.battles[sb.id].players);
    const again = applyMatchAction(m, act);
    expect(again.ok && again.duplicate).toBe(true);
    expect(JSON.stringify(m.battles[sb.id].players)).toBe(before);
  });

  it('views reveal teammates boards but never opponent ships', () => {
    const m = createMatch({ id: 'm', mode: 'online2v2', players: lobby(2), seed: 2 });
    setupAll(m);
    const v = viewMatch(m, 'p0'); // team A
    for (const b of Object.values(v.battles)) {
      for (const [owner, board] of Object.entries(b.boards)) {
        const team = m.players.find((p) => p.id === owner)!.team;
        expect(board.revealed).toBe(team === 'A');
        if (team === 'B') expect(board.ships).toHaveLength(0);
      }
    }
  });
});
