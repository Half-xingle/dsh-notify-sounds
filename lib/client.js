/**
 * dsh-notify-sounds — browser half.
 *
 * Plays short Web Audio tones when the agent needs the user (question,
 * plan review, approval) or when a session goes idle (task finished/stopped).
 *
 * Settings: stored in browser localStorage (self-contained). The host half
 * (lib/index.js) also registers a `notify-sounds` settings namespace, but the
 * web API gateway only exposes a hardcoded allowlist of namespaces to browser
 * clients (dsh-host-apiproxy's WEB_SETTINGS_NAMESPACES; pluggable exposure is
 * deferred upstream), so third-party namespaces are not readable/writable from
 * the browser yet. localStorage works today and syncs across tabs via the
 * `storage` event; if upstream opens the allowlist, the host half is already
 * in place.
 *
 * Bundle contract: `window.__ModuleLoader__.load({ id, factory })`; the id MUST
 * equal the package name. Exports `apply` (plugin entry) and `inject` (service
 * keys). The factory's `require` only resolves platform seed words, so this
 * bundle imports nothing beyond react and platform services passed through the
 * context.
 */
window.__ModuleLoader__.load({
	id: "dsh-notify-sounds",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region settings contract
		/** Defaults for every setting; the single source of truth for fallback. */
		const DEFAULT_SETTINGS = Object.freeze({
			enabled: true,
			question: true,
			complete: true,
			onlyWhenHidden: false,
			volume: 0.5,
			notifications: true,
			notifQuestion: true,
			notifComplete: true,
			notifTodo: true,
			notifTodoInterval: 12,
			/** "native" (host popup, default) | "system" (Windows notification center) | "both" */
			notifStyle: "native"
		});
		/** localStorage key holding the settings JSON. */
		const STORAGE_KEY = "dsh-notify-sounds.settings.v1";
		/** Locale namespace of the settings card copy. */
		const CARD_NS = "notify-sounds.card";
		/**
		 * Read settings from localStorage with defaults for missing/invalid values.
		 * Never throws: a blocked or corrupt storage falls back to defaults.
		 */
		function loadSettings() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (raw !== null) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
			} catch {}
			return { ...DEFAULT_SETTINGS };
		}
		/**
		 * Minimal observable settings store (uSES-compatible: getSnapshot +
		 * subscribe) backed by localStorage.
		 */
		function createLocalSettingsStore() {
			const listeners = new Set();
			let state = loadSettings();
			const notify = () => {
				for (const listener of [...listeners]) listener();
			};
			const persist = () => {
				try {
					localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
				} catch {}
			};
			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(field, value) {
					state = { ...state, [field]: value };
					persist();
					notify();
				},
				resetField(field) {
					state = { ...state, [field]: DEFAULT_SETTINGS[field] };
					persist();
					notify();
				},
				resetAll() {
					state = { ...DEFAULT_SETTINGS };
					persist();
					notify();
				},
				/** Replace the snapshot without writing back (cross-tab adoption). */
				adopt(value) {
					state = { ...DEFAULT_SETTINGS, ...value };
					notify();
				}
			};
		}
		/** Cross-tab sync: re-read when another tab writes the settings key. */
		function installStorageSync(store) {
			if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
			const onStorage = (event) => {
				if (event.key !== STORAGE_KEY) return;
				store.adopt(loadSettings());
			};
			window.addEventListener("storage", onStorage);
			return () => {
				window.removeEventListener("storage", onStorage);
			};
		}
		//#endregion

		//#region audio engine
		let audioCtx = null;
		/** Lazily create the shared AudioContext (created once per page). */
		function audioContext() {
			if (audioCtx !== null) return audioCtx;
			const Ctor = typeof window !== "undefined" ? (window.AudioContext ?? window.webkitAudioContext) : void 0;
			if (Ctor === void 0) return null;
			try {
				audioCtx = new Ctor();
			} catch {
				return null;
			}
			return audioCtx;
		}
		/** Resume a suspended context (autoplay policy: only a user gesture unlocks it). */
		function unlockAudio() {
			const ctx = audioContext();
			if (ctx !== null && ctx.state === "suspended") ctx.resume().catch(() => {});
		}
		/** Unlock audio on the first user gesture; before that, beeps are silently skipped. */
		function installAudioUnlock() {
			if (typeof window === "undefined") return;
			for (const type of ["pointerdown", "keydown", "touchstart"]) {
				window.addEventListener(type, unlockAudio, { once: true, passive: true });
			}
		}
		//#endregion

		//#region desktop notifications (Web Notification API)
		/** Whether the browser supports the Notification API at all. */
		function notificationsSupported() {
			return typeof Notification !== "undefined";
		}
		/** Current permission: "granted" | "denied" | "default" | "unsupported". */
		function notificationPermission() {
			if (!notificationsSupported()) return "unsupported";
			return Notification.permission;
		}
		/**
		 * Ask for notification permission. Best called inside a user gesture
		 * (e.g. the settings card button). Returns the resulting permission.
		 */
		async function requestNotificationPermission() {
			if (!notificationsSupported()) return "unsupported";
			try {
				return await Notification.requestPermission();
			} catch {
				return Notification.permission;
			}
		}
		/**
		 * Show one desktop notification. Same-tag notifications replace each
		 * other, so step-progress toasts never stack on screen.
		 * @param input - title/body/tag; clicking the toast focuses the window.
		 */
		function showNotification({ title, body, tag }) {
			if (!notificationsSupported() || Notification.permission !== "granted") return;
			try {
				const notification = new Notification(title, { body, tag });
				notification.onclick = () => {
					try {
						window.focus();
					} catch {}
					notification.close();
				};
			} catch {}
		}
		//#endregion
		/** Note sequences: [start, duration] seconds relative to the sequence start. */
		const SEQUENCES = {
			/** 叮咚 — a question, plan review, or other ask. */
			question: [
				{ freq: 880.0, start: 0.0, duration: 0.16 },
				{ freq: 1174.66, start: 0.22, duration: 0.24 }
			],
			/** 咚咚 — a permission approval request. */
			approval: [
				{ freq: 659.25, start: 0.0, duration: 0.15 },
				{ freq: 880.0, start: 0.2, duration: 0.3 }
			],
			/** 上行三连音 — a task finished. */
			complete: [
				{ freq: 523.25, start: 0.0, duration: 0.14 },
				{ freq: 659.25, start: 0.17, duration: 0.14 },
				{ freq: 783.99, start: 0.34, duration: 0.32 }
			]
		};
		/**
		 * Play one sequence through the shared context.
		 * @param kind - sequence key.
		 * @param volume - master volume 0..1 (per-note gain stays gentle).
		 */
		function playSequence(kind, volume) {
			const ctx = audioContext();
			if (ctx === null) return;
			unlockAudio();
			if (ctx.state !== "running") return;
			const notes = SEQUENCES[kind];
			if (notes === void 0) return;
			const gain = Math.max(0, Math.min(1, Number(volume) || 0)) * 0.3;
			if (gain <= 0) return;
			for (const note of notes) {
				const t0 = ctx.currentTime + note.start;
				const osc = ctx.createOscillator();
				const g = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = note.freq;
				g.gain.setValueAtTime(0.0001, t0);
				g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
				g.gain.setValueAtTime(gain, t0 + Math.max(0.03, note.duration - 0.06));
				g.gain.exponentialRampToValueAtTime(0.0001, t0 + note.duration);
				osc.connect(g);
				g.connect(ctx.destination);
				osc.start(t0);
				osc.stop(t0 + note.duration + 0.03);
			}
		}
		//#endregion

		//#region notify runtime
		/**
		 * Watches the sessions list observable and the settings store.
		 *
		 * Session list entries carry `running` and `pendingInteraction`
		 * (`approval` | `plan-review` | `question`). Edges, not levels: only a
		 * transition INTO a pending interaction or a running→idle transition
		 * beeps, and the first observation after load/reconnect only records
		 * state (no beep for pre-existing conditions).
		 */
		var NotifyRuntime = class {
			/**
			 * @param ctx - client plugin context (sessions injected).
			 * @param store - settings store (localStorage-backed).
			 */
			constructor(ctx, store) {
				this.ctx = ctx;
				this.store = store;
				this.settings = { ...DEFAULT_SETTINGS };
				this.prev = new Map();
				this.initialized = false;
				// todo-progress tracking: per-session last-seen todo list
				// (sessionId -> Map(content -> status)); null/absent = no baseline.
				this.todoPrev = new Map();
				// per-session progress-toast throttle: sessionId -> { lastToastAt, pending, timer }
				this.todoThrottle = new Map();
				// diagnostics (rendered in the settings card's debug section)
				this.diag = {
					attached: null,
					subscribed: false,
					lastSnapshot: null,
					lastGate: null,
					attempts: []
				};
				this.diagListeners = new Set();
				ctx.effect(() => store.subscribe(() => this.adoptSettings()), "notify-sounds: settings adoption");
				this.adoptSettings();
				const sessions = ctx.get("sessions");
				if (sessions !== void 0) {
					ctx.effect(() => sessions.list.subscribe(() => this.onList()), "notify-sounds: session list subscription");
					this.onList();
				}
				ctx.on("connection/reset", () => {
					this.prev.clear();
					this.initialized = false;
					this.todoPrev.clear();
					for (const record of this.todoThrottle.values()) {
						if (record.timer !== null) clearTimeout(record.timer);
					}
					this.todoThrottle.clear();
				});
				installAudioUnlock();
			}
			/** Diagnostics bookkeeping: push one attempt line (newest last, capped). */
			diagAttempt(line) {
				this.diag.attempts.push(`${new Date().toLocaleTimeString()} ${line}`);
				if (this.diag.attempts.length > 8) this.diag.attempts.splice(0, this.diag.attempts.length - 8);
				for (const listener of [...this.diagListeners]) listener();
			}
			/** Diagnostics observable face for the settings card. */
			diagSubscribe(listener) {
				this.diagListeners.add(listener);
				return () => {
					this.diagListeners.delete(listener);
				};
			}
			/** Adopt the store's current values. */
			adoptSettings() {
				this.settings = { ...DEFAULT_SETTINGS, ...this.store.getSnapshot() };
			}
			/** Whether the master switch allows sounds right now. */
			shouldPlay() {
				return this.settings.enabled === true;
			}
			/** Play one sequence honoring master switch, per-kind toggle, and hidden-only. */
			play(kind, toggle) {
				if (!this.shouldPlay()) return;
				if (toggle !== true) return;
				if (this.settings.onlyWhenHidden === true && typeof document !== "undefined" && document.visibilityState !== "hidden") return;
				playSequence(kind, this.settings.volume);
			}
			/** Session display title for notification copy (falls back to the id). */
			titleOf(id, entry) {
				return entry?.displayTitle ?? id;
			}
			/**
			 * Desktop notification honoring master + per-kind toggles. Falls back
			 * to asking for permission when it was never decided (Chrome shows the
			 * prompt; some browsers require a gesture, hence the card button).
			 */
			notify(toggle, { title, body, tag }) {
				if (this.settings.notifications !== true || toggle !== true) {
					this.diagAttempt(`notify skipped: master=${this.settings.notifications} toggle=${toggle}`);
					return;
				}
				// "native" mode: the HOST renders a custom desktop popup; the
				// browser must not touch the Windows notification center (no
				// system chime, no archiving).
				if (this.settings.notifStyle === "native") {
					this.diagAttempt(`notify skipped: native popup mode (${tag})`);
					return;
				}
				const permission = notificationPermission();
				if (permission === "denied" || permission === "unsupported") {
					this.diagAttempt(`notify skipped: permission=${permission}`);
					return;
				}
				if (permission === "default") {
					this.diagAttempt(`notify: requesting permission (${tag})`);
					requestNotificationPermission().then((next) => {
						if (next === "granted") showNotification({ title, body, tag });
					});
					return;
				}
				this.diagAttempt(`notify sent: ${tag} "${body}"`);
				showNotification({ title, body, tag });
			}
			/**
			 * Diff one session's todo projection and toast items that just turned
			 * completed. The host `todos` projection resets to null at turn/start
			 * and is re-written whole by each `todo_write`, so:
			 *  - null  -> drop the per-session baseline (turn boundary; the next
			 *            written list becomes a fresh baseline and re-completed
			 *            items from earlier turns never re-toast);
			 *  - first list after a boundary -> record as baseline, no toast;
			 *  - later lists -> items whose status moved to "completed" toast.
			 *
			 * Windows archives consecutive notifications from one app, so rapid
			 * completions are aggregated: at most one progress toast per session
			 * per `notifTodoInterval` seconds; completions inside the window are
			 * folded into one toast (latest item + count) fired at the window
			 * end — but only while the session is still running (otherwise the
			 * task-complete toast already covers it).
			 */
			diffTodos(id, entry) {
				const todos = entry.projectionValues?.todos;
				if (!Array.isArray(todos)) {
					this.todoPrev.delete(id);
					return;
				}
				const prev = this.todoPrev.get(id);
				const next = new Map(todos.map((item) => [item.content, item.status]));
				if (prev === void 0) {
					this.todoPrev.set(id, next);
					this.diagAttempt(`todo: baseline "${id}" (${todos.length} items)`);
					return;
				}
				const done = todos.filter((item) => item.status === "completed").length;
				const total = todos.length;
				const newlyCompleted = todos.filter((item) => item.status === "completed" && prev.get(item.content) !== "completed");
				if (newlyCompleted.length > 0) {
					const last = newlyCompleted[newlyCompleted.length - 1];
					this.scheduleTodoToast(id, entry, last.content, done, total, newlyCompleted.length);
				}
				this.todoPrev.set(id, next);
			}
			/** Fire one aggregated progress toast, or fold the completion into a pending one. */
			scheduleTodoToast(id, entry, content, done, total, batch) {
				const raw = Number(this.settings.notifTodoInterval);
				const intervalMs = raw > 0 ? Math.max(1, raw) * 1000 : 0;
				const title = this.titleOf(id, entry);
				const payload = {
					title: `DSH · ${title}`,
					body: `「${content}」已完成（${done}/${total}）`,
					tag: `dsh-notify-todo-${id}`
				};
				// aggregation disabled: toast every completion immediately
				if (intervalMs <= 0) {
					this.notify(this.settings.notifTodo, payload);
					return;
				}
				const now = Date.now();
				const record = this.todoThrottle.get(id) ?? { lastToastAt: 0, pending: null, timer: null };
				const fire = () => {
					if (record.pending === null) return;
					const pending = record.pending;
					record.pending = null;
					record.lastToastAt = Date.now();
					this.notify(this.settings.notifTodo, {
						title: pending.title,
						body: pending.body,
						tag: pending.tag
					});
				};
				// burst inside the window: fold into the pending toast
				if (now - record.lastToastAt < intervalMs && record.timer !== null) {
					record.pending = payload;
					if (record.timer !== null) clearTimeout(record.timer);
					record.timer = setTimeout(() => {
						record.timer = null;
						const list = this.ctx.get("sessions")?.list.getSnapshot();
						const live = list?.byId?.[id]?.running === true;
						if (live) fire();
						else this.diagAttempt(`todo: burst toast skipped (session idle), ${batch} item(s) completed`);
					}, intervalMs - (now - record.lastToastAt));
					this.diagAttempt(`todo: burst folded (${batch} item(s), ${done}/${total})`);
					this.todoThrottle.set(id, record);
					return;
				}
				// outside the window: toast now, keep the window armed
				record.pending = payload;
				record.lastToastAt = now;
				if (record.timer !== null) {
					clearTimeout(record.timer);
					record.timer = null;
				}
				fire();
				record.timer = setTimeout(() => {
					record.timer = null;
					const list = this.ctx.get("sessions")?.list.getSnapshot();
					const live = list?.byId?.[id]?.running === true;
					if (live) fire();
				}, intervalMs);
				this.todoThrottle.set(id, record);
			}
			/** Diff the latest sessions snapshot against the previous one. */
			onList() {
				const sessions = this.ctx.get("sessions");
				if (sessions === void 0) return;
				const snap = sessions.list.getSnapshot();
				const byId = snap.byId ?? {};
				const seen = new Set();
				for (const id of snap.ids ?? []) {
					const entry = byId[id];
					if (entry === void 0) continue;
					seen.add(id);
					// Subagent sessions (children of a main conversation) are
					// deliberately silent: only top-level sessions notify.
					if (entry.parentSessionId !== void 0) continue;
					const now = {
						running: entry.running === true,
						pending: entry.pendingInteraction
					};
					const prev = this.prev.get(id);
					if (!this.initialized || prev === void 0) {
						this.prev.set(id, now);
						continue;
					}
					if (prev.pending === void 0 && now.pending !== void 0) {
						const title = this.titleOf(id, entry);
						this.play(now.pending === "approval" ? "approval" : "question", this.settings.question);
						this.notify(this.settings.notifQuestion, {
							title: `DSH · ${title}`,
							body: now.pending === "approval" ? "等待你的审批" : "智能体正在等待你的选择",
							tag: `dsh-notify-question-${id}`
						});
					}
					if (prev.running && !now.running) {
						const title = this.titleOf(id, entry);
						this.play("complete", this.settings.complete);
						this.notify(this.settings.notifComplete, {
							title: `DSH · ${title}`,
							body: "任务完成",
							tag: `dsh-notify-complete-${id}`
						});
					}
					this.prev.set(id, now);
				}
				for (const id of this.prev.keys()) if (!seen.has(id)) this.prev.delete(id);
				this.initialized = true;
				// todo progress: diff every TOP-LEVEL session's todo projection
				for (const id of snap.ids ?? []) {
					const entry = byId[id];
					if (entry === void 0) continue;
					if (entry.parentSessionId !== void 0) continue;
					this.diffTodos(id, entry);
				}
				for (const id of this.todoPrev.keys()) if (!seen.has(id)) this.todoPrev.delete(id);
			}
			/** Slot inject: hooks + actions for the settings card. */
			inject() {
				return {
					hooks: {
						notify: this.store,
						diag: {
							getSnapshot: () => this.diag,
							subscribe: (listener) => this.diagSubscribe(listener)
						}
					},
					setField: (field, value) => {
						this.store.set(field, value);
					},
					resetField: (field) => {
						this.store.resetField(field);
					},
					resetAll: () => {
						this.store.resetAll();
					},
					preview: () => {
						playSequence("complete", this.settings.volume);
					},
					requestPermission: async () => requestNotificationPermission(),
					permission: () => notificationPermission()
				};
			}
		};
		//#endregion

		//#region settings card
		/** Inline styles keyed to the app's design tokens. */
		const cardStyle = {
			card: {
				boxSizing: "border-box",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3)",
				borderRadius: "12px",
				listStyle: "none",
				padding: "12px 16px 14px",
				display: "flex",
				flexDirection: "column",
				gap: "10px"
			},
			head: { display: "flex", flexDirection: "column", gap: "2px" },
			title: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5 },
			row: { display: "flex", alignItems: "center", gap: "8px", minHeight: "30px" },
			label: { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: 1.5 },
			check: { accentColor: "var(--dsw-alias-brand-primary)", flex: "none", width: "16px", height: "16px", cursor: "pointer" },
			range: { flex: 1, accentColor: "var(--dsw-alias-brand-primary)", cursor: "pointer" },
			value: { flex: "none", minWidth: "44px", textAlign: "right", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", fontVariantNumeric: "tabular-nums" },
			footer: { display: "flex", justifyContent: "flex-end", gap: "8px", paddingTop: "2px" },
			button: {
				font: "inherit",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: "8px",
				padding: "4px 12px",
				fontSize: "13px",
				lineHeight: 1.5,
				cursor: "pointer"
			},
			group: {
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				paddingTop: "10px",
				display: "flex",
				flexDirection: "column",
				gap: "8px"
			},
			groupTitle: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: 600, lineHeight: 1.5 },
			status: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: 1.5 },
			number: {
				flex: "none",
				width: "56px",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-3)",
				borderRadius: "8px",
				padding: "2px 8px",
				font: "inherit",
				fontSize: "13px",
				color: "var(--dsw-alias-label-primary)",
				textAlign: "right"
			}
		};
		/**
		 * Render the notify-sounds settings card.
		 * @param props - `t`, `useNotify`, `setField`, `resetField`, `resetAll`, `preview`, `requestPermission`, `permission`.
		 * @returns the card.
		 */
		function NotifyCard(props) {
			const { t } = props;
			const value = props.useNotify((s) => s);
			const toggle = (key, checked) => props.setField(key, checked === true);
			const percent = Math.round((value.volume ?? DEFAULT_SETTINGS.volume) * 100);
			const row = (key, label, extra) => react.createElement("div", { style: cardStyle.row, key }, [
				react.createElement("span", { style: cardStyle.label, key: "label" }, label),
				...extra !== void 0 ? [extra] : [],
				react.createElement("input", {
					key: "check",
					type: "checkbox",
					style: cardStyle.check,
					checked: value[key] === true,
					onChange: (event) => toggle(key, event.target.checked)
				})
			]);
			// notification permission state (live; re-read on every render)
			const permission = props.permission();
			const permissionLabel = permission === "granted" ? t("notifGranted") : permission === "denied" ? t("notifDenied") : permission === "unsupported" ? t("notifUnsupported") : t("notifDefault");
			const diag = props.useDiag((s) => s);
			const debugLines = [
				`sessions: ${diag.attached ?? "—"} subscribed=${diag.subscribed ? "yes" : "no"}`,
				`snapshot: running=${diag.lastSnapshot?.running ?? "—"} nodes=${diag.lastSnapshot?.nodes ?? "—"} partialStep=${diag.lastSnapshot?.partialStep ?? "—"} gate=${diag.lastGate ?? "—"}`,
				...(diag.attempts.length > 0 ? [`last: ${diag.attempts[diag.attempts.length - 1]}`, ...diag.attempts.slice(0, -1).reverse()] : ["last: (none)"])
			];
			const group = (key, titleKey, children) => react.createElement("div", { style: cardStyle.group, key }, [
				react.createElement("span", { style: cardStyle.groupTitle, key: "title" }, t(titleKey)),
				...children
			]);
			return react.createElement("li", { style: cardStyle.card }, [
				react.createElement("div", { style: cardStyle.head, key: "head" }, [
					react.createElement("span", { style: cardStyle.title, key: "title" }, t("title")),
					react.createElement("span", { style: cardStyle.desc, key: "desc" }, t("description"))
				]),
				group("sounds", "soundsGroup", [
					row("enabled", t("enabled")),
					row("question", t("question")),
					row("complete", t("complete")),
					row("onlyWhenHidden", t("onlyHidden")),
					react.createElement("div", { style: cardStyle.row, key: "volume" }, [
						react.createElement("span", { style: cardStyle.label, key: "label" }, t("volume")),
						react.createElement("input", {
							key: "range",
							type: "range",
							min: 0,
							max: 1,
							step: 0.05,
							style: cardStyle.range,
							value: value.volume ?? DEFAULT_SETTINGS.volume,
							onChange: (event) => props.setField("volume", Number(event.target.value))
						}),
						react.createElement("span", { style: cardStyle.value, key: "value" }, `${percent}%`)
					])
				]),
				group("notifications", "notifGroup", [
					row("notifications", t("notifEnabled")),
					react.createElement("div", { style: cardStyle.row, key: "style" }, [
						react.createElement("span", { style: cardStyle.label, key: "label" }, t("notifStyle")),
						react.createElement("select", {
							key: "select",
							style: { ...cardStyle.number, width: "110px", textAlign: "left", cursor: "pointer" },
							value: value.notifStyle ?? DEFAULT_SETTINGS.notifStyle,
							onChange: (event) => props.setField("notifStyle", event.target.value)
						}, [
							react.createElement("option", { key: "native", value: "native" }, t("notifStyleNative")),
							react.createElement("option", { key: "system", value: "system" }, t("notifStyleSystem")),
							react.createElement("option", { key: "both", value: "both" }, t("notifStyleBoth"))
						])
					]),
					row("notifQuestion", t("notifQuestion")),
					row("notifComplete", t("notifComplete")),
					row("notifTodo", t("notifTodo")),
					react.createElement("div", { style: cardStyle.row, key: "interval" }, [
						react.createElement("span", { style: cardStyle.label, key: "label" }, t("notifTodoInterval")),
						react.createElement("input", {
							key: "number",
							type: "number",
							min: 0,
							max: 120,
							step: 1,
							style: cardStyle.number,
							value: value.notifTodoInterval ?? DEFAULT_SETTINGS.notifTodoInterval,
							onChange: (event) => props.setField("notifTodoInterval", Math.max(0, Math.min(120, Math.round(Number(event.target.value) || 0))))
						})
					]),
					react.createElement("div", { style: cardStyle.row, key: "permission" }, [
						react.createElement("span", { style: { ...cardStyle.label, fontSize: "12px" }, key: "label" }, `${t("notifPermission")}：${permissionLabel}`),
						react.createElement("button", {
							key: "ask",
							type: "button",
							style: cardStyle.button,
							disabled: permission === "granted" || permission === "unsupported",
							onClick: () => {
								props.requestPermission();
							}
						}, permission === "granted" ? t("notifOn") : t("notifEnable"))
					])
				]),
				group("debug", "debugGroup", debugLines.map((line, index) => react.createElement("div", {
					key: `line${index}`,
					style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: 1.6, fontFamily: "ui-monospace, Consolas, monospace", wordBreak: "break-all" }
				}, line))),
				react.createElement("div", { style: cardStyle.footer, key: "footer" }, [
					react.createElement("button", {
						key: "preview",
						type: "button",
						style: cardStyle.button,
						onClick: props.preview
					}, t("preview")),
					react.createElement("button", {
						key: "resetAll",
						type: "button",
						style: cardStyle.button,
						onClick: props.resetAll
					}, t("resetAll"))
				])
			]);
		}
		//#endregion

		//#region locale
		const zh = {
			title: "提示音通知",
			description: "智能体需要选择或任务完成时播放短提示音，并可在桌面右下角弹出系统通知。",
			enabled: "启用提示音",
			question: "提问 / 审批提示",
			complete: "任务完成提示",
			onlyHidden: "仅页面隐藏时播放",
			volume: "音量",
			preview: "试听",
			resetAll: "恢复默认",
			soundsGroup: "提示音",
			notifGroup: "桌面通知",
			notifEnabled: "启用桌面通知",
			notifStyle: "通知样式",
			notifStyleNative: "原生弹窗（推荐）",
			notifStyleSystem: "系统通知",
			notifStyleBoth: "两者都要",
			notifQuestion: "提问 / 审批通知",
			notifComplete: "任务完成通知",
			notifTodo: "任务进度通知（计划项完成时）",
			notifTodoInterval: "进度通知最小间隔（秒，0=逐条）",
			notifPermission: "通知权限",
			notifGranted: "已允许",
			notifDenied: "已拒绝（请在浏览器站点设置中重新允许）",
			notifUnsupported: "当前浏览器不支持",
			notifDefault: "未授权",
			notifOn: "已开启",
			notifEnable: "开启桌面通知",
			debugGroup: "调试信息"
		};
		const en = {
			title: "Sound notifications",
			description: "Play a short sound when your input is needed or a task finishes, with optional desktop notifications.",
			enabled: "Enable sounds",
			question: "Question & approval",
			complete: "Task complete",
			onlyHidden: "Only while the page is hidden",
			volume: "Volume",
			preview: "Preview",
			resetAll: "Reset all",
			soundsGroup: "Sounds",
			notifGroup: "Desktop notifications",
			notifEnabled: "Enable notifications",
			notifStyle: "Style",
			notifStyleNative: "Native popup (recommended)",
			notifStyleSystem: "System notification",
			notifStyleBoth: "Both",
			notifQuestion: "Question & approval",
			notifComplete: "Task complete",
			notifTodo: "Task progress (plan items)",
			notifTodoInterval: "Progress toast min interval (s, 0 = every item)",
			notifPermission: "Permission",
			notifGranted: "granted",
			notifDenied: "denied — re-enable in browser site settings",
			notifUnsupported: "not supported by this browser",
			notifDefault: "not requested yet",
			notifOn: "On",
			notifEnable: "Enable notifications",
			debugGroup: "Diagnostics"
		};
		//#endregion

		//#region plugin entry
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"sessions",
			"connection"
		];
		/**
		 * Plugin body: watch sessions for notification edges and mount the
		 * settings card into Settings → 插件配置.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(CARD_NS, {
				zh,
				en
			}), "notify-sounds: card dictionaries");
			const store = createLocalSettingsStore();
			ctx.effect(() => installStorageSync(store), "notify-sounds: cross-tab settings sync");
			const runtime = new NotifyRuntime(ctx, store);
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					id: "notify-sounds",
					order: 30,
					locale: CARD_NS,
					inject: () => runtime.inject()
				}, NotifyCard);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.NotifyRuntime = NotifyRuntime;
		exports.createLocalSettingsStore = createLocalSettingsStore;
		exports.loadSettings = loadSettings;
		exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
		exports.STORAGE_KEY = STORAGE_KEY;
		return module.exports;
	}
});
