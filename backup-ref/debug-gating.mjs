import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let handoff = null;
const scheduled = [];
class FakeAudioContext {
	constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
	createOscillator() { const o = { frequency: { value: 0 }, connect() { return this; }, start() {}, stop() {} }; scheduled.push(o); return o; }
	createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; }
	resume() { return Promise.resolve(); }
}
globalThis.window = { __ModuleLoader__: { load(h) { handoff = h; } }, addEventListener() {}, removeEventListener() {}, AudioContext: FakeAudioContext };
globalThis.document = { visibilityState: "hidden" };
(0, eval)(readFileSync(join(here, "..", "lib", "client.js"), "utf8"));
const mod = handoff.factory((s) => (s === "react" ? { createElement: () => null } : (() => { throw new Error(s); })()));
const { NotifyRuntime, DEFAULT_SETTINGS } = mod;

const listeners = new Set();
let map = new Map([["s1", { running: true, pendingInteraction: undefined }]]);
const status = { subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); }, getSnapshot: () => map };
const publish = (next) => { map = new Map(next); for (const l of [...listeners]) l(); };

const mutable = { value: { ...DEFAULT_SETTINGS } };
const liveStore = { getSnapshot: () => mutable.value, subscribe: () => () => {}, dispose() {} };
const ctx = { effect: (fn) => { fn(); return () => {}; }, on: () => () => {}, get: (k) => (k === "uiSession" ? { sessionStatus: status } : undefined) };
const rt = new NotifyRuntime(ctx, liveStore);
console.log("source:", rt.source, "settings.question:", rt.settings.question, "settings.complete:", rt.settings.complete, "settings.enabled:", rt.settings.enabled);

mutable.value = { ...DEFAULT_SETTINGS, question: false };
rt.adoptSettings();
console.log("after adopt, settings.question:", rt.settings.question);
publish([["s1", { running: true, pendingInteraction: "question" }]]);
console.log("plays:", scheduled.length);
