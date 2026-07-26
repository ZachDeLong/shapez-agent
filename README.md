# shapez-agent

Lets Claude play [shapez](https://github.com/tobspr-games/shapez.io), a factory building game.

## Why

Most factory games come down to throughput ratios and production chains, which puts a lot of
weight on the layout decisions. That seemed like an interesting thing to have a model work at.

## How it works

A mod inside the game exposes the map, building placement, and the simulation clock over a
local WebSocket. On the other end an agent loop reads the state, works out the machine
ratios, places buildings, and connects them.

Belt routing is scripted with A\* rather than left to the model. Without that, most of what
the model does is emit tile coordinates instead of designing factories.

```
shapez
  └── agent-bridge.js  (mod)
        └── WebSocket ──► bridge-server.mjs ──► agent/run.mjs
```

Seven tools: `observe`, `place`, `place_many`, `connect`, `remove`, `run`, `list_buildings`.

## Setup

You need a copy of shapez. The Steam version is easiest, no build step.

```bash
npm install
npm test               # 140 checks, no game needed
npm run install-mod    # drops the mod in %APPDATA%/shapez.io/mods
```

Restart shapez. It shows up under Settings > Mods as "Agent Bridge".

```bash
npm run smoke          # checks the connection, start or load a game when it asks
```

Then:

```bash
ANTHROPIC_API_KEY=... npm run agent
```

`AGENT_EFFORT` (default `high`), `AGENT_MAX_TURNS` (default 40) and `AGENT_GOAL` tune the run.

Two things to know: loading any mod turns off Steam achievements and the Puzzle DLC until you
remove it, and the agent builds in whatever save is open, so start a fresh one.

To uninstall, delete the file from the mods folder.

### From source

Only needed for hot reload. Build shapez per its own README, then point
`externalModUrl` at `http://localhost:3006/agent-bridge.js` in `config.local.js` and run
`npm run serve-mod`.

## Using the bridge directly

The agent loop is optional. `GameBridge` is a normal API.

```js
import { GameBridge } from "./server/bridge-server.mjs";

const bridge = new GameBridge().start();
await bridge.waitForInGame();

await bridge.setPaused(true);
const state = await bridge.observe();
await bridge.place({ type: "miner", x: 10, y: 4, rotation: 180 });
await bridge.connect({ fromX: 10, fromY: 4, toX: -2, toY: -2 });
const result = await bridge.run(30);
```

## Layout

| Path | What it is |
|---|---|
| `mod/` | Runs inside the game |
| `router/` | A\* belt router, pure and testable on its own |
| `server/` | WebSocket RPC, tool definitions, mod build |
| `agent/` | The loop and the system prompt |
| `scripts/` | Tests, smoke test, installer |

## License

GPL-3.0, because shapez is GPL-3.0 and the mod loads into its process and calls its internals.

No shapez code is included here. You bring the game. shapez is © tobspr Games, and this
project is unaffiliated.
