import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { createRng, randomFleet, type MatchView } from '@battleship/engine';
import { startServer } from '../src/server';
import type { RoomView } from '../src/rooms';

let server: Awaited<ReturnType<typeof startServer>>;
let url = '';
const sockets: Socket[] = [];

beforeAll(async () => {
  server = await startServer({ port: 0, rules: { reconnectGraceSeconds: 1, setupSeconds: 0, turnSeconds: 0 } });
  url = `http://localhost:${server.port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await server.close();
});

interface Client {
  socket: Socket;
  last: () => RoomView | null;
  next: (pred?: (v: RoomView) => boolean) => Promise<RoomView>;
  emit: (ev: string, payload?: unknown) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
  raw: string[];
}

function client(): Promise<Client> {
  const socket = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  let latest: RoomView | null = null;
  const raw: string[] = [];
  const waiters: { pred: (v: RoomView) => boolean; resolve: (v: RoomView) => void }[] = [];
  socket.on('room:state', (v: RoomView) => {
    latest = v;
    raw.push(JSON.stringify(v));
    for (const w of [...waiters]) {
      if (w.pred(v)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(v);
      }
    }
  });
  return new Promise((resolve) =>
    socket.on('connect', () =>
      resolve({
        socket,
        raw,
        last: () => latest,
        next: (pred = () => true) =>
          new Promise((r, rej) => {
            if (latest && pred(latest)) return r(latest);
            const t = setTimeout(() => rej(new Error('timeout waiting for state')), 5000);
            waiters.push({ pred, resolve: (v) => (clearTimeout(t), r(v)) });
          }),
        emit: (ev, payload = {}) => new Promise((r) => socket.emit(ev, payload, r)),
      }),
    ),
  );
}

let actionSeq = 0;
const aid = () => `c${++actionSeq}`;

async function placeAndReady(c: Client, battle: MatchView['battles'][string]) {
  const fleet = randomFleet(battle.size, battle.templateIds, createRng(++actionSeq))!;
  expect((await c.emit('game:action', { action: { type: 'placeShips', actionId: aid(), placements: fleet } })).ok).toBe(true);
  expect((await c.emit('game:action', { action: { type: 'ready', actionId: aid() } })).ok).toBe(true);
}

describe('rooms', () => {
  it('valid players can join; invalid codes are rejected; capacity is enforced', async () => {
    const host = await client();
    const created = await host.emit('room:create', { mode: 'online1v1', name: 'Host' });
    expect(created.ok).toBe(true);
    const code = created.code as string;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const bad = await (await client()).emit('room:join', { code: 'ZZZZZZ', name: 'x' });
    expect(bad).toEqual({ ok: false, error: 'Room not found' });

    const guest = await client();
    expect((await guest.emit('room:join', { code: code.toLowerCase(), name: 'Guest' })).ok).toBe(true);
    const third = await (await client()).emit('room:join', { code, name: 'Extra' });
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/full/);

    const v = await host.next((s) => s.players.length === 2);
    expect(v.players.map((p) => p.team).sort()).toEqual(['A', 'B']);
    // Tokens are secret and never broadcast
    expect(host.raw.join('')).not.toContain(created.token as string);
  });

  it('only the host can start, and only when teams are complete', async () => {
    const host = await client();
    const { code } = await host.emit('room:create', { mode: 'online2v2', name: 'H' });
    const p2 = await client();
    await p2.emit('room:join', { code, name: 'P2' });
    expect((await host.emit('lobby:start')).error).toMatch(/Need 4/);
    const p3 = await client();
    const p4 = await client();
    await p3.emit('room:join', { code, name: 'P3' });
    await p4.emit('room:join', { code, name: 'P4' });
    expect((await p2.emit('lobby:start')).error).toMatch(/host/);
    const v = await host.next((s) => s.players.length === 4);
    expect(v.players.filter((p) => p.team === 'A')).toHaveLength(2);
    // host can move a player; team capacity enforced
    const bPlayer = v.players.find((p) => p.team === 'B')!;
    expect((await host.emit('lobby:setTeam', { playerId: bPlayer.id, team: 'A' })).error).toMatch(/full/);
    expect((await p2.emit('lobby:setTeam', { playerId: v.you.id, team: 'B' })).error).toMatch(/host/);
    expect((await host.emit('lobby:start')).ok).toBe(true);
    const started = await p3.next((s) => s.status === 'playing');
    expect(started.match!.schedule).toHaveLength(4);
    // joining an active match is not allowed
    expect((await (await client()).emit('room:join', { code, name: 'Late' })).error).toMatch(/in progress/);
  });
});

describe('online 1v1 match', () => {
  it('synchronises public state, keeps ships private, and ignores duplicate messages', async () => {
    const a = await client();
    const b = await client();
    const { code } = await a.emit('room:create', { mode: 'online1v1', name: 'A' });
    await b.emit('room:join', { code, name: 'B' });
    await a.next((s) => s.players.length === 2);
    await a.emit('lobby:start');
    const va = await a.next((s) => s.status === 'playing');
    const battleId = va.match!.myBattleId!;
    await placeAndReady(a, va.match!.battles[battleId]);
    await placeAndReady(b, va.match!.battles[battleId]);
    const active = await a.next((s) => s.match?.battles[battleId].phase === 'active');
    const battle = active.match!.battles[battleId];
    const aId = active.you.id;
    const bId = battle.playerOrder.find((p) => p !== aId)!;

    // Privacy: the opponent's ships never appear in any message A received.
    const bShips = server.rooms.getRoom(code).match!.battles[battleId].boards[bId].ships;
    const allA = a.raw.join('\n');
    for (const ship of bShips) expect(allA).not.toContain(ship.id);
    expect(battle.boards[bId].ships).toHaveLength(0);
    expect(battle.boards[aId].ships.length).toBeGreaterThan(0);

    // Whoever's turn it is attacks one of the opponent's real cells.
    const turnPlayer = battle.turn!.playerId;
    const attacker = turnPlayer === aId ? a : b;
    const defenderId = turnPlayer === aId ? bId : aId;
    const target = server.rooms.getRoom(code).match!.battles[battleId].boards[defenderId].ships[0].cells[0];
    const action = { type: 'attack', actionId: 'same-msg', x: target.x, y: target.y };
    const r1 = await attacker.emit('game:action', { action });
    const r2 = await attacker.emit('game:action', { action });
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: true, duplicate: true });
    const st = server.rooms.getRoom(code).match!.battles[battleId];
    expect(st.players[turnPlayer].balance).toBe(3); // exactly one reward

    // Client cannot spoof identity or the opponent's turn
    const other = attacker === a ? b : a;
    const spoof = await other.emit('game:action', { action: { type: 'endTurn', actionId: aid(), playerId: turnPlayer } });
    expect(spoof.ok).toBe(false);
    // Client cannot forfeit for others or claim results
    expect((await other.emit('game:action', { action: { type: 'forfeit', actionId: aid() } })).ok).toBe(false);

    // End turn exactly once
    const end = { type: 'endTurn', actionId: 'end-once' };
    await attacker.emit('game:action', { action: end });
    await attacker.emit('game:action', { action: end });
    expect(server.rooms.getRoom(code).match!.battles[battleId].turn).toMatchObject({ playerId: defenderId, number: 2 });
  });

  it('disconnection pauses, reconnection with token restores state, and grace expiry forfeits', async () => {
    const a = await client();
    const b = await client();
    const created = await a.emit('room:create', { mode: 'online1v1', name: 'A' });
    const code = created.code as string;
    const joined = await b.emit('room:join', { code, name: 'B' });
    await a.next((s) => s.players.length === 2);
    await a.emit('lobby:start');
    const v = await a.next((s) => s.status === 'playing');
    const battleId = v.match!.myBattleId!;
    await placeAndReady(a, v.match!.battles[battleId]);

    // B drops and comes back on a new socket with its token
    b.socket.close();
    await a.next((s) => s.players.some((p) => !p.connected));
    const b2 = await client();
    const re = await b2.emit('room:rejoin', { code, token: joined.token });
    expect(re.ok).toBe(true);
    expect(re.playerId).toBe(joined.playerId);
    const bv = await b2.next((s) => s.status === 'playing');
    expect(bv.match!.myBattleId).toBe(battleId);
    expect((await b2.emit('room:rejoin', { code, token: 'wrong' })).ok).toBe(false);

    // Now B drops for longer than the 1s grace → forfeits; A wins
    b2.socket.close();
    const finished = await a.next((s) => s.status === 'finished');
    expect(finished.match!.battles[battleId].winnerId).toBe(created.playerId);
    expect(finished.match!.battles[battleId].endReason).toBe('forfeit');
  });
});
