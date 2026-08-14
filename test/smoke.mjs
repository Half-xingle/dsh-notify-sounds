/**
 * Smoke test for dsh-notify-sounds browser half (lib/client.js).
 *
 * Simulates the client-modules environment: a fake `window` with
 * `__ModuleLoader__`, fake `document`, a stub react, fake localStorage, a fake
 * sessions list observable, and a fake AudioContext that records scheduled
 * tones. Drives `apply(ctx)` and asserts notification edges + settings.
 *
 * Run: node test/smoke.mjs  (from the dsh-notify-sounds directory)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");

let failures = 0;
function assert(condition, message) {
	if (condition) {
		console.log(`  ok - ${message}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

// ---- fake localStorage ----
const storageData = new Map();
const fakeLocalStorage = {
	getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
	setItem: (key, value) => { storageData.set(key, String(value)); },
	removeItem: (key) => { storageData.delete(key); },
	clear: () => { storageData.clear(); }
};

// ---- fake AudioContext recording scheduled oscillators ----
const scheduled = [];
class FakeAudioContext {
	constructor() {
		this.state = "running";
		this.currentTime = 0;
		this.destination = {};
	}
	createOscillator() {
		const osc = {
			type: "sine",
			frequency: { value: 0 },
			connect() { return this; },
			start() {},
			stop() {}
		};
		scheduled.push(osc);
		return osc;
	}
	createGain() {
		return {
			gain: {
				setValueAtTime() {},
				exponentialRampToValueAtTime() {}
			},
			connect() { return this; }
		};
	}
	resume() { this.state = "running"; return Promise.resolve(); }
}

// ---- fake window / document / module loader ----
let handoff = null;
const windowListeners = new Map();
const fakeWindow = {
	__ModuleLoader__: {
		load(h) { handoff = h; }
	},
	addEventListener(type, fn, opts) {
		windowListeners.set(type, { fn, opts });
	},
	removeEventListener(type) {
		windowListeners.delete(type);
	},
	AudioContext: FakeAudioContext
};
const fakeDocument = { visibilityState: "visible" };
globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.localStorage = fakeLocalStorage;

// ---- stub react ----
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: { ...props, children }, children }),
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
};
const fakeRequire = (spec) => {
	if (spec === "react") return reactStub;
	throw new Error(`unexpected require("${spec}") in smoke test`);
};

// ---- load + materialize the bundle ----
const source = readFileSync(clientPath, "utf8");
(0, eval)(source);
if (handoff === null) throw new Error("bundle did not register via __ModuleLoader__.load");
assert(handoff.id === "dsh-notify-sounds", `bundle id is "${handoff.id}"`);
const mod = handoff.factory(fakeRequire);
assert(typeof mod.apply === "function", "exports.apply is a function");
assert(Array.isArray(mod.inject), "exports.inject is an array");
assert(mod.inject.includes("sessions"), "inject lists sessions");

// ---- fake sessions list observable ----
const sessionsListeners = new Set();
let sessionSnap = { ids: [], byId: {}, current: void 0, phase: "ready", subagentsByParent: {}, jobsBySession: {}, currentAddress: void 0 };
const sessionsService = {
	list: {
		getSnapshot: () => sessionSnap,
		subscribe: (listener) => { sessionsListeners.add(listener); return () => sessionsListeners.delete(listener); }
	}
};
function setSessions(byId, ids = Object.keys(byId)) {
	sessionSnap = { ...sessionSnap, ids, byId };
	for (const l of [...sessionsListeners]) l();
}

// ---- fake ctx ----
const eventHandlers = new Map();
const slotInjections = new Map();
const locales = new Map();
const registrations = [];
const ctx = {
	effect: (fn) => { const out = fn(); return out ?? (() => {}); },
	on: (event, handler) => { eventHandlers.set(event, handler); return () => {}; },
	get: (key) => (key === "sessions" ? sessionsService : void 0),
	locale: { register: (ns, dict) => locales.set(ns, dict) },
	slots: {
		inject: (name, fn) => slotInjections.set(name, fn),
		register: (options, component) => { registrations.push({ options, component }); return () => {}; }
	}
};

// ---- apply ----
mod.apply(ctx);
assert(locales.has("notify-sounds.card"), "card locale registered");
assert(eventHandlers.has("connection/reset"), "connection/reset handler installed");
assert(slotInjections.has("settings.plugin.item"), "settings.plugin.item injection registered");

// ---- collect the card registration + store handle ----
const gen = slotInjections.get("settings.plugin.item")();
const first = gen.next();
assert(first.done === false, "slot injection yields a registration");
const registration = registrations[0];
assert(registration !== void 0, "slots.register captured a registration");
assert(registration.options.id === "notify-sounds", "card registered with id notify-sounds");
assert(typeof registration.component === "function", "card component is a function");
const injected = registration.options.inject();
const store = injected.hooks.notify;
assert(typeof store.getSnapshot === "function" && typeof store.set === "function", "card hooks.notify is the settings store");
const cardProps = {
	t: (key) => key,
	useNotify: (selector) => selector(store.getSnapshot()),
	...injected
};
const cardEl = registration.component(cardProps);
assert(cardEl !== null && cardEl !== void 0, "card renders");
assert(typeof cardEl.props.children === "object", "card has children rows");

// ---- defaults ----
assert(store.getSnapshot().enabled === true && store.getSnapshot().volume === 0.5, "defaults applied");

// ---- notification edge scenarios ----
function plays() { return scheduled.length; }
function freqAt(index) { return scheduled[index].frequency.value; }

// initial observation: one idle session -> no beep
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 0, "initial observation does not beep");

// session starts running -> no beep (only edges OUT of running beep)
setSessions({ s1: { id: "s1", running: true } });
assert(plays() === 0, "running start does not beep");

// question arrives while running -> question beep (two notes: 880 + 1174.66)
setSessions({ s1: { id: "s1", running: true, pendingInteraction: "question" } });
assert(plays() === 2, "question pendingInteraction beeps two notes");
assert(freqAt(0) === 880 && freqAt(1) === 1174.66, "question sequence frequencies match");

// question resolved -> no beep
setSessions({ s1: { id: "s1", running: true } });
assert(plays() === 2, "question resolution does not beep");

// approval arrives -> approval beep (660 + 880)
setSessions({ s1: { id: "s1", running: true, pendingInteraction: "approval" } });
assert(plays() === 4, "approval pendingInteraction beeps two notes");
assert(freqAt(2) === 659.25 && freqAt(3) === 880, "approval sequence frequencies match");

// approval resolved -> no beep; then plan-review arrives -> question beep
setSessions({ s1: { id: "s1", running: true } });
assert(plays() === 4, "approval resolution does not beep");
setSessions({ s1: { id: "s1", running: true, pendingInteraction: "plan-review" } });
assert(plays() === 6, "plan-review beeps two notes");
assert(freqAt(4) === 880, "plan-review uses the question sequence");

// task completes -> complete beep (523 + 659 + 784)
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 9, "running->idle beeps three notes");
assert(freqAt(6) === 523.25 && freqAt(7) === 659.25 && freqAt(8) === 783.99, "complete sequence frequencies match");

// ---- settings gating (through the store, as the card does) ----
store.set("complete", false);
setSessions({ s1: { id: "s1", running: true } });
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 9, "complete toggle off suppresses complete beep");
store.set("complete", true);

store.set("question", false);
setSessions({ s1: { id: "s1", running: true, pendingInteraction: "question" } });
assert(plays() === 9, "question toggle off suppresses question beep");
store.set("question", true);

store.set("enabled", false);
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 9, "master enabled=false suppresses beeps");
store.set("enabled", true);

// ---- onlyWhenHidden ----
store.set("onlyWhenHidden", true);
fakeDocument.visibilityState = "visible";
setSessions({ s1: { id: "s1", running: true } });
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 9, "onlyWhenHidden + visible page suppresses complete beep");
fakeDocument.visibilityState = "hidden";
setSessions({ s1: { id: "s1", running: true } });
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 12, "onlyWhenHidden + hidden page beeps");
fakeDocument.visibilityState = "visible";
store.set("onlyWhenHidden", false);

// ---- reconnect: no beep for pre-existing conditions ----
const reset = eventHandlers.get("connection/reset");
reset();
setSessions({ s2: { id: "s2", running: false }, s3: { id: "s3", running: false } });
assert(plays() === 12, "reconnect baseline records without beeping");
setSessions({ s2: { id: "s2", running: false }, s3: { id: "s3", running: false }, s4: { id: "s4", running: false } });
assert(plays() === 12, "new already-idle session does not beep");
setSessions({ s2: { id: "s2", running: true }, s3: { id: "s3", running: false }, s4: { id: "s4", running: false } });
setSessions({ s2: { id: "s2", running: false }, s3: { id: "s3", running: false }, s4: { id: "s4", running: false } });
assert(plays() === 15, "genuine running->idle edge after reconnect beeps");

// ---- volume 0 silences ----
store.set("volume", 0);
setSessions({ s1: { id: "s1", running: true } });
setSessions({ s1: { id: "s1", running: false } });
assert(plays() === 15, "volume 0 plays no tones");
store.set("volume", 0.5);

// ---- preview ignores gating but records a tone ----
const before = plays();
injected.preview();
assert(plays() === before + 3, "preview plays the complete sequence (3-note) — got " + (plays() - before));

// ---- persistence: a fresh store sees the stored values ----
store.set("volume", 0.8);
store.set("question", false);
const thirdStore = mod.createLocalSettingsStore();
assert(thirdStore.getSnapshot().volume === 0.8 && thirdStore.getSnapshot().question === false, "fresh store reads persisted localStorage");
store.set("volume", 0.5);
store.set("question", true);

// ---- resetAll restores defaults ----
store.set("onlyWhenHidden", true);
injected.resetAll();
assert(store.getSnapshot().onlyWhenHidden === false && store.getSnapshot().volume === 0.5, "resetAll restores defaults");

// ---- cross-tab sync via storage event ----
const storageListener = windowListeners.get("storage")?.fn;
assert(typeof storageListener === "function", "storage event listener installed");
fakeLocalStorage.setItem(mod.STORAGE_KEY, JSON.stringify({ ...mod.DEFAULT_SETTINGS, volume: 0.9 }));
storageListener({ key: mod.STORAGE_KEY });
assert(store.getSnapshot().volume === 0.9, "storage event adopts the other tab's value");
storageListener({ key: "unrelated-key" });
assert(store.getSnapshot().volume === 0.9, "unrelated storage events are ignored");

// ---- audio unlock listeners installed ----
assert(windowListeners.has("pointerdown") && windowListeners.has("keydown"), "audio unlock listeners installed");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
