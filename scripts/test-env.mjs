import assert from "node:assert/strict";
import { readIntegerEnv } from "../server/env.mjs";

let checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log(`  ✓ ${name}`);
}

check("uses the default when a setting is absent", () => {
    assert.equal(readIntegerEnv("AGENT_MAX_TURNS", undefined, 40), 40);
    assert.equal(readIntegerEnv("AGENT_MAX_TURNS", "  ", 40), 40);
});

check("accepts trimmed integers within the configured range", () => {
    assert.equal(readIntegerEnv("BRIDGE_PORT", " 8766 ", 8765, { max: 65_535 }), 8766);
    assert.equal(readIntegerEnv("AGENT_MAX_TURNS", "1", 40), 1);
});

for (const rawValue of ["0", "-1", "2.5", "1e3", "NaN", "Infinity", "65536"]) {
    check(`rejects invalid port value ${JSON.stringify(rawValue)}`, () => {
        assert.throws(
            () => readIntegerEnv("BRIDGE_PORT", rawValue, 8765, { max: 65_535 }),
            error => error instanceof Error && error.message.includes("BRIDGE_PORT") && error.message.includes(rawValue),
        );
    });
}

check("rejects integers larger than JavaScript can represent safely", () => {
    assert.throws(
        () => readIntegerEnv("AGENT_MAX_TURNS", "9007199254740992", 40),
        /AGENT_MAX_TURNS must be an integer/,
    );
});

console.log(`\n${checks} environment-setting checks passed`);
