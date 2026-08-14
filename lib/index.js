/**
 * dsh-notify-sounds — host half.
 *
 * Registers the `notify-sounds` settings namespace so the browser half can
 * read/write toggles and volume through the settings scope (Settings →
 * 插件配置). The actual notification engine lives entirely in the browser
 * half (lib/client.js); this half only owns the durable user settings.
 */
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

/** Settings namespace owned by this plugin (lowercase kebab-case). */
export const SETTINGS_NAMESPACE = settingsNamespace("notify-sounds");

/** Schema of the notify-sounds settings section. */
export const SETTINGS_SCHEMA = z.object({
	/** Master switch: no sound plays while false. */
	enabled: z.boolean().default(true),
	/** Play a sound when a session asks the user (question / plan review / approval). */
	question: z.boolean().default(true),
	/** Play a sound when a running session goes idle (task finished or stopped). */
	complete: z.boolean().default(true),
	/** Only play sounds while the page is hidden (e.g. user is on another tab). */
	onlyWhenHidden: z.boolean().default(false),
	/** Master volume, 0..1. */
	volume: z.number().min(0).max(1).step(0.05).default(0.5)
});

/** Composition defaults, used as the settings `base` layer. */
const DEFAULTS = Object.freeze({
	enabled: true,
	question: true,
	complete: true,
	onlyWhenHidden: false,
	volume: 0.5
});

let current = DEFAULTS;

/**
 * Plugin body: register the settings section on the host settings provider.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
	installSettingsSection(ctx, SETTINGS_NAMESPACE, SETTINGS_SCHEMA, DEFAULTS, {
		setSource: (next) => {
			current = next;
		},
		onChange: () => {}
	});
}
