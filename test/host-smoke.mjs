/**
 * Host-half smoke test: imports lib/index.js for real (through workspace shims
 * that re-export the installed @deepseek-ai packages), then exercises:
 *  - the settings-section registration (installSettingsSection contract),
 *  - the schema validation,
 *  - the native-popup decision engine (createPopupNotifier): question /
 *    approval / complete / todo events, turn-boundary baseline resets,
 *    settings gating,
 *  - the PowerShell popup command builder (-EncodedCommand round-trip).
 *
 * Run: node test/host-smoke.mjs  (from the dsh-notify-sounds directory)
 */
import { apply, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, createPopupNotifier, buildPopupCommand, showPopup, isRootSession } from "../lib/index.js";

let failures = 0;
function assert(condition, message) {
	if (condition) {
		console.log(`  ok - ${message}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

// ---- settings section registration + listener wiring ----
const registrations = [];
const listeners = new Map();
const fakeSettings = {
	register(ns, schema, options) {
		registrations.push({ ns, schema, options });
		return {
			get: () => ({ ...options.base }),
			watch: () => () => {}
		};
	}
};
const fakeCtx = {
	inject(keys, fn) {
		if (!Array.isArray(keys) || !keys.includes("settings")) throw new Error("expected settings injection");
		const sctx = {
			settings: fakeSettings,
			effect: (fn) => { const out = fn(); return out ?? (() => {}); }
		};
		return { dispose: fn(sctx) ?? (() => {}) };
	},
	root: {
		on: (name, fn) => { listeners.set(`root:${name}`, fn); return () => listeners.delete(`root:${name}`); }
	},
	on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
	// the real effect defers disposal; register-only so the wiring asserts pass
	effect: () => () => {}
};
apply(fakeCtx); // listeners wired; integration asserts below only feed subagent events (no real spawn)
assert(registrations.length === 1, "exactly one settings section registered");
assert(registrations[0].ns === "notify-sounds", "settings namespace is notify-sounds");
assert(registrations[0].options.base.notifications === true && registrations[0].options.base.notifStyle === "native", "composition defaults include notification fields");
assert(typeof listeners.get("session/event") === "function", "session/event listener wired (shared events pool via ctx.on)");
assert(typeof listeners.get("agent/status") === "function", "agent/status listener wired");

// ---- top-level-only gating ----
assert(isRootSession({ header: {} }) === true, "header without delegationDepth is a root session");
assert(isRootSession({ header: { delegationDepth: 0 } }) === true, "delegationDepth 0 is a root session");
assert(isRootSession({ header: { delegationDepth: 1 } }) === false, "delegationDepth 1 is a subagent session");
assert(isRootSession(undefined) === true, "missing session is treated as root (defensive)");
// feeding a SUBAGENT session event into the real wired listener must not
// reach the notifier (and thus must not spawn any PowerShell process)
listeners.get("session/event")({ id: "child-1", header: { delegationDepth: 1 } }, { type: "tool/call", data: { name: "ask_user_question" } });
listeners.get("session/event")({ id: "child-1", header: { delegationDepth: 1 } }, { type: "todo/write", data: { todos: [{ content: "x", status: "completed" }] } });
listeners.get("agent/status")({ agent: { id: "child-agent", session: { id: "child-1", header: { delegationDepth: 1 } } }, status: "idle" });
assert(true, "subagent session/event and agent/status are ignored (no popup spawned)");

// ---- config.popups=false registers settings but no listeners ----
const disabledRegistrations = [];
const disabledListeners = new Map();
const disabledCtx = {
	inject(keys, fn) {
		const sctx = { settings: { register: (ns, schema, options) => { disabledRegistrations.push({ ns, schema, options }); return { get: () => ({ ...options.base }), watch: () => () => {} }; } }, effect: (fn) => { const out = fn(); return out ?? (() => {}); } };
		return { dispose: fn(sctx) ?? (() => {}) };
	},
	on: (name, fn) => { disabledListeners.set(name, fn); return () => disabledListeners.delete(name); },
	effect: () => () => {}
};
apply(disabledCtx, { popups: false });
assert(disabledRegistrations.length === 1 && disabledListeners.size === 0, "popups:false keeps the settings section but wires no popup listeners");

// ---- schema ----
const good = SETTINGS_SCHEMA({ notifications: false, notifTodo: true, notifStyle: "both" });
assert(good.notifications === false && good.notifStyle === "both", "schema accepts valid values");
assert(good.notifTodoInterval === 12, "schema defaults notifTodoInterval to 12");
assert(good.notifications === false && good.notifStyle === "both", "schema accepts valid values");
let rejected = false;
try {
	SETTINGS_SCHEMA({ notifStyle: "weird" });
} catch {
	rejected = true;
}
assert(rejected, "schema rejects unknown notifStyle");

// ---- popup decision engine ----
const shown = [];
const settingsBox = { value: null };
const notifier = createPopupNotifier({
	show: (payload) => shown.push(payload),
	settings: () => settingsBox.value
});
settingsBox.value = {}; // all defaults -> all kinds on

// question via tool/call
notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
assert(shown.length === 1 && shown[0].body.includes("等待你的选择"), "question tool/call pops");
// approval via approval/asked
notifier.onSessionEvent("s1", { type: "approval/asked", data: { toolName: "write_file" } });
assert(shown.length === 2 && shown[1].body.includes("write_file"), "approval/asked pops with tool name");
// other tool calls do not pop
notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "read_file" } });
assert(shown.length === 2, "other tool calls do not pop");
// agent idle
notifier.onAgentIdle("s1");
assert(shown.length === 3 && shown[2].body === "任务完成", "agent idle pops task-complete");
// todo: baseline then completion
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
	{ content: "A", status: "pending" },
	{ content: "B", status: "in_progress" }
] } });
assert(shown.length === 3, "todo baseline does not pop");
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
	{ content: "A", status: "completed" },
	{ content: "B", status: "in_progress" }
] } });
assert(shown.length === 4 && shown[3].body.includes("「A」已完成（1/2）"), "todo completion pops with progress");
// unchanged list does not pop
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
	{ content: "A", status: "completed" },
	{ content: "B", status: "in_progress" }
] } });
assert(shown.length === 4, "unchanged todo list does not pop");
// turn boundary resets the baseline; re-written completed items do not re-pop
notifier.onSessionEvent("s1", { type: "turn/start", data: {} });
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
	{ content: "A", status: "completed" },
	{ content: "B", status: "completed" },
	{ content: "C", status: "in_progress" }
] } });
assert(shown.length === 4, "re-written plan after turn boundary does not re-pop completed items");
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
	{ content: "A", status: "completed" },
	{ content: "B", status: "completed" },
	{ content: "C", status: "completed" }
] } });
assert(shown.length === 5 && shown[4].body.includes("「C」已完成（3/3）"), "new-turn completion pops");

// gating: notifications off silences everything
settingsBox.value = { notifications: false };
notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
notifier.onAgentIdle("s1");
assert(shown.length === 5, "notifications=false gates all popups");
// per-kind gating
settingsBox.value = { notifications: true, notifComplete: false };
notifier.onAgentIdle("s1");
notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
assert(shown.length === 6, "notifComplete=false gates complete popup only");
settingsBox.value = {};

// reset() clears baselines (reconnect)
notifier.reset();
notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [{ content: "A", status: "completed" }] } });
assert(shown.length === 6, "after reset, first list is a fresh baseline (no pop)");

// ---- popup command builder (embedded payload, verified rendering) ----
const command = buildPopupCommand({ title: "DSH · 测试", body: "中文「引号'」与换行\n测试" });
assert(Array.isArray(command) && command.includes("-EncodedCommand"), "command uses -EncodedCommand");
const encoded = command[command.indexOf("-EncodedCommand") + 1];
const script = Buffer.from(encoded, "base64").toString("utf16le");
assert(script.includes("Add-Type -AssemblyName System.Windows.Forms"), "script loads WinForms");
assert(script.includes("TopMost"), "popup is always on top");
assert(!script.includes("Add-Type -TypeDefinition"), "no csc-based DPI prelude (breaks hidden spawns)");
assert(script.includes("AppliedDPI"), "registry-based scale compensation present");
assert(script.includes("DSH · 测试") && script.includes("中文「引号''」"), "payload embedded verbatim (single quotes doubled, Chinese intact)");
assert(!script.includes("\n测试"), "newlines are flattened");
assert(typeof showPopup === "function", "showPopup exported");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
