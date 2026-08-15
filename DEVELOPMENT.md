# DSH 插件开发经验备忘（dsh-notify-sounds 实战沉淀）

本文档总结在 Windows + DeepSeek Harness Web profile 下开发 dsh-notify-sounds 的全部经验：
架构要点、踩坑记录（含两个「查了一整天」的隐蔽 bug）、原生弹窗实现细节、测试与调试方法、
GitHub / npm 发布流程与账号凭证备忘。**做下一个 DSH 插件前先读一遍。**

---

## 1. 插件架构速览

### 1.1 双面插件结构

一个 DSH 插件 = 一个 npm 包，包含**宿主半部**（服务器进程内跑）与**浏览器半部**（页面里跑）：

```
dsh-notify-sounds/
├── lib/index.js      # 宿主半部：apply(ctx) 是入口（loader 通过 unwrapExports 找 apply）
├── lib/client.js     # 浏览器半部：apply(ctx) + inject 服务键
├── package.json
└── install.ps1       # Windows 一键接入（junction + shim + patch）
```

`package.json` 关键声明：

```json
{
  "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./client": { "default": "./lib/client.js" } },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", "..."] } }
}
```

### 1.2 挂载与安装（Windows）

- `$DSH_HOME` = `C:\Users\86156\.dsh`，web profile 在 `$DSH_HOME\profiles\web`。
- **挂载**：`profiles\web\cordis.patch.yml` 用 `- insert:` 列表新增行（顶层 `{id, name}` 只用于**覆盖已有行**，新增行必须 insert）：

  ```yaml
  - insert:
      - id: notify-sounds
        name: dsh-notify-sounds
  ```

- **接入**：`profiles\node_modules\dsh-notify-sounds` 是指向仓库目录的 **junction**（软链，改代码免重装，重启即生效）——与官方 `healProfilesModuleFallback` 同机制。`install.ps1` 还会在仓库 `node_modules\@deepseek-ai\` 下生成 `dsh-settings`、`schemastery` 两个 **shim**（重导出 profile 真实实现），否则宿主依赖解析不到。
- **改代码 → 生效**：`git commit` → 跑重启 helper（见 §6）→ 12 秒后刷新页面。插件集变化（新增/移除包）也必须重启（client-modules 对包身份有缓存）。

### 1.3 事件系统（核心认知，务必理解）

- 整个 app **只有一个事件池**：根 Context 构造时 `new EventsService(root)`，所有子 ctx 经原型链共享同一个 `events` 实例。`ctx.on` 通过 mixin 绑定 EventsService，hook 永远进共享池——**不存在「监听器注册到别的池」这回事**。
- `session/event`、`agent/status` 等带作用域的派发，thisArg 是 `scopeTarget(...)` 构建的 carrier，其 filter 逻辑（`dsh-scope`）：**无 scope 标签的 ctx 一律放行**；有标签的只有「派发键的祖先」放行。root/插件 ctx 无标签 → 普通 `ctx.on` 就能收到（持久化插件就是这么收的）。
- 保险起见监听这类事件用 `{ global: true }`：`hook.global` 直接跳过 filter，与 ctx 标签无关。
- ⚠️ **致命坑（本插件弹窗一个月不响的真凶）**：Cordis 的 `ctx.effect(cb)` **立即执行 cb，cb 的返回值才是卸载器**。下面这种写法会在注册瞬间把监听器当场注销：

  ```js
  // ❌ 错误：effect 体立即执行，两个 disposer 当场跑掉，监听器永远收不到事件
  const d1 = ctx.on("session/event", fn, { global: true });
  ctx.effect(() => { d1(); });
  // ✅ 正确：ctx.on 本身已注册 effect（随插件 fiber 卸载自动清理），什么都不用做
  ctx.on("session/event", fn, { global: true });
  ```

- ⚠️ **调试纪律**：**绝不要**在 `apply()` 里往全局事件流 `emit` 假事件自测——`dsh-session-persistence` 会处理任何 `session/event`，假 session 没有数据 → 抛异常 → **整棵树加载失败**（曾因此把用户环境搞崩，需 Claude Code 修）。诊断只用**文件写入**（`appendFileSync` 到 `lib/.dsh-events.log`，用完删）。

## 2. 踩坑记录（按严重度）

| 级别 | 坑 | 现象 | 根因 / 解法 |
| --- | --- | --- | --- |
| 🔴 致命 | `ctx.effect` 里调用监听器 disposer | 监听器「已注册」但事件永远不到 | effect 体立即执行；返回值才是 teardown。见 §1.3 |
| 🔴 致命 | apply 里 emit 假事件自测 | 服务器启动直接崩，整树加载失败 | 假 session 被持久化插件处理 → 异常。只准文件诊断 |
| 🟠 重要 | 弹窗画到屏幕外 | 进程 exit 0、窗口「显示」了但人看不见 | DPI 缩放坐标混用：`(wa - w - 18) * scale` 把未缩放尺寸乘了 scale。**位置必须用缩放后的窗体尺寸**：`Left = wa.Right - form.Width - 18*scale` |
| 🟠 重要 | npm publish 报 `404 Not Found - PUT` | 以为包名/权限问题 | 其实是 **npm 凭证失效**（未登录）。`npm whoami` 先验证身份；E404 PUT = 未登录/无权限，EOTP = 要验证码，E400 "otp fails" = 恢复码已失效 |
| 🟡 注意 | 隐藏 PowerShell 被杀软提示 | 每次弹窗都弹「隐藏 PowerShell」风险提示 | `-WindowStyle Hidden` + `-EncodedCommand` 内容每次不同 → 签名不同 → 按签名记忆；用户点「允许+不再询问」后不再打扰（火绒） |
| 🟡 注意 | `files: ["lib"]` 把调试日志打进 tarball | npm 包 487KB 含 `.dsh-events.log` | files 收窄到具体文件 + `.npmignore` 排除 `*.log`；`npm pack --dry-run` 检查内容 |
| 🟡 注意 | 客户端 `AssistantMessageNode.kind` | 用 `assistant-message` 判断不到 | 实际是 `'assistant'`。以运行期实际值为准，别信类型名 |
| 🟡 注意 | Windows 系统通知归档 | 同一应用短时间连续通知只显示第一条 | 通知 tag 会话级 + burst 合并（`notifTodoInterval`，0=逐条） |

## 3. 原生弹窗实现要点（Windows · PowerShell + WinForms）

如果下一个插件也要弹原生窗，直接照抄以下「唯一验证可行」的配置：

- **命令行**：`spawn("powershell.exe", ["-NoProfile","-WindowStyle","Hidden","-ExecutionPolicy","Bypass","-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" })`，`child.unref()`。
- **`-EncodedCommand`（UTF-16LE base64）内嵌 payload 是唯一能渲染的方案**；`-File`、JSON payload 变体在 node spawn 下都不渲染。
- **`ShowDialog()` 才能渲染**（`Show()` + DoEvents 在 node spawn 下不渲染）。
- **不要加 `Add-Type -TypeDefinition` DPI 预置**：C# 编译（csc）在隐藏 spawn 中静默失败，脚本直接死。
- **一次性进程 per 弹窗**：常驻 helper（长驻 PowerShell）无法渲染 WinForms，已弃用。
- **DPI 缩放**：非 DPI 感知进程里 `Screen.WorkingArea` 是物理像素；从注册表 `HKCU:\Control Panel\Desktop\WindowMetrics\AppliedDPI` 读缩放（125% → 120/96 = 1.25）。窗体宽高、字体、边距全部乘 scale；**定位用缩放后尺寸**（§2 的坑）。
- **诊断技巧**：脚本内部把窗体几何/可见性/时间戳 `Add-Content` 到临时文件（timer tick 里写 `Visible`），进程退出后读文件——比「盯着屏幕猜」可靠得多。本插件正是靠它拿到 `tick visible=True left=1422 top=1058`（屏幕 1536×960，窗口整个在屏幕外）才定位到坐标 bug。
- **事件源**（宿主弹窗的事件原料）：
  - 提问/计划审阅：`session/event` 里 `tool/call` 且 `data.name === "ask_user_question"`
  - 审批：`session/event` 里 `approval/asked`（`data.toolName`）
  - todo 进度：`session/event` 里 `todo/write`（`data.todos` 全量列表，diff 出新增 completed 项）
  - 完成：`agent/status` 载荷 `{ status, agent }`（idle/running），`agent.session.header` 有会话信息
- **子 agent 静默**：子会话带血缘标记——客户端 entry `parentSessionId`、宿主 session header `delegationDepth >= 1`（agent 经 `agent.session.header` 拿）。两端都过滤掉，只有顶层会话提示。
- 设置门控：宿主读 `$DSH_HOME/settings.yaml` 的 `notify-sounds:` 段（热重载）；`config: { popups: false }` 可整体禁用（loader 行 config）。

## 4. 测试与调试

```powershell
node --check lib\client.js
node test\smoke.mjs        # 浏览器半部：加载协议、事件边沿、设置开关、重连、音量、持久化
node test\host-smoke.mjs   # 宿主半部：settings 注册、schema、notifier、命令构建
node tools\verify-install.mjs  # 安装后校验
```

- **设计要点**：把决策逻辑写成**纯函数/可注入**（`createPopupNotifier({ show, settings })`），测试注入假 `show` 收集调用，不碰真实 spawn——宿主测试才安全。
- 客户端测试用假 `sessions.list`（`getSnapshot`/`subscribe`）驱动 `onList`；注意用例顺序对全局计数（`plays()`/`notifs()`）敏感，会改变基线的用例放最后。
- 发布前 `npm pack --dry-run` 检查 tarball 内容。

## 5. 发布流程

### 5.1 GitHub

```powershell
git add -A; git commit -m "..."
git push origin main
git push --tags          # npm version 打的 tag 也要推
```

SSH 已配置（`id_ed25519`），无需密码。注意：PowerShell 里 git 的 stderr 输出会被显示成红色「错误」，`exit code 1` 是假象，看 `main -> main` 和 `[new tag]` 行确认成功。

### 5.2 npm

```powershell
npm version minor        # 自动改 package.json + commit + tag（patch/minor/major）
npm publish              # 已配 bypass-2FA token，无需 --otp
git push --tags
```

- **当前凭证**：`~/.npmrc` 已写入 **Granular Access Token（勾选 "bypass 2FA"）**，`npm publish` 直接过，不用验证码。旧凭证备份在 `~/.npmrc.bak`。
- **如果 whoami 401（凭证过期）**：`npm login`（交互式；2FA 的 OTP 用恢复码，见 §6），或重新创建 token 写回 `.npmrc`。
- 没 token 时的 OTP 选项：验证器 6 位码、npm 恢复码（一次性整串）、或浏览器设备认证链接。
- 版本号策略：bug 修 patch、加功能 minor、不兼容 major。1.0.0 → 1.1.0（原生弹窗）→ 样式微调没发版，本地 + GitHub 先同步。

## 6. 账号与凭证备忘（敏感，勿外传）

| 项 | 值 / 位置 | 说明 |
| --- | --- | --- |
| npm 账号 | `half_xingle`（邮箱 1148958503@qq.com） | 2FA 开启 |
| npm 恢复码 | `D:\下载\npm_recovery_codes.txt` | 一次性整串（10 位小写字母数字）；**在 npm 网页重新生成过会全部作废**；剩余数量以文件为准 |
| npm Access Token | `~/.npmrc`（`//registry.npmjs.org/:_authToken=npm_...`） | **bypass 2FA**，发布免 OTP；丢失可到 npmjs.com → Access Tokens 重建 |
| GitHub 账号 | `cat_cat`（本地 git 身份） | 仓库组织/作者显示为 `Half-xingle` |
| GitHub SSH key | `id_ed25519` | 已配置免密推送 |
| DSH 环境 | `$DSH_HOME = C:\Users\86156\.dsh` | web profile：`profiles\web` |
| 重启 helper | `C:\Users\86156\AppData\Local\Temp\dsh-restart-helper2.ps1` | 等 4 秒 → 杀 3080 端口 → 起新 `dsh web`；日志 `%TEMP%\dsh-web-restart2.log` |
| 火绒 | 病毒查杀 → 信任区 | 加 powershell.exe 无效；「允许+不再询问」按命令行签名记忆，有效 |

**安全提醒**：token/恢复码不要写进任何会进 git 的文件；`~/.npmrc` 本身也不要提交。恢复码每个只能用一次，用完从文件里划掉。

## 7. 新插件开工清单

1. 建 npm 包，声明 `dsh.client` + `exports["./client"]` + `apply(ctx)`；
2. 参照 `install.ps1` 做 junction + shim + `cordis.patch.yml` insert；
3. 宿主侧先跑 `node --check` + host-smoke（建好 fakeCtx：`on` 收集监听器、`inject` 给 settings）；
4. 事件监听一律 `{ global: true }`，**绝不**在 `ctx.effect` 体里注销监听器，**绝不** emit 假事件自测；
5. 弹窗类功能先独立渲染测试（临时脚本直接 `buildPopupCommand` + spawn），确认肉眼可见再接入事件；
6. 发布：`npm version minor` → `npm publish` → `git push origin main --tags`。

---

（本文档由 dsh-notify-sounds 开发全程记录整理；项目 README.md 另含用户向的功能说明与安装文档。）
