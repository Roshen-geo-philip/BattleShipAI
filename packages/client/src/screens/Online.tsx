import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { BOARD_CONFIG, MODE_INFO, type BattleView, type MatchMode, type MatchView, type TeamId } from '@battleship/engine';
import { Combat } from '../components/Combat';
import { Placement } from '../components/Placement';
import type { ActionInput } from '../components/types';
import { loadName, loadSession, saveHistory, saveName } from '../lib/history';
import type { Online, RoomView } from '../lib/online';
import { Leaderboard, ResultScreen } from './Results';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const BOARD_LABEL = `${BOARD_CONFIG.size}×${BOARD_CONFIG.size} · ${BOARD_CONFIG.shipCount} ships`;

const FORMATS: { mode: MatchMode; title: string; text: string }[] = [
  { mode: 'online1v1', title: '1v1', text: 'One duel against a friend. First to sink the whole fleet wins.' },
  { mode: 'online2v2', title: '2v2', text: 'Two teams of two. Round-robin duels; the team with more points wins.' },
  { mode: 'online5v5', title: '5v5', text: 'Pick positions 1–5. Position k duels position k; team points decide.' },
];

export function OnlineScreen({ online, initialCode, onExit }: { online: Online; initialCode?: string; onExit: () => void }) {
  const { room } = online;
  if (!room) return <OnlineHome online={online} initialCode={initialCode} onExit={onExit} />;
  if (room.status === 'lobby') return <Lobby online={online} room={room} />;
  return <OnlineMatch online={online} room={room} onExit={onExit} />;
}

/* ------------------------------- home ------------------------------- */

function OnlineHome({ online, initialCode, onExit }: { online: Online; initialCode?: string; onExit: () => void }) {
  const [name, setName] = useState(loadName());
  const [mode, setMode] = useState<MatchMode | null>(null);
  const [joining, setJoining] = useState(!!initialCode);
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const saved = loadSession();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    saveName(name);
    await fn();
    setBusy(false);
  };

  const back = () => (mode || joining ? (setMode(null), setJoining(false)) : onExit());
  const nameField = (
    <label className="field" style={{ maxWidth: 420 }}>
      Your name
      <input type="text" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Captain" />
    </label>
  );

  return (
    <div className="stack lg">
      <button className="text-link" type="button" onClick={back} style={{ alignSelf: 'flex-start' }}>
        ← {mode || joining ? 'Online formats' : 'Modes'}
      </button>
      <div className="row spread">
        <div className="stack" style={{ gap: 8 }}>
          <span className="caption">{BOARD_LABEL} · real-time over the network</span>
          <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>{mode ? `Online ${FORMATS.find((f) => f.mode === mode)!.title}` : joining ? 'Join a room' : 'Online'}</h1>
        </div>
        <ConnectionPill status={online.status} />
      </div>
      {online.error && <div className="banner bad" role="alert">{online.error}</div>}
      {saved && (
        <div className="banner warn row spread">
          <span>You were in room <b className="mono">{saved.code}</b> as {saved.name}.</span>
          <button className="btn sm" type="button" disabled={busy} onClick={() => run(() => online.rejoin(saved))}>Reconnect</button>
        </div>
      )}

      {!mode && !joining && (
        <>
          <nav className="mode-grid" aria-label="Online match formats">
            {FORMATS.map((f, i) => (
              <button key={f.mode} type="button" className="mode-card" style={{ minHeight: 220 }} onClick={() => setMode(f.mode)}>
                <span className="index">0{i + 1}</span>
                <span className="title">{f.title}</span>
                <span>{f.text}</span>
                <span className="meta">
                  <span>{MODE_INFO[f.mode].players} players</span>
                  <span className="arrow" aria-hidden>→</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="row">
            <span className="muted">Have a room code?</span>
            <button className="text-link" type="button" onClick={() => setJoining(true)}>Join a room →</button>
          </div>
        </>
      )}

      {mode && (
        <div className="grid-2">
          <div className="panel stack">
            <h2>Host</h2>
            <p className="small">{MODE_INFO[mode].players} players. You'll get a room code, a join link and a QR code to share. Everyone plays on {BOARD_LABEL}.</p>
            {nameField}
            <button className="btn solid big" type="button" disabled={busy} onClick={() => run(() => online.create(mode, name))}>
              Create room
            </button>
          </div>
          <JoinPanel code={code} setCode={setCode} busy={busy} onJoin={() => run(() => online.join(code, name))} nameField={null} />
        </div>
      )}

      {joining && !mode && (
        <div className="narrow">
          <JoinPanel code={code} setCode={setCode} busy={busy} onJoin={() => run(() => online.join(code, name))} nameField={nameField} autoFocus={!!initialCode} />
        </div>
      )}
    </div>
  );
}

function JoinPanel(p: { code: string; setCode: (c: string) => void; busy: boolean; onJoin: () => void; nameField: React.ReactNode; autoFocus?: boolean }) {
  return (
    <div className="panel stack">
      <h2>Join</h2>
      <p className="small">The room code decides the format. Scanning a host's QR code opens this screen with the code filled in.</p>
      {p.nameField}
      <label className="field">
        Room code
        <input
          type="text"
          className="code-input"
          value={p.code}
          maxLength={6}
          onChange={(e) => p.setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="ABC234"
          autoFocus={p.autoFocus}
          inputMode="text"
          autoCapitalize="characters"
        />
      </label>
      <button className="btn primary big" type="button" disabled={p.busy || p.code.length !== 6} onClick={p.onJoin}>
        Join room
      </button>
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
    <div className="stack lg">
      <div className="row spread">
        <div className="stack" style={{ gap: 8 }}>
          <span className="caption">Lobby · {BOARD_LABEL} · {room.players.length}/{room.capacity} players</span>
          <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3.5rem)' }}>{MODE_INFO[room.mode].label}</h1>
        </div>
        <div className="row">
          <ConnectionPill status={online.status} />
          <button className="btn ghost" type="button" onClick={online.leave}>Leave room</button>
        </div>
      </div>
      {online.error && <div className="banner bad row spread" role="alert"><span>{online.error}</span><button className="btn ghost sm" type="button" onClick={online.clearError} aria-label="Dismiss">✕</button></div>}
      <div className="lobby-grid">
        <div className="panel stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <h3>Room code</h3>
          <div className="room-code" aria-label={`Room code ${room.code.split('').join(' ')}`}>{room.code}</div>
          {qr ? <img className="qr" src={qr} alt={`QR code to join room ${room.code}`} /> : <div className="qr" />}
          <button
            className="btn"
            type="button"
            onClick={() => navigator.clipboard?.writeText(joinUrl).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? 'Copied' : 'Copy join link'}
          </button>
          <span className="caption mono" style={{ wordBreak: 'break-all' }}>{joinUrl}</span>
        </div>
        <div className="stack">
          <div className="grid-2">
            {(['A', 'B'] as TeamId[]).map((t) => (
              <div key={t} className={`panel stack team-col ${t}`}>
                <div className="row spread">
                  <h3>{teamMode ? `Team ${t}` : t === 'A' ? 'Host side' : 'Challenger'}</h3>
                  <span className="small muted num">{room.players.filter((p) => p.team === t).length}/{room.teamSize}</span>
                </div>
                {room.players.filter((p) => p.team === t).map((p) => (
                  <div key={p.id} className="player-row">
                    <span>
                      {p.name}
                      {p.isHost && <span className="caption"> · host</span>}
                      {p.id === room.you.id && <span className="caption"> · you</span>}
                      {teamMode && p.preferredSlot ? <span className="pill" style={{ marginLeft: 6 }}>#{p.preferredSlot}</span> : null}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`pill ${p.connected ? 'ok' : 'bad'}`}>{p.connected ? 'online' : 'offline'}</span>
                      {teamMode && (isHost || p.id === room.you.id) && (
                        <button className="btn ghost sm" type="button" onClick={() => online.setTeam(p.id, t === 'A' ? 'B' : 'A')} aria-label={`Move ${p.name} to team ${t === 'A' ? 'B' : 'A'}`}>
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
              <p className="small">
                {room.mode === 'online5v5'
                  ? 'Position k on Team A battles position k on Team B. Clashes are resolved randomly; the battle order is shuffled and shown before play.'
                  : 'Positions decide the first-round pairing (1 vs 1, 2 vs 2), then teams swap opponents.'}
              </p>
              <div className="row">
                {Array.from({ length: room.teamSize }, (_, i) => i + 1).map((n) => {
                  const mine = room.players.find((p) => p.id === room.you.id)?.preferredSlot === n;
                  return (
                    <button key={n} type="button" className="btn" style={{ minWidth: 48, padding: 0 }} aria-pressed={mine} onClick={() => online.setSlot(mine ? null : n)}>
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {isHost ? (
            <button className="btn solid big" type="button" disabled={!!startProblem} onClick={online.start}>
              {startProblem ?? 'Start match'}
            </button>
          ) : (
            <div className="banner">Waiting for the host to start the match… {startProblem && `(${startProblem})`}</div>
          )}
          <p className="caption">
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
          <span className="caption">Team {t}{match.viewerTeam === t ? ' · yours' : ''}</span>
          <b>{match.teamScores[t]}</b>
          <span className="small muted">{match.players.filter((p) => p.team === t).map((p) => p.name).join(', ')}</span>
        </div>
      ))}
    </div>
  );
}

function Schedule({ match }: { match: MatchView }) {
  const name = (id: string) => match.players.find((p) => p.id === id)?.name ?? '?';
  const slot = (id: string) => match.players.find((p) => p.id === id)?.slot;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr><th>Round</th><th>Team A</th><th>Team B</th><th>Status</th></tr></thead>
        <tbody>
          {match.schedule.map((b) => (
            <tr key={b.id} className={b.round === match.round && b.status === 'active' ? 'current' : ''}>
              <td>{b.round}</td>
              <td>#{slot(b.playerA)} {name(b.playerA)}{b.winnerId === b.playerA ? ' · won' : ''}</td>
              <td>#{slot(b.playerB)} {name(b.playerB)}{b.winnerId === b.playerB ? ' · won' : ''}</td>
              <td>{b.status === 'finished' ? 'done' : b.status === 'active' ? (match.battles[b.id]?.phase === 'setup' ? 'placing ships' : 'in battle') : 'upcoming'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OnlineMatch({ online, room, onExit }: { online: Online; room: RoomView; onExit: () => void }) {
  const match = room.match!;
  const teamMode = room.teamSize > 1;
  const myBattle = match.myBattleId ? match.battles[match.myBattleId] : null;
  const currentBattles = match.schedule.filter((b) => match.battles[b.id] && (b.round === match.round || b.status === 'finished'));
  const [watching, setWatching] = useState<string | null>(null);
  const watchId = watching && match.battles[watching] ? watching : currentBattles.find((b) => b.status === 'active')?.id ?? currentBattles[0]?.id ?? null;
  const finished = room.status === 'finished' && !!match.result;

  const send = async (a: ActionInput) => {
    const res = await online.action({ ...a, actionId: uuid() });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  };

  useEffect(() => {
    if (!finished) return;
    saveHistory({
      id: `${room.code}:${room.history.length}`,
      at: Date.now(),
      mode: MODE_INFO[room.mode].label,
      summary: `Room ${room.code}`,
      winner: match.result!.winner ? (teamMode ? `Team ${match.result!.winner}` : match.players.find((p) => p.team === match.result!.winner)?.name ?? null) : 'Draw',
      scores: match.players.map((p) => ({ name: p.name, score: p.totalScore, team: p.team })),
    });
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const perspective = (b: BattleView) => b.playerOrder.find((p) => match.players.find((mp) => mp.id === p)?.team === match.viewerTeam) ?? b.playerOrder[0];
  const leave = () => {
    online.leave();
    onExit();
  };

  const result = match.result;
  const outcome = !result ? null : result.winner === null ? 'draw' : result.winner === match.viewerTeam ? 'victory' : 'defeat';
  const winnerName = result?.winner ? (teamMode ? `Team ${result.winner}` : match.players.find((p) => p.team === result.winner)?.name ?? '') : '';
  const oppTeam: TeamId = match.viewerTeam === 'B' ? 'A' : 'B';

  return (
    <div className="stack lg">
      <div className="row spread">
        <div className="stack" style={{ gap: 8 }}>
          <span className="caption">
            Room <span className="mono">{room.code}</span> · Round {match.round}/{match.rounds} · {BOARD_LABEL}
          </span>
          <h1 style={{ fontSize: 'clamp(1.75rem, 5vw, 3rem)' }}>{MODE_INFO[room.mode].label}</h1>
        </div>
        <div className="row">
          <ConnectionPill status={online.status} />
          {room.players.some((p) => !p.connected) && <span className="pill bad">{room.players.filter((p) => !p.connected).map((p) => p.name).join(', ')} disconnected</span>}
          <button className="btn ghost" type="button" onClick={leave}>Leave</button>
        </div>
      </div>
      {online.error && <div className="banner bad row spread" role="alert"><span>{online.error}</span><button className="btn ghost sm" type="button" onClick={online.clearError} aria-label="Dismiss">✕</button></div>}

      {finished && result && outcome && (
        <ResultScreen
          key={room.history.length}
          outcome={outcome}
          kicker={`${MODE_INFO[room.mode].label} · room ${room.code}`}
          winnerLine={
            outcome === 'draw'
              ? 'Scores, battles won and ships sunk are all level — the match is a draw.'
              : outcome === 'victory'
                ? teamMode ? `Your team, Team ${result.winner}, wins the match.` : 'You win the duel.'
                : `${winnerName} wins the match.`
          }
          scores={
            teamMode
              ? [{ label: `Team ${match.viewerTeam ?? 'A'}`, value: result.teamScores[match.viewerTeam ?? 'A'] }, { label: `Team ${oppTeam}`, value: result.teamScores[oppTeam] }]
              : match.players.map((p) => ({ label: p.id === room.you.id ? 'You' : p.name, value: p.totalScore }))
          }
          summary={[
            `Decided by ${result.decidedBy.replace('-', ' ')}`,
            `Battles won — A ${result.battlesWon.A} : B ${result.battlesWon.B} · ships sunk — A ${result.shipsSunk.A} : B ${result.shipsSunk.B}`,
          ]}
          leaderboard={teamMode ? match.leaderboard : undefined}
          onAgain={room.you.isHost ? online.rematch : undefined}
          againLabel="Rematch (back to lobby)"
          againNote={<span className="small muted">The host can start a rematch.</span>}
          onMenu={leave}
        />
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
          <div className="banner info">
            Spectating — {room.status === 'finished' ? 'match complete' : 'you have no battle this round'}. You see your team's boards; opponents' ships stay hidden.
          </div>
          <div className="tabs" role="tablist" aria-label="Battles">
            {currentBattles.map((b) => (
              <button key={b.id} role="tab" aria-selected={watchId === b.id} type="button" className="tab" onClick={() => setWatching(b.id)}>
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
          <h3>{teamMode ? 'Leaderboard' : 'Scores'}</h3>
          <Leaderboard data={match.leaderboard} viewerId={room.you.id} />
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
