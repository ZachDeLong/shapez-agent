// Drives every bridge RPC by hand, no model involved. Run this first — if it
// passes, the bridge works and anything that breaks later is agent logic.
//
//   1. node server/serve-mod.mjs      (terminal 1)
//   2. yarn gulp in the shapez repo   (terminal 2)
//   3. node scripts/smoke.mjs         (terminal 3), then start a game

import { GameBridge } from "../server/bridge-server.mjs";

const bridge = new GameBridge().start();

function heading(text) {
    console.log(`\n=== ${text} ===`);
}

async function main() {
    console.log("Waiting for shapez to launch...");
    await bridge.waitForGame();
    console.log("Connected. Now waiting for a savegame to be loaded.");

    const status = await bridge.waitForInGame({
        onWait: () => console.log("  (still at the main menu — start or load a game)"),
    });

    heading("ping");
    console.log(status);

    heading("unlocked buildings");
    const buildings = await bridge.buildings();
    console.log(
        buildings
            .filter(b => b.unlocked)
            .map(b => b.id)
            .join(", ")
    );

    heading("observe");
    const state = await bridge.observe({ radius: 25 });
    console.log("hub:      ", state.hub);
    console.log("level:    ", state.level);
    console.log("goal:     ", state.goal);
    console.log("rates:    ", state.rates);
    console.log("patches:  ", state.patches.slice(0, 5));
    console.log("entities: ", state.entities.length);
    if (state.ascii) console.log(`\n${state.ascii.grid}`);

    // Pause so `run` is the only thing advancing time — makes results repeatable.
    heading("pause");
    console.log(await bridge.setPaused(true));

    // Place a belt somewhere clear of the hub (which occupies a 4x4 at -2,-2).
    const testTile = { x: state.hub.x + 8, y: state.hub.y + 8 };
    heading(`place belt at (${testTile.x},${testTile.y})`);
    try {
        console.log(await bridge.place({ type: "belt", ...testTile, rotation: 90 }));
    } catch (ex) {
        console.log("placement failed:", ex.message);
    }

    heading("place_many (a short belt run)");
    const run = [];
    for (let i = 1; i <= 4; ++i) {
        run.push({ type: "belt", x: testTile.x + i, y: testTile.y, rotation: 90 });
    }
    console.log(await bridge.placeMany(run));

    heading("run 15s");
    console.log(await bridge.run(15));

    heading("cleanup");
    for (let i = 0; i <= 4; ++i) {
        try {
            await bridge.remove(testTile.x + i, testTile.y);
        } catch (ex) {
            console.log(`  remove (${testTile.x + i},${testTile.y}): ${ex.message}`);
        }
    }
    console.log(await bridge.setPaused(false));

    console.log("\nSmoke test finished.");
    bridge.stop();
    process.exit(0);
}

main().catch(err => {
    console.error("\nSmoke test failed:", err.message);
    bridge.stop();
    process.exit(1);
});
