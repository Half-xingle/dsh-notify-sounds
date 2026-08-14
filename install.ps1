# install.ps1 — 把 dsh-notify-sounds 安装进 DSH web profile（重启后生效）
#
# 安装方式说明：DSH web profile 的 node_modules 是扁平 hoisted 布局（profiles/node_modules，
# 其中 @deepseek-ai/* 是指向 DSH 安装目录的 junction），插件按同样方式接入：
#   1) profiles/node_modules/dsh-notify-sounds -> 本插件目录的 junction（软链，改代码免重装）
#   2) 在本插件目录的 node_modules 下生成两个 shim（@deepseek-ai/dsh-settings、
#      @deepseek-ai/schemastery），重导出 profile 中真实使用的实现 —— 因为插件文件经
#      junction 后真实路径在仓库里，Node 会从真实路径向上找依赖，需要这层垫片；
#      也可以用 `npm install` 安装真实依赖替代 shim（见 README「安装」）
#   3) cordis.patch.yml 追加 notify-sounds 行（insert 形式）
# 无需 pnpm / corepack / 网络（shim 方式）。兼容 Windows PowerShell 5.1 与 7+。
#
# 用法：在 dsh-notify-sounds 目录下执行
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"

# UTF-8 无 BOM 写入（PS 5.1 的 Set-Content -Encoding utf8NoBOM 不可用，统一走 .NET）
function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
}
function Append-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::AppendAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
}

$pluginDir = $PSScriptRoot
if (-not (Test-Path (Join-Path $pluginDir "package.json"))) {
    Write-Error "未找到 package.json（应在 $pluginDir）。请在 dsh-notify-sounds 目录下运行本脚本。"
    exit 1
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\web"
$profileNodeModules = Join-Path $dshHome "profiles\node_modules"
if (-not (Test-Path (Join-Path $profileDir "package.json"))) {
    Write-Error "未找到 web profile（应在 $profileDir）。请确认 DSH_HOME 或已运行过 dsh web。"
    exit 1
}
if (-not (Test-Path $profileNodeModules)) {
    Write-Error "未找到 $profileNodeModules —— 不是预期的扁平 hoisted 布局，请改用 pnpm 安装（见 README）。"
    exit 1
}

# 1) junction 插件目录到 profile node_modules
$link = Join-Path $profileNodeModules "dsh-notify-sounds"
if (Test-Path $link) {
    Write-Host "==> 已存在 $link，先移除旧链接 ..."
    cmd /c rmdir "$link" 2>$null
    if (Test-Path $link) { throw "无法移除 $link（请确认它是 junction/目录而非文件）" }
}
New-Item -ItemType Junction -Path $link -Target $pluginDir | Out-Null
Write-Host "==> 已创建 junction: $link -> $pluginDir"

# 2) 写入仓库根 node_modules 的 shim（重导出 profile 真实实现）
function Write-Shim([string]$pkg, [string]$body) {
    $dir = Join-Path $PSScriptRoot "node_modules\@deepseek-ai\$pkg"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $pkgJson = Join-Path $dir "package.json"
    if (-not (Test-Path $pkgJson)) {
        $json = @{
            name    = "@deepseek-ai/$pkg"
            version = "0.0.0-shim"
            private = $true
            type    = "module"
            main    = "index.js"
            exports = @{ "." = "./index.js" }
        } | ConvertTo-Json
        Write-Utf8NoBom $pkgJson $json
    }
    Write-Utf8NoBom (Join-Path $dir "index.js") $body
}
$settingsUrl = ([System.Uri]::new((Join-Path $profileNodeModules "@deepseek-ai\dsh-settings\lib\index.js"))).AbsoluteUri
$schemasteryUrl = ([System.Uri]::new((Join-Path $profileNodeModules "@deepseek-ai\schemastery\lib\index.mjs"))).AbsoluteUri
Write-Shim "dsh-settings" "export * from `"$settingsUrl`";`n"
Write-Shim "schemastery" "export * from `"$schemasteryUrl`";`nexport { default } from `"$schemasteryUrl`";`n"
Write-Host "==> 已写入 shim：node_modules\@deepseek-ai\{dsh-settings,schemastery}"

# 3) 把 notify-sounds 行挂进 cordis.patch.yml
$patchPath = Join-Path $profileDir "cordis.patch.yml"
if (-not (Test-Path $patchPath)) {
    Write-Error "未找到 $patchPath"
    exit 1
}
$content = [System.IO.File]::ReadAllText($patchPath, [System.Text.Encoding]::UTF8)
if ($content -match "dsh-notify-sounds") {
    Write-Host "==> cordis.patch.yml 已包含 notify-sounds，跳过。"
} else {
    # 官方 patch 语义：顶层 {id, name} 行是「按 id 覆盖已有行」，不存在的 id 会被警告跳过；
    # 新增插件行必须用 insert 列表（无 id 目标时追加到根条目列表）。
    $entry = "- insert:`n    - id: notify-sounds`n      name: dsh-notify-sounds`n"
    # 空列表（可能带注释）-> 用正则把 [] 行替换为 insert 块，保留原注释；
    # 没有 [] 行（已是列表/其他内容）-> 直接追加。
    $newContent = $content -replace "(?m)^\s*\[\]\s*$", $entry
    if ($newContent -eq $content) {
        Append-Utf8NoBom $patchPath $entry
    } else {
        Write-Utf8NoBom $patchPath $newContent
    }
    Write-Host "==> 已写入 cordis.patch.yml：notify-sounds 行（insert 形式）。"
}

Write-Host ""
Write-Host "安装完成。请重启 dsh web 使插件生效："
Write-Host "  1) 停止当前 dsh web 进程（Ctrl+C 或关掉终端）"
Write-Host "  2) 重新运行 dsh web 并打开页面"
Write-Host "  3) 在页面上点击/按键一次，解锁浏览器自动播放"
Write-Host "  4) 设置 -> 插件配置 -> 提示音通知 可调开关与音量"
