import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { MatchMode, MatchView, RulesConfig, TeamId } from '@battleship/engine';
import { saveSession, type SavedSession } from './history';

/** Mirror of the server's RoomView (kept structural so the client does not import server code). */
export interface RoomView {
  code: string;
  mode: MatchMode;
  size: number;
  status: 'lobby' | 'playing' | 'finished';
  hostId: string;
  capacity: number;
  teamSize: number;
  rules: RulesConfig;
  you: { id: string; name: string; team: TeamId; isHost: boolean };
  players: { id: string; name: string; team: TeamId; preferredSlot: number | null; connected: boolean; isHost: boolean }[];
  match: MatchView | null;
  timers: Record<string, { kind: 'setup' | 'turn'; deadline: number; paused: boolean; remaining: number | null }>;
  history: { finishedAt: number; winner: TeamId | null; teamScores: Record<TeamId, number> }[];
}

export type AckResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export function useOnline() {
  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<SavedSession | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const ensureSocket = useCallback((): Socket => {
    if (socketRef.current) return socketRef.current;
    setStatus('connecting');
    const url = import.meta.env.VITE_SERVER_URL || undefined;
    const s = url ? io(url, { transports: ['websocket', 'polling'] }) : io({ transports: ['websocket', 'polling'] });
    s.on('connect', () => {
      setStatus('connected');
      // Automatic re-authentication after a dropped connection.
      const sess = sessionRef.current;
      if (sess) {
        s.emit('room:rejoin', { code: sess.code, token: sess.token }, (res: AckResult) => {
          if (!res.ok) {
            setError(res.error);
            sessionRef.current = null;
            saveSession(null);
            setRoom(null);
          }
        });
      }
    });
    s.on('disconnect', () => setStatus('reconnecting'));
    s.io.on('reconnect_failed', () => setStatus('offline'));
    s.on('connect_error', () => setStatus('reconnecting'));
    s.on('room:state', (v: RoomView) => setRoom(v));
    socketRef.current = s;
    return s;
  }, []);

  useEffect(() => () => void socketRef.current?.close(), []);

  const emit = useCallback(
    (event: string, payload: unknown = {}): Promise<AckResult> =>
      new Promise((resolve) => {
        const s = ensureSocket();
        const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 8000);
        s.emit(event, payload, (res: AckResult) => {
          clearTimeout(timer);
          if (!res.ok) setError(res.error);
          resolve(res);
        });
      }),
    [ensureSocket],
  );

  const remember = (res: AckResult, name: string) => {
    if (res.ok) {
      const sess: SavedSession = { code: res.code as string, token: res.token as string, playerId: res.playerId as string, name };
      sessionRef.current = sess;
      saveSession(sess);
      setError(null);
    }
    return res;
  };

  return {
    room,
    status,
    error,
    clearError: () => setError(null),
    create: async (mode: MatchMode, name: string) => remember(await emit('room:create', { mode, name }), name),
    join: async (code: string, name: string) => remember(await emit('room:join', { code, name }), name),
    rejoin: async (sess: SavedSession) => {
      sessionRef.current = sess;
      const res = await emit('room:rejoin', { code: sess.code, token: sess.token });
      if (!res.ok) {
        sessionRef.current = null;
        saveSession(null);
      }
      return res;
    },
    leave: async () => {
      await emit('room:leave');
      sessionRef.current = null;
      saveSession(null);
      setRoom(null);
    },
    setTeam: (playerId: string, team: TeamId) => emit('lobby:setTeam', { playerId, team }),
    setSlot: (slot: number | null) => emit('lobby:setSlot', { slot }),
    start: () => emit('lobby:start'),
    rematch: () => emit('room:rematch'),
    action: (action: Record<string, unknown>) => emit('game:action', { action }),
  };
}

export type Online = ReturnType<typeof useOnline>;
