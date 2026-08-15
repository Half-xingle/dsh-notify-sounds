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
import { apply, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, createPopupNotifier, buildPopupScript, popupSpawnArgs, popupPaths, showPopup } from "../lib/index.js";

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
apply(fakeCtx, { popups: false }); // no real helper spawn in tests
assert(registrations.length === 1, "exactly one settings section registered");
assert(registrations[0].ns === "notify-sounds", "settings namespace is notify-sounds");
assert(registrations[0].options.base.notifications === true && registrations[0].options.base.notifStyle === "native", "composition defaults include notification fields");
assert(typeof listeners.get("root:session/event") === "function", "session/event listener wired on the root context");
assert(typeof listeners.get("agent/status") === "function", "agent/status listener wired");

// ---- schema ----
const good = SETTINGS_SCHEMA({ notifications: false, notifTodo: true, notifStyle: "both" });
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

// ---- popup script + fixed-signature spawn ----
const script = buildPopupScript();
assert(script.includes("Add-Type -AssemblyName System.Windows.Forms"), "script loads WinForms");
assert(script.includes("TopMost"), "popup is always on top");
assert(!script.includes("Add-Type -TypeDefinition"), "no csc-based DPI prelude (breaks hidden spawns)");
assert(script.includes("AppliedDPI"), "registry-based scale compensation present");
assert(script.includes("ConvertFrom-Json"), "payload is read from the JSON file, not embedded");
const args = popupSpawnArgs();
assert(args.includes("-File") && args.includes(popupPaths().script), "spawn uses -File with the fixed script path");
assert(!args.includes("-EncodedCommand"), "no EncodedCommand (its content would vary the command line per popup)");
assert(JSON.stringify(args) === JSON.stringify(popupSpawnArgs()), "spawn arguments are constant (anti-virus remember rules match once)");
assert(typeof showPopup === "function", "showPopup exported");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
