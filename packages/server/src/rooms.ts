import { randomBytes, randomInt } from 'node:crypto';
import {
  BOARD_CONFIGS,
  MODE_INFO,
  applyMatchAction,
  createMatch,
  createRng,
  makeRules,
  randomFleet,
  viewMatch,
  type BattleAction,
  type MatchMode,
  type MatchState,
  type MatchView,
  type RulesConfig,
  type TeamId,
} from '@battleship/engine';

export interface RoomPlayer {
  id: string;
  name: string;
  /** Secret reconnection token; never broadcast to other players. */
  token: string;
  team: TeamId;
  preferredSlot: number | null;
  connected: boolean;
  disconnectedAt: number | null;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

interface BattleTimer {
  kind: 'setup' | 'turn';
  deadline: number;
  /** Remaining ms while paused because a participant is disconnected. */
  pausedRemaining: number | null;
  handle: ReturnType<typeof setTimeout> | null;
  /** Turn number / phase the timer belongs to, so stale timers never fire. */
  stamp: string;
}

export interface Room {
  code: string;
  mode: MatchMode;
  size: number;
  rules: RulesConfig;
  hostId: string;
  status: RoomStatus;
  players: RoomPlayer[];
  match: MatchState | null;
  createdAt: number;
  updatedAt: number;
  timers: Map<string, BattleTimer>;
  forfeitTimers: Map<string, ReturnType<typeof setTimeout>>;
  history: { finishedAt: number; winner: TeamId | null; teamScores: Record<TeamId, number> }[];
}

export interface RoomView {
  code: string;
  mode: MatchMode;
  size: number;
  status: RoomStatus;
  hostId: string;
  capacity: number;
  teamSize: number;
  rules: RulesConfig;
  you: { id: string; name: string; team: TeamId; isHost: boolean };
  players: { id: string; name: string; team: TeamId; preferredSlot: number | null; connected: boolean; isHost: boolean }[];
  match: MatchView | null;
  timers: Record<string, { kind: 'setup' | 'turn'; deadline: number; paused: boolean; remaining: number | null }>;
  history: Room['history'];
}

export class RoomError extends Error {}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface RoomManagerOptions {
  rules?: Partial<RulesConfig>;
  /** Called whenever a room's state changes and clients should be re-synced. */
  onChange?: (room: Room) => void;
  now?: () => number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private onChange: (room: Room) => void;
  private now: () => number;
  private baseRules: Partial<RulesConfig>;

  constructor(opts: RoomManagerOptions = {}) {
    this.onChange = opts.onChange ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.baseRules = opts.rules ?? {};
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private sanitizeName(name: unknown): string {
    const n = typeof name === 'string' ? name.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 20) : '';
    return n || 'Sailor';
  }

  getRoom(code: unknown): Room {
    const room = typeof code === 'string' ? this.rooms.get(code.trim().toUpperCase()) : undefined;
    if (!room) throw new RoomError('Room not found');
    return room;
  }

  createRoom(input: { mode: unknown; name: unknown; size?: unknown }): { room: Room; player: RoomPlayer } {
    const mode = input.mode as MatchMode;
    if (!(mode in MODE_INFO)) throw new RoomError('Invalid mode');
    const size = input.size === BOARD_CONFIGS.small.size ? BOARD_CONFIGS.small.size : BOARD_CONFIGS.standard.size;
    const player = this.newPlayer(input.name, 'A');
    const room: Room = {
      code: this.newCode(),
      mode,
      size,
      rules: makeRules(this.baseRules),
      hostId: player.id,
      status: 'lobby',
      players: [player],
      match: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      timers: new Map(),
      forfeitTimers: new Map(),
      history: [],
    };
    this.rooms.set(room.code, room);
    return { room, player };
  }

  private newPlayer(name: unknown, team: TeamId): RoomPlayer {
    return {
      id: `pl_${randomBytes(6).toString('hex')}`,
      name: this.sanitizeName(name),
      token: randomBytes(24).toString('hex'),
      team,
      preferredSlot: null,
      connected: true,
      disconnectedAt: null,
    };
  }

  joinRoom(code: unknown, name: unknown): { room: Room; player: RoomPlayer } {
    const room = this.getRoom(code);
    if (room.status !== 'lobby') throw new RoomError('Match already in progress — only existing players can reconnect');
    const info = MODE_INFO[room.mode];
    if (room.players.length >= info.players) throw new RoomError('Room is full');
    const countA = room.players.filter((p) => p.team === 'A').length;
    const team: TeamId = countA < info.teamSize && countA <= room.players.length - countA ? 'A' : 'B';
    const player = this.newPlayer(name, team);
    room.players.push(player);
    this.touch(room);
    return { room, player };
  }

  /** Reconnect with the secret token issued at create/join time. */
  rejoin(code: unknown, token: unknown): { room: Room; player: RoomPlayer } {
    const room = this.getRoom(code);
    const player = room.players.find((p) => typeof token === 'string' && p.token === token);
    if (!player) throw new RoomError('Not a member of this room');
    player.connected = true;
    player.disconnectedAt = null;
    const ft = room.forfeitTimers.get(player.id);
    if (ft) {
      clearTimeout(ft);
      room.forfeitTimers.delete(player.id);
    }
    this.resumeTimersFor(room, player.id);
    this.touch(room);
    return { room, player };
  }

  private member(room: Room, playerId: string): RoomPlayer {
    const p = room.players.find((pl) => pl.id === playerId);
    if (!p) throw new RoomError('Not a member of this room');
    return p;
  }

  setTeam(room: Room, actorId: string, targetId: string, team: unknown) {
    if (room.status !== 'lobby') throw new RoomError('Teams are locked once the match starts');
    if (team !== 'A' && team !== 'B') throw new RoomError('Invalid team');
    if (actorId !== targetId && actorId !== room.hostId) throw new RoomError('Only the host can move other players');
    const target = this.member(room, targetId);
    const size = room.players.filter((p) => p.team === team && p.id !== targetId).length;
    if (size >= MODE_INFO[room.mode].teamSize) throw new RoomError(`Team ${team} is full`);
    target.team = team;
    target.preferredSlot = null;
    this.touch(room);
  }

  setSlot(room: Room, playerId: string, slot: unknown) {
    if (room.status !== 'lobby') throw new RoomError('Positions are locked once the match starts');
    const p = this.member(room, playerId);
    const max = MODE_INFO[room.mode].teamSize;
    if (slot === null) p.preferredSlot = null;
    else if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= max) p.preferredSlot = slot;
    else throw new RoomError('Invalid position');
    this.touch(room);
  }

  setBoardSize(room: Room, actorId: string, size: unknown) {
    if (actorId !== room.hostId) throw new RoomError('Only the host can change the board');
    if (room.status !== 'lobby') throw new RoomError('Board is locked');
    if (size !== 5 && size !== 15) throw new RoomError('Board must be 5 or 15');
    room.size = size;
    this.touch(room);
  }

  validateStart(room: Room): string | null {
    const info = MODE_INFO[room.mode];
    if (room.players.length !== info.players) return `Need ${info.players} players (have ${room.players.length})`;
    for (const t of ['A', 'B'] as TeamId[]) {
      if (room.players.filter((p) => p.team === t).length !== info.teamSize) return `Team ${t} needs ${info.teamSize} players`;
    }
    if (room.players.some((p) => !p.connected)) return 'All players must be connected';
    return null;
  }

  startMatch(room: Room, actorId: string) {
    if (actorId !== room.hostId) throw new RoomError('Only the host can start the match');
    if (room.status !== 'lobby') throw new RoomError('Match already started');
    const err = this.validateStart(room);
    if (err) throw new RoomError(err);
    room.match = createMatch({
      id: room.code,
      mode: room.mode,
      size: room.size,
      rules: room.rules,
      players: room.players.map((p) => ({ id: p.id, name: p.name, team: p.team, preferredSlot: p.preferredSlot })),
    });
    room.status = 'playing';
    this.syncTimers(room);
    this.touch(room);
  }

  /** Validate and apply a game action on behalf of an authenticated player. */
  action(room: Room, playerId: string, raw: unknown) {
    if (room.status !== 'playing' || !room.match) throw new RoomError('No match in progress');
    this.member(room, playerId);
    if (!raw || typeof raw !== 'object') throw new RoomError('Invalid action');
    const clientAction = raw as Record<string, unknown>;
    if (typeof clientAction.actionId !== 'string' || clientAction.actionId.length > 100) throw new RoomError('Invalid action id');
    if (clientAction.type === 'forfeit') throw new RoomError('Forfeit is server-controlled');
    // Never trust client identity: playerId comes from the authenticated socket; ids are namespaced.
    const action = { ...clientAction, playerId, actionId: `${playerId}:${clientAction.actionId}` } as BattleAction;
    const res = applyMatchAction(room.match, action);
    if (!res.ok) throw new RoomError(res.error);
    if (!res.duplicate) this.afterMatchChange(room);
    return res;
  }

  private afterMatchChange(room: Room) {
    const m = room.match!;
    if (m.phase === 'finished') {
      room.status = 'finished';
      this.clearAllTimers(room);
      if (m.result) room.history.push({ finishedAt: this.now(), winner: m.result.winner, teamScores: m.result.teamScores });
    } else {
      this.syncTimers(room);
    }
    this.touch(room);
  }

  rematch(room: Room, actorId: string) {
    if (actorId !== room.hostId) throw new RoomError('Only the host can start a rematch');
    if (room.status !== 'finished') throw new RoomError('Match not finished');
    room.status = 'lobby';
    room.match = null;
    this.clearAllTimers(room);
    this.touch(room);
  }

  leave(room: Room, playerId: string) {
    if (room.status === 'lobby') {
      this.removeFromLobby(room, playerId);
    } else {
      this.disconnect(room, playerId);
    }
  }

  private removeFromLobby(room: Room, playerId: string) {
    room.players = room.players.filter((p) => p.id !== playerId);
    if (room.players.length === 0) {
      this.deleteRoom(room);
      return;
    }
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    this.touch(room);
  }

  /** Disconnection policy: pause timers; forfeit the current battle if not back within the grace period. */
  disconnect(room: Room, playerId: string) {
    const p = room.players.find((pl) => pl.id === playerId);
    if (!p || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = this.now();
    const graceMs = room.rules.reconnectGraceSeconds * 1000;
    if (room.status === 'playing' && room.match) {
      this.pauseTimersFor(room, playerId);
      const handle = setTimeout(() => {
        room.forfeitTimers.delete(playerId);
        if (p.connected || room.status !== 'playing' || !room.match) return;
        const res = applyMatchAction(room.match, { type: 'forfeit', actionId: `server:forfeit:${playerId}:${room.match.round}`, playerId });
        if (res.ok && !res.duplicate) this.afterMatchChange(room);
      }, graceMs);
      room.forfeitTimers.set(playerId, handle);
    } else if (room.status === 'lobby') {
      const handle = setTimeout(() => {
        room.forfeitTimers.delete(playerId);
        if (!p.connected && room.status === 'lobby') this.removeFromLobby(room, playerId);
      }, graceMs);
      room.forfeitTimers.set(playerId, handle);
    }
    this.touch(room);
  }

  /* ------------------------------ timers ------------------------------ */

  private battleParticipants(room: Room, battleId: string): string[] {
    return room.match?.battles[battleId]?.playerOrder ?? [];
  }

  /** (Re)create setup/turn timers so they match the current authoritative state. */
  private syncTimers(room: Room) {
    const m = room.match;
    if (!m) return;
    for (const sb of m.schedule) {
      const b = m.battles[sb.id];
      const existing = room.timers.get(sb.id);
      if (!b || sb.status !== 'active' || b.phase === 'finished') {
        if (existing?.handle) clearTimeout(existing.handle);
        room.timers.delete(sb.id);
        continue;
      }
      const kind = b.phase === 'setup' ? 'setup' : 'turn';
      const seconds = kind === 'setup' ? room.rules.setupSeconds : room.rules.turnSeconds;
      const stamp = kind === 'setup' ? 'setup' : `turn:${b.turn!.number}`;
      if (seconds <= 0 || existing?.stamp === stamp) continue;
      if (existing?.handle) clearTimeout(existing.handle);
      const timer: BattleTimer = { kind, deadline: this.now() + seconds * 1000, pausedRemaining: null, handle: null, stamp };
      room.timers.set(sb.id, timer);
      const anyDisconnected = b.playerOrder.some((id) => !room.players.find((p) => p.id === id)?.connected);
      if (anyDisconnected) timer.pausedRemaining = seconds * 1000;
      else this.arm(room, sb.id, timer, seconds * 1000);
    }
  }

  private arm(room: Room, battleId: string, timer: BattleTimer, ms: number) {
    timer.deadline = this.now() + ms;
    timer.pausedRemaining = null;
    timer.handle = setTimeout(() => this.onTimer(room, battleId, timer.stamp), ms);
  }

  private onTimer(room: Room, battleId: string, stamp: string) {
    const m = room.match;
    const timer = room.timers.get(battleId);
    if (!m || !timer || timer.stamp !== stamp || room.status !== 'playing') return;
    const b = m.battles[battleId];
    if (stamp === 'setup' && b.phase === 'setup') {
      // Setup deadline: auto-deploy a random fleet for anyone not ready, then ready them.
      for (const pid of b.playerOrder) {
        const st = m.battles[battleId];
        if (st.players[pid].ready) continue;
        if (st.boards[pid].ships.length !== st.templateIds.length) {
          const blocked = new Set(st.boards[pid].mines.map((mi) => `${mi.x},${mi.y}`));
          const fleet = randomFleet(st.size, st.templateIds, createRng(Date.now() & 0xffffffff), blocked);
          if (fleet) applyMatchAction(m, { type: 'placeShips', actionId: `server:auto-place:${battleId}:${pid}`, playerId: pid, placements: fleet });
        }
        applyMatchAction(m, { type: 'ready', actionId: `server:auto-ready:${battleId}:${pid}`, playerId: pid });
      }
    } else if (b.phase === 'active' && stamp === `turn:${b.turn!.number}`) {
      applyMatchAction(m, { type: 'endTurn', actionId: `server:timeout:${battleId}:${b.turn!.number}`, playerId: b.turn!.playerId });
    }
    room.timers.delete(battleId);
    this.afterMatchChange(room);
  }

  private pauseTimersFor(room: Room, playerId: string) {
    for (const [battleId, t] of room.timers) {
      if (!this.battleParticipants(room, battleId).includes(playerId) || t.pausedRemaining !== null) continue;
      if (t.handle) clearTimeout(t.handle);
      t.handle = null;
      t.pausedRemaining = Math.max(0, t.deadline - this.now());
    }
  }

  private resumeTimersFor(room: Room, playerId: string) {
    for (const [battleId, t] of room.timers) {
      const parts = this.battleParticipants(room, battleId);
      if (!parts.includes(playerId) || t.pausedRemaining === null) continue;
      const allBack = parts.every((id) => room.players.find((p) => p.id === id)?.connected);
      if (allBack) this.arm(room, battleId, t, Math.max(t.pausedRemaining, 5000));
    }
  }

  private clearAllTimers(room: Room) {
    for (const t of room.timers.values()) if (t.handle) clearTimeout(t.handle);
    room.timers.clear();
  }

  deleteRoom(room: Room) {
    this.clearAllTimers(room);
    for (const h of room.forfeitTimers.values()) clearTimeout(h);
    room.forfeitTimers.clear();
    this.rooms.delete(room.code);
  }

  /** Remove idle rooms (no connected players for maxIdleMs). */
  sweep(maxIdleMs = 30 * 60 * 1000) {
    for (const room of [...this.rooms.values()]) {
      if (room.players.every((p) => !p.connected) && this.now() - room.updatedAt > maxIdleMs) this.deleteRoom(room);
    }
  }

  dispose() {
    for (const room of [...this.rooms.values()]) this.deleteRoom(room);
  }

  private touch(room: Room) {
    room.updatedAt = this.now();
    if (this.rooms.has(room.code)) this.onChange(room);
  }

  /* ------------------------------- views ------------------------------- */

  /** Per-player projection. Hidden opponent data never leaves the server. */
  viewFor(room: Room, playerId: string): RoomView {
    const me = this.member(room, playerId);
    const info = MODE_INFO[room.mode];
    const timers: RoomView['timers'] = {};
    for (const [id, t] of room.timers) {
      timers[id] = { kind: t.kind, deadline: t.deadline, paused: t.pausedRemaining !== null, remaining: t.pausedRemaining };
    }
    return {
      code: room.code,
      mode: room.mode,
      size: room.size,
      status: room.status,
      hostId: room.hostId,
      capacity: info.players,
      teamSize: info.teamSize,
      rules: room.rules,
      you: { id: me.id, name: me.name, team: me.team, isHost: me.id === room.hostId },
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        team: p.team,
        preferredSlot: p.preferredSlot,
        connected: p.connected,
        isHost: p.id === room.hostId,
      })),
      match: room.match ? viewMatch(room.match, playerId) : null,
      timers,
      history: room.history,
    };
  }
}
