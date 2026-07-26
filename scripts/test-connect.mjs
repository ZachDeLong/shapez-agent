// Tests the mod's port resolution and `connect` against a mocked game.
//
// This is the highest-risk logic in the bridge: the ejector/acceptor direction
// convention is easy to get backwards, and getting it wrong produces belts that
// look right and silently carry nothing. So we build the mod exactly as the
// server serves it, run it against a fake root, and assert the tiles.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMod } from "../server/serve-mod.mjs";
import { beltOutputDirection, DIR_VECTOR } from "../router/belt-router.mjs";

const ANGLE_DIR = { 0: "top", 90: "right", 180: "bottom", 270: "left" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every RPC the agent side can send: the seven the tool dispatcher maps to
// (server/tools.mjs) plus the two the bridge calls directly.
const TOOL_NAMES = [
    "observe",
    "buildings",
    "place",
    "placeMany",
    "connect",
    "remove",
    "run",
    "ping",
    "setPaused",
];

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
    checks++;
    if (!cond) failures++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

// --- mock shapez globals -----------------------------------------------------

class Vector {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }
    add(o) {
        return new Vector(this.x + o.x, this.y + o.y);
    }
    equals(o) {
        return this.x === o.x && this.y === o.y;
    }
    copy() {
        return new Vector(this.x, this.y);
    }
}

/** Minimal stand-in for shapez.Mod — the real base sets up signals. */
function makeSignal() {
    const handlers = [];
    return { add: fn => handlers.push(fn), dispatch: (...a) => handlers.forEach(h => h(...a)), handlers };
}

const modSignals = { gameStarted: makeSignal(), appBooted: makeSignal() };

const shapez = {
    Mod: class {
        constructor() {
            this.signals = modSignals;
            this.modInterface = {};
        }
    },
    Vector,
    enumDirectionToVector: {
        top: { x: 0, y: -1 },
        right: { x: 1, y: 0 },
        bottom: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
    },
    enumInvertedDirections: { top: "bottom", right: "left", bottom: "top", left: "right" },
    enumAngleToDirection: { 0: "top", 90: "right", 180: "bottom", 270: "left" },
    enumItemProcessorTypes: {},
    defaultBuildingVariant: "default",
    globalConfig: { mapChunkSize: 16 },
    gMetaBuildingRegistry: {
        hasId: id => id === "belt",
        getAllIds: () => ["belt"],
        findById: () => ({
            getLayer: () => "regular",
            // Belts auto-orient in the real game; here we just honour the
            // rotation the router asked for, which is what we're testing.
            computeOptimalDirectionAndRotationVariantAtTile: ({ rotation }) => ({
                rotation,
                rotationVariant: 0,
            }),
        }),
    },
};

/**
 * A 1x1 building at (x,y). Slots are given in world directions; local space is
 * identity here so the test asserts the direction convention, not rotation math
 * (which is shapez's own `localDirectionToWorld`, already covered by the game).
 */
function building({
    x,
    y,
    ejects = [],
    accepts = [],
    id = "machine",
    rotation = 0,
    rotationVariant = 0,
    belt = false,
}) {
    const origin = new Vector(x, y);
    return {
        uid: `${id}@${x},${y}`,
        components: {
            // Belts carry a BeltComponent and no ejector/acceptor at all.
            Belt: belt ? { direction: "top" } : undefined,
            StaticMapEntity: {
                origin,
                rotation,
                getRotationVariant: () => rotationVariant,
                getMetaBuilding: () => ({ getId: () => id }),
                getVariant: () => "default",
                getTileSize: () => new Vector(1, 1),
                localTileToWorld: local => new Vector(origin.x + local.x, origin.y + local.y),
                localDirectionToWorld: d => d,
                worldToLocalTile: w => new Vector(w.x - origin.x, w.y - origin.y),
            },
            ItemEjector: ejects.length
                ? { slots: ejects.map(d => ({ pos: new Vector(0, 0), direction: d })) }
                : undefined,
            ItemAcceptor: accepts.length
                ? { slots: accepts.map(d => ({ pos: new Vector(0, 0), direction: d })) }
                : undefined,
        },
    };
}

/** Fake root backed by a tile map. Records every placement. */
function makeRoot(entities = []) {
    const tiles = new Map();
    for (const e of entities) {
        const o = e.components.StaticMapEntity.origin;
        tiles.set(`${o.x},${o.y}`, e);
    }
    const placed = [];
    return {
        placed,
        tiles,
        map: {
            getTileContent: (tile, _layer) => tiles.get(`${tile.x},${tile.y}`) || null,
            placeStaticEntity: () => {},
        },
        logic: {
            tryPlaceBuilding: ({ origin, rotation, rotationVariant, building: meta, variant }) => {
                if (tiles.has(`${origin.x},${origin.y}`)) return null;
                const e = building({
                    x: origin.x,
                    y: origin.y,
                    id: "belt",
                    belt: true,
                    rotation,
                    rotationVariant: rotationVariant ?? 0,
                });
                tiles.set(`${origin.x},${origin.y}`, e);
                placed.push({ x: origin.x, y: origin.y, rotation, rotationVariant });
                return e;
            },
            tryDeleteBuilding: entity => {
                const o = entity.components.StaticMapEntity.origin;
                tiles.delete(`${o.x},${o.y}`);
                return true;
            },
        },
        entityMgr: {
            entities: entities.slice(),
            findByUid: uid => [...tiles.values()].find(e => e.uid === uid) || null,
        },
        signals: { entityManuallyPlaced: { dispatch: () => {} } },
    };
}

// --- load the built mod ------------------------------------------------------

const source = await buildMod(await readFile(join(ROOT, "mod", "agent-bridge.js"), "utf8"));

// Records every WebSocket the mod tries to open, so the lifecycle test can
// confirm init() actually reaches the socket setup.
const socketAttempts = [];
class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
        socketAttempts.push(url);
        this.url = url;
        this.readyState = 0;
    }
    send() {}
    close() {}
}

const fakeWindow = {};
const ModClass = new Function(
    "shapez",
    "window",
    "WebSocket",
    `${source}\nreturn Mod;`
)(shapez, fakeWindow, FakeWebSocket);

function newMod(root) {
    const mod = new ModClass();
    mod.root = root;
    mod.counters = { delivered: {}, produced: {} };
    return mod;
}

// --- tests -------------------------------------------------------------------

// This section exists because a real bug got past every other test: `init()`
// called this.connect() meaning the WebSocket, but a later `connect(params)`
// belt-routing method silently replaced it, so mod load died with
// "Cannot destructure property 'fromX' of 'undefined'". Nothing here had ever
// called init(), so nothing caught it.
console.log("=== mod lifecycle ===");
{
    const mod = new ModClass();
    let threw = null;
    try {
        mod.init();
    } catch (ex) {
        threw = ex.message;
    }
    check("init() does not throw", !threw, threw || "");
    check("  it opens the bridge socket", socketAttempts.length === 1, socketAttempts.join());
    check("  pointed at the bridge URL", /ws:\/\/127\.0\.0\.1:\d+/.test(socketAttempts[0] || ""),
        socketAttempts[0]);
    check("  and registers a gameStarted handler", modSignals.gameStarted.handlers.length === 1);
}
{
    // The collision above was invisible because both names were valid methods.
    // Assert the socket setup and the RPC are genuinely different functions.
    const mod = new ModClass();
    check("connectSocket and connect are distinct methods",
        typeof mod.connectSocket === "function" &&
        typeof mod.connect === "function" &&
        mod.connectSocket !== mod.connect);
    check("  connect takes routing params, not zero args", mod.connect.length === 1);
    check("  connectSocket takes none", mod.connectSocket.length === 0);
}
{
    // Every tool the agent can call must have a case in the mod's dispatcher,
    // or it fails only at runtime, in the game.
    // `ping` is answered by an early `if` rather than a switch case, so it can
    // reply before a game is loaded — accept either form.
    const handled = new Set([
        ...[...source.matchAll(/case "([a-zA-Z_]+)":/g)].map(m => m[1]),
        ...[...source.matchAll(/method === "([a-zA-Z_]+)"/g)].map(m => m[1]),
    ]);
    const missing = TOOL_NAMES.filter(n => !handled.has(n));
    check("every tool has a dispatch case in the mod", missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : `${TOOL_NAMES.length} tools`);
}

// patch.pos is the centroid of a patch's tiles, so it is fractional and can sit
// on a tile with no resource on it. Miners must go on an actual resource tile.
console.log("\n=== resource patch anchoring ===");
{
    const CHUNK = 16;
    const makeItem = key => ({ getAsCopyableKey: () => key, getItemType: () => "shape" });
    const layer = Array.from({ length: CHUNK }, () => Array(CHUNK).fill(null));
    // An L-shaped patch, chosen so its centroid falls on an empty tile.
    const cells = [[2, 2], [3, 2], [4, 2], [2, 3], [2, 4]];
    for (const [x, y] of cells) layer[x][y] = makeItem("CuCuCuCu");

    const chunk = {
        tileX: 32,
        tileY: -16,
        lowerLayer: layer,
        patches: [{ pos: { x: 2.6, y: 2.6 }, item: makeItem("CuCuCuCu"), size: 3 }],
    };

    const mod = newMod(makeRoot([]));
    // Only chunk (2,-1) exists — the rest of the scanned area is empty, as in a
    // real map.
    mod.root.map.getChunk = (cx2, cy2) => (cx2 === 2 && cy2 === -1 ? chunk : null);

    const anchor = mod.nearestResourceTile(chunk, "CuCuCuCu", 32 + 2.6, -16 + 2.6);
    check("anchor is an integer tile",
        Number.isInteger(anchor.x) && Number.isInteger(anchor.y), JSON.stringify(anchor));
    check("  it holds the resource",
        layer[anchor.x - chunk.tileX][anchor.y - chunk.tileY]?.getAsCopyableKey() === "CuCuCuCu");
    check("  counts every tile in the patch", anchor.count === cells.length, `${anchor.count}`);

    const patches = mod.resourcePatches(32 + 3, -16 + 3, 40);
    check("observe reports integer patch coordinates",
        patches.length > 0 && patches.every(p => Number.isInteger(p.x) && Number.isInteger(p.y)),
        JSON.stringify(patches));
    check("  each patch appears once", patches.length === 1, `${patches.length} entries`);
    check("  and a tile count, not a generation radius",
        patches[0]?.tiles === cells.length, JSON.stringify(patches[0]));
}
{
    // A resource the chunk doesn't actually contain must not be reported.
    const CHUNK = 16;
    const layer = Array.from({ length: CHUNK }, () => Array(CHUNK).fill(null));
    const chunk = {
        tileX: 0,
        tileY: 0,
        lowerLayer: layer,
        patches: [{ pos: { x: 5.5, y: 5.5 }, item: { getAsCopyableKey: () => "gone", getItemType: () => "shape" }, size: 3 }],
    };
    const mod = newMod(makeRoot([]));
    mod.root.map.getChunk = () => chunk;
    check("a patch with no remaining tiles is dropped", mod.resourcePatches(5, 5, 20).length === 0);
}

console.log("\n=== port resolution ===");
{
    // A miner ejecting upward: the belt run must start on the tile above it,
    // and that belt must itself point up or the miner won't hand items over.
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const mod = newMod(makeRoot([miner]));
    const port = mod.resolveSourcePort(5, 5, { x: 5, y: 0 });
    check("source tile is in front of the ejector", port.tile.x === 5 && port.tile.y === 4,
        JSON.stringify(port.tile));
    check("source direction matches the ejector", port.direction === "top");
}
{
    // An acceptor declares the direction items arrive FROM, so a slot accepting
    // "from bottom" is fed by the tile below, by a belt pointing up.
    const cutter = building({ x: 5, y: 0, accepts: ["bottom"], id: "cutter" });
    const mod = newMod(makeRoot([cutter]));
    const port = mod.resolveDestPort(5, 0, { x: 5, y: 5 });
    check("dest feeding tile is below the acceptor", port.tile.x === 5 && port.tile.y === 1,
        JSON.stringify(port.tile));
    check("final belt points into the building", port.lastDirection === "top",
        `got ${port.lastDirection}`);
}
{
    // Two outputs: prefer the one nearer the destination.
    const splitter = building({ x: 0, y: 0, ejects: ["left", "right"], id: "balancer" });
    const mod = newMod(makeRoot([splitter]));
    const near = mod.resolveSourcePort(0, 0, { x: 10, y: 0 });
    check("picks the output facing the destination", near.direction === "right",
        `got ${near.direction}`);
    const far = mod.resolveSourcePort(0, 0, { x: -10, y: 0 });
    check("...and the other way round", far.direction === "left", `got ${far.direction}`);
}
{
    // Preferring a free slot beats preferring a near one.
    const splitter = building({ x: 0, y: 0, ejects: ["left", "right"], id: "balancer" });
    const wall = building({ x: 1, y: 0, id: "wall" });
    const mod = newMod(makeRoot([splitter, wall]));
    const port = mod.resolveSourcePort(0, 0, { x: 10, y: 0 });
    check("skips a blocked output even when it is nearer", port.direction === "left",
        `got ${port.direction}`);
}
{
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const wall = building({ x: 5, y: 4, id: "wall" });
    const mod = newMod(makeRoot([miner, wall]));
    // The resolver reports blockage rather than throwing, so connect() can
    // first rule out a direct building-to-building hookup.
    const port = mod.resolveSourcePort(5, 5, { x: 5, y: 0 });
    check("a blocked output is reported, not thrown", port.free === false);

    let threw = "";
    try {
        mod.connect({ fromX: 5, fromY: 5, toX: 5, toY: 0 });
    } catch (ex) {
        threw = ex.message;
    }
    check("  connect turns it into a clear error", /output.*blocked/i.test(threw), threw);
}
{
    const mod = newMod(makeRoot([]));
    const port = mod.resolveSourcePort(3, 3, { x: 0, y: 0 });
    check("a bare tile has no direction constraint",
        port.tile.x === 3 && port.tile.y === 3 && port.direction === null);
}

console.log("\n=== connect ===");
{
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 5, y: 0, accepts: ["bottom"], id: "cutter" });
    const root = makeRoot([miner, cutter]);
    const mod = newMod(root);
    const r = mod.connect({ fromX: 5, fromY: 5, toX: 5, toY: 0 });

    check("straight run places 4 belts", r.placed === 4, `placed ${r.placed}`);
    check("  spans the gap between the machines",
        root.placed.every(p => p.x === 5 && p.y >= 1 && p.y <= 4));
    check("  every belt points up (rotation 0)", root.placed.every(p => p.rotation === 0));
    check("  no belt overwrites a machine",
        !root.placed.some(p => (p.x === 5 && p.y === 5) || (p.x === 5 && p.y === 0)));
}
{
    // Around a corner: source ejects up, destination accepts from its left.
    const miner = building({ x: 0, y: 5, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 4, y: 0, accepts: ["left"], id: "cutter" });
    const root = makeRoot([miner, cutter]);
    const mod = newMod(root);
    const r = mod.connect({ fromX: 0, fromY: 5, toX: 4, toY: 0 });

    check("cornering run succeeds", r.placed > 0, `placed ${r.placed}`);
    const first = root.placed[0];
    const last = root.placed[root.placed.length - 1];
    check("  first belt sits above the miner and points up",
        first.x === 0 && first.y === 4 && first.rotation === 0,
        JSON.stringify(first));
    check("  last belt sits left of the cutter and points right",
        last.x === 3 && last.y === 0 && last.rotation === 90,
        JSON.stringify(last));
}
{
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const hub = building({ x: 5, y: 4, accepts: ["bottom"], id: "hub" });
    const mod = newMod(makeRoot([miner, hub]));
    const r = mod.connect({ fromX: 5, fromY: 5, toX: 5, toY: 4 });
    check("touching machines report already-connected", r.alreadyConnected === true);
    check("  and place nothing", r.placed === 0);
}
{
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 5, y: 0, accepts: ["bottom"], id: "cutter" });
    const root = makeRoot([miner, cutter]);
    const mod = newMod(root);
    const r = mod.connect({ fromX: 5, fromY: 5, toX: 5, toY: 0, dryRun: true });
    check("dry run returns a route", r.dryRun === true && r.tiles.length === 4);
    check("  but builds nothing", root.placed.length === 0);
}
{
    // Wall the destination in completely.
    const miner = building({ x: 5, y: 5, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 5, y: 0, accepts: ["bottom"], id: "cutter" });
    const walls = [
        building({ x: 5, y: 1, id: "wall" }),
        building({ x: 4, y: 0, id: "wall" }),
        building({ x: 6, y: 0, id: "wall" }),
        building({ x: 5, y: -1, id: "wall" }),
    ];
    const root = makeRoot([miner, cutter, ...walls]);
    const mod = newMod(root);
    let threw = "";
    try {
        mod.connect({ fromX: 5, fromY: 5, toX: 5, toY: 0 });
    } catch (ex) {
        threw = ex.message;
    }
    check("unreachable destination raises", threw.length > 0, threw);
    check("  and leaves the map untouched", root.placed.length === 0);
}
{
    // Route around an obstacle sitting in the straight path.
    const miner = building({ x: 5, y: 8, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 5, y: 0, accepts: ["bottom"], id: "cutter" });
    const wall = building({ x: 5, y: 4, id: "wall" });
    const root = makeRoot([miner, cutter, wall]);
    const mod = newMod(root);
    const r = mod.connect({ fromX: 5, fromY: 8, toX: 5, toY: 0 });
    check("detours around an obstacle", r.placed > 0, `placed ${r.placed}`);
    check("  never builds on the obstacle", !root.placed.some(p => p.x === 5 && p.y === 4));
    check("  belt tiles are all distinct",
        new Set(root.placed.map(p => `${p.x},${p.y}`)).size === root.placed.length);
}
{
    // Every belt's rotation must point at the next belt, or items stall.
    const miner = building({ x: 0, y: 9, ejects: ["top"], id: "miner" });
    const cutter = building({ x: 7, y: 1, accepts: ["left"], id: "cutter" });
    const root = makeRoot([miner, cutter]);
    const mod = newMod(root);
    mod.connect({ fromX: 0, fromY: 9, toX: 7, toY: 1 });
    // Decode rotation + rotationVariant the way the game does, rather than
    // assuming rotation is the output direction — that assumption is what let
    // a broken corner reach a live game.
    let broken = null;
    for (let i = 0; i < root.placed.length - 1; ++i) {
        const b = root.placed[i];
        const out = beltOutputDirection(ANGLE_DIR[b.rotation], b.rotationVariant);
        const v = DIR_VECTOR[out];
        const next = root.placed[i + 1];
        if (!v || b.x + v.x !== next.x || b.y + v.y !== next.y) {
            broken = `belt ${i} at (${b.x},${b.y}) rot ${b.rotation}/var ${b.rotationVariant} outputs ${out}`;
        }
    }
    check("each belt feeds the next one", !broken, broken || `${root.placed.length} belts`);
}

// Belts carry no ItemEjector/ItemAcceptor, so before this they fell into the
// "no ports" branch, which returned free:undefined and made connect report the
// building as blocking itself. Extending an existing line was impossible.
console.log("\n=== belt endpoints ===");
{
    // A belt at (0,0) pointing right: its output tile is (1,0).
    const beltEnd = building({ x: 0, y: 0, id: "belt", belt: true, rotation: 90 });
    const mod = newMod(makeRoot([beltEnd]));
    const port = mod.resolveSourcePort(0, 0, { x: 5, y: 0 });
    check("a belt is a usable source", port.free === true);
    check("  its output tile is in front of it", port.tile.x === 1 && port.tile.y === 0,
        JSON.stringify(port.tile));
    check("  handing off in its own direction", port.direction === "right");
}
{
    // A corner belt: rotation right, left-turn variant, so it outputs upward.
    const corner = building({ x: 0, y: 0, id: "belt", belt: true, rotation: 90, rotationVariant: 1 });
    const mod = newMod(makeRoot([corner]));
    const port = mod.resolveSourcePort(0, 0, { x: 0, y: -5 });
    check("a corner belt's output follows its variant, not its rotation",
        port.tile.x === 0 && port.tile.y === -1 && port.direction === "top",
        JSON.stringify(port));
}
{
    // Feeding an existing belt: it accepts items arriving along its rotation,
    // so the feeding tile is behind it.
    const target = building({ x: 5, y: 0, id: "belt", belt: true, rotation: 90 });
    const mod = newMod(makeRoot([target]));
    const port = mod.resolveDestPort(5, 0, { x: 0, y: 0 });
    check("a belt is a usable destination", port.free === true);
    check("  fed from the tile behind it", port.tile.x === 4 && port.tile.y === 0,
        JSON.stringify(port.tile));
    check("  by a belt pointing into it", port.lastDirection === "right");
}
{
    // The end-to-end case the agent needed: extend one line into another.
    const source = building({ x: 0, y: 0, id: "belt", belt: true, rotation: 90 });
    const target = building({ x: 6, y: 4, id: "belt", belt: true, rotation: 180 });
    const root = makeRoot([source, target]);
    const mod = newMod(root);
    const r = mod.connect({ fromX: 0, fromY: 0, toX: 6, toY: 4 });
    check("belt-to-belt connect works", r.placed > 0, `placed ${r.placed}`);
    check("  it does not overwrite either endpoint",
        !root.placed.some(p => (p.x === 0 && p.y === 0) || (p.x === 6 && p.y === 4)));
    const last = root.placed[root.placed.length - 1];
    const out = beltOutputDirection(ANGLE_DIR[last.rotation], last.rotationVariant);
    const v = DIR_VECTOR[out];
    check("  the final belt feeds the target belt",
        last.x + v.x === 6 && last.y + v.y === 4,
        `${last.x},${last.y} outputs ${out}`);
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nAll ${checks} checks passed`);
process.exit(failures ? 1 : 0);
