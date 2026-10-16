import type { BattleAction } from '@battleship/engine';

type Without<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** An action as the UI emits it: identity and idempotency id are added by the controller. */
export type ActionInput = Without<BattleAction, 'actionId' | 'playerId'>;

export type SendResult = { ok: boolean; error?: string };
export type Send = (a: ActionInput) => Promise<SendResult>;

export interface TimerInfo {
  kind: 'setup' | 'turn';
  deadline: number;
  paused: boolean;
  remaining: number | null;
}
