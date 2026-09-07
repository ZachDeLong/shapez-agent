// Stubs the game side of the protocol to verify the bridge's RPC layer.
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { GameBridge } from "../server/bridge-server.mjs";
import { TOOLS, createDispatcher } from "../server/tools.mjs";

const bridge = new GameBridge({ port: 8799, log: () => {} }).start();
const dispatch = createDispatcher(bridge);
let failures = 0;

function check(name, cond, extra = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
    if (!cond) failures++;
}

// Fake game: answers the same methods the mod implements.
const game = new WebSocket("ws://127.0.0.1:8799");
game.on("message", raw => {
    const { id, method, params } = JSON.parse(raw.toString());
    const replies = {
        ping: () => ({ pong: true, inGame: true }),
        observe: () => ({
            hub: { x: -2, y: -2, w: 4, h: 4 },
            level: 1,
            goal: { shape: "CuCuCuCu", required: 30, delivered: 0 },
            rates: { beltItemsPerSecond: 6, minerItemsPerSecond: 1.5 },
            patches: [{ x: 10, y: 4, kind: "shape", item: "CuCuCuCu", size: 9 }],
            entities: [["hub", -2, -2, 0, "default", 1]],
            radiusEcho: params.radius,
            portsEcho: params.includePorts,
        }),
        buildings: () => [{ id: "belt", unlocked: true }, { id: "miner", unlocked: true }],
        place: () => ({ uid: 42, ...params }),
        placeMany: () => ({ placed: params.entities.length, failures: [] }),
        remove: () => ({ removed: true }),
        setPaused: () => ({ paused: params.paused }),
        run: () => ({ ticks: 900, elapsedSeconds: 15, deliveredDelta: { CuCuCuCu: { count: 3, perSecond: 0.2 } } }),
        boom: () => { throw new Error("simulated game-side failure"); },
    };
    try {
        game.send(JSON.stringify({ id, ok: true, result: replies[method]() }));
    } catch (ex) {
        game.send(JSON.stringify({ id, ok: false, error: String(ex.message) }));
    }
});

await bridge.waitForGame(5000);

// --- request/response plumbing ---
check("ping round-trips", (await bridge.ping()).pong === true);
const obs = await bridge.observe({ radius: 25 });
check("observe returns state", obs.goal.shape === "CuCuCuCu");
check("params reach the game", obs.radiusEcho === 25);

// --- concurrent calls must not cross wires ---
const [a, b, c] = await Promise.all([bridge.buildings(), bridge.ping(), bridge.run(15)]);
check("concurrent calls resolve independently",
    Array.isArray(a) && b.pong === true && c.ticks === 900);

// --- game-side errors surface as rejections ---
let rejected = false;
try { await bridge.call("boom"); } catch (ex) { rejected = ex.message.includes("simulated"); }
check("game-side error rejects with its message", rejected);

// --- tool dispatch layer ---
const viaTool = await dispatch("observe", { radius: 12, include_ports: false });
check("dispatcher maps snake_case to bridge args",
    viaTool.radiusEcho === 12 && viaTool.portsEcho === false);
const unknown = await dispatch("nope", {});
check("unknown tool returns error, doesn't throw", typeof unknown.error === "string");

// --- tool schema sanity ---
check("every tool has name/description/input_schema",
    TOOLS.every(t => t.name && t.description && t.input_schema?.type === "object"));
check("every dispatcher key has a schema and vice versa",
    TOOLS.every(t => typeof dispatch === "function") && TOOLS.length === 7,
    `${TOOLS.length} tools`);
for (const t of TOOLS) {
    const r = await dispatch(t.name, {});
    check(`  dispatch(${t.name}) reaches the game`, !r?.error || !r.error.startsWith("Unknown tool"));
}

// --- replacement socket close events must not poison the new connection ---
class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.OPEN = 1;
        this.readyState = this.OPEN;
        this.sent = [];
        this.terminated = false;
    }
    send(raw) {
        this.sent.push(JSON.parse(raw));
    }
    terminate() {
        this.terminated = true;
    }
}

const reconnectBridge = new GameBridge({ log: () => {} });
const oldSocket = new FakeSocket();
const newSocket = new FakeSocket();
reconnectBridge.handleConnection(oldSocket);

const oldCall = reconnectBridge.call("old-request", {}, 5000);
reconnectBridge.handleConnection(newSocket);
let replacementHandled = false;
try { await oldCall; } catch (ex) { replacementHandled = ex.message.includes("replaced"); }
check("replacement rejects calls sent through the old socket", replacementHandled);
check("replacement terminates the old socket", oldSocket.terminated);

const newCall = reconnectBridge.call("new-request", {}, 5000);
oldSocket.emit("close");
const [{ id: newCallId }] = newSocket.sent;
reconnectBridge.onMessage(JSON.stringify({ id: newCallId, ok: true, result: "new response" }));
check("stale close leaves new-socket calls alive", (await newCall) === "new response");

// --- send failures reject immediately and release pending state ---
const throwingSocket = new FakeSocket();
throwingSocket.send = () => { throw new Error("socket write failed"); };
const throwingBridge = new GameBridge({ log: () => {} });
throwingBridge.handleConnection(throwingSocket);
let synchronousSendRejected = false;
try {
    await throwingBridge.call("sync-send-failure", {}, 5000);
} catch (ex) {
    synchronousSendRejected = ex.message.includes("socket write failed");
}
check("synchronous send failure rejects with its cause", synchronousSendRejected);
check("synchronous send failure clears pending state", throwingBridge.pending.size === 0);

const callbackSocket = new FakeSocket();
callbackSocket.send = (_raw, callback) => {
    queueMicrotask(() => callback(new Error("send callback failed")));
};
const callbackBridge = new GameBridge({ log: () => {} });
callbackBridge.handleConnection(callbackSocket);
let callbackSendRejected = false;
try {
    await callbackBridge.call("callback-send-failure", {}, 5000);
} catch (ex) {
    callbackSendRejected = ex.message.includes("send callback failed");
}
check("send callback failure rejects with its cause", callbackSendRejected);
check("send callback failure clears pending state", callbackBridge.pending.size === 0);

// --- connection waiters settle and release their timers ---
const timeoutBridge = new GameBridge({ log: () => {} });
let connectTimedOut = false;
try {
    await timeoutBridge.waitForGame(5);
} catch (ex) {
    connectTimedOut = ex.message.includes("No game connected");
}
check("connection wait timeout rejects", connectTimedOut);
check("timed-out connection waiter is removed", timeoutBridge.waitingForConnect.size === 0);

const stoppedBridge = new GameBridge({ log: () => {} });
const stoppedWaiter = stoppedBridge.waitForGame(5000);
stoppedBridge.stop();
let stopRejectedWaiter = false;
try {
    await stoppedWaiter;
} catch (ex) {
    stopRejectedWaiter = ex.message.includes("Bridge stopped");
}
check("stopping the bridge rejects connection waiters", stopRejectedWaiter);
check("stopping the bridge removes connection waiters", stoppedBridge.waitingForConnect.size === 0);

// --- disconnect fails in-flight calls instead of hanging ---
const inflight = bridge.call("observe", {}, 5000);
game.terminate();
let disconnectHandled = false;
try { await inflight; } catch (ex) { disconnectHandled = ex.message.includes("disconnected"); }
check("disconnect rejects in-flight calls", disconnectHandled);

bridge.stop();
console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
