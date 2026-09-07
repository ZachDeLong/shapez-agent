import assert from "node:assert/strict";
import { createBridgeLifecycle } from "../agent/bridge-lifecycle.mjs";

function fakeBridge({ pauseError, releaseErrors = 0 } = {}) {
    const calls = [];
    let remainingReleaseErrors = releaseErrors;
    return {
        calls,
        async setPaused(paused) {
            calls.push(["setPaused", paused]);
            if (paused && pauseError) throw pauseError;
            if (!paused && remainingReleaseErrors > 0) {
                remainingReleaseErrors--;
                throw new Error("unpause failed");
            }
        },
        stop() {
            calls.push(["stop"]);
        },
    };
}

let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`  ✓ ${name}`);
}

await check("normal release unpauses once before shutdown", async () => {
    const bridge = fakeBridge();
    const lifecycle = createBridgeLifecycle(bridge);
    await lifecycle.pause();
    await lifecycle.release();
    await lifecycle.cleanup();
    assert.deepEqual(bridge.calls, [["setPaused", true], ["setPaused", false], ["stop"]]);
});

await check("cleanup unpauses after agent work throws", async () => {
    const bridge = fakeBridge();
    const lifecycle = createBridgeLifecycle(bridge);
    await lifecycle.pause();
    await lifecycle.cleanup();
    assert.deepEqual(bridge.calls, [["setPaused", true], ["setPaused", false], ["stop"]]);
});

await check("an ambiguous pause failure still attempts restoration", async () => {
    const bridge = fakeBridge({ pauseError: new Error("pause timed out") });
    const lifecycle = createBridgeLifecycle(bridge);
    await assert.rejects(lifecycle.pause(), /pause timed out/);
    await lifecycle.cleanup();
    assert.deepEqual(bridge.calls, [["setPaused", true], ["setPaused", false], ["stop"]]);
});

await check("cleanup retries a failed normal release and always stops", async () => {
    const bridge = fakeBridge({ releaseErrors: 1 });
    const lifecycle = createBridgeLifecycle(bridge);
    await lifecycle.pause();
    await assert.rejects(lifecycle.release(), /unpause failed/);
    await lifecycle.cleanup();
    assert.deepEqual(bridge.calls, [
        ["setPaused", true],
        ["setPaused", false],
        ["setPaused", false],
        ["stop"],
    ]);
});

console.log(`\n${checks} bridge lifecycle checks passed`);
