// Serves mod/ over HTTP so the shapez dev build can load the bridge via
// config.local.js:
//     externalModUrl: "http://localhost:3006/agent-bridge.js"
//
// The mod loader fetches this URL at startup, so restarting the game reloads
// whatever is on disk — no bundling step.
//
// 3006, not 3005: shapez's own browsersync dev server takes 3005
// (gulp/gulpfile.js:137).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const PORT = Number(process.env.MOD_PORT || 3006);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD_DIR = join(ROOT, "mod");

// Modules the mod may inline via `// @inject <name>`. An allowlist rather than
// an arbitrary path: the result is evaluated as code inside the game, so the
// set of things that can end up there stays fixed and reviewable.
const INJECTABLE = {
    "router/belt-router.mjs": join(ROOT, "router", "belt-router.mjs"),
};

/**
 * Inlines allowlisted modules at their `// @inject` markers.
 *
 * The shapez mod loader evaluates a mod as a single script, so it can't import.
 * Stripping the `export` keywords turns the module into plain declarations that
 * are already in scope — which keeps the router a normal, testable ES module on
 * disk instead of a copy pasted into the mod.
 */
export async function buildMod(source) {
    const marker = /^[ \t]*\/\/ @inject (.+)$/gm;
    const replacements = [];

    for (const match of source.matchAll(marker)) {
        const name = match[1].trim();
        const path = INJECTABLE[name];
        if (!path) {
            throw new Error(
                `@inject ${name} is not allowlisted (add it to INJECTABLE in serve-mod.mjs)`
            );
        }
        const module = await readFile(path, "utf8");
        const inlined = module.replace(/^export\s+(const|function|class|let)\s/gm, "$1 ");
        replacements.push([
            match[0],
            `// --- inlined from ${name} ---\n${inlined}\n// --- end ${name} ---`,
        ]);
    }

    let out = source;
    for (const [from, to] of replacements) out = out.replace(from, to);
    return out;
}

const server = createServer(async (req, res) => {
    // basename() keeps a crafted path from escaping mod/.
    const name = basename(new URL(req.url, "http://localhost").pathname) || "agent-bridge.js";

    try {
        const body = await buildMod(await readFile(join(MOD_DIR, name), "utf8"));
        res.writeHead(200, {
            "Content-Type": "application/javascript; charset=utf-8",
            // The game caches nothing across reloads, but proxies might.
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(body);
        console.log(`[mod-server] served ${name}`);
    } catch (ex) {
        // A missing file is a 404; a failed @inject is a build error and must
        // not look like one, or the game just reports "mod not found".
        const missing = ex.code === "ENOENT";
        const status = missing ? 404 : 500;
        const message = missing ? `Not found: ${name}` : `Build failed: ${ex.message}`;
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(message);
        console.log(`[mod-server] ${status} ${name} — ${message}`);
    }
});

// Only listen when run directly — tests import buildMod from here.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
    server.listen(PORT, () => {
        console.log(`[mod-server] http://localhost:${PORT}/agent-bridge.js`);
    });
}
