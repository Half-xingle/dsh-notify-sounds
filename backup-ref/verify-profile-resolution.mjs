// Proof that the profile resolves both halves of the plugin through the
// official bundle install (no manual junction, no shims).
//
// Run: node backup-ref/verify-profile-resolution.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const profileCordis = "C:/Users/86156/.dsh/profiles/web/cordis.yml";
const require = createRequire(pathToFileURL(profileCordis));

const pkgPath = require.resolve("dsh-notify-sounds/package.json");
console.log("package.json:", pkgPath);

const hostPath = require.resolve("dsh-notify-sounds");
console.log("host entry  :", hostPath);
const host = await import(pathToFileURL(hostPath).href);
console.log("host apply  :", typeof host.apply, "| Config:", typeof host.Config, "| has default:", Object.hasOwn(host, "default"));
console.log("namespace   :", host.SETTINGS_NAMESPACE);

const clientPath = require.resolve("dsh-notify-sounds/client");
console.log("client entry:", clientPath);
const source = readFileSync(clientPath, "utf8");
const match = /id:\s*"([^"]+)"/.exec(source);
console.log("bundle id   :", match ? match[1] : "<not found>", "| matches package:", match?.[1] === "dsh-notify-sounds");

const schemastery = require.resolve("@deepseek-ai/schemastery");
console.log("schemastery :", schemastery);
