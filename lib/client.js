window.__ModuleLoader__.load({
	id: "dsh-notify-sounds",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// ---- src/client/contract.js ----
		/** Fallback defaults, mirroring the host Config schema defaults one-for-one. */
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
			notifStyle: "native",
			notifTodoInterval: 12,
		});
		
		/** Locale namespace of the settings card copy. */
		const CARD_NS = "notify-sounds.card";
		
		/** Loader entry id owned by this plugin — the settings namespace the Host serves. */
		const SETTINGS_NAMESPACE = "notify-sounds";
		
		/** localStorage key of the fallback store (used when no Host form is served). */
		const FALLBACK_STORAGE_KEY = "dsh-notify-sounds.settings.v1";
		
		// ---- src/client/locale.js ----
		/** Settings card copy: Chinese. */
		const zh = {};
		
		/** Settings card copy: English. */
		const en = {};
		
		// ---- src/client/audio.js ----
		/** Shared AudioContext (created once per page). */
		let audioCtx = null;
		
		/** Note sequences: [start, duration] seconds relative to the sequence start. */
		const SEQUENCES = {};
		
		function audioContext() {
			return null;
		}
		
		function playSequence() {}
		
		// ---- src/client/settings.js ----
		function createLocalSettingsStore() {
			const listeners = new Set();
			let state = { ...DEFAULT_SETTINGS };
			return {
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set(field, value) {
					state = { ...state, [field]: value };
					for (const listener of [...listeners]) listener();
				},
				resetField() {},
				resetAll() {
					state = { ...DEFAULT_SETTINGS };
				},
				dispose() {},
			};
		}
		
		function createConfigFormStore() {
			return createLocalSettingsStore();
		}
		
		function createSettingsStore() {
			return createLocalSettingsStore();
		}
		
		// ---- src/client/runtime.js ----
		/** Watches the sessions source and the settings store for notification edges. */
		class NotifyRuntime {
			constructor(ctx, store) {
				this.ctx = ctx;
				this.store = store;
			}
		}
		
		function installAudioUnlock() {}
		
		// ---- src/client/card.js ----
		/** Inline styles keyed to the app's design tokens. */
		const cardStyle = {
			card: {
				boxSizing: "border-box",
				border: "0.5px solid var(--dsw-alias-settings-card-stroke)",
				background: "var(--dsw-alias-settings-card-fill)",
				borderRadius: "var(--dsw-radius-xl)",
				listStyle: "none",
				padding: "12px 16px 14px",
				display: "flex",
				flexDirection: "column",
				gap: "10px",
			},
		};
		
		/** Render the notify-sounds settings card. */
		function NotifyCard(props) {
			return react.createElement("li", { style: cardStyle.card }, props.t("title"));
		}
		
		// ---- src/client/index.js ----
		let react = require("react");
		
		const inject = [
			"slots",
			"locale",
			"sessions",
			"connection",
			"configForms",
		];
		
		function apply(ctx) {
			void ctx;
			void react;
			void NotifyCard;
		}
		
		exports.apply = apply;
		exports.inject = inject;
		
		return module.exports;
	}
});
