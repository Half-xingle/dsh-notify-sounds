/**
 * dsh-notify-sounds — host half.
 *
 * Owns the `notify-sounds` loader entry: the exported Config schema below IS
 * the settings page dsh serves for it, and the browser half edits that same
 * namespace through `ctx.configForms`. It also drives NATIVE desktop popups via
 * the decision engine in ./notifier.js and the WinForms spawner in ./popup.js.
 *
 * Event sources (all from the host session event stream / agent registry):
 *   - question / plan review : `tool/call` with name `ask_user_question`
 *   - approval               : `approval/asked` (dsh-user-approval audit event)
 *   - task complete          : `agent/status` -> idle
 *   - todo progress          : `todo/write` (full-list diff; `turn/start`
 *                              resets the per-session baseline, matching the
 *                              host `todos` projection semantics)
 *
 * Gating reads the live Config object: volatile fields resolve to cosmokit
 * Volatile boxes that the loader rewrites IN PLACE (then emits
 * `loader/volatile-update`), so a settings-UI toggle takes effect without a
 * restart — see readConfigValue. The composition row may set
 * `config: { popups: false }` to keep the UI but silence desktop popups.
 */
import z from "@deepseek-ai/schemastery";
import { DEFAULT_SETTINGS, createPopupNotifier } from "./notifier.js";

/** Plugin name for the Loader row; the client bundle registers under the same id. */
export const name = "dsh-notify-sounds";

/** Loader entry id owned by this plugin — the settings namespace dsh serves its config under. */
export const SETTINGS_NAMESPACE = "notify-sounds";

/**
 * Plugin Config schema. Since dsh 0.1.7 a loader entry's settings page is
 * derived from this schema alone (the `settings.installSection` registration
 * this file used before no longer exists), and every field marked `volatile`
 * becomes live-editable from the browser. The loader commits accepted values
 * into the running config object IN PLACE and then emits
 * `loader/volatile-update`, so the popup gate below reads live values with no
 * re-registration.
 */
export const Config = z.object({
	/** Master switch: no sound plays while false. */
	enabled: z.boolean().default(true).volatile(),
	/** Play a sound when a session asks the user (question / plan review / approval). */
	question: z.boolean().default(true).volatile(),
	/** Play a sound when a running session goes idle (task finished or stopped). */
	complete: z.boolean().default(true).volatile(),
	/** Only play sounds while the page is hidden (e.g. user is on another tab). */
	onlyWhenHidden: z.boolean().default(false).volatile(),
	/** Master volume, 0..1. */
	volume: z.number().min(0).max(1).step(0.05).default(0.5).volatile(),
	/** Desktop notifications master. */
	notifications: z.boolean().default(true).volatile(),
	/** Popup on question / plan review / approval. */
	notifQuestion: z.boolean().default(true).volatile(),
	/** Popup on task complete. */
	notifComplete: z.boolean().default(true).volatile(),
	/** Popup when a todo (plan item) turns completed. */
	notifTodo: z.boolean().default(true).volatile(),
	/** Popup style preferred by the browser half ("native" | "system" | "both"). */
	notifStyle: z.union([
		z.const("native"),
		z.const("system"),
		z.const("both")
	]).default("native").volatile(),
	/** Browser progress-toast aggregation window, seconds (0 = every item). */
	notifTodoInterval: z.number().min(0).max(120).step(1).default(12).volatile(),
	/**
	 * Desktop popups switch. Deliberately NOT volatile: it is deployment policy
	 * edited in the composition row (`config: { popups: false }`), not a user
	 * preference, so it stays out of the settings form.
	 */
	popups: z.boolean().default(true)
});

/**
 * Read one resolved Config field.
 *
 * A field marked `volatile` resolves to a cosmokit Volatile BOX — an object
 * carrying `get()` and the write symbol — not to a plain value. The loader
 * mutates that box in place on a live update (`updateVolatile` writes through
 * the box), so unwrapping at every read is exactly what makes a settings-page
 * toggle take effect without a restart. Comparing the box itself against a
 * literal would silently disable every gate.
 * @param value - one resolved Config field.
 * @returns the plain value.
 */
export function readConfigValue(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.get === "function" ? value.get() : value;
}

/** Resolved settings with every volatile box unwrapped; recomputed per decision. */
function readSettings(config) {
	return Object.fromEntries(
		Object.entries({ ...DEFAULT_SETTINGS, ...config }).map(([key, value]) => [key, readConfigValue(value)])
	);
}

/**
 * Whether a session belongs to the top level of its delegation tree.
 *
 * Subagent sessions carry a positive `delegationDepth` in their header
 * (`0`/absent = top level). Their activity — todo writes, tool calls,
 * approvals, completion — is deliberately silent so a main conversation
 * running subagents only notifies about its own state.
 * @param session - a `Session` instance (or anything with `.header`).
 * @returns true for a top-level session.
 */
export function isRootSession(session) {
	return (session?.header?.delegationDepth ?? 0) === 0;
}

/**
 * Plugin body: wire the native-popup listeners. `session/event` and
 * `agent/status` are dispatched through scope carriers, so the listeners
 * register with `global: true` to bypass the scope filter; the hooks still land
 * in the shared root events pool, which is the pool the dispatchers read.
 * Listener lifecycles follow the plugin via the `ctx.on` effect; never dispose
 * them inside a `ctx.effect` body.
 * @param ctx - host plugin context.
 * @param config - loader row config; `{ popups: false }` disables popups.
 */
export function apply(ctx, config = {}) {
	if (readConfigValue(config.popups) === false) return;
	// The gate re-reads the live config on every decision (see readSettings):
	// the loader keeps the same config object across a volatile update, so a
	// captured snapshot would go stale.
	const notifier = createPopupNotifier({ settings: () => readSettings(config) });
	// `global: true` bypasses the scope-carrier filter: session/event and
	// agent/status are dispatched through scope carriers, and a plugin outside
	// the agent scope would otherwise never receive them. `ctx.on` registers
	// into the shared root events pool either way (mixin binds the events
	// service), and the returned disposers must NOT be invoked here — Cordis
	// `ctx.effect(cb)` runs `cb` immediately and collects its RETURN VALUE as
	// the teardown, so calling the disposers in an effect body unregisters the
	// listeners the moment they are wired (the bug that made popups never fire).
	ctx.on("session/event", (session, event) => {
		if (!isRootSession(session)) return; // subagent sessions are silent
		notifier.onSessionEvent(session?.id, event);
	}, { global: true });
	ctx.on("agent/status", ({ agent, status }) => {
		if (status !== "idle") return;
		if (!isRootSession(agent?.session)) return; // subagent idle is silent
		notifier.onAgentIdle(agent?.session?.id ?? agent?.id);
	}, { global: true });
}
