// build-smoke.mjs — prove the built artifacts satisfy their contracts without a browser.
//
// Checks:
//  1. lib/client.js registers exactly one factory, with id === package name.
//  2. Executing the bundle runs no module body (the factory is not called).
//  3. The factory only requires platform seed words (here: "react").
//  4. The factory's exports carry the browser half's public surface.
//  5. The host half is named-export only (no default) and exposes apply/Config.
//
// node test/build-smoke.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "dsh-notify-sounds";

const source = await readFile(join(root, "lib", "client.js"), "utf8");
assert.equal(/^\s*(?:import|export)\s/m.test(source), false, "bundle must not contain top-level import/export statements");

// 1 + 2) executing the bundle registers one factory and runs no other side effect.
const registrations = [];
globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			registrations.push(registration);
		},
	},
};
(0, eval)(source);
assert.equal(registrations.length, 1, "bundle must register exactly one factory");
const registration = registrations[0];
assert.equal(registration.id, packageName, `bundle id must equal the package name (got ${registration.id})`);
assert.equal(typeof registration.factory, "function", "factory must be a function");

// 3) every synchronous require inside the factory is a platform seed word.
const requires = new Set();
const react = {
	createElement: () => null,
	useState: () => [undefined, () => {}],
	useSyncExternalStore: () => undefined,
};
const require = (spec) => {
	requires.add(spec);
	if (spec === "react") return react;
	throw new Error(`unexpected require("${spec}")`);
};
// 4) the factory's exports carry the browser half's surface.
const exported = registration.factory(require);
for (const spec of requires) {
	assert.equal(spec, "react", `factory may only require the platform seed word "react", got "${spec}"`);
}
assert.equal(typeof exported.apply, "function", "client half must export apply");
assert.ok(Array.isArray(exported.inject), "client half must export an inject array");
assert.deepEqual(
	[...exported.inject].sort(),
	["configForms", "connection", "locale", "sessions", "slots"],
	"client half must inject exactly the services it consumes",
);

// 5) the host half is named-export only.
const host = await import(pathToFileURL(join(root, "lib", "index.js")).href);
assert.equal(Object.hasOwn(host, "default"), false, "host half must not export default");
assert.equal(typeof host.apply, "function", "host half must export apply");
assert.equal(typeof host.Config, "function", "host half must export the callable schemastery Config");
assert.ok(host.Config({}).enabled !== undefined, "the Config schema must resolve");
assert.equal(host.SETTINGS_NAMESPACE, "notify-sounds", "settings namespace must stay notify-sounds");

console.log(
	`build-smoke: OK (id=${registration.id}, requires=[${[...requires].join(",")}], ` +
		`client exports=[${Object.keys(exported).sort().join(",")}])`,
);
