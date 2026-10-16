import { applyAction, createBattle, opponentOf } from '../src/battle';
import type { RulesConfig } from '../src/config';
import type { BattleAction, BattleState, ShipPlacement } from '../src/types';

let n = 0;
export const id = () => `t${++n}`;

export const TEMPLATES = ['patrol', 'destroyer', 'corvette', 'battleship', 'carrier'];

/** Fixed fleet in the left columns, rows 0,2,4-5,7,9 — cells x>=6 are always empty water. */
export const FLEET: ShipPlacement[] = [
  { templateId: 'patrol', x: 0, y: 0, orientation: 'horizontal' },
  { templateId: 'destroyer', x: 0, y: 2, orientation: 'horizontal' },
  { templateId: 'corvette', x: 0, y: 4, orientation: 'horizontal' },
  { templateId: 'battleship', x: 0, y: 7, orientation: 'horizontal' },
  { templateId: 'carrier', x: 0, y: 9, orientation: 'horizontal' },
];

export function must(state: BattleState, action: BattleAction): BattleState {
  const r = applyAction(state, action);
  if (!r.ok) throw new Error(`${action.type} failed: ${r.error}`);
  return r.state;
}

type ActInput = BattleAction extends infer A ? (A extends BattleAction ? Omit<A, 'actionId'> & { actionId?: string } : never) : never;

export function act(state: BattleState, a: ActInput) {
  return applyAction(state, { actionId: id(), ...a } as BattleAction);
}

export function placeAndReady(s: BattleState, playerId: string, fleet = FLEET) {
  s = must(s, { type: 'placeShips', actionId: id(), playerId, placements: fleet });
  return must(s, { type: 'ready', actionId: id(), playerId });
}

/** Returns an active battle plus the attacker (player whose turn it is) and defender. */
export function activeBattle(rules: Partial<RulesConfig> = {}, seed = 1) {
  let s = createBattle({
    players: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    size: 15,
    templateIds: TEMPLATES,
    rules,
    seed,
  });
  s = placeAndReady(s, 'p1');
  s = placeAndReady(s, 'p2');
  const attacker = s.turn!.playerId;
  return { s, attacker, defender: opponentOf(s, attacker) };
}
