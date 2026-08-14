# dsh-notify-sounds

[![npm version](https://img.shields.io/npm/v/dsh-notify-sounds.svg)](https://www.npmjs.com/package/dsh-notify-sounds)
[![License](https://img.shields.io/npm/l/dsh-notify-sounds.svg)](LICENSE)
[![CI](https://github.com/Half-xingle/dsh-notify-sounds/actions/workflows/ci.yml/badge.svg)](https://github.com/Half-xingle/dsh-notify-sounds/actions)

DeepSeek Harness Web GUI 提示音插件：当智能体**需要你选择**（提问 / 计划审阅 / 权限审批）或**任务完成**（会话从运行变为空闲）时，播放一段短提示音。适合你把 DSH 页面切到后台、在别的网页干活时的场景。

- 浏览器半部（`lib/client.js`）：Web Audio 合成短音，订阅会话列表的 `pendingInteraction` 与 `running` 边沿，零外部依赖；设置存浏览器 localStorage（跨标签页自动同步）。
- 宿主半部（`lib/index.js`）：注册 `notify-sounds` 设置命名空间与 schema（官方模式；当前 API 网关只对白名单命名空间开放浏览器读写，见「与官方标准的对照」）。
- 设置项显示在 **设置 → 插件配置 → 提示音通知** 卡片中（开关、音量、试听、恢复默认）。

## 声音

| 场景 | 触发时机 | 声音 |
| --- | --- | --- |
| 提问 | `ask_user_question` 等待选择（含计划审阅） | 叮咚（880 → 1174 Hz，两音） |
| 审批 | 权限审批请求 | 咚咚（659 → 880 Hz，两音） |
| 完成 | 会话 running → idle（任务完成或被停止） | 上行三连音（523 → 659 → 784 Hz） |

均为短促正弦波，峰值约为设定音量的 30%。

## 安装

### 前置

- Windows + DSH web profile（`dsh web` 已运行过，`$DSH_HOME/profiles/web` 存在）
- 浏览器打开 GUI 后**点击/按键一次**解锁自动播放策略（一次性，之后后台标签页也能响）

### 方式一：一键脚本（Windows，推荐，无需 pnpm/网络）

在 `dsh-notify-sounds` 目录下执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本利用 DSH profile 的扁平 node_modules 布局（`profiles/node_modules` 下所有包平铺、`@deepseek-ai/*` 是指向 DSH 安装目录的 junction）——与 dsh 官方 `healProfilesModuleFallback` 为自己的包建立的接入机制相同：

1. 在 `profiles/node_modules` 下创建 `dsh-notify-sounds` junction 指向本插件目录（软链，改代码免重装，重启即生效）；
2. 在本插件目录 `node_modules/@deepseek-ai/` 下生成 `dsh-settings`、`schemastery` 两个 shim，重导出 profile 中真实使用的实现（插件经 junction 后真实路径在仓库里，Node 从真实路径向上找依赖，需要这层垫片；也可改用 `npm install` 装真实依赖替代 shim）；
3. 在 `cordis.patch.yml` 中写入 `insert:` 形式的插件行（新增行必须用 insert，顶层 `{id, name}` 只用于覆盖已有行）。

### 方式二：手动 / 其他平台

```powershell
# 1. 把插件链接进 profile 的 node_modules（Windows junction；Linux/macOS 用 ln -s）
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-notify-sounds" "此处填插件绝对路径"
# 2. 安装宿主依赖：npm install（装真实依赖）或参考 install.ps1 生成 shim
# 3. 在 cordis.patch.yml 追加：
# - insert:
#     - id: notify-sounds
#       name: dsh-notify-sounds
# 4. 重启 dsh web
```

### 方式三：官方 pnpm 方式（发布到 npm 后）

```powershell
dsh plugin --profile web add dsh-notify-sounds
# 并按方式二第 3、4 步追加 insert 行并重启
```

> 插件集变化（新增/移除包）需要**重启 `dsh web`** 才生效（`client-modules` 对包身份有缓存）。

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 启用提示音 | 开 | 总开关 |
| 提问 / 审批提示 | 开 | 提问、计划审阅（plan-review）、权限审批时播放 |
| 任务完成提示 | 开 | 会话 running → idle（任务完成或被停止）时播放 |
| 仅页面隐藏时播放 | 关 | 只在标签页不可见时响 |
| 音量 | 50% | 0–100% |

设置存储在浏览器 localStorage（键 `dsh-notify-sounds.settings.v1`），跨标签页自动同步。

## 工作原理

浏览器半部订阅 `ctx.sessions.list` 可观察对象（dsh-client-runtime 提供的会话列表镜像），按会话记录上一次的 `{ running, pendingInteraction }`：

- `pendingInteraction` 从无到有 → 播放提问音（`approval` 用审批音，`question` / `plan-review` 用提问音）；
- `running` 从 true 变 false → 播放完成音；
- 只对**边沿**发声：页面加载、重连后的首次快照只记录状态不发声；新出现的会话不发声。

## 限制

- 浏览器自动播放策略：首次发声前需要页面上有过一次用户手势（点击/按键）。
- 标签页被**关闭**时听不到（浏览器侧插件的固有限制）。
- 多标签页各自发声（每页一个运行时实例），设置经 `storage` 事件同步。
- 手动停止任务也会触发「完成」音（running → idle 无法区分完成与停止）；如不需要可关闭「任务完成提示」。

## 与官方标准的对照

官方文档（[插件开发入门](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)、[扩展食谱](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)、[架构说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)）与官方包实现要求：

| 官方要求 | 本插件 |
| --- | --- |
| 插件是 npm 包，`package.json` 声明 `dsh.client: { platform: "web", inject?, immediately? }` 且导出 `./client` 子路径 | ✅ |
| 浏览器 bundle 经 `window.__ModuleLoader__.load({ id: <包名>, factory })` 注册，导出 `apply(ctx)` 与 `inject` 服务键 | ✅ |
| bundle 纯净化：只能 require 平台 seed 词与经 ctx 注入的服务 | ✅ 只 require react |
| 设置项：宿主半部 `installSettingsSection` + schemastery schema | ✅（客户端因网关白名单改用 localStorage，见下） |
| 挂载：`cordis.patch.yml` 用 `insert:` 列表新增行 | ✅ |
| 安装：官方 `dsh plugin`（pnpm）；junction 接入 = 官方 `healProfilesModuleFallback` 同款机制 | ✅ 等效 |

**关于设置存储**：宿主半部按官方模式注册了 `notify-sounds` 命名空间，但 web API 网关（`dsh-host-apiproxy`）只暴露硬编码白名单（`WEB_SETTINGS_NAMESPACES`/`PRODUCT_SETTINGS_NAMESPACES`）给浏览器客户端，第三方命名空间暂不可远程读写（官方源码注释标注为 deferred work）。因此设置实际存于浏览器 localStorage；上游开放后可无缝切回命名空间。

## 开发

```powershell
node --check lib\client.js
node test\smoke.mjs        # 浏览器半部：加载协议、事件边沿、设置开关、重连、音量、持久化
node test\host-smoke.mjs   # 宿主半部：settings 命名空间注册与 schema 校验（需要宿主依赖：install.ps1 生成的 shim 或 npm install）
node tools\verify-install.mjs  # 安装后校验：模拟 client-modules 扫描 + 完整导入链路
```

CI（GitHub Actions）会自动跑两个测试。

## 发布到 npm

包已声明 `dsh.client` 与 `exports["./client"]`，`files` 只打包 `lib`；`npm publish` 前会自动跑冒烟测试（`prepublishOnly`）。

### 版本迭代流程

```powershell
# 1. 改代码 -> 本地测试
node test\smoke.mjs

# 2. 升版本号（自动改 package.json + 打 git tag）
npm version patch   # 修 bug：1.0.0 -> 1.0.1
npm version minor   # 加功能：1.0.0 -> 1.1.0
npm version major   # 不兼容变更：1.0.0 -> 2.0.0

# 3. 发布（2FA 验证码：验证器 App 的 6 位码，或恢复码整串）
npm publish --otp=123456

# 4. 推送代码和 tag
git push
git push --tags
```

> 没有验证器 App 时可用 npm 的恢复码（每个一次）；也可以在 npmjs.com → Access Tokens 创建勾选了 "bypass 2FA" 的 Granular Access Token 后，用 `$env:NPM_TOKEN` 免验证码发布。

发布后用户即可用 `dsh plugin --profile web add dsh-notify-sounds` 安装（见安装方式三）。

## License

MIT
