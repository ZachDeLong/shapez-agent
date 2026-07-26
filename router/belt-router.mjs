// A* belt router. Pure — no shapez dependencies — so it can be unit-tested in
// Node and injected into the mod by serve-mod.mjs.
//
// Why this exists: making the model emit individual belt tiles turns a 100x100
// grid into an enormous action space, almost all of which is pathfinding rather
// than factory design. The model says "connect this miner to that cutter" and
// this lays the tiles.
//
// Direction names and vectors match shapez (src/js/core/vector.js):
//   top=(0,-1)/0deg  right=(1,0)/90deg  bottom=(0,1)/180deg  left=(-1,0)/270deg

export const DIRECTIONS = ["top", "right", "bottom", "left"];

export const DIR_VECTOR = {
    top: { x: 0, y: -1 },
    right: { x: 1, y: 0 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
};

export const DIR_ANGLE = { top: 0, right: 90, bottom: 180, left: 270 };

export const INVERT_DIR = { top: "bottom", right: "left", bottom: "top", left: "right" };

/**
 * Belt geometry, from shapez's own definitions:
 *
 *   arrayBeltVariantToRotation = [top, left, right]   (buildings/belt.js:12)
 *   beltAcceptingDirection = localDirectionToWorld(top)  (systems/item_ejector.js:105)
 *
 * So a belt's `rotation` is the direction items ARRIVE travelling, not the
 * direction it outputs, and `rotationVariant` says whether the item continues
 * straight (0), turns left (1), or turns right (2). Treating rotation as the
 * output direction happens to work for straight belts and silently breaks
 * every corner.
 */
export const VARIANT_STRAIGHT = 0;
export const VARIANT_LEFT = 1;
export const VARIANT_RIGHT = 2;

/** Turn `dir` by n quarter-turns clockwise (top → right → bottom → left). */
export function rotateDir(dir, quarterTurns) {
    const i = DIRECTIONS.indexOf(dir);
    if (i < 0) return null;
    return DIRECTIONS[(i + (quarterTurns % 4) + 4) % 4];
}

/** The rotationVariant that turns an arrival direction into an exit direction. */
export function variantFor(incoming, outgoing) {
    if (incoming === outgoing) return VARIANT_STRAIGHT;
    if (outgoing === rotateDir(incoming, 1)) return VARIANT_RIGHT;
    if (outgoing === rotateDir(incoming, -1)) return VARIANT_LEFT;
    return null; // a U-turn; belts cannot express it
}

/** Where a belt actually sends items, given how the game stores it. */
export function beltOutputDirection(rotationDir, rotationVariant) {
    if (rotationVariant === VARIANT_STRAIGHT) return rotationDir;
    if (rotationVariant === VARIANT_RIGHT) return rotateDir(rotationDir, 1);
    if (rotationVariant === VARIANT_LEFT) return rotateDir(rotationDir, -1);
    return null;
}

/** Direction you travel to get from a to b. Null if not orthogonally adjacent. */
export function directionBetween(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const dir of DIRECTIONS) {
        const v = DIR_VECTOR[dir];
        if (v.x === dx && v.y === dy) return dir;
    }
    return null;
}

const key = (x, y, dir) => `${x},${y},${dir}`;

/**
 * Binary min-heap. A sorted-array frontier makes A* quadratic, which shows up
 * badly on the long belt runs this is actually for.
 */
class MinHeap {
    constructor() {
        this.items = [];
    }
    get size() {
        return this.items.length;
    }
    push(node) {
        const items = this.items;
        items.push(node);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (items[parent].f <= items[i].f) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }
    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let smallest = i;
                if (l < items.length && items[l].f < items[smallest].f) smallest = l;
                if (r < items.length && items[r].f < items[smallest].f) smallest = r;
                if (smallest === i) break;
                [items[smallest], items[i]] = [items[i], items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

/**
 * Finds a belt path from `start` to `goal` and assigns each tile a rotation.
 *
 * State is (tile, incoming direction) rather than just tile, because the turn
 * penalty depends on how you arrived — a plain (x,y) search can't express
 * "prefer straight runs".
 *
 * @param {object}   opts
 * @param {{x,y}}    opts.start          First belt tile.
 * @param {{x,y}}    opts.goal           Last belt tile.
 * @param {Function} opts.isBlocked      (x, y) => bool. Not called for start/goal.
 * @param {string}   [opts.firstDirection] Force the exit direction of `start`
 *                     (a source ejector only hands off to a belt whose rotation
 *                     matches the direction it ejects).
 * @param {string}   [opts.lastDirection]  Force the exit direction of `goal`
 *                     (points the final belt into the destination building).
 * @param {number}   [opts.turnPenalty=0.4] Extra cost per corner. Straight runs
 *                     are cheaper to build and easier to read.
 * @param {number}   [opts.maxNodes=200000] Search cap, so an unreachable goal
 *                     behind a wall fails fast instead of scanning open space.
 * @returns {{ok: true, tiles: Array<{x,y,direction,rotation}>, cost: number, turns: number}
 *          | {ok: false, reason: string, nodesExplored?: number}}
 */
export function planBeltPath({
    start,
    goal,
    isBlocked,
    firstDirection = null,
    lastDirection = null,
    turnPenalty = 0.4,
    maxNodes = 200000,
}) {
    if (!start || !goal) return { ok: false, reason: "start and goal are required" };
    if (typeof isBlocked !== "function") {
        return { ok: false, reason: "isBlocked must be a function" };
    }
    if (firstDirection && !DIR_VECTOR[firstDirection]) {
        return { ok: false, reason: `Invalid firstDirection: ${firstDirection}` };
    }
    if (lastDirection && !DIR_VECTOR[lastDirection]) {
        return { ok: false, reason: `Invalid lastDirection: ${lastDirection}` };
    }

    // Single-tile path: one belt that is both start and goal. It can only carry
    // one rotation, so a conflicting pair of constraints is unsatisfiable.
    if (start.x === goal.x && start.y === goal.y) {
        if (firstDirection && lastDirection && firstDirection !== lastDirection) {
            return {
                ok: false,
                reason:
                    `Start and goal are the same tile, but it would need to point ` +
                    `${firstDirection} for the source and ${lastDirection} for the destination`,
            };
        }
        const dir = lastDirection || firstDirection;
        if (!dir) return { ok: false, reason: "Start equals goal with no direction constraint" };
        return {
            ok: true,
            tiles: [{ x: start.x, y: start.y, direction: dir, rotation: DIR_ANGLE[dir] }],
            cost: 0,
            turns: 0,
        };
    }

    if (isBlocked(goal.x, goal.y)) {
        return { ok: false, reason: `Goal tile (${goal.x},${goal.y}) is occupied` };
    }

    // A goal boxed in by buildings is common (a machine surrounded by its
    // neighbours) and the grid is unbounded, so without this check A* explores
    // open space until it hits maxNodes. Catch it in four lookups instead.
    const goalNeighbours = DIRECTIONS.filter(dir => {
        const v = DIR_VECTOR[dir];
        const nx = goal.x + v.x;
        const ny = goal.y + v.y;
        return (nx === start.x && ny === start.y) || !isBlocked(nx, ny);
    });
    if (goalNeighbours.length === 0) {
        return {
            ok: false,
            reason: `No route found — every tile around the goal (${goal.x},${goal.y}) is occupied`,
        };
    }
    // Same idea for a forced approach direction: the one tile the belt must
    // arrive from has to be reachable.
    if (lastDirection) {
        const back = DIR_VECTOR[INVERT_DIR[lastDirection]];
        const bx = goal.x + back.x;
        const by = goal.y + back.y;
        const isStart = bx === start.x && by === start.y;
        const sameTile = goal.x === start.x && goal.y === start.y;
        if (!isStart && !sameTile && isBlocked(bx, by) && goalNeighbours.length === 1) {
            return {
                ok: false,
                reason:
                    `No route found — the goal can only be approached from (${bx},${by}), ` +
                    `which is occupied`,
            };
        }
    }

    const heuristic = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);

    const open = new MinHeap();
    const best = new Map(); // state key -> g
    const cameFrom = new Map(); // state key -> previous state key
    const nodes = new Map(); // state key -> {x, y, dir}

    // Seed. `dir` on a state is the direction taken to ARRIVE at (x,y); the
    // start has no arrival direction, so seed each legal first move instead.
    const seedDirections = firstDirection ? [firstDirection] : DIRECTIONS;
    for (const dir of seedDirections) {
        const v = DIR_VECTOR[dir];
        const nx = start.x + v.x;
        const ny = start.y + v.y;
        const isGoal = nx === goal.x && ny === goal.y;
        if (!isGoal && isBlocked(nx, ny)) continue;

        const k = key(nx, ny, dir);
        best.set(k, 1);
        nodes.set(k, { x: nx, y: ny, dir });
        cameFrom.set(k, null);
        open.push({ key: k, x: nx, y: ny, dir, g: 1, f: 1 + heuristic(nx, ny) });
    }

    if (open.size === 0) {
        return {
            ok: false,
            reason: firstDirection
                ? `The tile ${firstDirection} of the start is occupied, and the source ` +
                  `requires the belt to leave in that direction`
                : "Every tile adjacent to the start is occupied",
        };
    }

    let explored = 0;
    let goalState = null;

    while (open.size > 0) {
        const current = open.pop();
        if (current.g > (best.get(current.key) ?? Infinity)) continue; // stale heap entry
        if (++explored > maxNodes) {
            return { ok: false, reason: "Search limit reached — goal likely unreachable", nodesExplored: explored };
        }

        if (current.x === goal.x && current.y === goal.y) {
            // With a forced exit direction the final tile still has to turn, so
            // the true cost includes that corner. Keep searching if another
            // approach reaches the goal already facing the right way.
            if (!lastDirection || current.dir === lastDirection) {
                goalState = current;
                break;
            }
            if (!goalState) goalState = current;
            continue;
        }

        for (const dir of DIRECTIONS) {
            if (dir === INVERT_DIR[current.dir]) continue; // no U-turns
            const v = DIR_VECTOR[dir];
            const nx = current.x + v.x;
            const ny = current.y + v.y;
            const isGoal = nx === goal.x && ny === goal.y;
            if (!isGoal && isBlocked(nx, ny)) continue;

            const g = current.g + 1 + (dir === current.dir ? 0 : turnPenalty);
            const k = key(nx, ny, dir);
            if (g >= (best.get(k) ?? Infinity)) continue;

            best.set(k, g);
            nodes.set(k, { x: nx, y: ny, dir });
            cameFrom.set(k, current.key);
            open.push({ key: k, x: nx, y: ny, dir, g, f: g + heuristic(nx, ny) });
        }
    }

    if (!goalState) {
        return { ok: false, reason: "No route found — the goal is walled off", nodesExplored: explored };
    }

    // Walk back to the start, then prepend it.
    const reversed = [];
    for (let k = goalState.key; k != null; k = cameFrom.get(k)) {
        reversed.push(nodes.get(k));
    }
    reversed.push({ x: start.x, y: start.y, dir: null });
    const path = reversed.reverse();

    // Each tile needs both the direction items arrive from and the direction
    // they leave by: the first becomes `rotation`, the pair becomes the variant.
    const tiles = [];
    let turns = 0;

    for (let i = 0; i < path.length; ++i) {
        const outgoing = i < path.length - 1 ? path[i + 1].dir : lastDirection || path[i].dir;
        // path[0].dir is null — nothing arrived at the start tile. Use the
        // forced entry direction if there is one, otherwise treat it as straight.
        const incoming = path[i].dir || firstDirection || outgoing;
        const variant = variantFor(incoming, outgoing);
        if (variant === null) {
            return {
                ok: false,
                reason: `Path doubles back at (${path[i].x},${path[i].y}); a belt cannot U-turn`,
            };
        }
        if (variant !== VARIANT_STRAIGHT) turns++;

        tiles.push({
            x: path[i].x,
            y: path[i].y,
            // `direction` is where the item goes next — the readable form.
            direction: outgoing,
            // `rotation`/`rotationVariant` are what the game stores.
            rotation: DIR_ANGLE[incoming],
            rotationVariant: variant,
        });
    }

    return { ok: true, tiles, cost: goalState.g, turns };
}
