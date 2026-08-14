// verify-install.mjs — 复刻 client-modules 的扫描逻辑，验证插件在真实 profile 下可被发现。
// 运行：node verify-install.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE, ".dsh");
const profileDir = join(dshHome, "profiles", "web");

// 1) client-modules 用 createRequire(baseUrl) 解析包（baseUrl = profile 目录）
const requireFromProfile = createRequire(pathToFileURL(join(profileDir, "cordis.yml")));
const pkgPath = requireFromProfile.resolve("dsh-notify-sounds/package.json");
console.log("resolved package.json:", pkgPath);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
console.log("name:", pkg.name);

// 2) parseDshClient
const decl = pkg.dsh && pkg.dsh.client;
if (!decl || decl.platform !== "web") throw new Error("dsh.client platform != web");
console.log("dsh.client:", JSON.stringify(decl));

// 3) clientExportOf: exports["./client"]
const clientExport = pkg.exports && pkg.exports["./client"];
const clientRel = typeof clientExport === "string" ? clientExport : clientExport && clientExport.default;
if (!clientRel) throw new Error("no exports[./client]");
const clientPath = join(dirname(pkgPath), clientRel);
console.log("client bundle:", clientPath, "| exists:", existsSync(clientPath));

// 4) 图行 id 必须等于包名（bundle 用同一 id 注册工厂）
const src = readFileSync(clientPath, "utf8");
if (!src.includes("window.__ModuleLoader__.load({")) throw new Error("bundle 不含 loader 注册调用");
const idMatch = /id:\s*"([^"]+)"/.exec(src);
console.log("bundle id:", idMatch?.[1], "| matches package name:", idMatch?.[1] === pkg.name);
if (idMatch?.[1] !== pkg.name) throw new Error("bundle id 与包名不一致");

// 5) 宿主半部真实导入（经 junction -> workspace shim -> profile junction 链路）
const host = await import(pathToFileURL(join(dirname(pkgPath), pkg.main ?? "lib/index.js")).href);
if (typeof host.apply !== "function") throw new Error("宿主半部没有 apply");
console.log("host half apply():", typeof host.apply, "| namespace:", host.SETTINGS_NAMESPACE);

// 6) client bundle 在浏览器里的加载协议（模拟 materialize 前的基础检查）
const bundleId = idMatch[1];
console.log("scan checks: ALL PASSED (id=" + bundleId + ")");
