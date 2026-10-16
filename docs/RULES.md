# Rules and design decisions

This document is the source of truth for rules the specification left open. Every
value lives in [`packages/engine/src/config.ts`](../packages/engine/src/config.ts)
(`DEFAULT_RULES`) and can be overridden per battle or per server.

## Economy

| Event | Attacker | Owner / defender |
|---|---|---|
| Starting balance (per 1v1 battle) | 2 | 2 |
| Manual shot at a new cell (hit or miss) | +1 | – |
| Manual shot that sinks a ship | +1 +3 = **+4** | +2 |
| Ability sinks a ship (`abilitiesAwardSinkBonus`, default **on**) | +3 (no +1) | +2 |
| Manual shot triggers a mine | −1 (balance never < 0), **no** +1 | +3 |
| Airstrike / Nuke / Radar / Mine | −6 / −5 / −3 / −2 | – |

- **Balance** is spendable. **Score** = rewards − penalties; spending never lowers score.
- Every point change is a `Transaction { eventId, playerId, reason }` in the battle ledger.
  Each `(eventId, playerId, reason)` is applied **at most once**, and every action carries a
  client-generated `actionId` that is ignored if seen again. Duplicate network messages,
  reconnect replays and double clicks can therefore never pay twice.
- **Team score** is the sum of members' cumulative *scores* across all their battles, not
  their balances. Balances reset to 2 at the start of each battle.

## Turns

- A manual hit keeps the turn going, and the player may keep firing.
- A manual miss, or a triggered mine (which counts as a miss), **locks manual fire** for the
  rest of the turn. Abilities stay available (`allowAbilitiesAfterMiss`).
- **You cannot end your turn while a legal manual shot remains.** A legal shot exists while
  manual fire is unlocked (no miss yet this turn) and at least one opponent cell is untested.
  End Turn is rejected with `MUST_FIRE` otherwise. The rule lives in one function,
  `endTurnBlocker()` in `battle.ts`, used by the reducer and the UI alike. Abilities never
  unlock End Turn; only a miss (or a triggered mine) does, or exhausting every cell.
- Only **End Turn** passes the turn, plus the online turn timer: when it expires the server
  issues a `timeout` action, which passes the turn even though a shot remains. Clients can never
  send `timeout` (like `forfeit`, it is server-controlled).
- Several abilities may be used in one turn if affordable (`allowMultipleAbilitiesPerTurn`).
- Ability misses never lock manual fire.
- Victory is checked inside the same atomic action, after its transactions are applied.

## Abilities

| Ability | Target | Notes |
|---|---|---|
| Airstrike (6) | a full row or column | |
| Nuke (5) | 2×2; the top-left corner must keep the whole area on the board | |
| Radar (3) | 3×3 around a centre cell | **Boundary policy:** the window is shifted inward so it is always a full 3×3 on the board. It reveals, per cell, *ship / no ship* and any **active mine**. It deals no damage and earns no points. Results persist for the scanning player (and teammates who spectate). |
| Mine (2) | an empty, never-attacked cell on your own board | Allowed during setup (before Ready) and on your own turn. Hidden from opponents until triggered, defused or radar-detected. |

**Overlapping cells:** abilities may cover cells that were already attacked. Those cells are
reported as `skipped` and cause no damage, reward or new information. A ship cell is hit at
most once.

**Mines and abilities** (`abilityMineInteraction`):
- `'defuse'` (default): an Airstrike or Nuke reveals and removes the mine, and no points move.
- `'trigger'`: the mine fires as if hit by a manual shot.

A triggered mine is deactivated, so it can never fire twice.

## Ships

There are ten templates in [`ships.ts`](../packages/engine/src/ships.ts): straight 2, 3, 4 and
5, L3, L4, T4, Z4, a 2×2 square and a plus shape. `vertical` is the pattern rotated 90°
clockwise. The square and the plus allow only `horizontal`, since they are symmetric.

There is one board configuration, `BOARD_CONFIG` in `config.ts`: **15×15 with exactly 7 ships**
(the 5×5 option was removed; `createBattle` rejects any other size). Each battle randomly picks
7 distinct templates, caps the total area at 50% of the board, and *proves* the set fits by
building a placement with backtracking. If no random set fits, a validated fallback fleet
(patrol, destroyer, corvette, battleship, carrier, cruiser, frigate) is used.
Both opponents in a battle always share the same templates.

## Multiplayer

- **The server is authoritative.** Clients send intents only. The server replaces `playerId`
  with the authenticated socket's identity and namespaces `actionId` per player. Clients can
  never send `forfeit`.
- **Per-viewer views** (`viewBattle` / `viewMatch`) are the only state sent to clients. Hidden
  boards contain shots, sunk ships and revealed mines only.
- **Room codes** are 6 characters from an alphabet without ambiguous letters. Joining is only
  possible in the lobby. During a match, only existing members can reconnect, using a
  secret token that is never broadcast.
- **Timers:**
  - Setup deadline (180 s): unready players get a random fleet and are readied.
  - Turn limit (90 s): the server issues a `timeout`, which passes the turn.
- **Disconnects:** the affected battle's timers pause. After `reconnectGraceSeconds` (60 s)
  without a reconnect, the player forfeits **that battle only**, and the team match continues.
  A player who disconnects in the lobby is removed after the grace period, and host rights
  pass to the next player.

### Team schedules

- **1v1:** a single battle.
- **2v2:** a full round robin in 2 rounds. Each round's two battles run concurrently:
  `R1: A1–B1, A2–B2`, then `R2: A1–B2, A2–B1`.
- **5v5:** each player picks a preferred position 1–5. Unique picks are honoured, and clashes
  and blanks are resolved randomly into a permutation. Position *k* on team A plays position
  *k* on team B. The 5 pairings are shuffled and grouped into rounds of up to 2 concurrent
  battles (3 rounds in total).
- Every schedule is validated: no teammate pairings, and nobody is booked twice in a round.
- Players without a battle in the current round, or whose battle has finished, spectate.
  Spectators see their own team's boards in full and opponents' boards in their public form.

**Team victory:** when every scheduled battle has finished, the higher cumulative team score
wins. Ties are broken by battles won, then ships sunk, and otherwise the match is a **draw**.
One battle ending never ends the team match.

**Leaderboard (2v2 / 5v5):** `matchLeaderboard()` in `match.ts` ranks teams and players from the
authoritative battle state: points (earned score), then battles won, then ships sunk, the same
order as the team tie-break. Rows equal on all three share a rank (1, 1, 3 …) and are listed by
name, then id. The server sends it in every `MatchView`. It covers the current match only: there
is no database, so there is no cross-session global ranking.

## AI (FOPC)

- [`ai/logic.ts`](../packages/engine/src/ai/logic.ts) is a small first-order Horn-clause engine.
  It provides variables, unification, conjunctive bodies, negation-as-failure with
  stratification, built-in predicates, and forward chaining to a fixpoint.
- [`ai/knowledge.ts`](../packages/engine/src/ai/knowledge.ts) declares the predicates and
  rules R1–R4, R7 and R9 as data (for example
  `OpenHit(x,y) ∧ Adjacent(x,y,u,v) ∧ Untested(u,v) ∧ ¬NotShipAt(u,v) → Candidate(u,v)`).
- [`ai/agent.ts`](../packages/engine/src/ai/agent.ts) runs the pipeline:

  `observe → infer → enumerate placements (R5) → filter (R6) → rank (R8) → select → act`

While a legal shot remains the AI always fires (with a first-untested-cell fallback), so it
never asks for an illegal End Turn.

The AI receives **only** `viewBattle(state, aiId)`, and it throws an error if given a revealed
opponent board. Its actions go through the same `applyAction` as human actions.

| Difficulty | Reasoning | Abilities |
|---|---|---|
| Basic | R1–R4; random candidate, otherwise random untested water | none |
| Strategic | + R7 line extension, R9 radar targets, placement enumeration, parity hunting | Radar |
| Advanced | + full placement-density ranking | Airstrike / Nuke when expected value is high; a setup mine; defensive mines during its turn (own empty water, max 2 active, keeps a radar reserve) |

The difficulty levels differ only in inference strength and strategy. None of them cheat.
