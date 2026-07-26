// End-to-end test of the agent loop with no API key and no game.
//
// A local HTTP server stands in for the Claude API and a WebSocket client
// stands in for shapez, so this exercises the real path: tool schemas → tool
// runner → dispatcher → bridge → game, and the results back again.

import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import WebSocket from "ws";
import { GameBridge } from "../server/bridge-server.mjs";
import { TOOLS, createDispatcher } from "../server/tools.mjs";
import { SYSTEM_PROMPT } from "../agent/prompt.mjs";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
    checks++;
    if (!cond) failures++;
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

// --- stand-in for the Claude API --------------------------------------------

const requests = [];
let step = 0;

function assistantMessage(content, stopReason) {
    return {
        id: `msg_${++step}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
    };
}

// Scripted turns: observe, then connect, then finish.
const SCRIPT = [
    () =>
        assistantMessage(
            [
                { type: "text", text: "Looking at the map first." },
                { type: "tool_use", id: "toolu_1", name: "observe", input: { radius: 20 } },
            ],
            "tool_use"
        ),
    () =>
        assistantMessage(
            [
                {
                    type: "tool_use",
                    id: "toolu_2",
                    name: "connect",
                    input: { from_x: 5, from_y: 5, to_x: 5, to_y: 0 },
                },
            ],
            "tool_use"
        ),
    () => assistantMessage([{ type: "text", text: "Line built and verified." }], "end_turn"),
];

const api = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
        requests.push({ url: req.url, body: JSON.parse(body || "{}") });
        const handler = SCRIPT[requests.length - 1] || SCRIPT[SCRIPT.length - 1];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(handler()));
    });
});
await new Promise(resolve => api.listen(0, resolve));
const apiPort = api.address().port;

// --- stand-in for shapez -----------------------------------------------------

const bridge = new GameBridge({ port: 8798, log: () => {} }).start();
const gameCalls = [];
const game = new WebSocket("ws://127.0.0.1:8798");
game.on("message", raw => {
    const { id, method, params } = JSON.parse(raw.toString());
    gameCalls.push({ method, params });
    const replies = {
        setPaused: () => ({ paused: params.paused }),
        observe: () => ({
            hub: { x: -2, y: -2, w: 4, h: 4 },
            level: 1,
            goal: { shape: "CuCuCuCu", required: 30, delivered: 0 },
            rates: { minerItemsPerSecond: 1.5 },
            patches: [{ x: 5, y: 5, kind: "shape", item: "CuCuCuCu", size: 9 }],
            entities: [],
        }),
        connect: () => ({ placed: 4, turns: 0 }),
    };
    game.send(JSON.stringify({ id, ok: true, result: (replies[method] || (() => ({})))() }));
});
await bridge.waitForGame(5000);

// --- run the loop ------------------------------------------------------------

const dispatch = createDispatcher(bridge);
const executed = [];

const tools = TOOLS.map(spec =>
    betaTool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.input_schema,
        run: async input => {
            executed.push(spec.name);
            return JSON.stringify(await dispatch(spec.name, input));
        },
    })
);

const client = new Anthropic({
    apiKey: "test-key-not-real",
    baseURL: `http://127.0.0.1:${apiPort}`,
    maxRetries: 0,
});

const runner = client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: "high" },
    tools,
    messages: [{ role: "user", content: "Build a line." }],
    max_iterations: 10,
});

const turns = [];
for await (const message of runner) turns.push(message);

// --- assertions --------------------------------------------------------------

console.log("=== agent loop ===");
check("loop ran to completion", turns.length === 3, `${turns.length} turns`);
check("finished on end_turn", turns[turns.length - 1]?.stop_reason === "end_turn");
check("executed the tools the model asked for",
    executed.join(",") === "observe,connect", executed.join(",") || "none");
check("tool calls reached the game",
    gameCalls.some(c => c.method === "observe") && gameCalls.some(c => c.method === "connect"));

console.log("\n=== request shape the API actually received ===");
const first = requests[0].body;
check("model is claude-opus-5", first.model === "claude-opus-5", first.model);
check("effort is set", first.output_config?.effort === "high", JSON.stringify(first.output_config));
check("system prompt is attached", typeof first.system === "string" && first.system.length > 100);
check("all 7 tools are declared", first.tools?.length === 7, `${first.tools?.length}`);
check("tool schemas survive the round trip",
    first.tools.every(t => t.name && t.description && t.input_schema?.type === "object"));
check("connect is among them", first.tools.some(t => t.name === "connect"));

console.log("\n=== conversation threading ===");
const second = requests[1].body;
const hasToolResult = second.messages.some(
    m => m.role === "user" && Array.isArray(m.content) &&
         m.content.some(b => b.type === "tool_result" && b.tool_use_id === "toolu_1")
);
check("tool result is fed back with the matching id", hasToolResult);
const resultBlock = second.messages
    .flatMap(m => (Array.isArray(m.content) ? m.content : []))
    .find(b => b.type === "tool_result");
check("  it carries the game's observation",
    JSON.stringify(resultBlock?.content ?? "").includes("CuCuCuCu"));
check("history grows across turns", requests[2].body.messages.length > second.messages.length);

console.log("\n=== refusal path ===");
{
    // A refusal is a 200 with stop_reason "refusal" — the loop must not try to
    // read content blocks that may be absent.
    const refusal = assistantMessage([], "refusal");
    refusal.stop_details = { type: "refusal", category: "cyber" };
    let readOk = true;
    try {
        if (refusal.stop_reason === "refusal") {
            void refusal.stop_details?.category;
            for (const b of refusal.content) void b.type;
        }
    } catch {
        readOk = false;
    }
    check("empty-content refusal is safe to handle", readOk);
}

// Close in dependency order and let the event loop drain. Tearing the
// WebSocket server down underneath a live client, then exiting immediately,
// trips a libuv assertion on Windows.
game.close();
await new Promise(resolve => game.once("close", resolve));
bridge.stop();
await new Promise(resolve => api.close(resolve));

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nAll ${checks} checks passed`);
process.exitCode = failures ? 1 : 0;
