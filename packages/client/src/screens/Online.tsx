import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { MODE_INFO, type BattleView, type MatchMode, type MatchView, type TeamId } from '@battleship/engine';
import { Combat } from '../components/Combat';
import { Placement } from '../components/Placement';
import type { ActionInput } from '../components/types';
import { loadName, loadSession, saveHistory, saveName } from '../lib/history';
import type { Online, RoomView } from '../lib/online';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function OnlineScreen({ online, initialCode, onExit }: { online: Online; initialCode?: string; onExit: () => void }) {
  const { room } = online;
  if (!room) return <OnlineHome online={online} initialCode={initialCode} onExit={onExit} />;
  if (room.status === 'lobby') return <Lobby online={online} room={room} />;
  return <OnlineMatch online={online} room={room} onExit={onExit} />;
}

/* ------------------------------- home ------------------------------- */

function OnlineHome({ online, initialCode, onExit }: { online: Online; initialCode?: string; onExit: () => void }) {
  const [name, setName] = useState(loadName());
  const [mode, setMode] = useState<MatchMode>('online1v1');
  const [size, setSize] = useState(15);
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const saved = loadSession();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    saveName(name);
    await fn();
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="row spread">
        <h1>Online battle</h1>
        <button className="btn ghost" type="button" onClick={onExit}>← Back</button>
      </div>
      {online.error && <div className="banner bad" role="alert">{online.error}</div>}
      {saved && (
        <div className="banner warn row spread">
          <span>You were in room <b className="mono">{saved.code}</b> as {saved.name}.</span>
          <button className="btn" type="button" disabled={busy} onClick={() => run(() => online.rejoin(saved))}>Reconnect</button>
        </div>
      )}
      <label className="field" style={{ maxWidth: 360 }}>
        Your name
        <input type="text" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Captain" />
      </label>
      <div className="grid-2">
        <div className="panel stack">
          <h2>Host a room</h2>
          <div className="row" role="radiogroup" aria-label="Mode">
            {(Object.keys(MODE_INFO) as MatchMode[]).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
                {MODE_INFO[m].label}
              </button>
            ))}
          </div>
          <div className="row" role="radiogroup" aria-label="Board size">
            {[15, 5].map((s) => (
              <button key={s} type="button" role="radio" aria-checked={size === s} className={`btn ${size === s ? 'active' : ''}`} onClick={() => setSize(s)}>
                {s}×{s} · {s === 15 ? 5 : 3} ships
              </button>
            ))}
          </div>
          <p className="muted small">{MODE_INFO[mode].players} players. You'll get a room code and QR code to share.</p>
          <button className="btn primary big" type="button" disabled={busy} onClick={() => run(() => online.create(mode, name, size))}>
            Create room
          </button>
        </div>
        <div className="panel stack">
          <h2>Join a room</h2>
          <label className="field">
            Room code
            <input
              type="text"
              className="code-input"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder="ABC234"
              autoFocus={!!initialCode}
            />
          </label>
          <button className="btn primary big" type="button" disabled={busy || code.length !== 6} onClick={() => run(() => online.join(code, name))}>
            Join
          </button>
          <p className="muted small">Scanning a host's QR code opens this screen with the code filled in.</p>
        </div>
      </div>
      <ConnectionPill status={online.status} />
    </div>
  );
}

function ConnectionPill({ status }: { status: Online['status'] }) {
  const map = { idle: ['', 'Not connected'], connecting: ['warn', 'Connecting…'], connected: ['ok', 'Connected'], reconnecting: ['warn', 'Reconnecting…'], offline: ['bad', 'Offline'] } as const;
  const [cls, text] = map[status];
  return <span className={`pill ${cls}`} role="status">● {text}</span>;
}

/* ------------------------------- lobby ------------------------------ */

function Lobby({ online, room }: { online: Online; room: RoomView }) {
  const [qr, setQr] = useState<string | null>(null);
  const base = import.meta.env.VITE_PUBLIC_URL || window.location.origin;
  const joinUrl = `${base.replace(/\/$/, '')}/?join=${room.code}`;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(joinUrl, { margin: 1, width: 360 }).then(setQr).catch(() => setQr(null));
  }, [joinUrl]);

  const isHost = room.you.isHost;
  const teamMode = room.teamSize > 1;
  const startProblem = (() => {
    if (room.players.length !== room.capacity) return `Waiting for players (${room.players.length}/${room.capacity})`;
    for (const t of ['A', 'B'] as TeamId[]) if (room.players.filter((p) => p.team === t).length !== room.teamSize) return `Team ${t} needs ${room.teamSize}`;
    if (room.players.some((p) => !p.connected)) return 'A player is disconnected';
    return null;
  })();

  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <h1>{MODE_INFO[room.mode].label} lobby</h1>
          <p className="muted">Board {room.size}×{room.size} · {room.players.length}/{room.capacity} players</p>
        </div>
        <div className="row">
          <ConnectionPill status={online.status} />
          <button className="btn ghost" type="button" onClick={online.leave}>Leave room</button>
        </div>
      </div>
      {online.error && <div className="banner bad row spread" role="alert"><span>{online.error}</span><button className="btn ghost" type="button" onClick={online.clearError}>✕</button></div>}
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(240px, 300px) 1fr' }}>
        <div className="panel stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <h3>Room code</h3>
          <div className="room-code" aria-label={`Room code ${room.code.split('').join(' ')}`}>{room.code}</div>
          {qr ? <img className="qr" src={qr} alt={`QR code to join room ${room.code}`} /> : <div className="qr" />}
          <button
            className="btn"
            type="button"
            onClick={() => navigator.clipboard?.writeText(joinUrl).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? '✓ Copied' : '🔗 Copy join link'}
          </button>
          <span className="muted small mono" style={{ wordBreak: 'break-all' }}>{joinUrl}</span>
        </div>
        <div className="stack">
          <div className="grid-2">
            {(['A', 'B'] as TeamId[]).map((t) => (
              <div key={t} className={`panel stack team-col ${t}`}>
                <div className="row spread">
                  <h2>{teamMode ? `Team ${t}` : t === 'A' ? 'Host side' : 'Challenger'}</h2>
                  <span className="muted small">{room.players.filter((p) => p.team === t).length}/{room.teamSize}</span>
                </div>
                {room.players.filter((p) => p.team === t).map((p) => (
                  <div key={p.id} className="player-row">
                    <span>
                      {p.isHost && '👑 '}
                      {p.name}
                      {p.id === room.you.id && ' (you)'}
                      {teamMode && p.preferredSlot ? <span className="pill" style={{ marginLeft: 6 }}>#{p.preferredSlot}</span> : null}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`pill ${p.connected ? 'ok' : 'bad'}`}>{p.connected ? 'online' : 'offline'}</span>
                      {teamMode && (isHost || p.id === room.you.id) && (
                        <button className="btn ghost small" type="button" onClick={() => online.setTeam(p.id, t === 'A' ? 'B' : 'A')} aria-label={`Move ${p.name} to team ${t === 'A' ? 'B' : 'A'}`}>
                          ⇄
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {teamMode && (
            <div className="panel stack">
              <h3>Your position (pairing preference)</h3>
              <p className="muted small">
                {room.mode === 'online5v5'
                  ? 'Position k on Team A battles position k on Team B. Clashes are resolved randomly; the battle order is shuffled and shown before play.'
                  : 'Positions decide the first-round pairing (1 vs 1, 2 vs 2), then teams swap opponents.'}
              </p>
              <div className="row">
                {Array.from({ length: room.teamSize }, (_, i) => i + 1).map((n) => {
                  const mine = room.players.find((p) => p.id === room.you.id)?.preferredSlot === n;
                  return (
                    <button key={n} type="button" className={`btn ${mine ? 'active' : ''}`} aria-pressed={mine} onClick={() => online.setSlot(mine ? null : n)}>
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {isHost ? (
            <div className="panel stack">
              <div className="row">
                <span className="muted">Board:</span>
                {[15, 5].map((s) => (
                  <button key={s} type="button" className={`btn ${room.size === s ? 'active' : ''}`} onClick={() => online.setSize(s)}>{s}×{s}</button>
                ))}
              </div>
              <button className="btn primary big" type="button" disabled={!!startProblem} onClick={online.start}>
                {startProblem ?? '⚓ Start match'}
              </button>
            </div>
          ) : (
            <div className="banner">Waiting for the host to start the match… {startProblem && `(${startProblem})`}</div>
          )}
          <p className="muted small">
            Setup deadline {room.rules.setupSeconds}s · turn limit {room.rules.turnSeconds}s · reconnect grace {room.rules.reconnectGraceSeconds}s (then the battle is forfeited).
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- match ------------------------------ */

export function TeamScoreboard({ match }: { match: MatchView }) {
  return (
    <div className="team-score" role="region" aria-label="Team scores">
      {(['A', 'B'] as TeamId[]).map((t) => (
        <div key={t} className={`ts ${t}`}>
          <span className="muted small">Team {t}{match.viewerTeam === t ? ' (yours)' : ''}</span>
          <b>{match.teamScores[t]}</b>
          <span className="muted small">{match.players.filter((p) => p.team === t).map((p) => p.name).join(', ')}</span>
        </div>
      ))}
    </div>
  );
}

function Schedule({ match }: { match: MatchView }) {
  const name = (id: string) => match.players.find((p) => p.id === id)?.name ?? '?';
  const slot = (id: string) => match.players.find((p) => p.id === id)?.slot;
  return (
    <table className="tbl">
      <thead><tr><th>Round</th><th>Team A</th><th>Team B</th><th>Status</th></tr></thead>
      <tbody>
        {match.schedule.map((b) => (
          <tr key={b.id} className={b.round === match.round && b.status === 'active' ? 'current' : ''}>
            <td>{b.round}</td>
            <td>#{slot(b.playerA)} {name(b.playerA)}{b.winnerId === b.playerA ? ' 🏆' : ''}</td>
            <td>#{slot(b.playerB)} {name(b.playerB)}{b.winnerId === b.playerB ? ' 🏆' : ''}</td>
            <td>{b.status === 'finished' ? 'done' : b.status === 'active' ? (match.battles[b.id]?.phase === 'setup' ? 'placing ships' : 'in battle') : 'upcoming'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Rankings({ match }: { match: MatchView }) {
  const sorted = [...match.players].sort((a, b) => b.totalScore - a.totalScore);
  return (
    <table className="tbl">
      <thead><tr><th>#</th><th>Player</th><th>Team</th><th>Score</th></tr></thead>
      <tbody>
        {sorted.map((p, i) => (
          <tr key={p.id} className={p.id === match.viewerId ? 'current' : ''}>
            <td>{i + 1}</td><td>{p.name}</td><td><span className={`pill team-${p.team}`}>{p.team}</span></td><td>{p.totalScore}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OnlineMatch({ online, room, onExit }: { online: Online; room: RoomView; onExit: () => void }) {
  const match = room.match!;
  const teamMode = room.teamSize > 1;
  const myBattle = match.myBattleId ? match.battles[match.myBattleId] : null;
  const currentBattles = match.schedule.filter((b) => match.battles[b.id] && (b.round === match.round || b.status === 'finished'));
  const [watching, setWatching] = useState<string | null>(null);
  const watchId = watching && match.battles[watching] ? watching : currentBattles.find((b) => b.status === 'active')?.id ?? currentBattles[0]?.id ?? null;

  const send = async (a: ActionInput) => {
    const res = await online.action({ ...a, actionId: uuid() });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  useEffect(() => {
    if (room.status !== 'finished' || !match.result) return;
    saveHistory({
      id: `${room.code}:${room.history.length}`,
      at: Date.now(),
      mode: MODE_INFO[room.mode].label,
      summary: `Room ${room.code}`,
      winner: match.result.winner ? (teamMode ? `Team ${match.result.winner}` : match.players.find((p) => p.team === match.result!.winner)?.name ?? null) : 'Draw',
      scores: match.players.map((p) => ({ name: p.name, score: p.totalScore, team: p.team })),
    });
  }, [room.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const perspective = (b: BattleView) => b.playerOrder.find((p) => match.players.find((mp) => mp.id === p)?.team === match.viewerTeam) ?? b.playerOrder[0];

  return (
    <div className="stack">
      <div className="row spread">
        <div>
          <h1>{MODE_INFO[room.mode].label}</h1>
          <p className="muted">
            Room <span className="mono">{room.code}</span> · Round {match.round}/{match.rounds} · Board {room.size}×{room.size}
          </p>
        </div>
        <div className="row">
          <ConnectionPill status={online.status} />
          {room.players.some((p) => !p.connected) && <span className="pill bad">{room.players.filter((p) => !p.connected).map((p) => p.name).join(', ')} disconnected</span>}
          <button className="btn ghost" type="button" onClick={() => { online.leave(); onExit(); }}>Leave</button>
        </div>
      </div>
      {online.error && <div className="banner bad row spread" role="alert"><span>{online.error}</span><button className="btn ghost" type="button" onClick={online.clearError}>✕</button></div>}

      {room.status === 'finished' && match.result && (
        <div className="panel stack" role="region" aria-label="Match results">
          <h2>
            {match.result.winner === null
              ? '🤝 Draw'
              : teamMode
                ? `🏆 Team ${match.result.winner} wins${match.result.winner === match.viewerTeam ? ' — that’s you!' : ''}`
                : `🏆 ${match.players.find((p) => p.team === match.result!.winner)?.name} wins`}
          </h2>
          <p className="muted small">
            Decided by {match.result.decidedBy.replace('-', ' ')} · battles won A {match.result.battlesWon.A} – B {match.result.battlesWon.B} · ships sunk A {match.result.shipsSunk.A} – B {match.result.shipsSunk.B}
          </p>
          <div className="row">
            {room.you.isHost ? <button className="btn primary" type="button" onClick={online.rematch}>↻ Rematch (back to lobby)</button> : <span className="muted">The host can start a rematch.</span>}
          </div>
        </div>
      )}

      {teamMode && <TeamScoreboard match={match} />}

      {myBattle && room.status === 'playing' ? (
        myBattle.phase === 'setup' ? (
          <Placement view={myBattle} meId={room.you.id} send={send} timer={room.timers[match.myBattleId!]} title={`Round ${match.round}: deploy vs ${myBattle.players[myBattle.playerOrder.find((p) => p !== room.you.id)!].name}`} />
        ) : (
          <Combat view={myBattle} meId={room.you.id} canAct send={send} timer={room.timers[match.myBattleId!]} />
        )
      ) : (
        <div className="stack">
          <div className="banner">
            👁 Spectating — {room.status === 'finished' ? 'match complete' : 'you have no battle this round'}. You see your team's boards; opponents' ships stay hidden.
          </div>
          <div className="tabs" role="tablist">
            {currentBattles.map((b) => (
              <button key={b.id} role="tab" aria-selected={watchId === b.id} type="button" className={`btn ${watchId === b.id ? 'active' : ''}`} onClick={() => setWatching(b.id)}>
                R{b.round}: {match.players.find((p) => p.id === b.playerA)?.name} vs {match.players.find((p) => p.id === b.playerB)?.name}
              </button>
            ))}
          </div>
          {watchId && <Spectate view={match.battles[watchId]} meId={perspective(match.battles[watchId])} timer={room.timers[watchId]} />}
        </div>
      )}

      <div className="grid-2">
        <div className="panel stack">
          <h3>Match order</h3>
          <Schedule match={match} />
        </div>
        <div className="panel stack">
          <h3>Individual ranking</h3>
          <Rankings match={match} />
        </div>
      </div>
    </div>
  );
}

function Spectate({ view, meId, timer }: { view: BattleView; meId: string; timer?: RoomView['timers'][string] }) {
  const noop = useMemo(() => async () => ({ ok: false, error: 'Spectating' }), []);
  if (view.phase === 'setup') {
    return (
      <div className="panel">
        Ships are being placed… {view.playerOrder.map((p) => `${view.players[p].name}: ${view.players[p].ready ? 'ready' : 'placing'}`).join(' · ')}
      </div>
    );
  }
  return <Combat view={view} meId={meId} canAct={false} send={noop} spectator timer={timer} />;
}
