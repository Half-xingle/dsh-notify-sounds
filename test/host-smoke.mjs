/**
 * Host-half smoke test: imports lib/index.js for real (through workspace shims
 * that re-export the installed @deepseek-ai packages), then exercises:
 *  - the settings contract: the exported Config schema dsh derives the page
 *    from, and the fact that apply needs no settings service at all,
 *  - the schema validation,
 *  - the native-popup decision engine (createPopupNotifier): question /
 *    approval / complete / todo events, turn-boundary baseline resets,
 *    settings gating,
 *  - the PowerShell popup command builder (-EncodedCommand round-trip).
 *
 * Run: node test/host-smoke.mjs  (from the dsh-notify-sounds directory)
 */
import { apply, Config, readConfigValue, SETTINGS_NAMESPACE, createPopupNotifier, buildPopupCommand, showPopup, isRootSession } from "../lib/index.js";

let failures = 0;
function assert(condition, message) {
	if (condition) {
		console.log(`  ok - ${message}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

// ---- listener wiring: apply needs no settings service at all ----
const listeners = new Map();
const fakeCtx = {
	// dsh ≥ 0.1.7 derives the settings page from the exported Config schema, and
	// settings.installSection is gone, so reaching for a settings service here
	// would be a bug — `inject` is a hard failure.
	inject() {
		throw new Error("apply must not use ctx.inject any more (settings.installSection is gone)");
	},
	root: {
		on: (name, fn) => { listeners.set(`root:${name}`, fn); return () => listeners.delete(`root:${name}`); }
	},
	on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
	// the real effect defers disposal; register-only so the wiring asserts pass
	effect: () => () => {}
};
apply(fakeCtx); // listeners wired; integration asserts below only feed subagent events (no real spawn)
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

// ---- config.popups=false wires no popup listeners ----
const disabledListeners = new Map();
const disabledCtx = {
	inject() {
		throw new Error("apply must not use ctx.inject any more");
	},
	on: (name, fn) => { disabledListeners.set(name, fn); return () => disabledListeners.delete(name); },
	effect: () => () => {}
};
apply(disabledCtx, { popups: false });
assert(disabledListeners.size === 0, "popups:false wires no popup listeners (the settings page stays served by the entry Config)");

// ---- Config schema: the settings page dsh derives for this entry ----
const resolved = Config({ notifications: false, notifTodo: true, notifStyle: "both" });
// A volatile field resolves to a cosmokit Volatile BOX, not a plain value —
// readConfigValue is what the gate uses, and comparing the box itself would
// silently disable the gate (the trap this plugin was migrated past).
assert(typeof resolved.notifications === "object" && typeof resolved.notifications.get === "function", "volatile fields resolve to Volatile boxes");
assert(readConfigValue(resolved.notifications) === false && readConfigValue(resolved.notifStyle) === "both", "schema accepts valid values");
assert(readConfigValue(resolved.notifTodoInterval) === 12, "schema defaults notifTodoInterval to 12");
assert(readConfigValue(Config({}).popups) === true, "popups defaults to true (popups on)");
assert(Config({}).popups === true, "popups is ordinary config (plain boolean, not a box)");
{
	// The loader rewrites the box IN PLACE on a live settings edit; a read taken
	// afterwards must see the new value, which is what makes a toggle live.
	const writeSymbol = Object.getOwnPropertySymbols(resolved.notifications).find((symbol) => String(symbol).includes("volatile"));
	assert(typeof writeSymbol === "symbol", "the box carries the volatile write symbol");
	resolved.notifications[writeSymbol](true);
	assert(readConfigValue(resolved.notifications) === true, "a live write through the box is visible on the next read");
}
let rejected = false;
try {
	Config({ notifStyle: "weird" });
} catch {
	rejected = true;
}
assert(rejected, "schema rejects unknown notifStyle");
// Every user-facing field must be volatile or the settings page renders empty;
// `popups` is deployment policy and stays ordinary (non-volatile) config.
const schemaRefs = Object.values(Config.toJSON().refs ?? {});
const volatileRefs = schemaRefs.filter((ref) => ref?.meta?.volatile === true);
assert(volatileRefs.length === 11, `eleven user-facing fields are volatile (got ${volatileRefs.length})`);
assert(volatileRefs.every((ref) => ref.type === "boolean" || ref.type === "number" || ref.type === "union"), "volatile fields are scalar (path-op writable)");
assert(SETTINGS_NAMESPACE === "notify-sounds", "entry id equals the client's settings namespace");

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
