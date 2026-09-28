/**
 * dsh-notify-sounds — Windows native desktop popup.
 *
 * Renders a frameless, always-on-top WinForms toast in the bottom-right corner
 * of the screen. Popups bypass the Windows notification center entirely (no
 * system chime, no archiving, no Focus Assist suppression, and they work with
 * the browser tab closed).
 *
 * Display: one hidden PowerShell process per popup (one-shot ShowDialog, proven
 * to render reliably; a persistent helper was tried and abandoned — a
 * long-running node-spawned PowerShell cannot render WinForms forms in this
 * environment). Do NOT add an Add-Type -TypeDefinition DPI prelude: C#
 * compilation via csc silently kills the script before rendering. The
 * registry-based scale compensation handles scaled displays.
 */
import { spawn } from "node:child_process";

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
 * @param input - toast title, body, and lifetime in seconds.
 * @returns the argv for a hidden powershell.exe invocation.
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

/**
 * Spawn one hidden PowerShell toast. Never throws on display failure.
 * @param input - toast title, body, and lifetime in seconds.
 */
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
