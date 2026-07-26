// Unit tests for the belt router. Pure logic — no game required.

import {
    planBeltPath,
    directionBetween,
    beltOutputDirection,
    variantFor,
    rotateDir,
    DIR_ANGLE,
    DIRECTIONS,
    INVERT_DIR,
} from "../router/belt-router.mjs";

/** Inverse of DIR_ANGLE — turns a stored rotation back into a direction. */
const ANGLE_DIR = { 0: "top", 90: "right", 180: "bottom", 270: "left" };

let failures = 0;
let checks = 0;

function check(name, cond, extra = "") {
    checks++;
    if (!cond) failures++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

/** Blocks any tile in the given "x,y" set. */
const blockSet = (...tiles) => {
    const set = new Set(tiles);
    return (x, y) => set.has(`${x},${y}`);
};
const nothingBlocked = () => false;

/**
 * Every returned path must satisfy these regardless of the scenario, so assert
 * them centrally rather than re-checking per test.
 */
function validatePath(name, result, { start, goal, isBlocked, firstDirection, lastDirection }) {
    if (!result.ok) {
        check(`${name}: expected a path`, false, result.reason);
        return;
    }
    const t = result.tiles;
    let problem = null;

    if (t[0].x !== start.x || t[0].y !== start.y) problem = "does not begin at start";
    const end = t[t.length - 1];
    if (!problem && (end.x !== goal.x || end.y !== goal.y)) problem = "does not end at goal";

    for (let i = 0; !problem && i < t.length - 1; ++i) {
        const step = directionBetween(t[i], t[i + 1]);
        if (!step) {
            problem = `tiles ${i} and ${i + 1} are not adjacent`;
            break;
        }
        if (t[i].direction !== step) {
            problem = `tile ${i} exits ${t[i].direction}, next tile is ${step}`;
            break;
        }
        // The real test: decode rotation + rotationVariant the way the game
        // does and confirm the belt actually sends items at the next tile.
        const actual = beltOutputDirection(ANGLE_DIR[t[i].rotation], t[i].rotationVariant);
        if (actual !== step) {
            problem =
                `tile ${i} stores rotation ${t[i].rotation}/variant ${t[i].rotationVariant}, ` +
                `which outputs ${actual}, but the next tile is ${step}`;
        }
    }

    // Each belt must accept what the previous one hands it: a belt accepts
    // items arriving in the direction of its own rotation.
    for (let i = 1; !problem && i < t.length; ++i) {
        const arriving = directionBetween(t[i - 1], t[i]);
        if (ANGLE_DIR[t[i].rotation] !== arriving) {
            problem =
                `tile ${i} has rotation ${t[i].rotation} (accepts from ${ANGLE_DIR[t[i].rotation]}) ` +
                `but items arrive travelling ${arriving}`;
        }
    }

    const seen = new Set();
    for (const tile of t) {
        const k = `${tile.x},${tile.y}`;
        if (seen.has(k)) problem = problem || `revisits tile ${k}`;
        seen.add(k);
        if (isBlocked(tile.x, tile.y)) problem = problem || `routes through blocked tile ${k}`;
    }

    // A source only hands items to a belt whose rotation matches the direction
    // it ejects, so the first tile's rotation is the constrained one.
    if (!problem && firstDirection && ANGLE_DIR[t[0].rotation] !== firstDirection) {
        problem = `first tile accepts from ${ANGLE_DIR[t[0].rotation]}, expected ${firstDirection}`;
    }
    if (!problem && lastDirection && end.direction !== lastDirection) {
        problem = `last tile points ${end.direction}, expected ${lastDirection}`;
    }

    check(`${name}: path is valid`, !problem, problem || `${t.length} tiles, ${result.turns} turns`);
}

console.log("=== basic routing ===");
{
    const opts = { start: { x: 0, y: 0 }, goal: { x: 5, y: 0 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("straight horizontal", r, opts);
    check("  6 tiles", r.tiles.length === 6, `got ${r.tiles.length}`);
    check("  no turns", r.turns === 0);
    check("  all point right", r.tiles.every(t => t.direction === "right"));
    check("  rotation 90 throughout", r.tiles.every(t => t.rotation === 90));
}
{
    const opts = { start: { x: 3, y: 7 }, goal: { x: 3, y: 2 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("straight vertical (upward)", r, opts);
    check("  all point top", r.tiles.every(t => t.direction === "top"));
}
{
    const opts = { start: { x: 0, y: 0 }, goal: { x: 4, y: 4 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("diagonal target becomes an L", r, opts);
    check("  exactly one turn", r.turns === 1, `got ${r.turns}`);
    check("  9 tiles (Manhattan)", r.tiles.length === 9, `got ${r.tiles.length}`);
}

console.log("\n=== obstacles ===");
{
    // Full-height wall at x=2 with a single gap at y=3, so the gap is the only
    // way through rather than merely the shortest.
    const isBlocked = (x, y) => x === 2 && y !== 3;
    const opts = { start: { x: 0, y: 0 }, goal: { x: 4, y: 0 }, isBlocked };
    const r = planBeltPath(opts);
    validatePath("routes through the only gap in a wall", r, opts);
    check("  passes through the gap at (2,3)", r.ok && r.tiles.some(t => t.x === 2 && t.y === 3));
}
{
    // Fully enclose the goal.
    const isBlocked = blockSet("4,0", "6,0", "5,1", "5,-1");
    const t0 = process.hrtime.bigint();
    const r = planBeltPath({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 }, isBlocked });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check("walled-off goal fails", !r.ok, r.reason);
    check("  reason mentions no route", /no route|walled/i.test(r.reason || ""));
    // Detected by inspecting the goal's neighbours, not by exhausting the search.
    check(`  fails immediately (${ms.toFixed(2)}ms)`, ms < 5);
}
{
    const isBlocked = blockSet("5,0");
    const r = planBeltPath({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 }, isBlocked });
    check("occupied goal tile fails", !r.ok, r.reason);
    check("  reason names the tile", (r.reason || "").includes("(5,0)"));
}
{
    // Start boxed in on all four sides.
    const isBlocked = blockSet("1,0", "-1,0", "0,1", "0,-1");
    const r = planBeltPath({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 }, isBlocked });
    check("boxed-in start fails", !r.ok, r.reason);
}

console.log("\n=== port constraints ===");
{
    // A source ejecting downward: the first belt must leave downward even
    // though the goal is up and to the right.
    const opts = {
        start: { x: 0, y: 0 },
        goal: { x: 3, y: -2 },
        isBlocked: nothingBlocked,
        firstDirection: "bottom",
    };
    const r = planBeltPath(opts);
    validatePath("forced first direction", r, opts);
    check("  second tile is below the first", r.tiles[1].y === r.tiles[0].y + 1);
}
{
    const isBlocked = blockSet("0,1");
    const r = planBeltPath({
        start: { x: 0, y: 0 },
        goal: { x: 3, y: 3 },
        isBlocked,
        firstDirection: "bottom",
    });
    check("forced first direction into a blocked tile fails", !r.ok, r.reason);
    check("  reason explains the constraint", /required|occupied/i.test(r.reason || ""));
}
{
    // Destination accepts from its left, so the final belt must point right.
    const opts = {
        start: { x: 0, y: 0 },
        goal: { x: 4, y: 3 },
        isBlocked: nothingBlocked,
        lastDirection: "right",
    };
    const r = planBeltPath(opts);
    validatePath("forced last direction", r, opts);
}
{
    const opts = {
        start: { x: 0, y: 0 },
        goal: { x: 6, y: 4 },
        isBlocked: nothingBlocked,
        firstDirection: "top",
        lastDirection: "bottom",
    };
    const r = planBeltPath(opts);
    validatePath("both endpoints constrained", r, opts);
}

console.log("\n=== degenerate cases ===");
{
    const r = planBeltPath({
        start: { x: 2, y: 2 },
        goal: { x: 2, y: 2 },
        isBlocked: nothingBlocked,
        lastDirection: "right",
    });
    check("start == goal yields a single belt", r.ok && r.tiles.length === 1);
    check("  it points the required way", r.ok && r.tiles[0].direction === "right");
}
{
    const r = planBeltPath({
        start: { x: 2, y: 2 },
        goal: { x: 2, y: 2 },
        isBlocked: nothingBlocked,
        firstDirection: "top",
        lastDirection: "right",
    });
    check("start == goal with contradictory constraints fails", !r.ok, r.reason);
}
{
    const opts = { start: { x: 0, y: 0 }, goal: { x: 1, y: 0 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("adjacent tiles", r, opts);
    check("  2 tiles", r.tiles.length === 2);
}
{
    const r = planBeltPath({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 } });
    check("missing isBlocked is rejected", !r.ok && /isBlocked/.test(r.reason));
    const r2 = planBeltPath({
        start: { x: 0, y: 0 },
        goal: { x: 5, y: 0 },
        isBlocked: nothingBlocked,
        firstDirection: "up",
    });
    check("bogus direction name is rejected", !r2.ok && /Invalid firstDirection/.test(r2.reason));
}

console.log("\n=== path quality ===");
{
    // A staircase and an L are the same length; the turn penalty should pick the L.
    const opts = { start: { x: 0, y: 0 }, goal: { x: 6, y: 6 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("prefers few corners", r, opts);
    check("  one turn, not a staircase", r.turns === 1, `${r.turns} turns`);
}
{
    // Turn penalty must not cause a detour longer than the Manhattan distance.
    const opts = { start: { x: 0, y: 0 }, goal: { x: 10, y: 3 }, isBlocked: nothingBlocked };
    const r = planBeltPath(opts);
    validatePath("stays on the shortest route", r, opts);
    check("  14 tiles (Manhattan optimal)", r.tiles.length === 14, `got ${r.tiles.length}`);
}
{
    const r = planBeltPath({ start: { x: 0, y: 0 }, goal: { x: 8, y: 0 }, isBlocked: nothingBlocked });
    let uTurn = false;
    for (let i = 0; i < r.tiles.length - 1; ++i) {
        if (r.tiles[i + 1].direction === INVERT_DIR[r.tiles[i].direction]) uTurn = true;
    }
    check("never doubles back", !uTurn);
}

// The bug this section exists for: rotation was treated as the belt's OUTPUT
// direction. That is only true for straight belts, so every corner was stored
// wrong and silently dropped items on the floor.
console.log("\n=== belt geometry (rotation vs rotationVariant) ===");
{
    let bad = null;
    for (const incoming of DIRECTIONS) {
        for (const outgoing of DIRECTIONS) {
            if (outgoing === INVERT_DIR[incoming]) continue; // U-turns are impossible
            const variant = variantFor(incoming, outgoing);
            if (variant === null) { bad = `${incoming}->${outgoing} has no variant`; break; }
            const decoded = beltOutputDirection(incoming, variant);
            if (decoded !== outgoing) {
                bad = `${incoming}->${outgoing}: variant ${variant} decodes to ${decoded}`;
            }
        }
    }
    check("every legal turn round-trips through variantFor/beltOutputDirection", !bad, bad || "12 pairs");
    check("a U-turn has no representable variant", variantFor("top", "bottom") === null);
    check("straight is variant 0", variantFor("right", "right") === 0);
    check("clockwise turn is variant 2 (right)", variantFor("top", "right") === 2);
    check("anticlockwise turn is variant 1 (left)", variantFor("top", "left") === 1);
    check("rotateDir wraps", rotateDir("left", 1) === "top" && rotateDir("top", -1) === "left");
}
{
    // Travel right, then turn to go up. The corner belt must store rotation
    // "right" (how items arrive) with the left-turn variant — NOT rotation
    // "top", which is where they leave.
    const opts = { start: { x: 0, y: 0 }, goal: { x: 3, y: -3 }, isBlocked: nothingBlocked,
                   firstDirection: "right", lastDirection: "top" };
    const r = planBeltPath(opts);
    validatePath("right-then-up corner", r, opts);
    const corner = r.tiles.find(t => t.rotationVariant !== 0);
    check("  the corner stores the arrival direction", corner && corner.rotation === DIR_ANGLE.right,
        corner ? `rotation ${corner.rotation}` : "no corner found");
    check("  with the left-turn variant", corner?.rotationVariant === 1, `${corner?.rotationVariant}`);
    check("  and it outputs upward",
        beltOutputDirection("right", corner?.rotationVariant) === "top");
    check("  straight tiles stay variant 0",
        r.tiles.filter(t => t.rotationVariant === 0).length === r.tiles.length - 1);
}
{
    const opts = { start: { x: 0, y: 0 }, goal: { x: 3, y: 3 }, isBlocked: nothingBlocked,
                   firstDirection: "right", lastDirection: "bottom" };
    const r = planBeltPath(opts);
    validatePath("right-then-down corner", r, opts);
    const corner = r.tiles.find(t => t.rotationVariant !== 0);
    check("  clockwise corner uses variant 2", corner?.rotationVariant === 2, `${corner?.rotationVariant}`);
}
{
    // A miner ejecting up feeds the belt above it only if that belt's rotation
    // is "top" — the exact case that broke the first live run.
    const opts = { start: { x: 0, y: 0 }, goal: { x: 6, y: 0 }, isBlocked: nothingBlocked,
                   firstDirection: "top" };
    const r = planBeltPath(opts);
    validatePath("belt fed from below then turning away", r, opts);
    check("  first belt accepts from the source's eject direction",
        r.tiles[0].rotation === DIR_ANGLE.top, `rotation ${r.tiles[0].rotation}`);
    check("  and still leaves toward the goal",
        beltOutputDirection("top", r.tiles[0].rotationVariant) === r.tiles[0].direction);
}

console.log("\n=== scale ===");
{
    // A spiral wall forces a long path — exercises the heap on a real workload.
    const blocked = new Set();
    for (let y = -60; y <= 60; ++y) if (y !== 60) blocked.add(`0,${y}`);
    const isBlocked = (x, y) => blocked.has(`${x},${y}`);
    const opts = { start: { x: -40, y: 0 }, goal: { x: 40, y: 0 }, isBlocked };
    const t0 = process.hrtime.bigint();
    const r = planBeltPath(opts);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    validatePath("long detour around a 121-tile wall", r, opts);
    check(`  completes quickly (${ms.toFixed(1)}ms)`, ms < 500);
    check("  detours below the wall", r.ok && r.tiles.some(t => t.y >= 60));
}
{
    // Unreachable inside a large open field: must hit the cap, not hang.
    const isBlocked = (x, y) => x === 3;
    const t0 = process.hrtime.bigint();
    const r = planBeltPath({
        start: { x: 0, y: 0 },
        goal: { x: 10, y: 0 },
        isBlocked,
        maxNodes: 20000,
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check("infinite wall terminates via the node cap", !r.ok, r.reason);
    check(`  bails out quickly (${ms.toFixed(1)}ms)`, ms < 2000);
}

console.log(
    failures ? `\n${failures} of ${checks} checks FAILED` : `\nAll ${checks} checks passed`
);
process.exit(failures ? 1 : 0);
