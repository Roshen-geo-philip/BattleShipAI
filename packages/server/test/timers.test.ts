import { afterEach, describe, expect, it } from 'vitest';
import { createRng, randomFleet } from '@battleship/engine';
import { RoomManager } from '../src/rooms';

let rooms: RoomManager | null = null;
afterEach(() => rooms?.dispose());

describe('turn timer', () => {
  it('passes the turn with a server timeout even though a legal shot remains', async () => {
    rooms = new RoomManager({ rules: { setupSeconds: 0, turnSeconds: 1, reconnectGraceSeconds: 5 } });
    const { room, player: a } = rooms.createRoom({ mode: 'online1v1', name: 'A' });
    const { player: b } = rooms.joinRoom(room.code, 'B');
    rooms.startMatch(room, a.id);
    const battleId = room.match!.schedule[0].id;
    let n = 0;
    for (const p of [a, b]) {
      const st = room.match!.battles[battleId];
      rooms.action(room, p.id, { type: 'placeShips', actionId: `p${++n}`, placements: randomFleet(st.size, st.templateIds, createRng(n))! });
      rooms.action(room, p.id, { type: 'ready', actionId: `r${++n}` });
    }
    const first = room.match!.battles[battleId].turn!.playerId;
    // The player has not fired, so End Turn is refused…
    expect(() => rooms!.action(room, first, { type: 'endTurn', actionId: 'early' })).toThrow(/keep firing/);
    // …but the 1 s turn timer still moves play on.
    await new Promise((r) => setTimeout(r, 1300));
    const battle = room.match!.battles[battleId];
    expect(battle.turn).toMatchObject({ number: 2 });
    expect(battle.turn!.playerId).not.toBe(first);
    expect(battle.log.at(-1)).toMatchObject({ kind: 'turn-ended', playerId: first, timedOut: true });
  });
});
