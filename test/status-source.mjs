/**
 * Status-source test for the browser half's session-edge watcher.
 *
 * `smoke.mjs` drives the whole bundle through the `sessions.list` fallback.
 * This file covers the PREFERRED source the runtime picks when the Session UI
 * adapter is present — `ctx.uiSession.sessionStatus`, a
 * `ReadonlyMap<SessionId, { running, pendingInteraction, completionUnread }>` —
 * and proves the two sources produce the same edges.
 *
 * Run: node test/status-source.mjs  (from the dsh-notify-sounds directory)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// ---- fake AudioContext recording scheduled tones ----
const scheduled = [];
class FakeAudioContext {
	constructor() {
		this.state = "running";
		this.currentTime = 0;
		this.destination = {};
	}
	createOscillator() {
		const osc = { type: "sine", frequency: { value: 0 }, connect() { return this; }, start() {}, stop() {} };
		scheduled.push(osc);
		return osc;
	}
	createGain() {
		return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } };
	}
	resume() { return Promise.resolve(); }
}

// ---- fake window / document / module loader ----
let handoff = null;
const windowListeners = new Map();
globalThis.window = {
	__ModuleLoader__: { load(h) { handoff = h; } },
	addEventListener: (type, fn) => windowListeners.set(type, fn),
	removeEventListener: (type) => windowListeners.delete(type),
	AudioContext: FakeAudioContext,
};
globalThis.document = { visibilityState: "hidden" };

// ---- load + materialize the bundle ----
(0, eval)(readFileSync(clientPath, "utf8"));
if (handoff === null) throw new Error("bundle did not register via __ModuleLoader__.load");
const mod = handoff.factory((spec) => {
	if (spec === "react") return { createElement: () => null, useSyncExternalStore: () => undefined };
	throw new Error(`unexpected require("${spec}")`);
});
const { NotifyRuntime, DEFAULT_SETTINGS } = mod;

/** A settings store that never changes (the runtime only reads it here). */
const store = {
	getSnapshot: () => ({ ...DEFAULT_SETTINGS }),
	subscribe: () => () => {},
	dispose: () => {},
};

/**
 * A settings store whose value the test can replace. Like the real configForms
 * adapter it PUBLISHES on change, which is what makes the runtime re-adopt the
 * settings; a store that only swaps its snapshot would be a test artifact.
 * @param initial - the starting settings object.
 */
function mutableSettingsStore(initial) {
	const listeners = new Set();
	let value = { ...initial };
	return {
		getSnapshot: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => {},
		/** Replace the settings and notify subscribers. */
		update(next) {
			value = { ...next };
			for (const listener of [...listeners]) listener();
		},
	};
}

/** A SessionStatusSnapshot stand-in: a ReadonlyMap with replaceable contents. */
function statusSource(entries) {
	const listeners = new Set();
	let map = new Map(entries);
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => map,
		publish(next) {
			map = new Map(next);
			for (const listener of [...listeners]) listener();
		},
	};
}

/** Minimal ctx: `get` serves whatever this test wires. */
function ctxFor({ status, sessions }) {
	const listeners = new Map();
	return {
		effects: 0,
		effect(fn) { this.effects += 1; const out = fn(); return typeof out === "function" ? out : () => {}; },
		on(event, handler) { listeners.set(event, handler); return () => {}; },
		get: (key) => (key === "uiSession" && status !== undefined ? { sessionStatus: status } : key === "sessions" ? sessions : void 0),
		event: (name) => listeners.get(name),
	};
}

const settings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, ...overrides });
const plays = () => scheduled.length;
const freqs = () => scheduled.map((osc) => osc.frequency.value);

// ============ 1. the status source is preferred and drives the edges ============
{
	scheduled.length = 0;
	const status = statusSource([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	const ctx = ctxFor({ status });
	const runtime = new NotifyRuntime(ctx, store);
	assert(runtime.source === "status", "the runtime prefers ctx.uiSession.sessionStatus when it is present");

	// initial observation records state without beeping
	assert(plays() === 0, "initial status snapshot does not beep");

	// running start is not an edge
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 0, "running start does not beep");

	// pending interaction appears -> question sequence (880 / 1174.66)
	status.publish([["s1", { running: true, pendingInteraction: "question", completionUnread: false }]]);
	assert(plays() === 2, "pending question beeps the two-note question sequence");
	assert(freqs()[0] === 880 && freqs()[1] === 1174.66, "question sequence frequencies match the list-source path");

	// resolution is not an edge
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 2, "question resolution does not beep");

	// approval uses the approval sequence (659.25 / 880)
	status.publish([["s1", { running: true, pendingInteraction: "approval", completionUnread: false }]]);
	assert(plays() === 4, "pending approval beeps the two-note approval sequence");
	assert(freqs()[2] === 659.25 && freqs()[3] === 880, "approval sequence frequencies match the list-source path");

	// approval resolved -> no beep
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 4, "approval resolution does not beep");

	// plan-review maps to the question sequence
	status.publish([["s1", { running: true, pendingInteraction: "plan-review", completionUnread: false }]]);
	assert(plays() === 6 && freqs()[4] === 880, "plan-review uses the question sequence");

	// resolve the pending interaction before testing the completion edge: the
	// running -> idle edge needs a state with no pending interaction
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 6, "plan-review resolution does not beep");

	// running -> idle is the completion edge (three notes)
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 9, "running -> idle beeps the three-note complete sequence");
	assert(freqs()[6] === 523.25 && freqs()[7] === 659.25 && freqs()[8] === 783.99, "complete sequence frequencies match");

	// section 1 tail: a session leaving the snapshot drops its baseline silently
	status.publish([]);
	assert(plays() === 9, "a session leaving the snapshot does not beep");
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 9, "re-entering with no edge does not beep");
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 12, "a genuine running -> idle edge after re-entry beeps");
}

// ============ 2. gating still reads the live settings ============
{
	scheduled.length = 0;
	const status = statusSource([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	const liveStore = mutableSettingsStore(DEFAULT_SETTINGS);
	const runtime = new NotifyRuntime(ctxFor({ status }), liveStore);
	assert(runtime.source === "status", "second runtime also uses the status source");

	liveStore.update(settings({ question: false }));
	status.publish([["s1", { running: true, pendingInteraction: "question", completionUnread: false }]]);
	assert(plays() === 0, "question toggle off suppresses the question beep");

	liveStore.update(settings({ complete: false }));
	// resolve the (suppressed) pending interaction first so the completion edge
	// is a plain running -> idle transition
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 0, "complete toggle off suppresses the complete beep");

	liveStore.update(settings({ enabled: false }));
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	status.publish([["s1", { running: true, pendingInteraction: "approval", completionUnread: false }]]);
	assert(plays() === 0, "the master switch suppresses every beep");
}

// ============ 3. connection/reset re-baselines without beeping ============
{
	scheduled.length = 0;
	const status = statusSource([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	const ctx = ctxFor({ status });
	new NotifyRuntime(ctx, store);
	assert(plays() === 0, "baseline established");

	const reset = ctx.event("connection/reset");
	assert(typeof reset === "function", "connection/reset handler installed");
	reset();
	// after a reset the first snapshot is a baseline again, even mid-condition
	status.publish([["s1", { running: false, pendingInteraction: "question", completionUnread: false }]]);
	assert(plays() === 0, "after connection/reset the first snapshot records without beeping");
	// and real edges afterwards still fire
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 0, "clearing the pending interaction is not an edge");
	status.publish([["s1", { running: true, pendingInteraction: undefined, completionUnread: false }]]);
	status.publish([["s1", { running: false, pendingInteraction: undefined, completionUnread: false }]]);
	assert(plays() === 3, "a genuine completion edge after the reset beeps");
}

// ============ 4. subagent sessions stay silent ============
{
	scheduled.length = 0;
	const status = statusSource([
		["parent", { running: true, pendingInteraction: undefined, completionUnread: false }],
		["child", { running: true, pendingInteraction: undefined, completionUnread: false }],
	]);
	// The status map carries no parent link, so the list source supplies it.
	const sessions = {
		list: {
			getSnapshot: () => ({
				ids: ["parent", "child"],
				byId: {
					parent: { id: "parent", running: true, displayTitle: "Parent" },
					child: { id: "child", running: true, parentId: "parent", displayTitle: "Child" },
				},
			}),
			subscribe: () => () => {},
		},
	};
	new NotifyRuntime(ctxFor({ status, sessions }), store);
	assert(plays() === 0, "subagent baseline records without beeping");

	status.publish([
		["parent", { running: true, pendingInteraction: undefined, completionUnread: false }],
		["child", { running: true, pendingInteraction: "question", completionUnread: false }],
	]);
	assert(plays() === 0, "a subagent pending interaction does not beep");

	// clear the subagent's pending interaction before its completion edge
	status.publish([
		["parent", { running: true, pendingInteraction: undefined, completionUnread: false }],
		["child", { running: true, pendingInteraction: undefined, completionUnread: false }],
	]);
	assert(plays() === 0, "clearing a subagent pending interaction does not beep");

	status.publish([
		["parent", { running: true, pendingInteraction: undefined, completionUnread: false }],
		["child", { running: false, pendingInteraction: undefined, completionUnread: false }],
	]);
	assert(plays() === 0, "a subagent running -> idle does not beep");

	status.publish([
		["parent", { running: true, pendingInteraction: "question", completionUnread: false }],
		["child", { running: false, pendingInteraction: undefined, completionUnread: false }],
	]);
	assert(plays() === 2, "the top-level session still beeps while a subagent is present");
}

// ============ 5. without uiSession the list source is used ============
{
	scheduled.length = 0;
	const sessions = {
		list: {
			getSnapshot: () => ({ ids: ["s1"], byId: { s1: { id: "s1", running: false } } }),
			subscribe: () => () => {},
		},
	};
	const ctx = ctxFor({ sessions });
	const runtime = new NotifyRuntime(ctx, store);
	assert(runtime.source === "list", "without uiSession the runtime falls back to sessions.list");
	assert(plays() === 0, "fallback baseline does not beep");
}

// ============ 6. offline mode: no session source at all ============
{
	scheduled.length = 0;
	const runtime = new NotifyRuntime(ctxFor({}), store);
	assert(runtime.source === undefined, "with neither source the runtime subscribes to nothing");
	assert(plays() === 0, "no source means no beep and no crash");
	assert(windowListeners.has("pointerdown") && windowListeners.has("keydown"), "audio unlock listeners are still installed");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
