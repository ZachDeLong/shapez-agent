// WebSocket server the shapez mod connects out to.
//
// The game runs in a browser and browsers can't listen, so the agent side hosts
// and the game dials in. One game at a time — a second connection replaces the
// first (that's a page reload, not a second player).

import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const DEFAULT_TIMEOUT_MS = 30_000;

export class GameBridge {
    constructor({ port = PORT, log = console.log } = {}) {
        this.port = port;
        this.log = log;
        this.socket = null;
        this.nextId = 1;
        /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
        this.pending = new Map();
        this.waitingForConnect = [];
        this.server = null;
    }

    start() {
        this.server = new WebSocketServer({ port: this.port });
        this.log(`[bridge] listening on ws://127.0.0.1:${this.port}`);

        this.server.on("connection", socket => {
            if (this.socket) {
                this.log("[bridge] replacing previous connection");
                this.socket.terminate();
            }
            this.socket = socket;
            this.log("[bridge] game connected");

            const waiters = this.waitingForConnect;
            this.waitingForConnect = [];
            for (const resolve of waiters) resolve();

            socket.on("message", raw => this.onMessage(raw));
            socket.on("close", () => {
                if (this.socket === socket) this.socket = null;
                this.log("[bridge] game disconnected");
                this.failAllPending(new Error("Game disconnected"));
            });
            socket.on("error", err => this.log("[bridge] socket error:", err.message));
        });

        return this;
    }

    stop() {
        this.failAllPending(new Error("Bridge stopped"));
        if (this.socket) this.socket.terminate();
        if (this.server) this.server.close();
    }

    /** Resolves once the game process has connected its socket. */
    waitForGame(timeoutMs = 120_000) {
        if (this.socket) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`No game connected after ${timeoutMs}ms`)),
                timeoutMs
            );
            this.waitingForConnect.push(() => {
                clearTimeout(timer);
                resolve();
            });
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
        await this.waitForGame(timeoutMs);
        const deadline = Date.now() + timeoutMs;
        let announced = false;

        for (;;) {
            const status = await this.ping().catch(() => null);
            if (status?.inGame) return status;

            if (!announced && onWait) {
                onWait();
                announced = true;
            }
            if (Date.now() > deadline) {
                throw new Error(`Still at the main menu after ${Math.round(timeoutMs / 1000)}s`);
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
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

    /**
     * Sends an RPC request to the game and resolves with its result.
     * `run` can legitimately take a while, so give it a longer timeout.
     */
    call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
        if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
            return Promise.reject(new Error("No game connected"));
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out after ${timeoutMs}ms: ${method}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(JSON.stringify({ id, method, params }));
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
        return this.call("run", { seconds }, Math.max(60_000, seconds * 2000));
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
