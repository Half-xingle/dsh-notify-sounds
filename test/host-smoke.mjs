/**
 * Host-half smoke test: imports src/ directly (no build needed), then exercises:
 *  - the apply/ctx wiring contract (global listeners, popups:false short-circuit),
 *  - the settings contract: the exported Config schema dsh derives the page from,
 *  - schema validation and the volatile/non-volatile split,
 *  - the native-popup decision engine (createPopupNotifier): question /
 *    approval / complete / todo events, turn-boundary baseline resets,
 *    settings gating,
 *  - the PowerShell popup command builder (-EncodedCommand round-trip).
 *
 * Run: node --test test/host-smoke.mjs  (from the dsh-notify-sounds directory)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { apply, Config, isRootSession, name, readConfigValue, SETTINGS_NAMESPACE } from "../src/index.js";
import { DEFAULT_SETTINGS, createPopupNotifier } from "../src/notifier.js";
import { buildPopupCommand, showPopup } from "../src/popup.js";

/** A ctx that only records listeners, so wiring can be asserted without a runtime. */
function fakeCtx() {
	const listeners = new Map();
	return {
		listeners,
		inject() {
			throw new Error("apply must not use ctx.inject (settings.installSection is gone)");
		},
		on: (event, fn) => {
			listeners.set(event, fn);
			return () => listeners.delete(event);
		},
		// the real effect defers disposal; register-only so the wiring asserts pass
		effect: () => () => {}
	};
}

test("plugin name and settings namespace identify the same loader entry", () => {
	assert.equal(name, "dsh-notify-sounds");
	assert.equal(SETTINGS_NAMESPACE, "notify-sounds");
});

test("apply wires the global session/event and agent/status listeners", () => {
	const ctx = fakeCtx();
	apply(ctx);
	assert.equal(typeof ctx.listeners.get("session/event"), "function");
	assert.equal(typeof ctx.listeners.get("agent/status"), "function");
});

test("apply ignores subagent sessions entirely (no popup can spawn)", () => {
	const ctx = fakeCtx();
	apply(ctx);
	const child = { id: "child-1", header: { delegationDepth: 1 } };
	assert.doesNotThrow(() => {
		ctx.listeners.get("session/event")(child, { type: "tool/call", data: { name: "ask_user_question" } });
		ctx.listeners.get("session/event")(child, { type: "todo/write", data: { todos: [{ content: "x", status: "completed" }] } });
		ctx.listeners.get("agent/status")({ agent: { id: "child-agent", session: child }, status: "idle" });
	});
});

test("apply with popups:false wires no listeners at all", () => {
	const ctx = fakeCtx();
	apply(ctx, { popups: false });
	assert.equal(ctx.listeners.size, 0, "popups:false keeps the settings page but wires no popup listeners");
});

test("Config resolves every field with its documented default", () => {
	const resolved = Config({});
	const read = (field) => readConfigValue(resolved[field]);
	assert.deepEqual(
		{
			enabled: read("enabled"),
			question: read("question"),
			complete: read("complete"),
			onlyWhenHidden: read("onlyWhenHidden"),
			volume: read("volume"),
			notifications: read("notifications"),
			notifQuestion: read("notifQuestion"),
			notifComplete: read("notifComplete"),
			notifTodo: read("notifTodo"),
			notifStyle: read("notifStyle"),
			notifTodoInterval: read("notifTodoInterval"),
			popups: resolved.popups
		},
		{
			enabled: true,
			question: true,
			complete: true,
			onlyWhenHidden: false,
			volume: 0.5,
			notifications: true,
			notifQuestion: true,
			notifComplete: true,
			notifTodo: true,
			notifStyle: "native",
			notifTodoInterval: 12,
			popups: true
		}
	);
});

test("volatile fields resolve to boxes whose live writes are visible on the next read", () => {
	const resolved = Config({});
	// A volatile field resolves to a cosmokit Volatile BOX, not a plain value —
	// readConfigValue is what the gate uses, and comparing the box itself would
	// silently disable the gate (the trap this plugin was migrated past).
	assert.equal(typeof resolved.notifications, "object");
	assert.equal(typeof resolved.notifications.get, "function");
	assert.equal(readConfigValue(resolved.notifications), true);

	// The loader rewrites the box IN PLACE on a live settings edit; a read taken
	// afterwards must see the new value, which is what makes a toggle live.
	const writeSymbol = Object.getOwnPropertySymbols(resolved.notifications).find((symbol) =>
		String(symbol).includes("volatile")
	);
	assert.equal(typeof writeSymbol, "symbol", "the box carries the volatile write symbol");
	resolved.notifications[writeSymbol](false);
	assert.equal(readConfigValue(resolved.notifications), false);
	assert.equal(readConfigValue(Config({ notifications: false }).notifications), false);
});

test("exactly the eleven user-facing fields are volatile; popups stays ordinary config", () => {
	// Every user-facing field must be volatile or the settings page renders
	// empty; `popups` is deployment policy and stays ordinary (non-volatile).
	const schemaRefs = Object.values(Config.toJSON().refs ?? {});
	const volatileRefs = schemaRefs.filter((ref) => ref?.meta?.volatile === true);
	assert.equal(volatileRefs.length, 11, `eleven user-facing fields are volatile (got ${volatileRefs.length})`);
	for (const ref of volatileRefs) {
		assert.ok(
			ref.type === "boolean" || ref.type === "number" || ref.type === "union",
			`volatile fields must be scalar (path-op writable), got ${ref.type}`
		);
	}
	assert.equal(Config({}).popups, true, "popups is a plain boolean, not a box");
	assert.equal(readConfigValue(Config({ popups: false }).popups), false);
});

test("Config rejects invalid values loudly", () => {
	assert.throws(() => Config({ notifStyle: "weird" }));
	assert.throws(() => Config({ volume: 1.5 }));
	assert.throws(() => Config({ volume: -0.1 }));
	assert.throws(() => Config({ notifTodoInterval: 999 }));
	assert.equal(readConfigValue(Config({ notifStyle: "both" }).notifStyle), "both");
});

test("readConfigValue unwraps boxes and passes plain values through", () => {
	assert.equal(readConfigValue({ get: () => 0.5 }), 0.5);
	assert.equal(readConfigValue(true), true);
	assert.equal(readConfigValue(false), false);
	assert.equal(readConfigValue(undefined), undefined);
	assert.equal(readConfigValue(null), null);
	assert.deepEqual(readConfigValue([1, 2]), [1, 2], "arrays are passed through, never treated as boxes");
});

test("DEFAULT_SETTINGS mirrors the Config defaults one-for-one", () => {
	const resolved = Config({});
	for (const [field, value] of Object.entries(DEFAULT_SETTINGS)) {
		assert.equal(value, readConfigValue(resolved[field]), `DEFAULT_SETTINGS.${field} must equal the Config default`);
	}
	assert.equal(Object.keys(DEFAULT_SETTINGS).length, 11, "DEFAULT_SETTINGS carries exactly the user-facing fields");
});

test("only root sessions notify", () => {
	assert.equal(isRootSession({ header: {} }), true);
	assert.equal(isRootSession({ header: { delegationDepth: 0 } }), true);
	assert.equal(isRootSession(undefined), true);
	assert.equal(isRootSession({ header: { delegationDepth: 1 } }), false);
	assert.equal(isRootSession({ header: { delegationDepth: 3 } }), false);
});

test("the popup decision engine maps each event to its toast and honours gating", () => {
	const shown = [];
	const settingsBox = { value: {} };
	const notifier = createPopupNotifier({
		show: (payload) => shown.push(payload),
		settings: () => settingsBox.value
	});

	notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
	assert.equal(shown.length, 1);
	assert.ok(shown[0].body.includes("等待你的选择"));

	notifier.onSessionEvent("s1", { type: "approval/asked", data: { toolName: "write_file" } });
	assert.equal(shown.length, 2);
	assert.ok(shown[1].body.includes("write_file"));

	notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "read_file" } });
	assert.equal(shown.length, 2, "other tool calls do not pop");

	notifier.onAgentIdle("s1");
	assert.equal(shown.length, 3);
	assert.equal(shown[2].body, "任务完成");

	// todo: baseline then completion
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
		{ content: "A", status: "pending" },
		{ content: "B", status: "in_progress" }
	] } });
	assert.equal(shown.length, 3, "todo baseline does not pop");
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
		{ content: "A", status: "completed" },
		{ content: "B", status: "in_progress" }
	] } });
	assert.equal(shown.length, 4);
	assert.ok(shown[3].body.includes("「A」已完成（1/2）"));
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
		{ content: "A", status: "completed" },
		{ content: "B", status: "in_progress" }
	] } });
	assert.equal(shown.length, 4, "unchanged todo list does not pop");

	// turn boundary resets the baseline; re-written completed items do not re-pop
	notifier.onSessionEvent("s1", { type: "turn/start", data: {} });
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
		{ content: "A", status: "completed" },
		{ content: "B", status: "completed" },
		{ content: "C", status: "in_progress" }
	] } });
	assert.equal(shown.length, 4, "re-written plan after a turn boundary does not re-pop completed items");
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [
		{ content: "A", status: "completed" },
		{ content: "B", status: "completed" },
		{ content: "C", status: "completed" }
	] } });
	assert.equal(shown.length, 5);
	assert.ok(shown[4].body.includes("「C」已完成（3/3）"));

	// gating: notifications off silences everything
	settingsBox.value = { notifications: false };
	notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
	notifier.onAgentIdle("s1");
	assert.equal(shown.length, 5, "notifications=false gates all popups");

	// per-kind gating
	settingsBox.value = { notifications: true, notifComplete: false };
	notifier.onAgentIdle("s1");
	notifier.onSessionEvent("s1", { type: "tool/call", data: { name: "ask_user_question" } });
	assert.equal(shown.length, 6, "notifComplete=false gates the complete popup only");

	settingsBox.value = { notifications: true, notifTodo: false };
	notifier.onSessionEvent("s1", { type: "turn/start", data: {} });
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [{ content: "D", status: "pending" }] } });
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [{ content: "D", status: "completed" }] } });
	assert.equal(shown.length, 6, "notifTodo=false gates the progress popup only");

	// reset() clears baselines (reconnect)
	settingsBox.value = {};
	notifier.reset();
	notifier.onSessionEvent("s1", { type: "todo/write", data: { todos: [{ content: "A", status: "completed" }] } });
	assert.equal(shown.length, 6, "after reset, the first list is a fresh baseline (no pop)");
});

test("a non-array todo write drops the baseline instead of throwing", () => {
	const notifier = createPopupNotifier({ show: () => {}, settings: () => ({}) });
	assert.doesNotThrow(() => notifier.onTodos("s1", undefined));
	assert.doesNotThrow(() => notifier.onTodos("s1", null));
});

test("buildPopupCommand is a hidden EncodedCommand invocation carrying the toast text", () => {
	const command = buildPopupCommand({ title: "DSH · 测试", body: "中文「引号'」与换行\n测试" });
	assert.ok(Array.isArray(command));
	assert.equal(command[0], "-NoProfile");
	assert.equal(command[command.indexOf("-WindowStyle") + 1], "Hidden");
	assert.ok(command.includes("-EncodedCommand"));
	const script = Buffer.from(command[command.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
	assert.ok(script.includes("Add-Type -AssemblyName System.Windows.Forms"), "script loads WinForms");
	assert.ok(script.includes("TopMost"), "popup is always on top");
	assert.equal(script.includes("Add-Type -TypeDefinition"), false, "no csc DPI prelude (it breaks hidden spawns)");
	assert.ok(script.includes("AppliedDPI"), "registry-based scale compensation present");
	assert.ok(script.includes("DSH · 测试"), "title embedded verbatim");
	assert.ok(script.includes("中文「引号''」"), "single quotes doubled, Chinese intact");
	assert.ok(script.includes("line1") === false && script.includes("与换行 测试"), "newlines are flattened");
});

test("buildPopupCommand clamps the lifetime to 2..30 seconds", () => {
	const decode = (seconds) => {
		const command = buildPopupCommand({ title: "t", body: "b", seconds });
		return Buffer.from(command[command.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
	};
	assert.ok(decode(0).includes("$seconds = 2"));
	assert.ok(decode(999).includes("$seconds = 30"));
	assert.ok(decode(6).includes("$seconds = 6"));
});

test("showPopup is exported as a function that never throws", () => {
	// Deliberately not called: it spawns a real hidden PowerShell window, which a
	// unit test must not do. Its argv is covered by the buildPopupCommand tests.
	assert.equal(typeof showPopup, "function");
});
