# dsh-notify-sounds

[![npm version](https://img.shields.io/npm/v/dsh-notify-sounds.svg)](https://www.npmjs.com/package/dsh-notify-sounds)
[![License](https://img.shields.io/npm/l/dsh-notify-sounds.svg)](LICENSE)
[![CI](https://github.com/Half-xingle/dsh-notify-sounds/actions/workflows/ci.yml/badge.svg)](https://github.com/Half-xingle/dsh-notify-sounds/actions)

DeepSeek Harness Web GUI 提示音插件：当智能体**需要你选择**（提问 / 计划审阅 / 权限审批）或**任务完成**（会话从运行变为空闲）时，播放一段短提示音，并在屏幕右下角弹出原生通知。适合你把 DSH 页面切到后台、在别的网页干活时的场景。

- **浏览器半部**（`src/client/index.js` → `lib/client.js`）：Web Audio 合成短音，订阅会话状态，零外部依赖（只依赖平台播种的 React）。
- **宿主半部**（`src/*.js` → `lib/*.js`）：导出插件 `Config` schema（dsh 据此生成设置页面，浏览器半部经 `ctx.configForms` 编辑同一份值），并驱动**原生桌面弹窗**：右下角无边框圆角 toast，6 秒自动消失，不依赖浏览器通知中心——**浏览器标签页关闭也能弹**。
- 设置项出现在 **设置 → 插件 → dsh-notify-sounds** 页面（开关、音量、试听、恢复默认）。

## 声音

| 场景 | 触发时机 | 声音 |
| --- | --- | --- |
| 提问 | 会话出现待处理交互，类型为 `question` / `plan-review` | 叮咚（880 → 1174 Hz，两音） |
| 审批 | 会话出现待处理交互，类型为 `approval` | 咚咚（659 → 880 Hz，两音） |
| 完成 | 会话由 running 变为 idle（任务完成或被停止） | 上行三连音（523 → 659 → 784 Hz） |

均为短促正弦波，峰值约为设定音量的 30%。只对**边沿**发声：页面加载、重连后的首次快照只记录状态不发声；新出现的会话不发声；子会话（subagent）完全静默。

## 安装

### 前置

- Windows + DSH web profile（`dsh web` 已运行过，`$DSH_HOME/profiles/web` 存在）
- 浏览器打开 GUI 后**点击/按键一次**解锁自动播放策略（一次性，之后后台标签页也能响）

### 方式一：本地目录（开发/自用，推荐）

从 DSH 内用 `plugin_manager` 的 `install_bundle`，或从命令行：

```powershell
dsh plugin --profile web add "D:\persenal program\dph_插件\dsh-notify-sounds"
```

DSH 会因为该包声明了 `dsh.bundle` 而把 `dsh-notify-sounds` 追加进 profile 的 `dsh.profile.bundles`，层的加载顺序由该列表决定。等价的 profile 内容：

```json
{
  "dependencies": { "dsh-notify-sounds": "link:D:/persenal program/dph_插件/dsh-notify-sounds" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-notify-sounds"] } }
}
```

先验证层再启动，可以只看组合结果：

```powershell
dsh --profile web --dump-config   # 应出现 "# == dsh-notify-sounds" 层
```

### 方式二：npm / tarball（用户侧无需构建授权）

```powershell
dsh plugin --profile web add dsh-notify-sounds          # 预构建产物，来自 npm
dsh plugin --profile web add .\dsh-notify-sounds-2.0.0.tgz   # 或 pnpm pack 出的 tarball
```

### 方式三：git 安装（需要你为构建脚本授权）

```powershell
dsh plugin --profile web add github:Half-xingle/dsh-notify-sounds#<sha>
```

git 安装拉的是**源码而不是构建产物**，所以 pnpm 会运行本包的 `prepare` 脚本（`node scripts/build.mjs`）现场生成 `lib/`。pnpm ≥ 10 在得到显式允许前会拒绝运行它，首次 `add` 会失败并提示你把包名加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-notify-sounds: true
```

> 请把这项授权视为**允许该包的代码在你机器上以宿主权限执行**（不在 agent 的沙箱内）。只对源码可信的包授权，并锁定 commit（`#<sha>`），避免后续推送改变实际运行的内容。不想授权就改用方式一或方式二。

> 插件集变化（新增/移除包）需要**重启 `dsh web`** 才生效（`client-modules` 对包身份有缓存）。

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` 启用提示音 | 开 | 总开关 |
| `question` 提问 / 审批提示 | 开 | 提问、计划审阅（plan-review）、权限审批时播放 |
| `complete` 任务完成提示 | 开 | 会话 running → idle（任务完成或被停止）时播放 |
| `onlyWhenHidden` 仅页面隐藏时播放 | 关 | 只在标签页不可见时响 |
| `volume` 音量 | 50% | 0–100% |
| `notifications` 启用桌面通知 | 开 | 系统通知总开关 |
| `notifQuestion` 提问 / 审批通知 | 开 | 提问、计划审阅、权限审批时弹通知 |
| `notifComplete` 任务完成通知 | 开 | 任务完成时弹通知 |
| `notifTodo` 任务进度通知 | 开 | **计划（todo）列表中的某一项变为已完成时**弹通知，如「「收集需求」已完成（2/5）」 |
| `notifTodoInterval` 进度通知最小间隔 | 12 秒 | 突发合并：同一会话在间隔内连续完成的多项，合并为一条（最新项+计数）；0 = 逐条提示 |
| `notifStyle` 通知样式 | `native` | `native`（宿主原生弹窗，推荐）/ `system`（浏览器系统通知）/ `both` |
| `popups` 宿主弹窗总开关 | 开（**非 volatile**） | 部署策略，写在该插件行的 `config` 里，不出现在设置页面 |

### 设置存在哪里

插件的 **`Config` schema 是唯一的真源**（dsh ≥ 0.1.7）。宿主半部导出 `Config`，其中面向用户的字段都标了 `volatile()`：

- dsh 由该 schema 生成插件设置页面；
- 浏览器半部经 `ctx.configForms.get("notify-sounds")` 拿到同一个命名空间的表单，用 `set` / `unset` 写入（写进 profile 的补丁层），用 `getSnapshot()` 读取；
- 标记为 volatile 的字段不需要重启插件：loader 把新值**原地写进运行中的 Config 对象**再发 `loader/volatile-update`，所以宿主弹窗的门控与浏览器声音始终读到同一份值。

卡片只在 Host 真的服务该命名空间时才注册（`ctx.configForms.whileServed`），因此没装这个插件的组合里不会留下痕迹。

**部署级关闭弹窗**（保留声音与设置页面）：在该插件行写 `config: { popups: false }`。

## 原生弹窗（宿主半部，Windows）

宿主半部在屏幕**右下角**弹出原生 toast（无边框、深色圆角、置顶，约 6 秒自动消失；点击或 Esc 立即关闭）。与浏览器系统通知相互独立，**不占用系统通知中心**（无归档、无 Focus Assist 抑制），浏览器标签页关闭、页面切后台都能弹。

| 场景 | 触发时机 | 弹窗内容 |
| --- | --- | --- |
| 提问 | `session/event` 的 `tool/call`，工具名为 `ask_user_question` | 「DSH · 需要你 智能体正在等待你的选择」 |
| 审批 | `session/event` 的 `approval/asked` 审计事件 | 「DSH · 等待审批 「工具名」需要你的审批」 |
| 进度 | `session/event` 的 `todo/write` 中某计划项变为已完成 | 「DSH · 任务进度 「计划项」已完成（n/m）」 |
| 完成 | `agent/status` → `idle` | 「DSH 任务完成」 |

门控与声音同源：都读那份 `Config`（`notifications` / `notifQuestion` / `notifComplete` / `notifTodo`，默认全开），保存即生效。

**实现说明**：每个弹窗是一个一次性隐藏 PowerShell 进程（WinForms `ShowDialog`；常驻 helper 方案在本环境无法渲染，已弃用）。用 `-EncodedCommand` 内嵌脚本（文件/JSON 变体不渲染），经注册表 `AppliedDPI` 做缩放补偿（125% 等缩放屏右下角定位正确；缩放坐标混用曾导致弹窗画到屏幕外，已修复）。**不要在脚本里加 `Add-Type -TypeDefinition` 的 DPI 前奏**——C# 编译会静默杀死隐藏脚本。首次弹窗可能触发安全软件对「隐藏 PowerShell」的提示，允许并勾选「不再询问」后按命令行签名记忆，不再打扰。

## 工作原理

浏览器半部按优先级选择状态源：

1. **首选** `ctx.uiSession.sessionStatus`（`ReadonlyMap<SessionId, { running, pendingInteraction, completionUnread }>`）——这就是本插件需要的会话 UI 状态面；
2. **回落** `ctx.get("sessions").list` 快照（快照项带 `running` / `pendingInteraction`）。

两条路都归一成同一份 `{ running, pending }` 事实再走同一套边沿判定，因此行为不会因源不同而漂移：`pendingInteraction` 由无到有 → 提示音；`running` 由 true 变 false → 完成音。显示标题与「是否子会话」只存在于会话列表里，所以两者都从那里补齐；**当列表服务不可用时，运行时会把每个会话都当作顶层会话**（宁可多提醒，也不因为拿不到父链而漏掉提醒）。`connection/reset` 会清空所有边沿基线，重连后的首个快照只记录状态。

宿主半部监听全局 `session/event` 与 `agent/status`（`global: true` 绕过作用域 carrier 过滤），按上表驱动原生弹窗；todo 进度对每次 `todo/write` 的全量列表做 diff（`turn/start` 重置基线）。子会话（`delegationDepth !== 0`）静默。

## 限制

- 浏览器自动播放策略：首次发声前需要页面上有过一次用户手势（点击/按键）。
- 标签页被**关闭**时听不到声音（浏览器侧插件的固有限制）；原生弹窗不受影响，照常弹出。
- 多标签页各自发声（每页一个运行时实例），设置经同一个命名空间同步（同源同值）。
- 手动停止任务也会触发「完成」音/弹窗（running → idle 无法区分完成与停止）；如不需要可关闭「任务完成提示」。
- 原生弹窗仅 Windows（依赖 PowerShell + WinForms），且可能触发安全软件对隐藏 PowerShell 的首次提示（见上）。
- 远程（非回环）访问 DSH 时设置可能只读（`status: "unavailable"` 或 `mode: "memory"`），此时卡片回退到浏览器本地 `localStorage`（键 `dsh-notify-sounds.settings.v1`）。

## 与官方标准的对照

依据官方仓库 `deepseek-ai/deepseek-harness` 的 **master 提交 `21638c5`（2026-09-27）**；本插件运行在 dsh **0.1.7-rc.2**。

| 官方要求 | 本插件 |
| --- | --- |
| 组合包是 npm 包，声明 `dsh.bundle.patch` 指向一个 patch 文件 | ✅ `cordis.patch.yml`，用 `insert` 列表新增行 |
| 加载行按**裸包名**引用插件（Node 才能解析到已安装代码） | ✅ `name: 'dsh-notify-sounds'` |
| 浏览器半部声明 `dsh.client.platform: "web"`，并从 `exports["./client"]` 导出构建产物 | ✅ `lib/client.js` |
| 构建出的 `./client` 必须是**惰性 CJS factory**：`__ModuleLoader__.load({ id, factory })`，注册 id 等于包名，执行时只注册不运行模块体 | ✅ 由 `scripts/build.mjs` 生成，`test/build-smoke.mjs` 断言 |
| 动态包只 `require` 平台种子词（React 等）；不得 import 其他功能插件的运行时值 | ✅ 只 `require("react")`；跨包协作走注入的服务与插槽 |
| React 属于外壳播种的基线 external，**不写进**动态包的清单依赖 | ✅ React 只在 `devDependencies`，`dsh.client.inject` 只做元数据 |
| 设置来源 = 插件导出的 `Config` schema；面向用户的字段用 `.volatile()`，经 `ctx.configForms` 编辑 | ✅ 12 个字段（11 个 volatile） |
| 设置页面注册进 `plugins.item`，并用 `ctx.configForms.whileServed` 跟随宿主命名空间 | ✅ `whileServed([SETTINGS_NAMESPACE], …)` |
| 插件集变化需要重启 `dsh web` | ✅ 见「安装」末段 |
| 所有注册都是 effect，随插件卸载清理 | ✅ `ctx.effect` / `ctx.on`；插件只用具名导出、不导出 default |

## 开发

```powershell
npm run build     # src/ -> lib/
npm run verify    # 校验 lib/ 与 src/ 一致（陈旧就非零退出）
npm test          # verify + 全部测试
```

| 测试 | 覆盖 |
| --- | --- |
| `test/smoke.mjs` | 浏览器半部端到端：加载协议、边沿、设置门控、重连、todo 聚合、系统通知（走 `sessions.list` 回落路径） |
| `test/status-source.mjs` | 浏览器半部首选路径 `uiSession.sessionStatus`，以及回落切换、`connection/reset`、子会话静默 |
| `test/host-smoke.mjs` | 宿主半部：`apply` 装配、`Config` schema 与 volatile 读写、弹窗判定引擎、PowerShell 命令构造 |
| `test/build-smoke.mjs` | 产物契约：bundle 注册 id、只 require 平台种子词、宿主半部无 default 导出 |
| `tools/verify-install.mjs` | 安装后校验：复刻 client-modules 扫描逻辑，验证包能被解析与发现 |

### 目录约定

```
src/                  唯一真源
├─ index.js           宿主入口：Config schema + apply(ctx, config)
├─ notifier.js        弹窗判定引擎（纯逻辑，show 可注入）
├─ popup.js           buildPopupCommand / showPopup
└─ client/index.js    浏览器半部（普通脚本文本，非 ES 模块）
lib/                  构建产物，随仓库提交以便零构建安装
scripts/build.mjs     构建：src -> lib，含陈旧产物校验
backup-ref/           改造前的原始文件与一次性迁移脚本（不参与构建）
```

`lib/` 是**提交进仓库的构建产物**：这样 `install_bundle` 与 `pnpm pack` 都不需要现场构建。代价是可能忘记重建，所以构建脚本会写 `lib/.build-stamp.json`（`src/` 每个文件的 sha256），`npm test` 开头的 `--verify` 会重算比对，不一致直接失败。

## 发布到 npm

```powershell
npm version patch      # 或 minor / major
npm publish --otp=123456
git push && git push --tags
```

`prepare` 会在安装与发布前构建 `lib/`；`files` 只打包 `lib/`、`cordis.patch.yml`、README 与 LICENSE。

## License

MIT
