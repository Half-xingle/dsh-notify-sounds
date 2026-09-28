/**
 * dsh-notify-sounds — host half.
 *
 * Owns the `notify-sounds` loader entry: the exported Config schema below IS
 * the settings page dsh serves for it. Since v1.1 it also drives NATIVE
 * desktop popups: a
 * frameless, always-on-top WinForms toast in the bottom-right corner of the
 * screen. Popups bypass the Windows notification center entirely (no system
 * chime, no archiving, no Focus Assist suppression, works with the browser
 * tab closed).
 *
 * Display: one hidden PowerShell process per popup (one-shot ShowDialog,
 * proven to render reliably; a persistent helper was tried and abandoned —
 * long-running node-spawned PowerShell cannot render WinForms forms in this
 * environment). Do NOT add an Add-Type -TypeDefinition DPI prelude: C#
 * compilation via csc silently kills the script before rendering. The
 * registry-based scale compensation handles scaled displays.
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
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";

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

/** Composition defaults, the fallback for a row that omits fields. */
const DEFAULTS = Object.freeze({
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

//#region native popup (embedded one-shot)
/**
 * Build a one-shot PowerShell popup command: renders one WinForms toast and
 * exits. Uses -EncodedCommand (UTF-16LE base64) with the payload EMBEDDED —
 * this is the ONLY configuration verified to render in every spawn context
 * (file/JSON-based variants never rendered in testing). The command line
 * varies per popup, so anti-virus may prompt per NEW signature until
 * whitelisted; that is preferable to an invisible popup.
 *
 * No Add-Type -TypeDefinition DPI prelude (C# compilation silently kills
 * hidden spawns); the registry-based scale compensation (pure cmdlets) keeps
 * the toast bottom-right on scaled displays. Position is derived from the
 * SCALED form size — mixing unscaled sizes into the offset placed the toast
 * off-screen on 125%+ displays (verified with an in-script diagnostic).
 */
export function buildPopupCommand({ title, body, seconds = 6 }) {
	const single = (value) => "'" + String(value).replace(/'/g, "''").replace(/\r?\n/g, " ") + "'";
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'
$title = ${single(title)}
$body = ${single(body)}
$seconds = ${Math.max(2, Math.min(30, Math.round(seconds)))}
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$scale = 1.0
$applied = Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue
if ($null -ne $applied -and $applied.AppliedDPI -gt 0) { $scale = $applied.AppliedDPI / 96.0 }
$w = 300
$h = 104
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Width = [int]($w * $scale)
$form.Height = [int]($h * $scale)
$form.Left = [int]($wa.Right - $form.Width - 18 * $scale)
$form.Top = [int]($wa.Bottom - $form.Height - 18 * $scale)
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 32, 38)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = [int](12 * $scale)
$path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
$path.AddArc($form.Width - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
$path.AddArc($form.Width - 2 * $r, $form.Height - 2 * $r, 2 * $r, 2 * $r, 0, 90)
$path.AddArc(0, $form.Height - 2 * $r, 2 * $r, 2 * $r, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $title
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(235, 235, 240)
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', (12 * $scale), [System.Drawing.FontStyle]::Bold)
$lblTitle.AutoSize = $true
$lblTitle.Location = New-Object System.Drawing.Point([int](16 * $scale), [int](12 * $scale))
$lblTitle.MaximumSize = New-Object System.Drawing.Size([int](($w - 32) * $scale), [int](32 * $scale))
$lblTitle.BackColor = [System.Drawing.Color]::Transparent
$lblBody = New-Object System.Windows.Forms.Label
$lblBody.Text = $body
$lblBody.ForeColor = [System.Drawing.Color]::FromArgb(185, 188, 195)
$lblBody.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', (10 * $scale))
$lblBody.AutoSize = $true
$lblBody.Location = New-Object System.Drawing.Point([int](16 * $scale), [int](46 * $scale))
$lblBody.MaximumSize = New-Object System.Drawing.Size([int](($w - 32) * $scale), [int](50 * $scale))
$lblBody.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($lblTitle)
$form.Controls.Add($lblBody)
$close = { $form.Close() }
$form.Add_Click($close)
$lblTitle.Add_Click($close)
$lblBody.Add_Click($close)
$form.KeyPreview = $true
$form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Close() } })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $seconds * 1000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()
$form.ShowDialog() | Out-Null
`;
	return [
		"-NoProfile",
		"-WindowStyle",
		"Hidden",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64")
	];
}

/** Spawn one hidden PowerShell toast. Never throws on display failure. */
export function showPopup({ title, body, seconds = 6 }) {
	try {
		const child = spawn("powershell.exe", buildPopupCommand({ title, body, seconds }), {
			windowsHide: true,
			stdio: "ignore"
		});
		child.on("error", (error) => {
			console.error(`[notify-sounds] popup spawn failed: ${error.message}`);
		});
		child.unref();
	} catch (error) {
		console.error(`[notify-sounds] showPopup threw: ${error.message}`);
	}
}
//#endregion

/**
 * Pure event -> popup decision engine (unit-testable with an injected `show`).
 * @param deps - `show(payload)`, `settings()` getter.
 */
export function createPopupNotifier({ show = showPopup, settings = () => DEFAULTS } = {}) {
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

/**
 * Whether a session belongs to the top level of its delegation tree.
 *
 * Subagent sessions carry a positive `delegationDepth` in their header
 * (`0`/absent = top level). Their activity — todo writes, tool calls,
 * approvals, completion — is deliberately silent so a main conversation
 * running subagents only notifies about its own state.
 * @param session - a `Session` instance (or anything with `.header`).
 */
export function isRootSession(session) {
	return (session?.header?.delegationDepth ?? 0) === 0;
}

/**
 * Plugin body: register the settings section and wire the native-popup
 * listeners. `session/event` and `agent/status` are dispatched through scope
 * carriers, so the listeners register with `global: true` to bypass the
 * scope filter; the hooks still land in the shared root events pool, which is
 * the pool the dispatchers read. Listener lifecycles follow the plugin via
 * the `ctx.on` effect; never dispose them inside a `ctx.effect` body.
 * @param ctx - host plugin context.
 * @param config - loader row config; `{ popups: false }` disables popups.
 */
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
		Object.entries({ ...DEFAULTS, ...config }).map(([key, value]) => [key, readConfigValue(value)])
	);
}

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
