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
