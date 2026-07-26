// Produces the single-file mod the standalone (Steam) build loads.
//
// The dev build can fetch the mod over HTTP via externalModUrl, but the
// standalone reads plain .js files off disk, so the router has to be inlined
// ahead of time rather than at serve time.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMod } from "../server/serve-mod.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.argv[2] ? process.argv[2] : join(ROOT, "dist");
const OUT = join(OUT_DIR, "agent-bridge.js");

const source = await readFile(join(ROOT, "mod", "agent-bridge.js"), "utf8");
const built = await buildMod(source);

// Fail loudly rather than shipping a mod the game will reject at load time.
if (/^export\s/m.test(built)) throw new Error("build left an `export` in the output");
if (built.includes("@inject")) throw new Error("an @inject marker was not resolved");
if (!built.includes("class Mod")) throw new Error("no Mod class in the output");
if (!built.includes("const METADATA")) throw new Error("no METADATA in the output");
new Function(built); // parse check — catches syntax errors before the game does

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, built, "utf8");
console.log(`Wrote ${OUT} (${built.length} bytes)`);
