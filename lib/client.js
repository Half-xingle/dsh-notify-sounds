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
			volume: 0.5
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
				});
				installAudioUnlock();
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
						this.play(now.pending === "approval" ? "approval" : "question", this.settings.question);
					}
					if (prev.running && !now.running) {
						this.play("complete", this.settings.complete);
					}
					this.prev.set(id, now);
				}
				for (const id of this.prev.keys()) if (!seen.has(id)) this.prev.delete(id);
				this.initialized = true;
			}
			/** Slot inject: hooks + actions for the settings card. */
			inject() {
				return {
					hooks: { notify: this.store },
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
					}
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
			}
		};
		/**
		 * Render the notify-sounds settings card.
		 * @param props - `t`, `useNotify`, `setField`, `resetField`, `resetAll`, `preview`.
		 * @returns the card.
		 */
		function NotifyCard(props) {
			const { t } = props;
			const value = props.useNotify((s) => s);
			const toggle = (key, checked) => props.setField(key, checked === true);
			const percent = Math.round((value.volume ?? DEFAULT_SETTINGS.volume) * 100);
			const row = (key, label) => react.createElement("div", { style: cardStyle.row, key }, [
				react.createElement("span", { style: cardStyle.label, key: "label" }, label),
				react.createElement("input", {
					key: "check",
					type: "checkbox",
					style: cardStyle.check,
					checked: value[key] === true,
					onChange: (event) => toggle(key, event.target.checked)
				})
			]);
			return react.createElement("li", { style: cardStyle.card }, [
				react.createElement("div", { style: cardStyle.head, key: "head" }, [
					react.createElement("span", { style: cardStyle.title, key: "title" }, t("title")),
					react.createElement("span", { style: cardStyle.desc, key: "desc" }, t("description"))
				]),
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
				]),
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
			description: "智能体需要选择或任务完成时播放短提示音。",
			enabled: "启用提示音",
			question: "提问 / 审批提示",
			complete: "任务完成提示",
			onlyHidden: "仅页面隐藏时播放",
			volume: "音量",
			preview: "试听",
			resetAll: "恢复默认"
		};
		const en = {
			title: "Sound notifications",
			description: "Play a short sound when your input is needed or a task finishes.",
			enabled: "Enable sounds",
			question: "Question & approval",
			complete: "Task complete",
			onlyHidden: "Only while the page is hidden",
			volume: "Volume",
			preview: "Preview",
			resetAll: "Reset all"
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
