/**
 * Host-half smoke test: imports lib/index.js for real (through workspace shims
 * that re-export the installed @deepseek-ai packages), drives `apply(ctx)`
 * against a fake settings provider, and asserts the section registration.
 *
 * Run: node test/host-smoke.mjs  (from the dsh-notify-sounds directory)
 */
import { apply, SETTINGS_NAMESPACE, SETTINGS_SCHEMA } from "../lib/index.js";

let failures = 0;
function assert(condition, message) {
	if (condition) {
		console.log(`  ok - ${message}`);
	} else {
		failures += 1;
		console.error(`  FAIL - ${message}`);
	}
}

// ---- fake settings provider ----
const registrations = [];
const watchCallbacks = new Set();
const fakeSettings = {
	register(ns, schema, options) {
		registrations.push({ ns, schema, options });
		return {
			get: () => ({ ...options.base }),
			watch: (cb) => {
				watchCallbacks.add(cb);
				return () => watchCallbacks.delete(cb);
			}
		};
	}
};
const fakeCtx = {
	inject(keys, fn) {
		if (!Array.isArray(keys) || !keys.includes("settings")) throw new Error("expected settings injection");
		const sctx = {
			settings: fakeSettings,
			effect: (fn) => { const out = fn(); return out ?? (() => {}); }
		};
		return { dispose: fn(sctx) ?? (() => {}) };
	}
};

// ---- drive apply ----
apply(fakeCtx);

assert(registrations.length === 1, "exactly one settings section registered");
const reg = registrations[0];
assert(reg.ns === "notify-sounds", `namespace is "notify-sounds" (got "${reg.ns}")`);
assert(reg.options.base.enabled === true && reg.options.base.volume === 0.5, "composition defaults are the section base");
assert(typeof reg.options.validate === "undefined" || typeof reg.options.validate === "function", "validate hook shape ok");

// schema validates a good value and rejects bad ones (schemas are callable)
const good = SETTINGS_SCHEMA({ enabled: true, question: false, complete: true, onlyWhenHidden: true, volume: 0.35 });
assert(good.volume === 0.35 && good.question === false, "schema accepts a valid value");
let rejected = false;
try {
	SETTINGS_SCHEMA({ volume: 1.5 });
} catch {
	rejected = true;
}
assert(rejected, "schema rejects out-of-range volume");
let rejectedType = false;
try {
	SETTINGS_SCHEMA({ enabled: "yes" });
} catch {
	rejectedType = true;
}
assert(rejectedType, "schema rejects wrong-typed field");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
