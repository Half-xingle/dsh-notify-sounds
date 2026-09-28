/**
 * dsh-notify-sounds — native popup decision engine.
 *
 * Pure event -> popup mapping, unit-testable with an injected `show`. The
 * plugin body feeds it the host session event stream; it owns no listeners.
 */
import { showPopup } from "./popup.js";

/**
 * Composition defaults, the fallback for a row that omits fields and the
 * settings source of last resort. The host Config schema is the single source
 * of truth; these mirror its defaults one-for-one.
 */
export const DEFAULT_SETTINGS = Object.freeze({
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
	notifTodoInterval: 12
});

/**
 * Pure event -> popup decision engine (unit-testable with an injected `show`).
 * @param deps - `show(payload)`, `settings()` getter.
 * @returns the notifier's event entry points and per-session baseline state.
 */
export function createPopupNotifier({ show = showPopup, settings = () => DEFAULT_SETTINGS } = {}) {
	/** Per-session last-seen todo list: sessionId -> Map(content -> status). */
	const todoPrev = new Map();
	const gate = (kind) => {
		const s = settings() ?? {};
		if (s.notifications === false) return false;
		if (kind === "question" && s.notifQuestion === false) return false;
		if (kind === "complete" && s.notifComplete === false) return false;
		if (kind === "todo" && s.notifTodo === false) return false;
		return true;
	};
	return {
		/** Feed one session event (from `session/event`, args (session, event)). */
		onSessionEvent(sessionId, event) {
			switch (event?.type) {
				case "turn/start":
					// todo projection resets at turn boundaries; drop the baseline
					todoPrev.delete(sessionId);
					return;
				case "todo/write":
					this.onTodos(sessionId, event.data?.todos);
					return;
				case "tool/call":
					if (event.data?.name === "ask_user_question" && gate("question")) {
						show({ title: "DSH · 需要你", body: "智能体正在等待你的选择" });
					}
					return;
				case "approval/asked":
					if (gate("question")) {
						const tool = event.data?.toolName ?? "工具调用";
						show({ title: "DSH · 等待审批", body: `「${tool}」需要你的审批` });
					}
					return;
				default:
					return;
			}
		},
		/** Agent went idle: task finished (or stopped). */
		onAgentIdle(sessionId) {
			if (gate("complete")) show({ title: "DSH", body: "任务完成" });
		},
		/** Diff one full todo list; toast items that just turned completed. */
		onTodos(sessionId, todos) {
			if (!Array.isArray(todos)) {
				todoPrev.delete(sessionId);
				return;
			}
			const prev = todoPrev.get(sessionId);
			const next = new Map(todos.map((item) => [item.content, item.status]));
			if (prev === void 0) {
				todoPrev.set(sessionId, next);
				return;
			}
			const done = todos.filter((item) => item.status === "completed").length;
			const total = todos.length;
			for (const item of todos) {
				if (item.status !== "completed") continue;
				if (prev.get(item.content) === "completed") continue;
				if (gate("todo")) {
					show({ title: "DSH · 任务进度", body: `「${item.content}」已完成（${done}/${total}）` });
				}
			}
			todoPrev.set(sessionId, next);
		},
		/** Forget all per-session baselines (reconnect/tests). */
		reset() {
			todoPrev.clear();
		}
	};
}
