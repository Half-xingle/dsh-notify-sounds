// 临时诊断：弹窗脚本内部自检（几何/可见性/计时）写入 %TEMP%\dsh-popup-diag.txt
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DIAG = join(process.env.TEMP ?? "C:\\Users\\86156\\AppData\\Local\\Temp", "dsh-popup-diag.txt");
writeFileSync(DIAG, ""); // clear

const single = (value) => "'" + String(value).replace(/'/g, "''").replace(/\r?\n/g, " ") + "'";
const diagPath = DIAG.replace(/'/g, "''");

const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'
$diag = ${single(diagPath)}
function Write-Diag($line) { try { Add-Content -Path $diag -Value $line } catch {} }
try {
  Write-Diag ("start " + (Get-Date -Format HH:mm:ss.fff))
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  Write-Diag ("wa=" + $wa.Right + "x" + $wa.Bottom)
  $applied = Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop\\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue
  $scale = 1.0
  if ($null -ne $applied -and $applied.AppliedDPI -gt 0) { $scale = $applied.AppliedDPI / 96.0 }
  Write-Diag ("scale=" + $scale)
  $w = 380
  $h = 96
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
  Write-Diag ("created left=" + $form.Left + " top=" + $form.Top + " w=" + $form.Width + " h=" + $form.Height + " visible=" + $form.Visible)
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 4000
  $timer.Add_Tick({
    $timer.Stop()
    Write-Diag ("tick visible=" + $form.Visible + " left=" + $form.Left + " top=" + $form.Top)
    $form.Close()
  })
  $timer.Start()
  Write-Diag ("before showdialog " + (Get-Date -Format HH:mm:ss.fff))
  $form.ShowDialog() | Out-Null
  Write-Diag ("after showdialog " + (Get-Date -Format HH:mm:ss.fff))
} catch {
  Write-Diag ("EXCEPTION: " + $_.Exception.Message)
}
`;

const t0 = performance.now();
const child = spawn("powershell.exe", [
	"-NoProfile",
	"-WindowStyle",
	"Hidden",
	"-ExecutionPolicy",
	"Bypass",
	"-EncodedCommand",
	Buffer.from(script, "utf16le").toString("base64")
], { windowsHide: true, stdio: "ignore" });
child.on("error", (error) => console.log("spawn error:", error.message));
child.on("exit", (code) => {
	console.log(`popup process exited: ${code} after ${(performance.now() - t0).toFixed(0)} ms`);
});
console.log("spawned pid:", child.pid, "diag:", DIAG);
