# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Logic Battleship**: a Battleship game with a points economy, ten ship shapes, four purchasable abilities and an AI that reasons in first-order logic. The landing page has three modes: **Versus AI**, **Local PNP** (pass and play, 2 players), **Online** (menu: **1v1**, **2v2**, **5v5**). One board: 15×15 with 7 ships.

## Commands

npm workspaces monorepo (`packages/engine`, `packages/server`, `packages/client`). Node 20+ (developed on Node 22).

```bash
npm install
npm run dev              # server (tsx watch, :3001) + Vite client (:5173, --host, proxies /socket.io and /api)
npm run dev:server       # server only
npm run dev:client       # client only
npm test                 # vitest run — all packages/*/test/**/*.test.ts (68 tests)
npm run typecheck        # tsc per package (engine, server, client); there is no linter
npm run build            # builds the client only (packages/client/dist)
npm start                # one Node process serves client dist + API + WebSockets on $PORT
```

Single test file / single test:

```bash
npx vitest run packages/engine/test/rules.test.ts
npx vitest run -t "name of the test"
```

There is no build step for the engine or server: the engine's `package.json` points `main`/`exports` at `src/index.ts`, and the server runs TypeScript directly via `tsx`. All tsconfigs are `noEmit`.

Open <http://localhost:5173> in dev. For phones on the same Wi-Fi, use `http://<LAN-IP>:5173`; because Vite runs with `--host`, room QR codes encode that address.

If :3001 is taken, run `PORT=3011 VITE_DEV_SERVER_PROXY=http://localhost:3011 npm run dev` (the Vite proxy target is configurable).

Server config comes from env vars (see `.env.example`): `PORT`, `CORS_ORIGIN`, `STATIC_DIR`, `SETUP_SECONDS`, `TURN_SECONDS`, `RECONNECT_GRACE_SECONDS`; client build-time `VITE_SERVER_URL`, `VITE_PUBLIC_URL` (only needed when the client is hosted separately).

## Project layout

```text
packages/
  engine/   Pure TypeScript game engine shared by client and server
    src/config.ts          all rule constants and open-rule decisions
    src/ships.ts           the 10 ship templates and rotation rules
    src/board.ts           placement validation, random fleets, template selection
    src/battle.ts          authoritative 1v1 reducer (atomic, idempotent, ledgered)
    src/views.ts           per-viewer projections (hidden-information boundary)
    src/ai/                FOPC logic engine, knowledge base, reasoning agent
    src/match/match.ts     teams, slots, schedules, rounds, team scoring, tie-breaks
    test/                  board / rules / AI / match tests
  server/   Express + Socket.IO; rooms, timers, reconnection, per-player sync
    test/                  multiplayer integration tests over real sockets
  client/   React + Vite UI (menu, placement, combat, lobby + QR, spectating, history)
docs/RULES.md  every rule decision, scoring table, schedules, AI design
```

## Architecture

**`@battleship/engine`** is pure TypeScript shared by client and server. It is the single source of game logic.

- `battle.ts` — `applyAction(state, action)` is the authoritative 1v1 reducer. Turn rule: End Turn is rejected (`MUST_FIRE`) while a legal manual shot remains; `endTurnBlocker()` / `canEndTurn()` are the single source of truth, shared with the UI. The server-only `timeout` action (turn timer) bypasses it; `rooms.ts` rejects `timeout` and `forfeit` from clients. Every action (human, AI, server timer) goes through it. It validates phase/turn/coords/balance, works on a copy, and returns `{ ok, state }` or `{ ok: false, error }` — failures are atomic. Victory is checked inside the same action.
- **Idempotency/ledger:** every point change is a `Transaction { eventId, playerId, reason }`; each `(eventId, playerId, reason)` applies at most once, and each action carries a client-generated `actionId` that is ignored if seen again. Preserve this when adding actions or rewards.
- `views.ts` — `viewBattle(state, viewerId, alliedIds)` is the hidden-information boundary. Only views are ever sent to clients or given to the AI; hidden boards expose only shots, sunk ships and revealed mines.
- `board.ts` — battles get a random selection of `BOARD_CONFIG.shipCount` (7) ship templates that is proven to fit the 15×15 board. `BOARD_CONFIG` in `config.ts` is the only board; `createBattle` throws on any other size.
- `match/match.ts` — teams, slots, schedules (1v1 / 2v2 round robin / 5v5 position pairings, `MODE_INFO.maxConcurrent`), `applyMatchAction`, team scoring, tie-breaks, `matchLeaderboard` (score → battles won → ships sunk, shared ranks), `viewMatch` (includes `leaderboard`).
- `config.ts` — `DEFAULT_RULES`: all rule constants and rule switches (e.g. `abilityMineInteraction`, `allowAbilitiesAfterMiss`), overridable per battle/server.
- `ai/` — `logic.ts` is a first-order Horn-clause engine (unification, negation-as-failure with stratification, forward chaining); `knowledge.ts` declares predicates and rules R1–R9 as data; `agent.ts` runs observe → infer → enumerate placements → filter → rank → act. Three difficulties. The AI receives only `viewBattle(state, aiId)` and throws if given a revealed opponent board — it must never cheat. Its moves go through `applyAction`. It treats placements of different remaining ships as independent when estimating probabilities (standard approximation).
- `rng.ts` — seedable mulberry32 `Rng`. Randomness (fleets, schedules, AI) takes an `Rng` so tests are reproducible; don't use `Math.random()` in engine logic.

**`@battleship/server`** — Express + Socket.IO. `server.ts` (`startServer`) wires sockets, a per-socket token-bucket rate limiter and `/api/health`, `/api/rooms/:code`; `rooms.ts` (`RoomManager`) holds in-memory rooms, timers, reconnection and per-player views. The server is authoritative: it overwrites `playerId` with the socket's authenticated identity, namespaces `actionId` per player, and never accepts `forfeit` from clients. Each player gets `room:state` built for them via `rooms.viewFor`. Identity is a per-room secret token (client keeps it in `localStorage`); no accounts. No database; idle rooms are swept after 30 minutes.

**`@battleship/client`** — React 18 + Vite. Design tokens (BMW M reference: black canvas, Inter 700/300, 0 radius, M tricolor stripe) live in `styles.css` `:root`; the visible app name is `APP_NAME` in `lib/brand.ts`. `components/Combat.tsx` holds the primary/secondary board layout, ability panel and mine-placement mode; `components/AIExplainer.tsx` renders rule tables from `STRATEGIC_RULES` and a live knowledge-base example; `screens/Results.tsx` holds `ResultScreen` (victory/defeat/draw) and `Leaderboard`. Local and vs-AI modes run the engine in the browser (`screens/LocalGame.tsx`, `screens/AIGame.tsx`); online modes (`screens/Online.tsx`, `lib/online.ts`) only render server-sent views. Prediction flags and match history are browser-only (never sent to the server).

## Implemented features

- Placement: preview, rotation (R key), pick-up / reposition, random deploy, mines during setup, Ready/Unready, setup deadline.
- Full economy and four abilities with configurable rule switches.
- AI mode with a live "AI inference" panel showing which rules fired.
- Local PNP with privacy handover screens.
- Ability panel (costs, descriptions, live availability), dedicated mine-placement mode, End Turn lock with reason, victory/defeat screens, team leaderboard, "How the AI thinks" explainer.
- Online lobby: room code, QR code, copy-link, team assignment (host can move players), position picks, board size.
- Online match: visible match order, team and individual scoreboards, turn and setup timers, connection status, auto-reconnect, spectating, results with tie-break reason, rematch.
- Device-local match history; mutable sound effects; animations with reduced-motion support; keyboard-navigable grids with screen-reader labels; responsive down to phone width.

## Testing notes

- Engine tests use helpers in `packages/engine/test/helpers.ts` (`must`, `act`, fixed `FLEET`/`TEMPLATES`).
- `packages/server/test/multiplayer.test.ts` starts a real server on port 0 with short timers (`reconnectGraceSeconds: 1`, `setupSeconds: 0`, `turnSeconds: 0`) and drives it with real `socket.io-client` sockets; it includes a privacy check that no received message leaks hidden ships. Global `testTimeout` is 20s.
- Engine test helpers also include `passTurn` (issues `timeout`, changes no scores) and `emptyCell`.
- Coverage areas: board (catalog, rotation, bounds, overlap, random-fleet validity over many seeds, exactly 7 ships, other sizes rejected); scoring (start 2 pts, +1/shot, +4/+2 on sink, ability costs, no shot reward for abilities, mine transfers once, no overspend, ledger reconciliation); turns (hit continues, miss locks without advancing, End Turn refused while a shot remains, timeout passes once, actions rejected after the end, End Turn advances once, previous player rejected, instant victory, atomic failures); AI (inference rules, placement filtering, identical decisions against different hidden fleets, full legal games at every difficulty, Strategic beats Basic, legal move with no candidates); multiplayer (join, bad codes, capacity, host-only start, teams, privacy, duplicate messages, identity spoofing, reconnect-with-token, forfeit after grace, End Turn refused before a miss, client `timeout` rejected); `server/test/timers.test.ts` checks the turn timer passes the turn; leaderboard ranking in `match.test.ts`.

## Deployment

- Server: any host keeping a Node process alive with WebSocket support (Render, Fly.io, Railway, VM): `npm ci && npm run build && npm start`.
- Client: served by the same process (simplest), or as static files (Netlify, Vercel, S3) with `VITE_SERVER_URL` pointing at the server and `CORS_ORIGIN` set on the server.

## Known limitations

- State is in memory only: no persistence across restarts (a restart ends live matches), no horizontal scaling (would need Redis + Socket.IO Redis adapter).
- 5v5 runs at most 2 battles concurrently (`MODE_INFO.maxConcurrent`), so a full 5v5 takes 3 rounds.
- Leaving an active match counts as a disconnect → forfeit of the current battle after the grace period.
- Rate limiting is per-socket only; production would want IP-level limits at a proxy.
- 15×15 boards are small (~20 px cells) on very narrow phones but usable.
- The leaderboard is per match/room (in memory); no cross-session global ranking without a database.

## Rules

`docs/RULES.md` is the source of truth for rule decisions (economy table, turn locking, abilities, mines, ship selection, schedules, tie-breaks, AI difficulty levels). Update it alongside `config.ts` when changing a rule.
