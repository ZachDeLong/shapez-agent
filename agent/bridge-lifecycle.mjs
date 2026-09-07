/**
 * Tracks whether an agent run may have left the game paused and guarantees
 * best-effort restoration before the bridge shuts down.
 */
export function createBridgeLifecycle(bridge) {
    let shouldUnpause = false;

    return {
        async pause() {
            // Set this before the RPC: a timeout can still mean the game applied it.
            shouldUnpause = true;
            await bridge.setPaused(true);
        },

        async release() {
            if (!shouldUnpause) return;
            await bridge.setPaused(false);
            shouldUnpause = false;
        },

        async cleanup() {
            try {
                if (shouldUnpause) {
                    await bridge.setPaused(false).catch(() => {});
                    shouldUnpause = false;
                }
            } finally {
                bridge.stop();
            }
        },
    };
}
