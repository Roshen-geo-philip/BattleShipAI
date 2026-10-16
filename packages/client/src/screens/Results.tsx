import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Leaderboard as LeaderboardData } from '@battleship/engine';

export interface ResultPlayer {
  id: string;
  name: string;
  balance: number;
  score: number;
  shipsSunk: number;
  hits: number;
  misses: number;
  shipsLost: number;
}

export type Outcome = 'victory' | 'defeat' | 'draw';

interface ResultScreenProps {
  outcome: Outcome;
  /** Small line above the headline, e.g. "Versus AI · Strategic". */
  kicker: string;
  /** Who won, phrased for the viewer: "You defeated FOPC AI", "Team B wins". */
  winnerLine: string;
  /** Headline scores, e.g. [{ label: 'You', value: 31 }, { label: 'AI', value: 18 }]. */
  scores: { label: string; value: number }[];
  /** Concise match summary lines. */
  summary: string[];
  /** Optional per-player statistics table (1v1 modes). */
  players?: ResultPlayer[];
  winnerId?: string | null;
  /** Points leaderboard (team modes). */
  leaderboard?: LeaderboardData;
  onMenu: () => void;
  onAgain?: () => void;
  againLabel?: string;
  /** Rendered instead of the again button when the viewer cannot start one (e.g. waiting for host). */
  againNote?: ReactNode;
}

/**
 * Victory / defeat / draw screen. It is rendered only from authoritative finished state;
 * "Review board" hides it so the final boards can be inspected, and it can be reopened.
 */
export function ResultScreen(p: ResultScreenProps) {
  const [open, setOpen] = useState(true);
  const [showBoard, setShowBoard] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const title = p.outcome === 'victory' ? 'Victory' : p.outcome === 'defeat' ? 'Defeat' : 'Draw';
  if (!open) {
    return (
      <div className="review-bar" role="region" aria-label="Match finished">
        <span className="small"><b>{title}</b> · {p.winnerLine}</span>
        <div className="row">
          <button className="btn sm primary" type="button" onClick={() => setOpen(true)}>Show results</button>
          <button className="btn sm" type="button" onClick={p.onMenu}>Main menu</button>
        </div>
      </div>
    );
  }
  return (
    <div className="result-overlay">
      <div className={`result ${p.outcome}`} role="dialog" aria-modal="true" aria-labelledby="result-title">
        <div className="m-stripe" />
        <div className="result-body">
          <div className="stack" style={{ gap: 8 }}>
            <span className="kicker">{p.kicker}</span>
            <h1 id="result-title" ref={heading} tabIndex={-1}>{title}</h1>
            <p className="lead">{p.winnerLine}</p>
          </div>
          <div className="score-line">
            {p.scores.map((s) => (
              <div key={s.label} className="stack" style={{ gap: 4 }}>
                <span className="caption">{s.label}</span>
                <span className="big-num">{s.value}</span>
              </div>
            ))}
          </div>
          {p.summary.length > 0 && (
            <ul className="rules-list small">
              {p.summary.map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          {p.players && !showBoard && <PlayerStats players={p.players} winnerId={p.winnerId ?? null} />}
          {p.leaderboard && showBoard && <Leaderboard data={p.leaderboard} />}
          <div className="result-actions">
            {p.onAgain ? <button className="btn solid" type="button" onClick={p.onAgain}>{p.againLabel ?? 'Play again'}</button> : p.againNote}
            {p.leaderboard && (
              <button className="btn" type="button" aria-pressed={showBoard} onClick={() => setShowBoard(!showBoard)}>
                {showBoard ? 'Hide leaderboard' : 'View leaderboard'}
              </button>
            )}
            <button className="btn" type="button" onClick={() => setOpen(false)}>Review board</button>
            <button className="btn ghost" type="button" onClick={p.onMenu}>Main menu</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayerStats({ players, winnerId }: { players: ResultPlayer[]; winnerId: string | null }) {
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr><th>Player</th><th>Score</th><th>Balance</th><th>Ships sunk</th><th>Hits</th><th>Misses</th><th>Accuracy</th></tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id} className={p.id === winnerId ? 'current' : ''}>
              <td>{p.name}{p.id === winnerId ? ' · winner' : ''}</td>
              <td>{p.score}</td>
              <td>{p.balance}</td>
              <td>{p.shipsSunk}</td>
              <td>{p.hits}</td>
              <td>{p.misses}</td>
              <td>{p.hits + p.misses ? Math.round((100 * p.hits) / (p.hits + p.misses)) : 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Points leaderboard for team formats, rendered straight from the server-computed ranking. */
export function Leaderboard({ data, viewerId }: { data: LeaderboardData; viewerId?: string }) {
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="tbl" aria-label="Team ranking">
          <thead><tr><th>Rank</th><th>Team</th><th>Points</th><th>Battles won</th><th>Ships sunk</th></tr></thead>
          <tbody>
            {data.teams.map((t) => (
              <tr key={t.team}>
                <td className="rank">{t.rank}</td>
                <td><span className={`pill team-${t.team}`}>Team {t.team}</span></td>
                <td>{t.score}</td>
                <td>{t.battlesWon}</td>
                <td>{t.shipsSunk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <table className="tbl" aria-label="Player ranking">
          <thead><tr><th>Rank</th><th>Player</th><th>Team</th><th>Points</th><th>Won</th><th>Played</th><th>Sunk</th><th>Lost</th><th>Accuracy</th></tr></thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.id} className={p.id === viewerId ? 'current' : ''}>
                <td className="rank">{p.rank}</td>
                <td>{p.name}{p.id === viewerId ? ' (you)' : ''}</td>
                <td><span className={`pill team-${p.team}`}>{p.team}</span></td>
                <td>{p.score}</td>
                <td>{p.battlesWon}</td>
                <td>{p.battlesPlayed}</td>
                <td>{p.shipsSunk}</td>
                <td>{p.shipsLost}</td>
                <td>{p.hits + p.misses ? Math.round((100 * p.hits) / (p.hits + p.misses)) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption">{data.policy}</p>
    </div>
  );
}
