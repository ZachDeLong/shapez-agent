// The agent loop: hands the six bridge tools to Claude and lets it build.
//
//   1. node server/serve-mod.mjs          (terminal 1)
//   2. yarn gulp in the shapez repo       (terminal 2)
//   3. ANTHROPIC_API_KEY=... npm run agent (terminal 3), then start a game
//
// Options: AGENT_EFFORT (default "high"), AGENT_MAX_TURNS (default 40),
// AGENT_GOAL (free-text extra direction for the opening turn).

import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { GameBridge } from "../server/bridge-server.mjs";
import { TOOLS, createDispatcher } from "../server/tools.mjs";
import { SYSTEM_PROMPT, initialTask } from "./prompt.mjs";

const MODEL = "claude-opus-5";
// Opus 5 guidance is to start at xhigh for agentic work and sweep down; "high"
// is the cheaper starting point for a loop that runs many turns. Worth testing
// both on your own runs.
const EFFORT = process.env.AGENT_EFFORT || "high";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS || 40);

// Opus 5's safety classifiers can decline a request outright; this re-serves it
// on another model inside the same call instead of returning the refusal.
// Remove both lines to opt out.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACKS = "default";

/** Trims tool output so a big observation doesn't dominate the transcript log. */
function summarize(value, limit = 220) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log("ANTHROPIC_API_KEY is not set — trying an `ant auth login` profile.");
    }

    const bridge = new GameBridge().start();
    console.log("Waiting for shapez to launch...");
    await bridge.waitForGame();
    // A live socket only means the app is running; the mod connects at boot, so
    // at the main menu there is no game state to act on.
    await bridge.waitForInGame({
        onWait: () => console.log("Connected — now start or load a savegame."),
    });
    console.log("In game.\n");

    // Pause so `run` is the only thing that advances time. Without this the
    // factory keeps running while the model thinks, and its throughput readings
    // reflect wall-clock rather than the window it asked for.
    await bridge.setPaused(true);

    const dispatch = createDispatcher(bridge);
    let toolCalls = 0;

    const tools = TOOLS.map(spec =>
        betaTool({
            name: spec.name,
            description: spec.description,
            inputSchema: spec.input_schema,
            run: async input => {
                toolCalls++;
                console.log(`  → ${spec.name}(${summarize(input, 120)})`);
                const result = await dispatch(spec.name, input);
                console.log(`    ${result?.error ? "✗ " + result.error : summarize(result)}`);
                return JSON.stringify(result);
            },
        })
    );

    const client = new Anthropic();
    const runner = client.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: { effort: EFFORT },
        betas: [FALLBACK_BETA],
        fallbacks: FALLBACKS,
        tools,
        messages: [{ role: "user", content: initialTask(process.env.AGENT_GOAL || "") }],
        max_iterations: MAX_TURNS,
    });

    let turn = 0;
    let last = null;

    for await (const message of runner) {
        last = message;
        turn++;

        // Refusals arrive as a normal 200 with an empty or partial content
        // array, so check before reading content.
        if (message.stop_reason === "refusal") {
            console.log(`\n[refused: ${message.stop_details?.category ?? "unspecified"}]`);
            break;
        }

        for (const block of message.content) {
            if (block.type === "text" && block.text.trim()) {
                console.log(`\n[turn ${turn}] ${block.text.trim()}`);
            }
        }
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`Finished after ${turn} turns and ${toolCalls} tool calls.`);
    if (last?.stop_reason === "max_tokens") {
        console.log("Stopped on max_tokens — the last turn was truncated.");
    }
    if (turn >= MAX_TURNS) {
        console.log(`Hit the ${MAX_TURNS}-turn cap; raise AGENT_MAX_TURNS to let it continue.`);
    }

    // Hand the factory back to real time so you can watch it run.
    await bridge.setPaused(false).catch(() => {});

    const final = await bridge.observe({ ascii: true }).catch(() => null);
    if (final) {
        console.log(`\nLevel ${final.level}, goal ${final.goal?.shape} ` +
            `(${final.goal?.delivered}/${final.goal?.required} delivered), ` +
            `${final.entities.length} buildings placed.`);
        if (final.ascii) console.log(`\n${final.ascii.grid}`);
    }

    bridge.stop();
    process.exit(0);
}

main().catch(err => {
    console.error("\nAgent failed:", err.message);
    process.exit(1);
});
