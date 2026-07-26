// Tool definitions for the LLM agent, plus a dispatcher that routes each call
// to the bridge.
//
// Schemas are in Anthropic tool format ({name, description, input_schema}) and
// are plain JSON — usable from any harness.

export const TOOLS = [
    {
        name: "observe",
        description:
            "Get the current state of the factory: resource patches, placed buildings, the " +
            "current hub goal, throughput rates, and the machine speed constants needed to " +
            "compute production ratios. Call this before planning any build, and again after " +
            "`run` to see what changed. Returns an ASCII map of the built area alongside the " +
            "structured data. Each patch gives the coordinates of an actual minable tile, so " +
            "you can place a miner there directly, plus `tiles`: how many tiles that patch " +
            "covers, i.e. how many miners could fit on it.",
        input_schema: {
            type: "object",
            properties: {
                radius: {
                    type: "integer",
                    description:
                        "How many tiles around the hub to report, in each direction. Default 40. " +
                        "Raise it only if the factory has grown past the current view.",
                },
                include_ports: {
                    type: "boolean",
                    description:
                        "Include each building's input/output slot positions in world coordinates. " +
                        "Needed when planning belt connections. Default true.",
                },
                ascii: {
                    type: "boolean",
                    description: "Include the ASCII map view. Default true.",
                },
            },
        },
    },
    {
        name: "list_buildings",
        description:
            "List every building type you can place, with its dimensions, variants, and whether " +
            "it is unlocked yet. Call this once at the start of a session, or after a level-up " +
            "unlocks new buildings.",
        input_schema: { type: "object", properties: {} },
    },
    {
        name: "place",
        description:
            "Place a single building. Rotation is in degrees: 0 points up, 90 right, 180 down, " +
            "270 left — this is the direction the building outputs toward. Fails if the tile is " +
            "occupied or the building is not unlocked; the error says which. Prefer `place_many` " +
            "when placing several buildings at once.",
        input_schema: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    description:
                        "Building id, e.g. 'belt', 'miner', 'cutter', 'rotater', 'stacker', " +
                        "'painter', 'mixer', 'balancer', 'underground_belt', 'trash'. " +
                        "Use list_buildings for the full set.",
                },
                x: { type: "integer", description: "Tile X. The hub sits near (-2,-2)." },
                y: { type: "integer", description: "Tile Y. Y increases downward." },
                rotation: {
                    type: "integer",
                    enum: [0, 90, 180, 270],
                    description: "Output direction in degrees. Default 0 (up).",
                },
                variant: {
                    type: "string",
                    description: "Building variant, e.g. 'default', 'mirrored'. Default 'default'.",
                },
            },
            required: ["type", "x", "y"],
        },
    },
    {
        name: "place_many",
        description:
            "Place several buildings in one call. Reports per-building success, so a partly " +
            "blocked belt run still tells you exactly which tile failed. Set atomic=true when " +
            "the layout only makes sense complete — any failure then rolls the whole batch back.",
        input_schema: {
            type: "object",
            properties: {
                entities: {
                    type: "array",
                    description: "Buildings to place, in order. Same fields as `place`.",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string" },
                            x: { type: "integer" },
                            y: { type: "integer" },
                            rotation: { type: "integer", enum: [0, 90, 180, 270] },
                            variant: { type: "string" },
                        },
                        required: ["type", "x", "y"],
                    },
                },
                atomic: {
                    type: "boolean",
                    description: "Roll back every placement if any one fails. Default false.",
                },
            },
            required: ["entities"],
        },
    },
    {
        name: "connect",
        description:
            "Lay a belt line between two buildings. Give the coordinates of the two buildings " +
            "and the route is worked out for you — it finds the shortest path, avoids existing " +
            "buildings, prefers straight runs, and attaches to the right output and input slots. " +
            "Always prefer this over placing belts one tile at a time. Belt placement is " +
            "all-or-nothing: if no route exists you get an explanation and nothing is built.",
        input_schema: {
            type: "object",
            properties: {
                from_x: { type: "integer", description: "X of the source building (or a bare tile)." },
                from_y: { type: "integer", description: "Y of the source building." },
                to_x: { type: "integer", description: "X of the destination building." },
                to_y: { type: "integer", description: "Y of the destination building." },
                dry_run: {
                    type: "boolean",
                    description:
                        "Compute and return the route without building it. Useful to check " +
                        "a path exists before committing to a layout. Default false.",
                },
            },
            required: ["from_x", "from_y", "to_x", "to_y"],
        },
    },
    {
        name: "remove",
        description: "Remove the building occupying a tile. Use it to fix a misplaced building.",
        input_schema: {
            type: "object",
            properties: {
                x: { type: "integer" },
                y: { type: "integer" },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "run",
        description:
            "Advance the simulation by a number of in-game seconds and report what was produced " +
            "and delivered during that window, as counts and per-second rates. This is how you " +
            "check whether a build actually works. Run 30 seconds or more before judging " +
            "throughput — items need time to travel the belts.",
        input_schema: {
            type: "object",
            properties: {
                seconds: {
                    type: "number",
                    description: "In-game seconds to advance. Default 10.",
                },
            },
        },
    },
];

/** Maps tool names to bridge methods. */
export function createDispatcher(bridge) {
    const handlers = {
        observe: input =>
            bridge.observe({
                radius: input.radius ?? 40,
                includePorts: input.include_ports ?? true,
                ascii: input.ascii ?? true,
            }),
        list_buildings: () => bridge.buildings(),
        place: input => bridge.place(input),
        place_many: input => bridge.placeMany(input.entities, input.atomic ?? false),
        connect: input =>
            bridge.connect({
                fromX: input.from_x,
                fromY: input.from_y,
                toX: input.to_x,
                toY: input.to_y,
                dryRun: input.dry_run ?? false,
            }),
        remove: input => bridge.remove(input.x, input.y),
        run: input => bridge.run(input.seconds ?? 10),
    };

    /**
     * Executes a tool call. Game-side failures come back as a result object with
     * `error` rather than a thrown exception — a blocked placement is information
     * the model should act on, not a crash.
     */
    return async function dispatch(name, input) {
        const handler = handlers[name];
        if (!handler) {
            return { error: `Unknown tool: ${name}` };
        }
        try {
            return await handler(input || {});
        } catch (ex) {
            return { error: String(ex.message || ex) };
        }
    };
}
