import type { AbilityId, RulesConfig } from './config';

/** x = column (0..size-1, left→right), y = row (0..size-1, top→bottom). */
export interface Coord {
  x: number;
  y: number;
}

export type Orientation = 'horizontal' | 'vertical';

export interface ShipPlacement {
  templateId: string;
  /** Anchor = top-left of the oriented pattern's bounding box. */
  x: number;
  y: number;
  orientation: Orientation;
}

export interface ShipInstance {
  id: string;
  templateId: string;
  cells: Coord[];
  hits: boolean[];
  sunk: boolean;
  placement: ShipPlacement;
}

export interface Mine {
  id: string;
  x: number;
  y: number;
  active: boolean;
  /** How the mine left play, if it did. */
  outcome?: 'triggered' | 'defused';
  /** Player ids (besides the owner) that legitimately know this mine's location. */
  knownBy: string[];
}

export type ShotSource = 'manual' | 'airstrike' | 'nuke';

export interface Shot {
  x: number;
  y: number;
  result: 'hit' | 'miss' | 'mine';
  source: ShotSource;
  /** Present on hits so the owner's view can render damage; hidden from opponents. */
  shipId?: string;
  turn: number;
}

export interface RadarScan {
  id: string;
  /** Top-left of the clamped 3x3 window. */
  x: number;
  y: number;
  size: number;
  /** Per-cell evidence inside the scan window. */
  cells: { x: number; y: number; ship: boolean; mine: boolean }[];
  turn: number;
}

export interface Board {
  ownerId: string;
  size: number;
  ships: ShipInstance[];
  mines: Mine[];
  /** Keyed by "x,y". Every cell that any attack (manual or ability) has resolved. */
  shots: Record<string, Shot>;
}

export interface PlayerState {
  id: string;
  name: string;
  isAI: boolean;
  balance: number;
  /** Earned rewards minus penalties (spending does not reduce score). Used for leaderboards. */
  score: number;
  ready: boolean;
  /** Radar scans this player performed against their opponent. */
  radar: RadarScan[];
}

export type TxReason =
  | 'start'
  | 'manual-attack'
  | 'sink-bonus'
  | 'sink-compensation'
  | 'mine-penalty'
  | 'mine-reward'
  | 'purchase';

export interface Transaction {
  id: string;
  /** The game event that produced this transaction (attack/ability id). */
  eventId: string;
  playerId: string;
  amount: number;
  reason: TxReason;
  /** Spending (purchases) changes balance only; rewards/penalties change balance AND score. */
  affectsScore: boolean;
}

export type BattlePhase = 'setup' | 'active' | 'finished';

export interface TurnState {
  playerId: string;
  number: number;
  /** True once a manual attack missed (or triggered a mine) this turn. */
  manualLocked: boolean;
  abilitiesUsed: number;
}

export interface BattleState {
  id: string;
  rules: RulesConfig;
  size: number;
  /** Shared ship templates for this battle — both opponents use the same set. */
  templateIds: string[];
  phase: BattlePhase;
  playerOrder: [string, string];
  players: Record<string, PlayerState>;
  boards: Record<string, Board>;
  turn: TurnState | null;
  winnerId: string | null;
  endReason: 'all-sunk' | 'forfeit' | null;
  transactions: Transaction[];
  /** Action ids already applied — used to make every network message idempotent. */
  processedActionIds: string[];
  log: BattleEvent[];
  seed: number;
  rngCalls: number;
  createdAt: number;
}

/* ----------------------------- Actions ----------------------------- */

interface ActionBase {
  /** Client-generated unique id. A repeated id is ignored (idempotency). */
  actionId: string;
  playerId: string;
}

export type BattleAction =
  | (ActionBase & { type: 'placeShips'; placements: ShipPlacement[] })
  | (ActionBase & { type: 'clearShips' })
  | (ActionBase & { type: 'placeMine'; x: number; y: number })
  | (ActionBase & { type: 'ready' })
  | (ActionBase & { type: 'unready' })
  | (ActionBase & { type: 'attack'; x: number; y: number })
  | (ActionBase & { type: 'airstrike'; axis: 'row' | 'col'; index: number })
  | (ActionBase & { type: 'nuke'; x: number; y: number })
  | (ActionBase & { type: 'radar'; x: number; y: number })
  | (ActionBase & { type: 'endTurn' })
  /** Server-issued when the turn timer expires: passes the turn even if a shot remains. Never accepted from clients. */
  | (ActionBase & { type: 'timeout' })
  | (ActionBase & { type: 'forfeit' });

/* ----------------------------- Events ------------------------------ */

export interface CellOutcome {
  x: number;
  y: number;
  result: 'hit' | 'miss' | 'mine' | 'skipped' | 'mine-defused';
}

export type BattleEvent =
  | { kind: 'ships-placed'; playerId: string }
  | { kind: 'mine-placed'; playerId: string }
  | { kind: 'ready'; playerId: string; ready: boolean }
  | { kind: 'battle-started'; firstPlayerId: string }
  | {
      kind: 'attack';
      eventId: string;
      attackerId: string;
      source: ShotSource;
      cells: CellOutcome[];
      sunk: { templateId: string; cells: Coord[] }[];
    }
  | { kind: 'mine-triggered'; eventId: string; attackerId: string; ownerId: string; x: number; y: number }
  | { kind: 'radar'; eventId: string; attackerId: string; x: number; y: number }
  | { kind: 'purchase'; playerId: string; ability: AbilityId; cost: number }
  | { kind: 'manual-locked'; playerId: string }
  | { kind: 'turn-ended'; playerId: string; nextPlayerId: string; turn: number; timedOut?: boolean }
  | { kind: 'battle-finished'; winnerId: string; reason: 'all-sunk' | 'forfeit' };

export type ApplyResult =
  | { ok: true; state: BattleState; events: BattleEvent[]; duplicate: boolean }
  | { ok: false; error: string; code: ErrorCode };

export type ErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_PLAYER'
  | 'OUT_OF_BOUNDS'
  | 'ALREADY_ATTACKED'
  | 'MANUAL_LOCKED'
  | 'INSUFFICIENT_POINTS'
  | 'INVALID_PLACEMENT'
  | 'NOT_READY'
  | 'ALREADY_READY'
  | 'INVALID_ACTION'
  | 'ABILITY_LIMIT'
  | 'MUST_FIRE';
