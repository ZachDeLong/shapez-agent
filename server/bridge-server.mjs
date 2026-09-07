// WebSocket server the shapez mod connects out to.
//
// The game runs in a browser and browsers can't listen, so the agent side hosts
// and the game dials in. One game at a time — a second connection replaces the
// first (that's a page reload, not a second player).

import { WebSocketServer } from "ws";
import { readIntegerEnv } from "./env.mjs";

const PORT = readIntegerEnv("BRIDGE_PORT", process.env.BRIDGE_PORT, 8765, { max: 65_535 });
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RUN_SECONDS = 300;

export function validateRunSeconds(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RUN_SECONDS) {
        throw new Error(`seconds must be a finite number greater than 0 and no more than ${MAX_RUN_SECONDS}`);
    }
    return seconds;
}

export class GameBridge {
    constructor({ port = PORT, log = console.log } = {}) {
        this.port = port;
        this.log = log;
        this.socket = null;
        this.nextId = 1;
        /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
        this.pending = new Map();
        /** @type {Set<{resolve: Function, reject: Function, timer: any}>} */
        this.waitingForConnect = new Set();
        this.server = null;
    }

    start() {
        this.server = new WebSocketServer({ port: this.port });
        this.log(`[bridge] listening on ws://127.0.0.1:${this.port}`);

        this.server.on("connection", socket => this.handleConnection(socket));

        return this;
    }

    handleConnection(socket) {
        if (this.socket) {
            this.log("[bridge] replacing previous connection");
            this.failAllPending(new Error("Game connection replaced"));
            this.socket.terminate();
        }
        this.socket = socket;
        this.log("[bridge] game connected");

        const waiters = [...this.waitingForConnect];
        this.waitingForConnect.clear();
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve();
        }

        socket.on("message", raw => this.onMessage(raw));
        socket.on("close", () => {
            // A replaced socket can close after the new connection is already
            // serving RPCs. Its stale close event must not reject those calls.
            if (this.socket !== socket) return;
            this.socket = null;
            this.log("[bridge] game disconnected");
            this.failAllPending(new Error("Game disconnected"));
        });
        socket.on("error", err => this.log("[bridge] socket error:", err.message));
    }

    stop() {
        this.failAllPending(new Error("Bridge stopped"));
        this.failAllConnectWaiters(new Error("Bridge stopped"));
        if (this.socket) this.socket.terminate();
        if (this.server) this.server.close();
    }

    /** Resolves once the game process has connected its socket. */
    waitForGame(timeoutMs = 120_000) {
        if (this.socket) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                this.waitingForConnect.delete(waiter);
                reject(new Error(`No game connected after ${timeoutMs}ms`));
            }, timeoutMs);
            this.waitingForConnect.add(waiter);
        });
    }

    /**
     * Resolves once a savegame is actually loaded.
     *
     * The mod connects at app boot, so a live socket only means the game is
     * running — at the main menu there is no root and every RPC but `ping`
     * fails. Poll until it reports in-game.
     */
    async waitForInGame({ timeoutMs = 600_000, pollMs = 1000, onWait } = {}) {
        const deadline = Date.now() + timeoutMs;
        await this.waitForGame(timeoutMs);
        let announced = false;

        for (;;) {
            const remainingBeforePing = deadline - Date.now();
            if (remainingBeforePing <= 0) {
                throw new Error(`Still at the main menu after ${Math.round(timeoutMs / 1000)}s`);
            }

            const status = await this.call(
                "ping",
                {},
                Math.min(DEFAULT_TIMEOUT_MS, remainingBeforePing)
            ).catch(() => null);
            if (status?.inGame) return status;

            if (!announced && onWait) {
                onWait();
                announced = true;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`Still at the main menu after ${Math.round(timeoutMs / 1000)}s`);
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
        }
    }

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (ex) {
            this.log("[bridge] unparseable message from game");
            return;
        }

        // Unsolicited notifications (e.g. gameStarted) carry no id.
        if (msg.id === undefined) {
            this.log("[bridge] event:", msg.event || msg.type);
            return;
        }

        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);

        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || "Unknown game-side error"));
    }

    failAllPending(error) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
    }

    failAllConnectWaiters(error) {
        for (const waiter of this.waitingForConnect) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.waitingForConnect.clear();
    }

    /**
     * Sends an RPC request to the game and resolves with its result.
     * `run` can legitimately take a while, so give it a longer timeout.
     */
    call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
            return Promise.reject(new Error("No game connected"));
        }

        const socket = this.socket;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out after ${timeoutMs}ms: ${method}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            const failSend = error => {
                if (!error) return;
                const entry = this.pending.get(id);
                if (!entry) return;

                this.pending.delete(id);
                clearTimeout(entry.timer);
                const message = error instanceof Error ? error.message : String(error);
                reject(new Error(`Failed to send ${method}: ${message}`));
            };

            try {
                socket.send(JSON.stringify({ id, method, params }), failSend);
            } catch (error) {
                failSend(error);
            }
        });
    }

    // Convenience wrappers ---------------------------------------------------

    ping() {
        return this.call("ping");
    }
    observe(params = {}) {
        return this.call("observe", params);
    }
    buildings() {
        return this.call("buildings");
    }
    place(params) {
        return this.call("place", params);
    }
    placeMany(entities, atomic = false) {
        return this.call("placeMany", { entities, atomic });
    }
    remove(x, y) {
        return this.call("remove", { x, y });
    }
    connect(params) {
        return this.call("connect", params);
    }
    setPaused(paused) {
        return this.call("setPaused", { paused });
    }
    /** Stepping is synchronous game-side, so allow generous headroom. */
    run(seconds = 10) {
        const validatedSeconds = validateRunSeconds(seconds);
        return this.call(
            "run",
            { seconds: validatedSeconds },
            Math.max(60_000, validatedSeconds * 2000)
        );
    }
}

// Run standalone: node server/bridge-server.mjs
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
    const bridge = new GameBridge().start();
    process.on("SIGINT", () => {
        bridge.stop();
        process.exit(0);
    });
}
