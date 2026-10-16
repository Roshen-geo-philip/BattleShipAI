import type { RulesConfig } from './config';
import type { BattleEvent, BattleState, Coord, RadarScan, TurnState } from './types';

/**
 * Per-viewer projection of a battle. This is the ONLY shape that leaves the
 * authoritative engine (sent over the network, given to the AI, rendered by the UI).
 * Hidden boards never include unrevealed ship coordinates or unrevealed mines.
 */
export interface ShipView {
  id: string;
  templateId: string;
  cells: Coord[];
  hits: boolean[];
  sunk: boolean;
}

export interface ShotView {
  x: number;
  y: number;
  result: 'hit' | 'miss' | 'mine';
  source: 'manual' | 'airstrike' | 'nuke';
}

export interface MineView {
  x: number;
  y: number;
  active: boolean;
  outcome?: 'triggered' | 'defused';
}

export interface BoardView {
  ownerId: string;
  size: number;
  /** true when the viewer may see this board's ships and mines (owner or teammate). */
  revealed: boolean;
  /** Revealed board: every ship. Hidden board: only sunk ships. */
  ships: ShipView[];
  shipsRemaining: number;
  shots: ShotView[];
  mines: MineView[];
}

export interface PlayerView {
  id: string;
  name: string;
  isAI: boolean;
  balance: number;
  score: number;
  ready: boolean;
  shipsPlaced: boolean;
}

export interface BattleView {
  id: string;
  size: number;
  rules: RulesConfig;
  templateIds: string[];
  phase: BattleState['phase'];
  playerOrder: [string, string];
  players: Record<string, PlayerView>;
  boards: Record<string, BoardView>;
  turn: TurnState | null;
  winnerId: string | null;
  endReason: BattleState['endReason'];
  /** Radar scans performed by players on the viewer's side. */
  radar: Record<string, RadarScan[]>;
  log: BattleEvent[];
  viewerId: string | null;
}

/**
 * @param viewerId  the requesting player (null for a neutral spectator)
 * @param alliedIds owners whose boards the viewer may fully see (self + teammates)
 */
export function viewBattle(state: BattleState, viewerId: string | null, alliedIds: string[] = viewerId ? [viewerId] : []): BattleView {
  const allied = new Set(alliedIds);
  const boards: Record<string, BoardView> = {};
  for (const id of state.playerOrder) {
    const b = state.boards[id];
    const revealed = allied.has(id);
    boards[id] = {
      ownerId: id,
      size: b.size,
      revealed,
      ships: b.ships
        .filter((sh) => revealed || sh.sunk)
        .map((sh) => ({ id: sh.id, templateId: sh.templateId, cells: sh.cells, hits: sh.hits, sunk: sh.sunk })),
      shipsRemaining: state.phase === 'setup' && !revealed ? state.templateIds.length : b.ships.filter((sh) => !sh.sunk).length,
      shots: Object.values(b.shots).map((sh) => ({ x: sh.x, y: sh.y, result: sh.result, source: sh.source })),
      mines: b.mines
        .filter((m) => revealed || m.outcome !== undefined || m.knownBy.some((k) => allied.has(k)))
        .map((m) => ({ x: m.x, y: m.y, active: m.active, outcome: m.outcome })),
    };
  }
  const players: Record<string, PlayerView> = {};
  const radar: Record<string, RadarScan[]> = {};
  for (const id of state.playerOrder) {
    const p = state.players[id];
    players[id] = {
      id,
      name: p.name,
      isAI: p.isAI,
      balance: p.balance,
      score: p.score,
      ready: p.ready,
      shipsPlaced: state.boards[id].ships.length === state.templateIds.length,
    };
    if (allied.has(id)) radar[id] = p.radar;
  }
  return {
    id: state.id,
    size: state.size,
    rules: state.rules,
    templateIds: state.templateIds,
    phase: state.phase,
    playerOrder: state.playerOrder,
    players,
    boards,
    turn: state.turn,
    winnerId: state.winnerId,
    endReason: state.endReason,
    radar,
    log: state.log.slice(-40),
    viewerId,
  };
}
