import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import type { RulesConfig } from '@battleship/engine';
import { RoomError, RoomManager, type Room } from './rooms';

export interface ServerOptions {
  port?: number;
  corsOrigin?: string | string[];
  staticDir?: string;
  rules?: Partial<RulesConfig>;
}

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

interface SocketData {
  playerId?: string;
  roomCode?: string;
}

/** Simple per-socket token bucket to stop message floods. */
function rateLimiter(capacity = 40, refillPerSec = 20) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function startServer(opts: ServerOptions = {}): Promise<{ http: HttpServer; io: Server; rooms: RoomManager; port: number; close: () => Promise<void> }> {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { cors: { origin: opts.corsOrigin ?? '*' } });

  const broadcast = (room: Room) => {
    for (const p of room.players) {
      if (!p.connected) continue;
      io.to(`player:${p.id}`).emit('room:state', rooms.viewFor(room, p.id));
    }
  };
  const rooms = new RoomManager({ rules: opts.rules, onChange: broadcast });

  app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));
  // Public room lookup: no secrets, no board data.
  app.get('/api/rooms/:code', (req, res) => {
    try {
      const r = rooms.getRoom(req.params.code);
      res.json({ ok: true, code: r.code, mode: r.mode, status: r.status, players: r.players.length, size: r.size });
    } catch {
      res.status(404).json({ ok: false, error: 'Room not found' });
    }
  });
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
  }

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const allow = rateLimiter();

    const bind = (room: Room, playerId: string) => {
      if (data.playerId && data.playerId !== playerId) socket.leave(`player:${data.playerId}`);
      data.playerId = playerId;
      data.roomCode = room.code;
      socket.join(`player:${playerId}`);
    };

    const handler =
      <T>(fn: (payload: T, ack: Ack) => void) =>
      (payload: T, ack?: Ack) => {
        const reply: Ack = typeof ack === 'function' ? ack : () => {};
        if (!allow()) return reply({ ok: false, error: 'Too many requests' });
        try {
          fn(payload ?? ({} as T), reply);
        } catch (e) {
          reply({ ok: false, error: e instanceof RoomError ? e.message : 'Server error' });
          if (!(e instanceof RoomError)) console.error(e);
        }
      };

    const current = () => {
      if (!data.roomCode || !data.playerId) throw new RoomError('Join a room first');
      return { room: rooms.getRoom(data.roomCode), playerId: data.playerId };
    };

    socket.on('room:create', handler<{ mode: unknown; name: unknown; size?: unknown }>((p, ack) => {
      const { room, player } = rooms.createRoom(p);
      bind(room, player.id);
      ack({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(room);
    }));

    socket.on('room:join', handler<{ code: unknown; name: unknown }>((p, ack) => {
      const { room, player } = rooms.joinRoom(p.code, p.name);
      bind(room, player.id);
      ack({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(room);
    }));

    socket.on('room:rejoin', handler<{ code: unknown; token: unknown }>((p, ack) => {
      const { room, player } = rooms.rejoin(p.code, p.token);
      bind(room, player.id);
      ack({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcast(room);
    }));

    socket.on('room:leave', handler<unknown>((_p, ack) => {
      const { room, playerId } = current();
      rooms.leave(room, playerId);
      socket.leave(`player:${playerId}`);
      data.playerId = undefined;
      data.roomCode = undefined;
      ack({ ok: true });
    }));

    socket.on('lobby:setTeam', handler<{ playerId: unknown; team: unknown }>((p, ack) => {
      const { room, playerId } = current();
      rooms.setTeam(room, playerId, typeof p.playerId === 'string' ? p.playerId : playerId, p.team);
      ack({ ok: true });
    }));

    socket.on('lobby:setSlot', handler<{ slot: unknown }>((p, ack) => {
      const { room, playerId } = current();
      rooms.setSlot(room, playerId, p.slot);
      ack({ ok: true });
    }));

    socket.on('lobby:setSize', handler<{ size: unknown }>((p, ack) => {
      const { room, playerId } = current();
      rooms.setBoardSize(room, playerId, p.size);
      ack({ ok: true });
    }));

    socket.on('lobby:start', handler<unknown>((_p, ack) => {
      const { room, playerId } = current();
      rooms.startMatch(room, playerId);
      ack({ ok: true });
    }));

    socket.on('room:rematch', handler<unknown>((_p, ack) => {
      const { room, playerId } = current();
      rooms.rematch(room, playerId);
      ack({ ok: true });
    }));

    socket.on('game:action', handler<{ action: unknown }>((p, ack) => {
      const { room, playerId } = current();
      const res = rooms.action(room, playerId, p.action);
      ack({ ok: true, duplicate: res.ok && res.duplicate });
    }));

    socket.on('disconnect', () => {
      if (!data.roomCode || !data.playerId) return;
      const room = rooms.rooms.get(data.roomCode);
      if (!room) return;
      // Only mark disconnected if no other socket of this player is still connected.
      const stillThere = io.sockets.adapter.rooms.get(`player:${data.playerId}`)?.size ?? 0;
      if (stillThere === 0) rooms.disconnect(room, data.playerId);
    });
  });

  const sweeper = setInterval(() => rooms.sweep(), 60_000);
  sweeper.unref();

  return new Promise((resolve) => {
    http.listen(opts.port ?? 3001, () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port ?? 3001;
      resolve({
        http,
        io,
        rooms,
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweeper);
            rooms.dispose();
            io.close(() => done());
          }),
      });
    });
  });
}
