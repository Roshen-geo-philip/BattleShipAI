/**
 * Central rule configuration. Every gameplay decision that the specification
 * leaves open is resolved here (and documented in docs/RULES.md) instead of
 * being scattered through the code.
 */

export type AbilityId = 'airstrike' | 'nuke' | 'radar' | 'mine';

export interface BoardConfig {
  size: number;
  shipCount: number;
}

export interface RulesConfig {
  /** Balance every player starts each 1v1 battle with. */
  startingPoints: number;
  /** Reward for every new manually attacked cell (hit or miss). */
  manualAttackReward: number;
  /** Extra reward to the attacker for sinking a ship. */
  sinkBonusAttacker: number;
  /** Compensation to the owner of a sunk ship. */
  sinkCompensationOwner: number;
  abilityCosts: Record<AbilityId, number>;
  /** Whether a ship sunk by Airstrike / Nuke pays the attacker's sinking bonus. */
  abilitiesAwardSinkBonus: boolean;
  /** Whether the owner gets compensation when an ability sinks their ship. */
  abilitiesAwardOwnerCompensation: boolean;
  /** Points the attacker loses when a manual attack triggers a mine (clamped at 0 balance). */
  minePenaltyAttacker: number;
  /** Points the mine owner receives when their mine is triggered. */
  mineRewardOwner: number;
  /**
   * How Airstrike/Nuke interact with mines:
   *  - 'defuse': the mine is revealed and removed, no points move (default)
   *  - 'trigger': the mine fires exactly like a manual trigger
   */
  abilityMineInteraction: 'defuse' | 'trigger';
  /** Mines may be placed during the setup phase. */
  allowMinesInSetup: boolean;
  /** Mines may be placed on your own turn during active play. */
  allowMinesInTurn: boolean;
  /** Maximum active mines per board (0 = unlimited). */
  maxMinesPerBoard: number;
  /** Abilities may be used more than once per turn. */
  allowMultipleAbilitiesPerTurn: boolean;
  /** Abilities may still be used after a manual miss in the same turn. */
  allowAbilitiesAfterMiss: boolean;
  /** Placement deadline (seconds) used by online rooms. 0 disables it. */
  setupSeconds: number;
  /** Per-turn deadline (seconds) used by online rooms. 0 disables it. */
  turnSeconds: number;
  /** Seconds a disconnected player has to reconnect before forfeiting the battle. */
  reconnectGraceSeconds: number;
}

export const BOARD_CONFIGS: Record<'standard' | 'small', BoardConfig> = {
  standard: { size: 15, shipCount: 5 },
  small: { size: 5, shipCount: 3 },
};

export const DEFAULT_RULES: RulesConfig = {
  startingPoints: 2,
  manualAttackReward: 1,
  sinkBonusAttacker: 3,
  sinkCompensationOwner: 2,
  abilityCosts: { airstrike: 6, nuke: 5, radar: 3, mine: 2 },
  abilitiesAwardSinkBonus: true,
  abilitiesAwardOwnerCompensation: true,
  minePenaltyAttacker: 1,
  mineRewardOwner: 3,
  abilityMineInteraction: 'defuse',
  allowMinesInSetup: true,
  allowMinesInTurn: true,
  maxMinesPerBoard: 0,
  allowMultipleAbilitiesPerTurn: true,
  allowAbilitiesAfterMiss: true,
  setupSeconds: 180,
  turnSeconds: 90,
  reconnectGraceSeconds: 60,
};

export function makeRules(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    ...DEFAULT_RULES,
    ...overrides,
    abilityCosts: { ...DEFAULT_RULES.abilityCosts, ...(overrides.abilityCosts ?? {}) },
  };
}
