# shapez-agent

Lets Claude play [shapez](https://github.com/tobspr-games/shapez.io) — the factory-building
game — by giving it seven tools instead of a mouse.

A mod inside the game exposes state and building placement over a local WebSocket. On the
other end, an agent loop reads the map, does the machine-ratio arithmetic, places miners
and machines, and routes belts between them. Belt pathfinding is scripted rather than
modelled, so the agent designs factories instead of emitting tile coordinates.

```
shapez (Steam standalone, or a dev build)
  └── agent-bridge.js  (mod)
        └── WebSocket client ──► ws://127.0.0.1:8765
                                      │
                                 bridge-server.mjs
                                      ├── tools.mjs   (tool schemas + dispatch)
                                      └── agent/run.mjs
```

Status: it plays. It builds working production lines and verifies its own throughput.
It is not a good player yet.

## Layout

| Path | What it is |
|---|---|
| `mod/agent-bridge.js` | Runs inside the game. Serializes state, executes placements, steps the sim. |
| `router/belt-router.mjs` | A* belt router. Pure — no shapez deps — inlined into the mod at serve time. |
| `server/bridge-server.mjs` | WebSocket server + JSON-RPC client. `GameBridge` is the API you call. |
| `server/tools.mjs` | Seven tool definitions in Anthropic format, plus a dispatcher. |
| `server/serve-mod.mjs` | Serves the mod on :3006, inlining `@inject` modules. |
| `agent/run.mjs` | The agent loop — hands the tools to Claude and lets it build. |
| `agent/prompt.mjs` | System prompt. Tells the model to do the ratio maths before building. |
| `scripts/test-*.mjs` | Four suites, 140 checks, none needing a running game. `npm test`. |
| `scripts/install-mod.mjs` | Builds and drops the mod into the standalone's mods folder. |
| `scripts/smoke.mjs` | Drives every RPC against the real game, by hand. |

## Setup

You need a copy of shapez. The Steam build is the easy path — no toolchain, no
compiling.

### With the Steam version

```bash
npm install
npm test               # 140 checks, no game needed
npm run install-mod    # builds the mod into %APPDATA%/shapez.io/mods
```

Restart shapez. It should appear under Settings → Mods as "Agent Bridge". Then:

```bash
npm run smoke          # terminal 1 — waits for the game, exercises every call
```

Two caveats worth knowing before you install: **loading any mod disables Steam
achievements and the Puzzle DLC** (the game re-enables them when no mods are present),
and the agent will build in whatever save is loaded, so start a fresh one.

`npm run install-mod` rebuilds and reinstalls; delete the file to uninstall. If mods
don't load at all, check Steam → Properties → Betas for the `1.5.0-modloader` branch.

### From source

Only needed if you want hot reload. Requires Node 16, Yarn, ffmpeg, and Java:

```bash
git clone https://github.com/tobspr-games/shapez.io
cd shapez.io && yarn
cd gulp && yarn && yarn gulp   # dev server on http://localhost:3005
```

Copy `src/js/core/config.local.template.js` to `config.local.js` and uncomment:

```js
export default {
    fastGameEnter: true,
    externalModUrl: "http://localhost:3006/agent-bridge.js",
};
```

Then `npm run serve-mod` (port 3006 — the game's own dev server takes 3005, see
`gulp/gulpfile.js:137`). Restarting the game re-fetches the mod.

### Running the agent

Once the smoke test passes:

```bash
ANTHROPIC_API_KEY=... npm run agent
```

`AGENT_EFFORT` (default `high`), `AGENT_MAX_TURNS` (default 40), and `AGENT_GOAL`
(extra free-text direction) tune the run.

## Using the bridge

```js
import { GameBridge } from "./server/bridge-server.mjs";

const bridge = new GameBridge().start();
await bridge.waitForGame();

await bridge.setPaused(true);           // `run` becomes the only clock
const state = await bridge.observe();   // patches, entities, goal, rate constants
await bridge.place({ type: "miner", x: 10, y: 4, rotation: 180 });
await bridge.connect({ fromX: 10, fromY: 4, toX: -2, toY: -2 });  // routes itself
const result = await bridge.run(30);    // → { deliveredDelta: { CuCuCuCu: {...} } }
```

For your own agent loop, pair `TOOLS` with `createDispatcher(bridge)` from
`server/tools.mjs` — that's all `agent/run.mjs` does.

## Design notes

**The game dials out.** Browsers can't listen, so the agent process hosts the
WebSocket and the mod connects to it, retrying every 2s.

**Placement goes through the UI's own code path.** `place` calls
`computeOptimalDirectionAndRotationVariantAtTile` before `tryPlaceBuilding`, exactly
as `building_placer_logic.js:437` does. Belts, tunnels, and wires override that method
to work out corners and tunnel ends — skipping it makes every belt a straight segment
pointing the wrong way.

**`run` is a manual stepper, not wall-clock.** `setPaused(true)` installs
`PausedGameSpeed` (time multiplier 0), so the render loop stops accumulating a logic
budget. `run` then calls `core.updateLogic()` N times directly and advances
`root.time.timeSeconds` by hand. Results don't depend on framerate.

**Throughput comes from signals, not the analytics buffer.** The mod counts
`shapeDelivered` and `itemProduced` directly, so `run` reports exact counts rather than
values quantized into `ProductionAnalytics`' 1-second slices.

**Observations are compact by design.** The grid is never serialized — resource patches
come from the per-chunk `patches` summary the map generator already builds, and entities
are positional arrays (`["belt", 3, 5, 90, "default", 12]`) rather than objects. An
early-game factory is roughly 1–3k tokens.

**`rates` is the interesting field.** `getBeltBaseSpeed()`, `getMinerBaseSpeed()`, and
the per-processor speeds let a model derive correct machine ratios instead of
discovering them by trial and error.

**Belt routing is scripted, not modelled.** `connect` runs A* over the tile grid, so
the model never emits a belt coordinate. This is the single biggest lever on the action
space: without it, most of what the model does is pathfinding rather than factory design.
Search state is `(tile, incoming direction)` rather than just `(tile)`, which is what
lets a turn penalty express "prefer straight runs". A boxed-in goal is caught by
checking its four neighbours rather than by exhausting the search.

**The router is a normal ES module.** `serve-mod.mjs` inlines it into the mod at its
`// @inject` marker, stripping `export` keywords. The shapez mod loader evaluates a mod
as one script and can't import, but this keeps the router unit-testable in plain Node
instead of copy-pasted into the mod. Only allowlisted paths can be injected.

**Ports are resolved from slot geometry, not guessed.** An ejector names the direction
it pushes items *into*; an acceptor names the direction it accepts them *from*
(`item_acceptor.js`, `findMatchingSlot`). Getting that inversion backwards produces
belts that look correct and silently carry nothing, so `scripts/test-connect.mjs`
asserts the resulting tiles against a mocked game.

## Testing

`npm test` runs four suites, none of which need shapez:

| Suite | Covers |
|---|---|
| `test-router` | A*: obstacles, forced port directions, turn penalty, degenerate cases, scale |
| `test-protocol` | RPC round-trips, concurrency, error propagation, disconnect handling |
| `test-connect` | Port resolution and `connect` against a mocked game — the direction convention |
| `test-agent-loop` | The real tool runner against a mock API and a stub game |

What they don't cover: the game itself. The suites run against mocks, so `npm run smoke`
is what proves the mod works in a real game. Two of the four suites exist because a live
run found something the mocks didn't:

- **Method collision.** `init()` called `this.connect()` meaning the WebSocket, but a
  later `connect(params)` belt-routing method silently replaced it. Mod load died on
  arrival. Nothing had ever called `init()`.
- **Belt geometry.** A belt's `rotation` is the direction items *arrive* from, not the
  direction it outputs; corners live in `rotationVariant`. Every test was a straight line,
  where the two coincide, so every corner was stored wrong and quietly dropped items.

## License

GPL-3.0. shapez is GPL-3.0, and `mod/agent-bridge.js` is loaded into the game's process
and calls its internals directly, which makes the safe reading that this is a derivative
work. The Node-side code (`router/`, `server/`, `agent/`) touches no shapez source and
could stand alone under another license if you ever wanted to split it out.

No shapez code is redistributed here — you supply the game.

shapez is © tobspr Games. This project is unaffiliated.
