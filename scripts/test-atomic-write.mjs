import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.mjs";

let failures = 0;
let checks = 0;
function check(name, condition, extra = "") {
    checks++;
    if (!condition) failures++;
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

const directory = await mkdtemp(join(tmpdir(), "shapez-agent-atomic-write-"));
const target = join(directory, "agent-bridge.js");

try {
    await writeFile(target, "known-good", "utf8");
    await writeFileAtomic(target, "complete-update");

    check("complete writes replace the target", (await readFile(target, "utf8")) === "complete-update");
    check(
        "successful writes leave no temporary file",
        (await readdir(directory)).every(name => !name.endsWith(".tmp"))
    );

    await writeFile(target, "known-good", "utf8");
    const expected = new Error("simulated interrupted write");
    const calls = [];
    const interruptedOperations = {
        async writeFile(path) {
            calls.push(["write", path]);
            throw expected;
        },
        async rename(from, to) {
            calls.push(["rename", from, to]);
        },
        async rm(path, options) {
            calls.push(["cleanup", path, options]);
        },
    };

    let thrown;
    try {
        await writeFileAtomic(target, "partial-update", "utf8", interruptedOperations);
    } catch (error) {
        thrown = error;
    }

    check("interrupted writes report their original error", thrown === expected);
    check("interrupted writes do not rename partial contents", !calls.some(([operation]) => operation === "rename"));
    check("interrupted writes clean up their temporary file", calls.some(([operation]) => operation === "cleanup"));
    check("interrupted writes preserve the installed mod", (await readFile(target, "utf8")) === "known-good");

    const renameError = new Error("simulated failed replacement");
    const renameOperations = {
        async writeFile(path, contents, encoding) {
            await writeFile(path, contents, encoding);
        },
        async rename() {
            throw renameError;
        },
        async rm(path, options) {
            await rm(path, options);
        },
    };

    thrown = undefined;
    try {
        await writeFileAtomic(target, "complete-but-not-installed", "utf8", renameOperations);
    } catch (error) {
        thrown = error;
    }

    check("failed replacements report the rename error", thrown === renameError);
    check("failed replacements preserve the installed mod", (await readFile(target, "utf8")) === "known-good");
    check(
        "failed replacements remove the completed temporary file",
        (await readdir(directory)).every(name => !name.endsWith(".tmp"))
    );
} finally {
    await rm(directory, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
