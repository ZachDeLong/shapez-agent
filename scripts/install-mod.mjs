// Builds the mod and copies it into the shapez standalone's mods folder.
//
// The standalone reads every .js in %APPDATA%/shapez.io/mods at startup
// (electron/index.js:27), so installing is just dropping the built file there.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMod } from "../server/serve-mod.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function modsFolder() {
    if (process.env.SHAPEZ_MODS_DIR) return process.env.SHAPEZ_MODS_DIR;
    const roaming =
        process.env.APPDATA ||
        (process.platform === "darwin"
            ? join(process.env.HOME, "Library", "Preferences")
            : join(process.env.HOME, ".local", "share"));
    return join(roaming, "shapez.io", "mods");
}

const dir = modsFolder();
const target = join(dir, "agent-bridge.js");

const built = await buildMod(await readFile(join(ROOT, "mod", "agent-bridge.js"), "utf8"));
if (built.includes("@inject")) throw new Error("an @inject marker was not resolved");
new Function(built); // parse check before it reaches the game

try {
    await access(dir);
} catch {
    console.log(`Creating ${dir}`);
    await mkdir(dir, { recursive: true });
}

await writeFile(target, built, "utf8");
console.log(`Installed ${target} (${built.length} bytes)`);
console.log("\nRestart shapez to load it. Delete that file to uninstall.");
