import { applyAction, battleStats, createBattle } from '../battle';
import { BOARD_CONFIG, type RulesConfig, makeRules } from '../config';
import { createRng, randomSeed, shuffle, type Rng } from '../rng';
import type { ApplyResult, BattleAction, BattleState } from '../types';
import { type BattleView, viewBattle } from '../views';

export type MatchMode = 'online1v1' | 'online2v2' | 'online5v5';
export type TeamId = 'A' | 'B';

export const MODE_INFO: Record<MatchMode, { teamSize: number; players: number; label: string; maxConcurrent: number }> = {
  online1v1: { teamSize: 1, players: 2, label: 'Online 1v1', maxConcurrent: 1 },
  online2v2: { teamSize: 2, players: 4, label: 'Online 2v2', maxConcurrent: 2 },
  online5v5: { teamSize: 5, players: 10, label: 'Online 5v5', maxConcurrent: 2 },
};

export interface MatchPlayer {
  id: string;
  name: string;
  team: TeamId;
  /** Preferred position 1..teamSize chosen in the lobby (5v5). */
  preferredSlot: number | null;
  /** Final position after resolving preferences. */
  slot: number;
}

export interface ScheduledBattle {
  id: string;
  round: number;
  playerA: string;
  playerB: string;
  status: 'pending' | 'active' | 'finished';
  winnerId: string | null;
}

export type MatchPhase = 'in-round' | 'finished';

export interface MatchResult {
  teamScores: Record<TeamId, number>;
  battlesWon: Record<TeamId, number>;
  shipsSunk: Record<TeamId, number>;
  winner: TeamId | null;
  decidedBy: 'score' | 'battles-won' | 'ships-sunk' | 'draw';
}

export interface MatchState {
  id: string;
  mode: MatchMode;
  size: number;
  rules: RulesConfig;
  players: MatchPlayer[];
  schedule: ScheduledBattle[];
  round: number;
  rounds: number;
  phase: MatchPhase;
  battles: Record<string, BattleState>;
  result: MatchResult | null;
  seed: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  team: TeamId;
  preferredSlot: number | null;
}

/** Resolve slot preferences: honour unique choices, resolve clashes randomly, fill the rest. */
export function assignSlots(players: LobbyPlayer[], teamSize: number, rng: Rng): Map<string, number> {
  const out = new Map<string, number>();
  const free = new Set(Array.from({ length: teamSize }, (_, i) => i + 1));
  const ordered = shuffle(rng, players);
  for (const p of ordered) {
    if (p.preferredSlot && free.has(p.preferredSlot)) {
      out.set(p.id, p.preferredSlot);
      free.delete(p.preferredSlot);
    }
  }
  for (const p of ordered) {
    if (out.has(p.id)) continue;
    const options = [...free];
    const slot = options[Math.floor(rng() * options.length)];
    out.set(p.id, slot);
    free.delete(slot);
  }
  return out;
}

/**
 * Scheduling policy:
 *  - 1v1: a single battle.
 *  - 2v2: full round robin in two rounds, both battles of a round run concurrently:
 *         R1: A1–B1, A2–B2   R2: A1–B2, A2–B1
 *  - 5v5: slot k of team A plays slot k of team B; the five pairings are shuffled
 *         and grouped into rounds of at most `maxConcurrent` concurrent battles.
 * Every player appears at most once per round, so each round is always completable.
 */
export function buildSchedule(mode: MatchMode, players: MatchPlayer[], rng: Rng): ScheduledBattle[] {
  const team = (t: TeamId) => players.filter((p) => p.team === t).sort((a, b) => a.slot - b.slot);
  const A = team('A');
  const B = team('B');
  const info = MODE_INFO[mode];
  if (A.length !== info.teamSize || B.length !== info.teamSize) throw new Error('Teams are not complete');
  let pairs: [string, string, number][] = [];
  if (mode === 'online1v1') pairs = [[A[0].id, B[0].id, 1]];
  else if (mode === 'online2v2') {
    pairs = [
      [A[0].id, B[0].id, 1],
      [A[1].id, B[1].id, 1],
      [A[0].id, B[1].id, 2],
      [A[1].id, B[0].id, 2],
    ];
  } else {
    const order = shuffle(rng, A.map((a, i) => [a.id, B[i].id] as [string, string]));
    pairs = order.map(([a, b], i) => [a, b, Math.floor(i / info.maxConcurrent) + 1]);
  }
  return pairs.map(([a, b, round], i) => ({
    id: `b${i + 1}`,
    round,
    playerA: a,
    playerB: b,
    status: 'pending',
    winnerId: null,
  }));
}

export function validateSchedule(schedule: ScheduledBattle[], players: MatchPlayer[]): string | null {
  const team = new Map(players.map((p) => [p.id, p.team]));
  const rounds = new Map<number, Set<string>>();
  for (const b of schedule) {
    if (!team.has(b.playerA) || !team.has(b.playerB)) return `Unknown player in ${b.id}`;
    if (team.get(b.playerA) === team.get(b.playerB)) return `${b.id} pairs teammates`;
    const busy = rounds.get(b.round) ?? new Set();
    if (busy.has(b.playerA) || busy.has(b.playerB)) return `Player double-booked in round ${b.round}`;
    busy.add(b.playerA).add(b.playerB);
    rounds.set(b.round, busy);
  }
  return null;
}

export interface CreateMatchOptions {
  id: string;
  mode: MatchMode;
  players: LobbyPlayer[];
  rules?: Partial<RulesConfig>;
  seed?: number;
}

export function createMatch(opts: CreateMatchOptions): MatchState {
  const seed = opts.seed ?? randomSeed();
  const rng = createRng(seed);
  const info = MODE_INFO[opts.mode];
  const players: MatchPlayer[] = [];
  for (const t of ['A', 'B'] as TeamId[]) {
    const members = opts.players.filter((p) => p.team === t);
    const slots = assignSlots(members, info.teamSize, rng);
    for (const m of members) players.push({ ...m, slot: slots.get(m.id)! });
  }
  const schedule = buildSchedule(opts.mode, players, rng);
  const err = validateSchedule(schedule, players);
  if (err) throw new Error(err);
  const match: MatchState = {
    id: opts.id,
    mode: opts.mode,
    size: BOARD_CONFIG.size,
    rules: makeRules(opts.rules),
    players,
    schedule,
    round: 0,
    rounds: Math.max(...schedule.map((b) => b.round)),
    phase: 'in-round',
    battles: {},
    result: null,
    seed,
  };
  startRound(match, 1);
  return match;
}

function startRound(m: MatchState, round: number) {
  m.round = round;
  for (const sb of m.schedule.filter((b) => b.round === round)) {
    const pa = m.players.find((p) => p.id === sb.playerA)!;
    const pb = m.players.find((p) => p.id === sb.playerB)!;
    m.battles[sb.id] = createBattle({
      id: `${m.id}:${sb.id}`,
      players: [{ id: pa.id, name: pa.name }, { id: pb.id, name: pb.name }],
      size: m.size,
      rules: m.rules,
      seed: (m.seed + round * 1013 + sb.id.length * 7 + Number(sb.id.slice(1)) * 31) >>> 0,
    });
    sb.status = 'active';
  }
}

/** The scheduled battle the player is currently fighting, if any. */
export function activeBattleFor(m: MatchState, playerId: string): ScheduledBattle | null {
  return m.schedule.find((b) => b.round === m.round && b.status === 'active' && (b.playerA === playerId || b.playerB === playerId)) ?? null;
}

export type MatchApplyResult = ApplyResult & { roundAdvanced?: boolean; matchFinished?: boolean };

/** Route a player's action to their current battle and advance the match when battles end. */
export function applyMatchAction(m: MatchState, action: BattleAction): MatchApplyResult {
  if (m.phase === 'finished') return { ok: false, code: 'WRONG_PHASE', error: 'Match finished' };
  const sb = activeBattleFor(m, action.playerId);
  if (!sb) return { ok: false, code: 'WRONG_PHASE', error: 'You are not in an active battle this round' };
  const res = applyAction(m.battles[sb.id], action);
  if (!res.ok || res.duplicate) return res;
  m.battles[sb.id] = res.state;
  let roundAdvanced = false;
  let matchFinished = false;
  if (res.state.phase === 'finished') {
    sb.status = 'finished';
    sb.winnerId = res.state.winnerId;
    const roundDone = m.schedule.filter((b) => b.round === m.round).every((b) => b.status === 'finished');
    if (roundDone) {
      if (m.round < m.rounds) {
        startRound(m, m.round + 1);
        roundAdvanced = true;
      } else {
        m.phase = 'finished';
        m.result = computeResult(m);
        matchFinished = true;
      }
    }
  }
  return { ...res, roundAdvanced, matchFinished };
}

/* ------------------------------ scoring ------------------------------ */

/** Cumulative earned score per player across every battle they played. */
export function individualScores(m: MatchState): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(m.players.map((p) => [p.id, 0]));
  for (const b of Object.values(m.battles)) {
    for (const id of b.playerOrder) out[id] += b.players[id].score;
  }
  return out;
}

/** Team score = sum of members' cumulative earned score (not their spendable balances). */
export function teamScores(m: MatchState): Record<TeamId, number> {
  const ind = individualScores(m);
  const out: Record<TeamId, number> = { A: 0, B: 0 };
  for (const p of m.players) out[p.team] += ind[p.id];
  return out;
}

/** Tie policy: team score → battles won → ships sunk → draw. */
export function computeResult(m: MatchState): MatchResult {
  const scores = teamScores(m);
  const teamOf = new Map(m.players.map((p) => [p.id, p.team]));
  const battlesWon: Record<TeamId, number> = { A: 0, B: 0 };
  const shipsSunk: Record<TeamId, number> = { A: 0, B: 0 };
  for (const sb of m.schedule) {
    if (sb.winnerId) battlesWon[teamOf.get(sb.winnerId)!] += 1;
    const b = m.battles[sb.id];
    if (!b) continue;
    for (const id of b.playerOrder) shipsSunk[teamOf.get(id)!] += battleStats(b, id).shipsSunk;
  }
  const cmp = (r: Record<TeamId, number>): TeamId | null => (r.A > r.B ? 'A' : r.B > r.A ? 'B' : null);
  let winner = cmp(scores);
  let decidedBy: MatchResult['decidedBy'] = 'score';
  if (!winner) {
    winner = cmp(battlesWon);
    decidedBy = 'battles-won';
  }
  if (!winner) {
    winner = cmp(shipsSunk);
    decidedBy = 'ships-sunk';
  }
  if (!winner) decidedBy = 'draw';
  return { teamScores: scores, battlesWon, shipsSunk, winner, decidedBy };
}

/* ----------------------------- leaderboard ---------------------------- */

export interface LeaderboardPlayer {
  id: string;
  name: string;
  team: TeamId;
  /** Competition rank (1, 1, 3 …): equal stat tuples share a rank. */
  rank: number;
  score: number;
  battlesPlayed: number;
  battlesWon: number;
  shipsSunk: number;
  shipsLost: number;
  hits: number;
  misses: number;
}

export interface LeaderboardTeam {
  team: TeamId;
  rank: number;
  score: number;
  battlesWon: number;
  shipsSunk: number;
}

export interface Leaderboard {
  teams: LeaderboardTeam[];
  players: LeaderboardPlayer[];
  /** Human-readable ranking policy, shown under the table. */
  policy: string;
}

type RankKey = { score: number; battlesWon: number; shipsSunk: number };
const compareRank = (a: RankKey, b: RankKey) => b.score - a.score || b.battlesWon - a.battlesWon || b.shipsSunk - a.shipsSunk;

function assignRanks<T extends RankKey & { rank: number }>(rows: T[]): T[] {
  rows.forEach((r, i) => {
    r.rank = i > 0 && compareRank(rows[i - 1], r) === 0 ? rows[i - 1].rank : i + 1;
  });
  return rows;
}

/**
 * Points-based leaderboard computed from authoritative battle state (never from client values).
 * Ranking policy (same order as the team tie-break): score → battles won → ships sunk;
 * rows that are equal on all three share a rank and are listed by name, then id, for determinism.
 */
export function matchLeaderboard(m: MatchState): Leaderboard {
  const ind = individualScores(m);
  const players: LeaderboardPlayer[] = m.players.map((p) => ({
    id: p.id, name: p.name, team: p.team, rank: 0, score: ind[p.id],
    battlesPlayed: 0, battlesWon: 0, shipsSunk: 0, shipsLost: 0, hits: 0, misses: 0,
  }));
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const sb of m.schedule) {
    const b = m.battles[sb.id];
    if (!b) continue;
    for (const pid of b.playerOrder) {
      const row = byId.get(pid)!;
      const st = battleStats(b, pid);
      row.shipsSunk += st.shipsSunk;
      row.shipsLost += st.shipsLost;
      row.hits += st.hits;
      row.misses += st.misses;
      if (sb.status === 'finished') row.battlesPlayed += 1;
      if (sb.winnerId === pid) row.battlesWon += 1;
    }
  }
  players.sort((a, b) => compareRank(a, b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const teams: LeaderboardTeam[] = (['A', 'B'] as TeamId[]).map((t) => {
    const members = players.filter((p) => p.team === t);
    return {
      team: t,
      rank: 0,
      score: members.reduce((s, p) => s + p.score, 0),
      battlesWon: members.reduce((s, p) => s + p.battlesWon, 0),
      shipsSunk: members.reduce((s, p) => s + p.shipsSunk, 0),
    };
  });
  teams.sort((a, b) => compareRank(a, b) || a.team.localeCompare(b.team));
  return {
    teams: assignRanks(teams),
    players: assignRanks(players),
    policy: 'Ranked by score, then battles won, then ships sunk. Rows equal on all three share a rank.',
  };
}

/** Forfeit the player's current battle (used by the disconnection policy). */
export function forfeitCurrentBattle(m: MatchState, playerId: string, actionId: string): MatchApplyResult {
  return applyMatchAction(m, { type: 'forfeit', actionId, playerId });
}

/* ------------------------------- views ------------------------------- */

export interface MatchView {
  id: string;
  mode: MatchMode;
  size: number;
  phase: MatchPhase;
  round: number;
  rounds: number;
  players: (MatchPlayer & { totalScore: number })[];
  schedule: ScheduledBattle[];
  teamScores: Record<TeamId, number>;
  result: MatchResult | null;
  viewerId: string;
  viewerTeam: TeamId | null;
  /** The viewer's own battle this round (null when spectating or done). */
  myBattleId: string | null;
  /** All battles of the current round (and finished ones), filtered for this viewer. */
  battles: Record<string, BattleView>;
  /** Authoritative points leaderboard (public information: scores and public battle stats). */
  leaderboard: Leaderboard;
}

/**
 * Visibility policy: a viewer sees full boards of themselves and their teammates;
 * opponents' boards are always hidden (only shots, sunk ships and revealed mines).
 */
export function viewMatch(m: MatchState, viewerId: string): MatchView {
  const viewer = m.players.find((p) => p.id === viewerId) ?? null;
  const allies = viewer ? m.players.filter((p) => p.team === viewer.team).map((p) => p.id) : [];
  const ind = individualScores(m);
  const battles: Record<string, BattleView> = {};
  for (const [id, b] of Object.entries(m.battles)) battles[id] = viewBattle(b, viewer ? viewerId : null, allies);
  return {
    id: m.id,
    mode: m.mode,
    size: m.size,
    phase: m.phase,
    round: m.round,
    rounds: m.rounds,
    players: m.players.map((p) => ({ ...p, totalScore: ind[p.id] })),
    schedule: m.schedule,
    teamScores: teamScores(m),
    result: m.result,
    viewerId,
    viewerTeam: viewer?.team ?? null,
    myBattleId: activeBattleFor(m, viewerId)?.id ?? null,
    battles,
    leaderboard: matchLeaderboard(m),
  };
}
