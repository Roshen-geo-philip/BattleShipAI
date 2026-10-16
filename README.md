# Logic Battleship

A Battleship game with a points economy, ten ship shapes, four purchasable abilities and an AI
that reasons in first-order logic. The landing page offers three modes: **Versus AI**,
**Local PNP** (pass and play) and **Online**, which opens a menu of **1v1**, **2v2** and **5v5**.
Every battle is played on a 15×15 board with 7 ships.

## Quick start

Requires Node.js 20 or later (developed on Node 22).

```bash
npm install
npm test             # engine + multiplayer test suites
npm run dev          # server on :3001 and Vite client on :5173 (proxied)
```

Open http://localhost:5173.

To play online from a phone on the same Wi-Fi, open `http://<your-LAN-IP>:5173`. Vite runs with
`--host`, so room QR codes encode that address.

### Production

```bash
npm run build        # builds packages/client/dist
npm start            # one Node process serves the client, the API and the WebSockets on $PORT
```

Copy `.env.example` to set the port, CORS origins, timers, and (if the client is hosted
separately) `VITE_SERVER_URL` / `VITE_PUBLIC_URL`.

## Project layout

```
packages/
  engine/   Pure TypeScript game engine shared by the client and server
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

**Architecture.** Every action, from humans, from the AI and from the server's timers, goes
through `applyAction`. It validates the action against the current phase, the turn, the
coordinates and the player's balance. It then applies the change to a copy of the state and
returns either the new state or an error. Local and AI modes run the engine in the browser.
Online modes run it only on the server, which sends each player a `viewMatch` built for that
player.

## Deployment

- **Server:** any host that keeps a Node process alive with WebSocket support (Render, Fly.io,
  Railway, a VM). Run `npm ci && npm run build && npm start`.
- **Client:** either served by the same process (simplest), or deployed as static files
  (Netlify, Vercel, S3) with `VITE_SERVER_URL` pointing at the server and `CORS_ORIGIN` set on
  the server.
- **No database.** Rooms live in memory and idle rooms are swept after 30 minutes. A server
  restart ends live matches; see the limitations below.

## Testing

`npm test` runs 68 tests with Vitest:

- **Board:** catalog integrity, rotation, bounds, overlap, random-fleet validity over hundreds of
  seeds, exactly 7 ships on the only (15×15) board, other sizes rejected.
- **Scoring:** the starting 2 points, +1 per shot, +4 / +2 on a sink, ability costs, no shot
  reward for abilities, mine transfers applied once, no overspending, ledger reconciliation.
- **Turns:** a hit continues, a miss locks without advancing, End Turn is refused while a legal
  shot remains (before firing, after a hit, after an ability) and allowed after a miss or when no
  cell is left, server timeouts pass the turn exactly once, End Turn advances exactly once, the
  previous player is rejected, instant victory, every action rejected after the battle ends,
  atomic failures.
- **Leaderboard:** team and player ranks from authoritative state, shared ranks for ties,
  agreement with the match result.
- **AI:** inference rules, placement filtering, no access to hidden information (identical
  decisions against different hidden fleets), full legal games at every difficulty, Strategic
  beating Basic, a legal move when no candidates remain, never asking for End Turn while a shot
  remains, Advanced laying mines through the normal `placeMine` action.
- **Multiplayer:** joining, bad codes, capacity, host-only start, teams, the hidden-ship privacy
  check on every received message, duplicate messages, identity spoofing,
  reconnect-with-token, forfeit after the grace period, End Turn refused before a miss, clients
  unable to send `timeout`, and the turn timer passing the turn.

## Implemented features

- 10 ship templates. Battles get a random selection that is proven to fit. Placement supports
  preview, rotation (R key), pick-up / reposition, random deploy, mines during setup, Ready and
  Unready, and a setup deadline.
- The full economy and the four abilities, with configurable rule switches.
- Predictions: private flag marks stored only in the browser, never sent to the server.
- AI mode at three difficulties, with a live "AI inference" panel showing which rules fired and
  a "How the AI thinks" section (decision process, predicates and rules rendered from the rule
  objects, a worked example computed live by the real knowledge base, and function reference).
- Local PNP (two players, one device) with privacy handover screens.
- Ability panel with descriptions, costs and live availability. A dedicated mine-placement mode
  brings your own board into the main slot and outlines valid cells. End Turn explains why it is
  locked.
- Victory, defeat and draw screens with scores, summary, play again / rematch, review board and
  (team modes) the leaderboard.
- Online 1v1, 2v2 and 5v5:
  - Lobby: room code, QR code and copy-link, team assignment (host can move players), position
    picks.
  - Match: visible match order, team scoreboard and points leaderboard, turn and setup timers,
    connection status, auto-reconnect, spectating, results with tie-break reason, rematch.
- Match history stored on the device. Sound effects (mutable) and animations, with
  reduced-motion support. Keyboard-navigable grids with screen-reader labels.
- Visual design follows the BMW M reference: true-black canvas, uppercase 700 display type
  against Light body copy (self-hosted Inter variable as the open substitute for BMW Type Next),
  0px radius, hairlines and the M tricolor stripe as the brand mark. The visible product name is
  defined once in `packages/client/src/lib/brand.ts`.
- Responsive from 360 px phones to wide desktops, portrait and landscape. The enemy board is
  the large primary board, sized by both width and viewport height; your board is a smaller
  secondary panel, and the layout stacks on narrow screens.

## Known limitations and assumptions

- Room and match state is in memory only, so there is no persistence across server restarts
  and no horizontal scaling. Scaling out would need a shared store such as Redis, plus the
  Socket.IO Redis adapter.
- There are no accounts. Identity is a per-room secret token kept in `localStorage`.
- 5v5 runs at most 2 battles at the same time (`MODE_INFO.maxConcurrent`), so a full 5v5 takes
  3 rounds.
- Leaving an active match counts as a disconnect, so the player forfeits their current battle
  after the grace period.
- Rate limiting is a simple per-socket token bucket. Production use would want IP-level limits
  at a proxy.
- The AI treats placements of different remaining ships as independent when estimating
  probabilities (the standard approximation). Exact joint enumeration would be slower.
- Boards on very narrow phones use about 20 px cells, and on short landscape phones the board is
  height-limited to about 17 px cells. Both remain usable.
- The leaderboard covers the current match (and the room's in-memory history). A persistent,
  cross-session global ranking would need a database and player accounts, which this project
  does not have.

See [docs/RULES.md](docs/RULES.md) for every rule decision.
