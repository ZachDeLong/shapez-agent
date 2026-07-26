// @ts-nocheck
// Agent bridge for shapez.io — exposes observation + action RPC over a WebSocket.
//
// The game is the WebSocket *client*; the agent process hosts the server.
// Load this in a dev build via config.local.js:
//     externalModUrl: "http://localhost:3005/agent-bridge.js"

const METADATA = {
    website: "https://github.com/tobspr-games/shapez.io",
    author: "shapez-agent",
    name: "Agent Bridge",
    version: "1",
    id: "agent-bridge",
    description: "Exposes game state and building placement over a local WebSocket for LLM agents",
    minimumGameVersion: ">=1.5.0",
    doesNotAffectSavegame: true,
};

const BRIDGE_URL = "ws://127.0.0.1:8765";
const RECONNECT_MS = 2000;

// The A* belt router is injected here by serve-mod.mjs from
// router/belt-router.mjs. The mod loader evaluates this file with
// `new Function(...)`, so it can't import — but keeping one source of truth
// means the router stays unit-testable in plain Node.
// @inject router/belt-router.mjs

// Single-letter codes for the ASCII view. Anything unmapped renders as '?'.
const ASCII_CODES = {
    hub: "H",
    belt: null, // direction arrow, resolved per-entity
    miner: "M",
    cutter: "C",
    rotater: "R",
    stacker: "S",
    painter: "P",
    mixer: "X",
    trash: "T",
    balancer: "B",
    underground_belt: "U",
    storage: "G",
    reader: "E",
    filter: "F",
    display: "D",
    goal_acceptor: "A",
    constant_producer: "K",
    block: "#",
};

const BELT_ARROWS = { 0: "^", 90: ">", 180: "v", 270: "<" };

class Mod extends shapez.Mod {
    init() {
        this.root = null;
        this.socket = null;
        this.paused = false;

        // Exact counters, incremented from game signals. More precise than
        // ProductionAnalytics, which quantises into 1s slices.
        this.counters = { delivered: {}, produced: {} };

        this.signals.gameStarted.add(root => this.onGameStarted(root));
        this.connectSocket();
    }

    // ---------------------------------------------------------------- lifecycle

    onGameStarted(root) {
        this.root = root;
        this.counters = { delivered: {}, produced: {} };

        root.signals.shapeDelivered.add(definition => {
            const key = definition.getHash();
            this.counters.delivered[key] = (this.counters.delivered[key] || 0) + 1;
        });
        root.signals.itemProduced.add(item => {
            const key = item.getAsCopyableKey();
            this.counters.produced[key] = (this.counters.produced[key] || 0) + 1;
        });

        // Expose for console poking during development.
        window.agentBridge = this;
        this.send({ type: "event", event: "gameStarted" });
    }

    // Named connectSocket, not connect: `connect` is the belt-routing RPC
    // below, and a collision here silently replaces the socket setup — which
    // then runs at mod init with no arguments and kills the whole mod load.
    connectSocket() {
        try {
            this.socket = new WebSocket(BRIDGE_URL);
        } catch (ex) {
            setTimeout(() => this.connectSocket(), RECONNECT_MS);
            return;
        }

        this.socket.onopen = () => console.log("[agent-bridge] connected to", BRIDGE_URL);
        this.socket.onclose = () => {
            this.socket = null;
            setTimeout(() => this.connectSocket(), RECONNECT_MS);
        };
        this.socket.onerror = () => {
            /* onclose handles the retry */
        };
        this.socket.onmessage = ev => this.onMessage(ev.data);
    }

    send(payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        }
    }

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (ex) {
            return;
        }

        const { id, method, params } = msg;
        try {
            const result = this.dispatch(method, params || {});
            this.send({ id, ok: true, result });
        } catch (ex) {
            console.error("[agent-bridge]", method, ex);
            this.send({ id, ok: false, error: String((ex && ex.message) || ex) });
        }
    }

    dispatch(method, params) {
        if (method === "ping") {
            return { pong: true, inGame: !!this.root };
        }
        if (!this.root) {
            throw new Error("Not in a game yet — start or load a savegame first");
        }
        switch (method) {
            case "observe":
                return this.observe(params);
            case "place":
                return this.place(params);
            case "placeMany":
                return this.placeMany(params);
            case "remove":
                return this.remove(params);
            case "connect":
                return this.connect(params);
            case "run":
                return this.run(params);
            case "setPaused":
                return this.setPaused(params.paused);
            case "buildings":
                return this.listBuildings();
            default:
                throw new Error("Unknown method: " + method);
        }
    }

    // ------------------------------------------------------------------ actions

    /**
     * Resolves a building id + variant into a MetaBuilding, throwing a useful
     * error (with the valid ids) rather than a bare undefined deref.
     */
    resolveBuilding(type) {
        if (!shapez.gMetaBuildingRegistry.hasId(type)) {
            throw new Error(
                "Unknown building '" + type + "'. Valid: " + shapez.gMetaBuildingRegistry.getAllIds().join(", ")
            );
        }
        return shapez.gMetaBuildingRegistry.findById(type);
    }

    place({
        type,
        x,
        y,
        rotation = 0,
        variant = shapez.defaultBuildingVariant,
        rotationVariant = null,
    }) {
        const meta = this.resolveBuilding(type);
        const tile = new shapez.Vector(x, y);

        // Belts, tunnels and wires override this to work out corners and tunnel
        // ends from their neighbours. That is what you want for a hand-placed
        // building, but not for a routed belt run: the router already knows the
        // exact geometry, and letting the game re-derive it per tile from
        // whatever happens to be adjacent breaks the chain.
        const optimal =
            rotationVariant === null
                ? meta.computeOptimalDirectionAndRotationVariantAtTile({
                      root: this.root,
                      tile,
                      rotation,
                      variant,
                      layer: meta.getLayer(),
                  })
                : { rotation, rotationVariant };

        const entity = this.root.logic.tryPlaceBuilding({
            origin: tile,
            rotation: optimal.rotation,
            rotationVariant: optimal.rotationVariant,
            originalRotation: rotation,
            building: meta,
            variant,
        });

        if (!entity) {
            const blocker = this.describeBlocker(tile, meta.getLayer());
            throw new Error(
                "Cannot place " + type + " at (" + x + "," + y + ")" + (blocker ? " — blocked by " + blocker : "")
            );
        }

        this.root.signals.entityManuallyPlaced.dispatch(entity);
        return {
            uid: entity.uid,
            type,
            x,
            y,
            rotation: optimal.rotation,
            rotationVariant: optimal.rotationVariant,
        };
    }

    /**
     * Places a batch. Non-atomic by default: reports per-item success so a
     * partially-blocked belt run still tells you exactly which tile failed.
     * With atomic:true, any failure rolls back every placement in the batch.
     */
    placeMany({ entities = [], atomic = false }) {
        const placed = [];
        const failures = [];

        for (let i = 0; i < entities.length; ++i) {
            try {
                placed.push(this.place(entities[i]));
            } catch (ex) {
                failures.push({ index: i, spec: entities[i], error: String(ex.message || ex) });
                if (atomic) {
                    for (const p of placed) {
                        const e = this.root.entityMgr.findByUid(p.uid, false);
                        if (e) this.root.logic.tryDeleteBuilding(e);
                    }
                    throw new Error(
                        "Atomic batch failed at index " + i + ": " + String(ex.message || ex) + " (rolled back)"
                    );
                }
            }
        }
        return { placed: placed.length, failures, entities: placed };
    }

    remove({ x, y, layer = "regular" }) {
        const entity = this.root.map.getTileContent(new shapez.Vector(x, y), layer);
        if (!entity) {
            throw new Error("Nothing at (" + x + "," + y + ")");
        }
        if (!this.root.logic.tryDeleteBuilding(entity)) {
            throw new Error("Refused to delete building at (" + x + "," + y + ")");
        }
        return { removed: true, uid: entity.uid };
    }

    // ---------------------------------------------------------------- routing

    /**
     * Lays a belt run between two points, picking the route itself.
     *
     * Endpoints may be buildings or bare tiles. For a building, the real
     * endpoint is the tile just outside its output/input slot, and the belt at
     * that tile has to face a specific way — a source only hands items to a
     * belt whose rotation matches the direction it ejects (item_ejector.js:105),
     * and an acceptor only takes items arriving from the direction its slot
     * declares (item_acceptor.js findMatchingSlot).
     */
    connect({ fromX, fromY, toX, toY, dryRun = false }) {
        const source = this.resolveSourcePort(fromX, fromY, { x: toX, y: toY });
        const dest = this.resolveDestPort(toX, toY, { x: fromX, y: fromY });

        // Check this before reporting a blocked port: when two machines sit
        // flush against each other, each one *is* the thing "blocking" the
        // other's port, and they already feed directly with no belt needed.
        if (this.hasDirectConnection(source, toX, toY)) {
            return { alreadyConnected: true, placed: 0, tiles: [] };
        }

        if (!source.free) {
            throw new Error(
                `The output of the building at (${fromX},${fromY}) is blocked at ` +
                    `(${source.tile.x},${source.tile.y})`
            );
        }
        if (!dest.free) {
            throw new Error(
                `Every input of the building at (${toX},${toY}) is blocked ` +
                    `(nearest is (${dest.tile.x},${dest.tile.y}))`
            );
        }

        const plan = planBeltPath({
            start: source.tile,
            goal: dest.tile,
            isBlocked: (x, y) => this.isTileBlockedForBelt(x, y),
            firstDirection: source.direction,
            lastDirection: dest.lastDirection,
        });

        if (!plan.ok) {
            throw new Error(
                `Cannot connect (${fromX},${fromY}) to (${toX},${toY}): ${plan.reason}`
            );
        }
        if (dryRun) {
            return { dryRun: true, tiles: plan.tiles, turns: plan.turns };
        }

        // Atomic: a half-built belt run silently drops items, which is far
        // harder to debug than an outright failure.
        const result = this.placeMany({
            entities: plan.tiles.map(t => ({
                type: "belt",
                x: t.x,
                y: t.y,
                rotation: t.rotation,
                rotationVariant: t.rotationVariant,
            })),
            atomic: true,
        });

        return {
            placed: result.placed,
            turns: plan.turns,
            from: source.tile,
            to: dest.tile,
            tiles: plan.tiles.map(t => [t.x, t.y, t.rotation]),
        };
    }

    /**
     * Reads a belt's real geometry, or null if the entity isn't a belt.
     *
     * `accepts` is the direction items must be travelling to enter it (equal to
     * its rotation) and `output` is where they leave, which for a corner is a
     * quarter-turn off the rotation — see the note in belt-router.mjs.
     */
    beltGeometry(entity) {
        if (!entity || !entity.components.Belt) return null;
        const sme = entity.components.StaticMapEntity;
        const accepts = shapez.enumAngleToDirection[sme.rotation];
        return {
            x: sme.origin.x,
            y: sme.origin.y,
            accepts,
            output: beltOutputDirection(accepts, sme.getRotationVariant()),
        };
    }

    /** Belts can be laid over ground resources, so only buildings block. */
    isTileBlockedForBelt(x, y) {
        return !!this.root.map.getTileContent(new shapez.Vector(x, y), "regular");
    }

    /**
     * True when the source already ejects straight into an accepting slot of the
     * destination — mirrors the pairing test in item_ejector.js.
     */
    hasDirectConnection(source, toX, toY) {
        if (!source.direction) return false;
        const target = this.root.map.getTileContent(
            new shapez.Vector(source.tile.x, source.tile.y),
            "regular"
        );
        if (!target) return false;

        // The ejector must be pointing at the destination building itself.
        const destEntity = this.root.map.getTileContent(new shapez.Vector(toX, toY), "regular");
        if (!destEntity || destEntity.uid !== target.uid) return false;

        const acceptor = target.components.ItemAcceptor;
        if (!acceptor) return false;

        const sme = target.components.StaticMapEntity;
        // An acceptor names the direction items come FROM, the ejector the
        // direction it pushes items INTO — hence the inversion.
        const arrivingFrom = shapez.enumInvertedDirections[source.direction];
        return acceptor.slots.some(slot => {
            const slotTile = sme.localTileToWorld(slot.pos);
            return (
                slotTile.x === source.tile.x &&
                slotTile.y === source.tile.y &&
                sme.localDirectionToWorld(slot.direction) === arrivingFrom
            );
        });
    }

    /**
     * Picks which output to route from. With several (a cutter has two), prefer
     * one whose target tile is free, then whichever is nearest the destination.
     */
    resolveSourcePort(x, y, towards) {
        const entity = this.root.map.getTileContent(new shapez.Vector(x, y), "regular");

        // A belt has no ItemEjector — only a BeltComponent — so it needs its own
        // case, otherwise "extend this line" is impossible. Its output is the
        // tile it feeds, which depends on its variant, not just its rotation.
        const belt = this.beltGeometry(entity);
        if (belt) {
            const v = shapez.enumDirectionToVector[belt.output];
            const tile = { x: belt.x + v.x, y: belt.y + v.y };
            return {
                tile,
                direction: belt.output,
                free: !this.isTileBlockedForBelt(tile.x, tile.y),
            };
        }

        if (!entity || !entity.components.ItemEjector) {
            // A bare tile is a usable start; `free` must be set or connect
            // reads undefined as "blocked".
            return { tile: { x, y }, direction: null, free: true };
        }

        const sme = entity.components.StaticMapEntity;
        const candidates = entity.components.ItemEjector.slots.map(slot => {
            const slotTile = sme.localTileToWorld(slot.pos);
            const direction = sme.localDirectionToWorld(slot.direction);
            const v = shapez.enumDirectionToVector[direction];
            const tile = { x: slotTile.x + v.x, y: slotTile.y + v.y };
            return {
                tile,
                direction,
                free: !this.isTileBlockedForBelt(tile.x, tile.y),
                distance: Math.abs(tile.x - towards.x) + Math.abs(tile.y - towards.y),
            };
        });

        if (candidates.length === 0) return { tile: { x, y }, direction: null, free: true };
        // Blockage is reported, not thrown: connect() has to rule out a direct
        // building-to-building hookup first.
        candidates.sort((a, b) => b.free - a.free || a.distance - b.distance);
        return candidates[0];
    }

    /** Mirror of resolveSourcePort for the receiving end. */
    resolveDestPort(x, y, towards) {
        const entity = this.root.map.getTileContent(new shapez.Vector(x, y), "regular");

        // Feeding into an existing belt: it accepts items arriving in the
        // direction of its `rotation`, so the feeding tile sits behind it.
        const belt = this.beltGeometry(entity);
        if (belt) {
            const back = shapez.enumDirectionToVector[shapez.enumInvertedDirections[belt.accepts]];
            const tile = { x: belt.x + back.x, y: belt.y + back.y };
            return {
                tile,
                lastDirection: belt.accepts,
                buildingTile: { x: belt.x, y: belt.y },
                acceptFrom: shapez.enumInvertedDirections[belt.accepts],
                free: !this.isTileBlockedForBelt(tile.x, tile.y),
            };
        }

        if (!entity || !entity.components.ItemAcceptor) {
            return { tile: { x, y }, lastDirection: null, buildingTile: null, free: true };
        }

        const sme = entity.components.StaticMapEntity;
        const candidates = entity.components.ItemAcceptor.slots.map(slot => {
            const slotTile = sme.localTileToWorld(slot.pos);
            // The slot names the direction items arrive FROM, so the feeding
            // tile lies that way and the belt there must point back at us.
            const acceptFrom = sme.localDirectionToWorld(slot.direction);
            const v = shapez.enumDirectionToVector[acceptFrom];
            const tile = { x: slotTile.x + v.x, y: slotTile.y + v.y };
            return {
                tile,
                acceptFrom,
                lastDirection: shapez.enumInvertedDirections[acceptFrom],
                buildingTile: { x: slotTile.x, y: slotTile.y },
                free: !this.isTileBlockedForBelt(tile.x, tile.y),
                distance: Math.abs(tile.x - towards.x) + Math.abs(tile.y - towards.y),
            };
        });

        if (candidates.length === 0) {
            return { tile: { x, y }, lastDirection: null, buildingTile: null, free: true };
        }
        candidates.sort((a, b) => b.free - a.free || a.distance - b.distance);
        return candidates[0];
    }

    describeBlocker(tile, layer) {
        const existing = this.root.map.getTileContent(tile, layer);
        if (!existing) return null;
        const sme = existing.components.StaticMapEntity;
        return sme ? sme.getMetaBuilding().getId() + " at (" + sme.origin.x + "," + sme.origin.y + ")" : "an entity";
    }

    // -------------------------------------------------------------- time control

    /**
     * Pausing swaps in PausedGameSpeed, whose time multiplier is 0. The rAF loop
     * still runs and still renders, but GameTime never accumulates a logic
     * budget — so `run` becomes the only thing that advances the simulation.
     */
    setPaused(paused) {
        const speed = paused ? new shapez.PausedGameSpeed(this.root) : new shapez.RegularGameSpeed(this.root);
        if (this.root.time.getSpeed().getId() !== speed.constructor.getId()) {
            this.root.time.setSpeed(speed);
        }
        this.paused = !!paused;
        return { paused: this.paused };
    }

    /**
     * Advances the simulation by `seconds` of game time and reports what changed.
     * Steps updateLogic directly rather than going through performTicks, so the
     * result does not depend on wall-clock or framerate.
     */
    run({ seconds = 10 }) {
        const core = this.root.gameState.core;
        const deltaSeconds = this.root.dynamicTickrate.deltaSeconds;
        const ticks = Math.max(1, Math.round(seconds / deltaSeconds));

        const before = JSON.parse(JSON.stringify(this.counters));
        const levelBefore = this.root.hubGoals.level;
        const startTime = this.root.time.timeSeconds;

        for (let i = 0; i < ticks; ++i) {
            if (!core.updateLogic()) break; // root destructed
            this.root.time.timeSeconds += deltaSeconds;
            this.root.productionAnalytics.update();
        }

        const elapsed = this.root.time.timeSeconds - startTime;
        return {
            ticks,
            elapsedSeconds: round(elapsed, 2),
            deliveredDelta: diffRates(before.delivered, this.counters.delivered, elapsed),
            producedDelta: diffRates(before.produced, this.counters.produced, elapsed),
            level: this.root.hubGoals.level,
            leveledUp: this.root.hubGoals.level > levelBefore,
            goalDelivered: this.root.hubGoals.getCurrentGoalDelivered(),
        };
    }

    // ------------------------------------------------------------- observations

    listBuildings() {
        return shapez.gMetaBuildingRegistry.getAllIds().map(id => {
            const meta = shapez.gMetaBuildingRegistry.findById(id);
            const variants = meta.getAvailableVariants(this.root);
            return {
                id,
                unlocked: meta.getIsUnlocked(this.root),
                rotateable: meta.getIsRotateable(),
                layer: meta.getLayer(),
                variants,
                dimensions: variants.map(v => {
                    const d = meta.getDimensions(v);
                    return { variant: v, w: d.x, h: d.y };
                }),
            };
        });
    }

    observe({ radius = 40, includePorts = true, ascii = true, layer = "regular" } = {}) {
        const root = this.root;
        const hub = this.findHub();
        const cx = hub ? hub.x : 0;
        const cy = hub ? hub.y : 0;

        const entities = [];
        const ports = [];
        let minX = cx,
            maxX = cx,
            minY = cy,
            maxY = cy;

        for (const entity of root.entityMgr.entities) {
            if (entity.queuedForDestroy || entity.destroyed) continue;
            const sme = entity.components.StaticMapEntity;
            if (!sme) continue;
            const meta = sme.getMetaBuilding();
            if (meta.getLayer() !== layer) continue;

            const ox = sme.origin.x;
            const oy = sme.origin.y;
            if (Math.abs(ox - cx) > radius || Math.abs(oy - cy) > radius) continue;

            // Compact positional form — roughly 3x cheaper in tokens than objects.
            entities.push([meta.getId(), ox, oy, sme.rotation, sme.getVariant(), entity.uid]);

            const bounds = sme.getTileSpaceBounds();
            minX = Math.min(minX, bounds.x);
            minY = Math.min(minY, bounds.y);
            maxX = Math.max(maxX, bounds.x + bounds.w - 1);
            maxY = Math.max(maxY, bounds.y + bounds.h - 1);

            if (includePorts) {
                const p = this.entityPorts(entity, sme);
                if (p.in.length || p.out.length) ports.push(p);
            }
        }

        return {
            tick: root.time.timeSeconds,
            paused: this.paused,
            hub: hub,
            level: root.hubGoals.level,
            goal: this.goalState(),
            rates: this.rateConstants(),
            upgrades: Object.assign({}, root.hubGoals.upgradeLevels),
            storedShapes: Object.assign({}, root.hubGoals.storedShapes),
            totals: { delivered: this.counters.delivered, produced: this.counters.produced },
            patches: this.resourcePatches(cx, cy, radius),
            bounds: { minX, minY, maxX, maxY },
            entities,
            ports: includePorts ? ports : undefined,
            ascii: ascii ? this.renderAscii(minX, minY, maxX, maxY, layer) : undefined,
            legend: ascii ? this.asciiLegend() : undefined,
        };
    }

    findHub() {
        for (const entity of this.root.entityMgr.entities) {
            if (entity.components.Hub) {
                const sme = entity.components.StaticMapEntity;
                const d = sme.getTileSize();
                return { x: sme.origin.x, y: sme.origin.y, w: d.x, h: d.y };
            }
        }
        return null;
    }

    goalState() {
        const goal = this.root.hubGoals.currentGoal;
        if (!goal) return null;
        return {
            shape: goal.definition.getHash(),
            required: goal.required,
            delivered: this.root.hubGoals.getCurrentGoalDelivered(),
            throughputOnly: !!goal.throughputOnly,
            reward: goal.reward,
        };
    }

    /**
     * The numbers an agent needs to derive machine ratios instead of
     * discovering them by trial and error.
     */
    rateConstants() {
        const hubGoals = this.root.hubGoals;
        const processors = {};
        for (const key in shapez.enumItemProcessorTypes) {
            try {
                processors[key] = round(hubGoals.getProcessorBaseSpeed(key), 3);
            } catch (ex) {
                /* hub/goal/reader have no meaningful rate */
            }
        }
        return {
            beltItemsPerSecond: round(hubGoals.getBeltBaseSpeed(), 3),
            undergroundBeltItemsPerSecond: round(hubGoals.getUndergroundBeltBaseSpeed(), 3),
            minerItemsPerSecond: round(hubGoals.getMinerBaseSpeed(), 3),
            processorItemsPerSecond: processors,
        };
    }

    /**
     * Uses the per-chunk patch summary the map generator already builds, rather
     * than walking 40k individual tiles.
     */
    resourcePatches(cx, cy, radius) {
        const chunkSize = shapez.globalConfig.mapChunkSize;
        const out = [];
        // Two patches of the same resource in one chunk can snap to the same
        // tile; report it once.
        const seen = new Set();
        const minChunk = Math.floor((cx - radius) / chunkSize);
        const maxChunk = Math.ceil((cx + radius) / chunkSize);
        const minChunkY = Math.floor((cy - radius) / chunkSize);
        const maxChunkY = Math.ceil((cy + radius) / chunkSize);

        for (let chunkX = minChunk; chunkX <= maxChunk; ++chunkX) {
            for (let chunkY = minChunkY; chunkY <= maxChunkY; ++chunkY) {
                const chunk = this.root.map.getChunk(chunkX, chunkY, true);
                if (!chunk) continue;
                for (const patch of chunk.patches) {
                    // patch.pos is the centroid of the patch's tiles
                    // (map_chunk.js: avgPos.divideScalar(patchesDrawn)), so it
                    // is fractional and can even land on a non-resource tile.
                    // Snap to a real minable tile — a miner needs one of those.
                    const key = patch.item.getAsCopyableKey();
                    const anchor = this.nearestResourceTile(
                        chunk,
                        key,
                        chunk.tileX + patch.pos.x,
                        chunk.tileY + patch.pos.y
                    );
                    if (!anchor) continue;
                    if (Math.abs(anchor.x - cx) > radius || Math.abs(anchor.y - cy) > radius) {
                        continue;
                    }
                    const id = `${anchor.x},${anchor.y},${key}`;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    out.push({
                        x: anchor.x,
                        y: anchor.y,
                        kind: patch.item.getItemType(),
                        item: key,
                        tiles: anchor.count,
                    });
                }
            }
        }
        return out;
    }

    /**
     * Nearest tile in this chunk actually holding `key`, plus how many such
     * tiles the chunk has (i.e. how many miners could fit). Chunks are 16x16,
     * so the scan is cheap. Two patches of the same resource in one chunk share
     * a count, but each still anchors to the tile nearest its own centroid.
     */
    nearestResourceTile(chunk, key, targetX, targetY) {
        const size = shapez.globalConfig.mapChunkSize;
        let best = null;
        let count = 0;

        for (let lx = 0; lx < size; ++lx) {
            for (let ly = 0; ly < size; ++ly) {
                const item = chunk.lowerLayer[lx][ly];
                if (!item || item.getAsCopyableKey() !== key) continue;
                count++;
                const wx = chunk.tileX + lx;
                const wy = chunk.tileY + ly;
                const distance = Math.abs(wx - targetX) + Math.abs(wy - targetY);
                if (!best || distance < best.distance) best = { x: wx, y: wy, distance };
            }
        }
        return best ? { x: best.x, y: best.y, count } : null;
    }

    /** Input/output slots converted from entity-local space into world tiles. */
    entityPorts(entity, sme) {
        const out = [];
        const inp = [];

        const ejector = entity.components.ItemEjector;
        if (ejector) {
            for (const slot of ejector.slots) {
                const tile = sme.localTileToWorld(slot.pos);
                out.push([tile.x, tile.y, sme.localDirectionToWorld(slot.direction)]);
            }
        }

        const acceptor = entity.components.ItemAcceptor;
        if (acceptor) {
            for (const slot of acceptor.slots) {
                const tile = sme.localTileToWorld(slot.pos);
                inp.push([tile.x, tile.y, sme.localDirectionToWorld(slot.direction)]);
            }
        }

        return { uid: entity.uid, in: inp, out };
    }

    // ------------------------------------------------------------------- ascii

    renderAscii(minX, minY, maxX, maxY, layer) {
        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        if (width <= 0 || height <= 0 || width > 200 || height > 200) return null;

        const rows = [];
        for (let y = minY; y <= maxY; ++y) {
            let row = "";
            for (let x = minX; x <= maxX; ++x) {
                row += this.asciiCharAt(x, y, layer);
            }
            rows.push(row);
        }

        // Prefix each row with its world Y so coordinates are readable directly.
        const labelWidth = String(maxY).length + (minY < 0 ? 1 : 0);
        const labelled = rows.map((row, i) => String(minY + i).padStart(labelWidth) + " " + row);
        return {
            origin: { x: minX, y: minY },
            grid: labelled.join("\n"),
        };
    }

    asciiCharAt(x, y, layer) {
        const entity = this.root.map.getTileContent(new shapez.Vector(x, y), layer);
        if (entity) {
            const sme = entity.components.StaticMapEntity;
            const id = sme.getMetaBuilding().getId();
            if (id === "belt") {
                // Draw where items GO, not the stored rotation — on a corner
                // those differ, and an arrow showing the arrival direction
                // makes a working line look broken.
                const belt = this.beltGeometry(entity);
                return BELT_ARROWS[shapez.enumDirectionToAngle[belt.output]] || ">";
            }
            const code = ASCII_CODES[id];
            if (code) return code;
            return id[0] ? id[0].toUpperCase() : "?";
        }
        const resource = this.root.map.getLowerLayerContentXY(x, y);
        if (resource) {
            return resource.getItemType() === "color" ? resource.getAsCopyableKey()[0] : "o";
        }
        return ".";
    }

    asciiLegend() {
        return {
            "^ > v <": "belt, pointing up/right/down/left",
            H: "hub",
            M: "miner",
            C: "cutter",
            R: "rotater",
            S: "stacker",
            P: "painter",
            X: "mixer",
            B: "balancer",
            U: "underground belt",
            T: "trash",
            o: "shape resource on the ground",
            "r/g/b/y/p/c/w": "colour resource on the ground (first letter)",
            ".": "empty",
        };
    }
}

// ------------------------------------------------------------------- helpers

function round(value, digits) {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
}

/** Turns two counter snapshots into {key: {count, perSecond}}. */
function diffRates(before, after, elapsedSeconds) {
    const out = {};
    for (const key in after) {
        const delta = after[key] - (before[key] || 0);
        if (delta > 0) {
            out[key] = {
                count: delta,
                perSecond: elapsedSeconds > 0 ? round(delta / elapsedSeconds, 3) : 0,
            };
        }
    }
    return out;
}
