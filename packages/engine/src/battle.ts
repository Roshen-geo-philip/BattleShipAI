import { BOARD_CONFIG, type AbilityId, type RulesConfig, makeRules } from './config';
import { inBounds, key, placementCells, selectTemplates, validateFleet } from './board';
import { createRng, randomSeed, uid } from './rng';
import type {
  ApplyResult,
  BattleAction,
  BattleEvent,
  BattleState,
  Board,
  CellOutcome,
  Coord,
  ErrorCode,
  PlayerState,
  ShipInstance,
  ShotSource,
  TxReason,
} from './types';

export interface BattlePlayerInit {
  id: string;
  name: string;
  isAI?: boolean;
}

export interface CreateBattleOptions {
  id?: string;
  players: [BattlePlayerInit, BattlePlayerInit];
  /** Must equal BOARD_CONFIG.size (15) — kept as an option only for explicitness. */
  size?: number;
  /** Ship templates; if omitted BOARD_CONFIG.shipCount (7) are randomly selected and validated to fit. */
  templateIds?: string[];
  rules?: Partial<RulesConfig>;
  seed?: number;
}

export function createBattle(opts: CreateBattleOptions): BattleState {
  const seed = opts.seed ?? randomSeed();
  const rules = makeRules(opts.rules);
  const size = opts.size ?? BOARD_CONFIG.size;
  if (size !== BOARD_CONFIG.size) throw new Error(`Only ${BOARD_CONFIG.size}×${BOARD_CONFIG.size} boards are supported`);
  const templateIds = opts.templateIds ?? selectTemplates(BOARD_CONFIG, createRng(seed ^ 0x9e3779b9));
  if (opts.players[0].id === opts.players[1].id) throw new Error('Players must be distinct');

  const players: Record<string, PlayerState> = {};
  const boards: Record<string, Board> = {};
  const transactions: BattleState['transactions'] = [];
  for (const p of opts.players) {
    players[p.id] = {
      id: p.id,
      name: p.name,
      isAI: !!p.isAI,
      balance: rules.startingPoints,
      score: 0,
      ready: false,
      radar: [],
    };
    boards[p.id] = { ownerId: p.id, size, ships: [], mines: [], shots: {} };
    transactions.push({
      id: uid('tx'),
      eventId: 'start',
      playerId: p.id,
      amount: rules.startingPoints,
      reason: 'start',
      affectsScore: false,
    });
  }

  return {
    id: opts.id ?? uid('battle'),
    rules,
    size,
    templateIds,
    phase: 'setup',
    playerOrder: [opts.players[0].id, opts.players[1].id],
    players,
    boards,
    turn: null,
    winnerId: null,
    endReason: null,
    transactions,
    processedActionIds: [],
    log: [],
    seed,
    rngCalls: 0,
    createdAt: Date.now(),
  };
}

export function opponentOf(state: BattleState, playerId: string): string {
  const [a, b] = state.playerOrder;
  return playerId === a ? b : a;
}

class RuleError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

const fail = (code: ErrorCode, message: string): never => {
  throw new RuleError(code, message);
};

/**
 * Apply one action atomically. The input state is never mutated: on success a new
 * state is returned; on failure nothing changes. Repeated action ids are no-ops.
 */
export function applyAction(state: BattleState, action: BattleAction): ApplyResult {
  if (!action || typeof action.actionId !== 'string' || action.actionId.length === 0) {
    return { ok: false, code: 'INVALID_ACTION', error: 'Action id required' };
  }
  if (state.processedActionIds.includes(action.actionId)) {
    return { ok: true, state, events: [], duplicate: true };
  }
  if (!state.players[action.playerId]) {
    return { ok: false, code: 'UNKNOWN_PLAYER', error: 'Unknown player' };
  }
  const s: BattleState = structuredClone(state);
  const events: BattleEvent[] = [];
  try {
    reduce(s, action, events);
  } catch (e) {
    if (e instanceof RuleError) return { ok: false, code: e.code, error: e.message };
    throw e;
  }
  s.processedActionIds.push(action.actionId);
  s.log.push(...events);
  return { ok: true, state: s, events, duplicate: false };
}

/* --------------------------- point ledger --------------------------- */

function transact(
  s: BattleState,
  eventId: string,
  playerId: string,
  amount: number,
  reason: TxReason,
  affectsScore: boolean,
): number {
  // Exactly-once guard: one transaction per (event, player, reason).
  if (s.transactions.some((t) => t.eventId === eventId && t.playerId === playerId && t.reason === reason)) return 0;
  const p = s.players[playerId];
  const applied = amount < 0 ? Math.max(amount, -p.balance) : amount; // never negative balance
  p.balance += applied;
  if (affectsScore) p.score += applied;
  s.transactions.push({ id: uid('tx'), eventId, playerId, amount: applied, reason, affectsScore });
  return applied;
}

function purchase(s: BattleState, playerId: string, ability: AbilityId, eventId: string, events: BattleEvent[]) {
  const cost = s.rules.abilityCosts[ability];
  const p = s.players[playerId];
  if (p.balance < cost) fail('INSUFFICIENT_POINTS', `${ability} costs ${cost} points, you have ${p.balance}`);
  transact(s, eventId, playerId, -cost, 'purchase', false);
  events.push({ kind: 'purchase', playerId, ability, cost });
}

/* ----------------------------- reducer ------------------------------ */

function requirePhase(s: BattleState, phase: BattleState['phase']) {
  if (s.phase !== phase) fail('WRONG_PHASE', `Action not allowed during ${s.phase} phase`);
}

function requireTurn(s: BattleState, playerId: string) {
  requirePhase(s, 'active');
  if (!s.turn || s.turn.playerId !== playerId) fail('NOT_YOUR_TURN', 'It is not your turn');
}

function requireAbilityAllowed(s: BattleState) {
  const t = s.turn!;
  if (t.manualLocked && !s.rules.allowAbilitiesAfterMiss) fail('MANUAL_LOCKED', 'Abilities are disabled after a miss');
  if (t.abilitiesUsed > 0 && !s.rules.allowMultipleAbilitiesPerTurn) fail('ABILITY_LIMIT', 'Only one ability per turn');
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : NaN;
}

function shipAt(board: Board, x: number, y: number): { ship: ShipInstance; idx: number } | null {
  for (const ship of board.ships) {
    const idx = ship.cells.findIndex((c) => c.x === x && c.y === y);
    if (idx >= 0) return { ship, idx };
  }
  return null;
}

function reduce(s: BattleState, a: BattleAction, events: BattleEvent[]) {
  const me = s.players[a.playerId];
  const myBoard = s.boards[a.playerId];
  switch (a.type) {
    case 'placeShips': {
      requirePhase(s, 'setup');
      if (me.ready) fail('ALREADY_READY', 'Unready before changing your fleet');
      const blocked = new Set(myBoard.mines.map((m) => key(m.x, m.y)));
      const err = validateFleet(s.size, s.templateIds, a.placements, blocked);
      if (err) fail('INVALID_PLACEMENT', err);
      myBoard.ships = a.placements.map((p) => {
        const cells = placementCells(p);
        return {
          id: uid('ship'),
          templateId: p.templateId,
          cells,
          hits: cells.map(() => false),
          sunk: false,
          placement: { templateId: p.templateId, x: p.x, y: p.y, orientation: p.orientation },
        };
      });
      events.push({ kind: 'ships-placed', playerId: a.playerId });
      return;
    }
    case 'clearShips': {
      requirePhase(s, 'setup');
      if (me.ready) fail('ALREADY_READY', 'Unready before changing your fleet');
      myBoard.ships = [];
      return;
    }
    case 'placeMine': {
      const x = int(a.x);
      const y = int(a.y);
      if (s.phase === 'setup') {
        if (!s.rules.allowMinesInSetup) fail('WRONG_PHASE', 'Mines cannot be placed during setup');
        if (me.ready) fail('ALREADY_READY', 'Unready before placing mines');
      } else {
        requireTurn(s, a.playerId);
        if (!s.rules.allowMinesInTurn) fail('WRONG_PHASE', 'Mines can only be placed during setup');
        requireAbilityAllowed(s);
      }
      if (!inBounds(s.size, x, y)) fail('OUT_OF_BOUNDS', 'Mine must be on your board');
      if (shipAt(myBoard, x, y)) fail('INVALID_PLACEMENT', 'Mines cannot be placed on ship cells');
      if (myBoard.mines.some((m) => m.x === x && m.y === y)) fail('INVALID_PLACEMENT', 'There is already a mine here');
      if (myBoard.shots[key(x, y)]) fail('INVALID_PLACEMENT', 'That cell has already been attacked');
      const active = myBoard.mines.filter((m) => m.active).length;
      if (s.rules.maxMinesPerBoard > 0 && active >= s.rules.maxMinesPerBoard) fail('ABILITY_LIMIT', 'Mine limit reached');
      purchase(s, a.playerId, 'mine', a.actionId, events);
      myBoard.mines.push({ id: uid('mine'), x, y, active: true, knownBy: [] });
      if (s.turn && s.phase === 'active') s.turn.abilitiesUsed += 1;
      events.push({ kind: 'mine-placed', playerId: a.playerId });
      return;
    }
    case 'ready': {
      requirePhase(s, 'setup');
      if (me.ready) fail('ALREADY_READY', 'Already ready');
      if (myBoard.ships.length !== s.templateIds.length) fail('NOT_READY', 'Place all ships first');
      me.ready = true;
      events.push({ kind: 'ready', playerId: a.playerId, ready: true });
      if (s.playerOrder.every((id) => s.players[id].ready)) {
        const rng = createRng(s.seed + 7919 * ++s.rngCalls);
        const first = s.playerOrder[rng() < 0.5 ? 0 : 1];
        s.phase = 'active';
        s.turn = { playerId: first, number: 1, manualLocked: false, abilitiesUsed: 0 };
        events.push({ kind: 'battle-started', firstPlayerId: first });
      }
      return;
    }
    case 'unready': {
      requirePhase(s, 'setup');
      if (!me.ready) fail('NOT_READY', 'Not ready');
      me.ready = false;
      events.push({ kind: 'ready', playerId: a.playerId, ready: false });
      return;
    }
    case 'attack': {
      requireTurn(s, a.playerId);
      if (s.turn!.manualLocked) fail('MANUAL_LOCKED', 'You missed — manual attacks are disabled until your next turn');
      const x = int(a.x);
      const y = int(a.y);
      if (!inBounds(s.size, x, y)) fail('OUT_OF_BOUNDS', 'Target is outside the board');
      const oppId = opponentOf(s, a.playerId);
      const board = s.boards[oppId];
      if (board.shots[key(x, y)]) fail('ALREADY_ATTACKED', 'That cell has already been attacked');
      const turnNo = s.turn!.number;
      const mine = board.mines.find((m) => m.active && m.x === x && m.y === y);
      if (mine) {
        // Mine is a separate event: no manual-attack point, attacker penalised, owner rewarded, counts as a miss.
        mine.active = false;
        mine.outcome = 'triggered';
        if (!mine.knownBy.includes(a.playerId)) mine.knownBy.push(a.playerId);
        board.shots[key(x, y)] = { x, y, result: 'mine', source: 'manual', turn: turnNo };
        transact(s, a.actionId, a.playerId, -s.rules.minePenaltyAttacker, 'mine-penalty', true);
        transact(s, a.actionId, oppId, s.rules.mineRewardOwner, 'mine-reward', true);
        s.turn!.manualLocked = true;
        events.push({ kind: 'mine-triggered', eventId: a.actionId, attackerId: a.playerId, ownerId: oppId, x, y });
        events.push({ kind: 'attack', eventId: a.actionId, attackerId: a.playerId, source: 'manual', cells: [{ x, y, result: 'mine' }], sunk: [] });
        events.push({ kind: 'manual-locked', playerId: a.playerId });
        return;
      }
      transact(s, a.actionId, a.playerId, s.rules.manualAttackReward, 'manual-attack', true);
      const target = shipAt(board, x, y);
      if (!target) {
        board.shots[key(x, y)] = { x, y, result: 'miss', source: 'manual', turn: turnNo };
        s.turn!.manualLocked = true;
        events.push({ kind: 'attack', eventId: a.actionId, attackerId: a.playerId, source: 'manual', cells: [{ x, y, result: 'miss' }], sunk: [] });
        events.push({ kind: 'manual-locked', playerId: a.playerId });
        return;
      }
      board.shots[key(x, y)] = { x, y, result: 'hit', source: 'manual', shipId: target.ship.id, turn: turnNo };
      target.ship.hits[target.idx] = true;
      const sunk: { templateId: string; cells: Coord[] }[] = [];
      if (target.ship.hits.every(Boolean)) {
        target.ship.sunk = true;
        sunk.push({ templateId: target.ship.templateId, cells: target.ship.cells });
        transact(s, a.actionId, a.playerId, s.rules.sinkBonusAttacker, 'sink-bonus', true);
        transact(s, a.actionId, oppId, s.rules.sinkCompensationOwner, 'sink-compensation', true);
      }
      events.push({ kind: 'attack', eventId: a.actionId, attackerId: a.playerId, source: 'manual', cells: [{ x, y, result: 'hit' }], sunk });
      checkVictory(s, a.playerId, events);
      return;
    }
    case 'airstrike': {
      requireTurn(s, a.playerId);
      requireAbilityAllowed(s);
      if (a.axis !== 'row' && a.axis !== 'col') fail('INVALID_ACTION', 'Axis must be row or col');
      const idx = int(a.index);
      if (!(idx >= 0 && idx < s.size)) fail('OUT_OF_BOUNDS', 'Row/column outside the board');
      purchase(s, a.playerId, 'airstrike', a.actionId, events);
      const cells: Coord[] = [];
      for (let i = 0; i < s.size; i++) cells.push(a.axis === 'row' ? { x: i, y: idx } : { x: idx, y: i });
      resolveAbilityCells(s, a.playerId, a.actionId, 'airstrike', cells, events);
      return;
    }
    case 'nuke': {
      requireTurn(s, a.playerId);
      requireAbilityAllowed(s);
      const x = int(a.x);
      const y = int(a.y);
      if (!inBounds(s.size, x, y) || !inBounds(s.size, x + 1, y + 1)) fail('OUT_OF_BOUNDS', 'The 2×2 blast must fit on the board');
      purchase(s, a.playerId, 'nuke', a.actionId, events);
      const cells = [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
      resolveAbilityCells(s, a.playerId, a.actionId, 'nuke', cells, events);
      return;
    }
    case 'radar': {
      requireTurn(s, a.playerId);
      requireAbilityAllowed(s);
      const x = int(a.x);
      const y = int(a.y);
      if (!inBounds(s.size, x, y)) fail('OUT_OF_BOUNDS', 'Radar centre must be on the board');
      purchase(s, a.playerId, 'radar', a.actionId, events);
      const win = radarWindow(s.size, x, y);
      const board = s.boards[opponentOf(s, a.playerId)];
      const cells: { x: number; y: number; ship: boolean; mine: boolean }[] = [];
      for (let yy = win.y; yy < win.y + win.size; yy++) {
        for (let xx = win.x; xx < win.x + win.size; xx++) {
          const mine = board.mines.find((m) => m.active && m.x === xx && m.y === yy);
          if (mine && !mine.knownBy.includes(a.playerId)) mine.knownBy.push(a.playerId);
          cells.push({ x: xx, y: yy, ship: !!shipAt(board, xx, yy), mine: !!mine });
        }
      }
      me.radar.push({ id: a.actionId, x: win.x, y: win.y, size: win.size, cells, turn: s.turn!.number });
      s.turn!.abilitiesUsed += 1;
      events.push({ kind: 'radar', eventId: a.actionId, attackerId: a.playerId, x: win.x, y: win.y });
      return;
    }
    case 'endTurn':
    case 'timeout': {
      requireTurn(s, a.playerId);
      // Turn rule: you may not end your turn while a legal manual shot remains (timeouts bypass it).
      if (a.type === 'endTurn') {
        const blocked = endTurnBlocker(s.turn!, Object.keys(s.boards[opponentOf(s, a.playerId)].shots).length, s.size);
        if (blocked) fail('MUST_FIRE', blocked);
      }
      const next = opponentOf(s, a.playerId);
      const number = s.turn!.number + 1;
      s.turn = { playerId: next, number, manualLocked: false, abilitiesUsed: 0 };
      events.push({ kind: 'turn-ended', playerId: a.playerId, nextPlayerId: next, turn: number, ...(a.type === 'timeout' ? { timedOut: true } : {}) });
      return;
    }
    case 'forfeit': {
      if (s.phase === 'finished') fail('WRONG_PHASE', 'Battle already finished');
      s.phase = 'finished';
      s.winnerId = opponentOf(s, a.playerId);
      s.endReason = 'forfeit';
      events.push({ kind: 'battle-finished', winnerId: s.winnerId, reason: 'forfeit' });
      return;
    }
    default:
      fail('INVALID_ACTION', 'Unknown action');
  }
}

/** Boundary policy: the 3×3 window is shifted inwards so it always lies fully on the board. */
export function radarWindow(size: number, cx: number, cy: number) {
  const w = Math.min(3, size);
  const clamp = (v: number) => Math.max(0, Math.min(size - w, v));
  return { x: clamp(cx - 1), y: clamp(cy - 1), size: w };
}

function resolveAbilityCells(
  s: BattleState,
  attackerId: string,
  eventId: string,
  source: ShotSource,
  cells: Coord[],
  events: BattleEvent[],
) {
  const oppId = opponentOf(s, attackerId);
  const board = s.boards[oppId];
  const turnNo = s.turn!.number;
  const outcomes: CellOutcome[] = [];
  const newlySunk: ShipInstance[] = [];
  for (const { x, y } of cells) {
    const k = key(x, y);
    // Previously attacked cells are skipped: no repeat damage, no reward, no new information.
    if (board.shots[k]) {
      outcomes.push({ x, y, result: 'skipped' });
      continue;
    }
    const mine = board.mines.find((m) => m.active && m.x === x && m.y === y);
    if (mine) {
      mine.active = false;
      if (!mine.knownBy.includes(attackerId)) mine.knownBy.push(attackerId);
      board.shots[k] = { x, y, result: 'mine', source, turn: turnNo };
      if (s.rules.abilityMineInteraction === 'trigger') {
        mine.outcome = 'triggered';
        transact(s, `${eventId}:${k}`, attackerId, -s.rules.minePenaltyAttacker, 'mine-penalty', true);
        transact(s, `${eventId}:${k}`, oppId, s.rules.mineRewardOwner, 'mine-reward', true);
        events.push({ kind: 'mine-triggered', eventId, attackerId, ownerId: oppId, x, y });
        outcomes.push({ x, y, result: 'mine' });
      } else {
        mine.outcome = 'defused';
        outcomes.push({ x, y, result: 'mine-defused' });
      }
      continue;
    }
    const target = shipAt(board, x, y);
    if (target) {
      target.ship.hits[target.idx] = true;
      board.shots[k] = { x, y, result: 'hit', source, shipId: target.ship.id, turn: turnNo };
      outcomes.push({ x, y, result: 'hit' });
      if (!target.ship.sunk && target.ship.hits.every(Boolean)) {
        target.ship.sunk = true;
        newlySunk.push(target.ship);
      }
    } else {
      board.shots[k] = { x, y, result: 'miss', source, turn: turnNo };
      outcomes.push({ x, y, result: 'miss' });
    }
  }
  for (const ship of newlySunk) {
    const ev = `${eventId}:${ship.id}`;
    if (s.rules.abilitiesAwardSinkBonus) transact(s, ev, attackerId, s.rules.sinkBonusAttacker, 'sink-bonus', true);
    if (s.rules.abilitiesAwardOwnerCompensation) transact(s, ev, oppId, s.rules.sinkCompensationOwner, 'sink-compensation', true);
  }
  s.turn!.abilitiesUsed += 1;
  events.push({
    kind: 'attack',
    eventId,
    attackerId,
    source,
    cells: outcomes,
    sunk: newlySunk.map((sh) => ({ templateId: sh.templateId, cells: sh.cells })),
  });
  checkVictory(s, attackerId, events);
}

function checkVictory(s: BattleState, attackerId: string, events: BattleEvent[]) {
  const opp = s.boards[opponentOf(s, attackerId)];
  if (opp.ships.length > 0 && opp.ships.every((sh) => sh.sunk)) {
    s.phase = 'finished';
    s.winnerId = attackerId;
    s.endReason = 'all-sunk';
    events.push({ kind: 'battle-finished', winnerId: attackerId, reason: 'all-sunk' });
  }
}

/* ----------------------------- helpers ------------------------------ */

/**
 * Single source of truth for the turn-ending rule, shared by the reducer and the UI.
 * A legal manual shot exists while manual fire is not locked (no miss yet this turn)
 * and at least one opponent cell has never been attacked. Returns why End Turn is
 * blocked, or null when the turn may end.
 */
export function endTurnBlocker(turn: { manualLocked: boolean }, attackedCells: number, size: number): string | null {
  if (turn.manualLocked) return null;
  if (attackedCells >= size * size) return null;
  return 'You must keep firing: End Turn unlocks after a miss (or when no untested cell remains)';
}

/** Whether `playerId` may currently end their turn in this battle. */
export function canEndTurn(s: BattleState, playerId: string): boolean {
  if (s.phase !== 'active' || s.turn?.playerId !== playerId) return false;
  return endTurnBlocker(s.turn, Object.keys(s.boards[opponentOf(s, playerId)].shots).length, s.size) === null;
}

let actionCounter = 0;
export function newActionId(prefix = 'a'): string {
  actionCounter += 1;
  return `${prefix}_${uid('act')}_${actionCounter}`;
}

/** Statistics used for tie-breaking and results screens. */
export function battleStats(s: BattleState, playerId: string) {
  const opp = s.boards[opponentOf(s, playerId)];
  const shots = Object.values(opp.shots);
  return {
    shipsSunk: opp.ships.filter((sh) => sh.sunk).length,
    hits: shots.filter((sh) => sh.result === 'hit').length,
    misses: shots.filter((sh) => sh.result === 'miss').length,
    shipsLost: s.boards[playerId].ships.filter((sh) => sh.sunk).length,
  };
}
