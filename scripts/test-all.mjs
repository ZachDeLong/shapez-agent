// Runs every suite that doesn't need a running game.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = [
    ["belt router", "test-router.mjs"],
    ["bridge protocol", "test-protocol.mjs"],
    ["connect / port resolution", "test-connect.mjs"],
    ["agent loop", "test-agent-loop.mjs"],
];

let failed = 0;
for (const [label, file] of SUITES) {
    console.log(`\n${"=".repeat(60)}\n  ${label}\n${"=".repeat(60)}`);
    const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: "inherit" });
    if (result.status !== 0) failed++;
}

console.log(`\n${"=".repeat(60)}`);
console.log(failed ? `${failed} of ${SUITES.length} suites FAILED` : `All ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
