// dsh-notify-sounds build: src/ -> lib/
//
// Two products:
//  1. Host half: every src/*.js copied to the matching lib/*.js (plain ESM, no
//     bundling needed -- these are Node modules the Loader imports directly).
//  2. Browser half: src/client/index.js wrapped as the lazy-CJS factory the
//     Harness client module system requires. Executing the file only registers
//     `window.__ModuleLoader__.load({ id, factory })`; every module side effect
//     lives inside the factory closure and runs at materialization. The
//     registration id MUST equal the package name, and the factory may only
//     require platform seed words (here: "react").
//
// It also writes lib/.build-stamp.json: the sha256 of every src/ input plus the
// produced file list. `--verify` recomputes and fails on any mismatch, so a
// stale lib/ can never be installed silently.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const clientDir = join(srcDir, "client");
const libDir = join(root, "lib");
const stampPath = join(libDir, ".build-stamp.json");
const packageName = "dsh-notify-sounds";
const verifyOnly = process.argv.includes("--verify");

/**
 * Browser-half source path. It is plain script text (no import/export) holding
 * the whole browser half; `//#region` markers segment it for navigation.
 */
const CLIENT_SOURCE = "index.js";

/** Every file under `dir`, as slash-separated paths relative to `dir`. */
async function listFiles(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
		else out.push(relative(base, full).replace(/\\/g, "/"));
	}
	return out.sort();
}

/** The host-half inputs: every top-level src/*.js. */
async function hostInputs() {
	return (await listFiles(srcDir)).filter((rel) => !rel.includes("/") && rel.endsWith(".js"));
}

/** Compose the browser bundle from the client source. */
async function composeClientBundle() {
	const text = await readFile(join(clientDir, CLIENT_SOURCE), "utf8");
	if (/^\s*(?:import|export)\s/m.test(text)) {
		throw new Error(`src/client/${CLIENT_SOURCE} must be plain script text; found a top-level import/export`);
	}
	const body = `// ---- src/client/${CLIENT_SOURCE} ----\n${text.trimEnd()}\n`.replace(/^/gm, "\t\t");
	// Guard the invariant the factory contract rests on: the id this bundle
	// registers under must be the package name. The source declares it once
	// (PACKAGE_NAME) so no second literal can drift, and the build asserts both.
	if (!text.includes(`const PACKAGE_NAME = ${JSON.stringify(packageName)};`)) {
		throw new Error(
			`src/client/${CLIENT_SOURCE} must declare const PACKAGE_NAME = ${JSON.stringify(packageName)}; ` +
				"the client registration id and the plugins.bundle.config key both read it",
		);
	}
	return [
		"window.__ModuleLoader__.load({",
		`\tid: ${JSON.stringify(packageName)},`,
		"\tfactory: (require) => {",
		"\t\tvar module = { exports: {} };",
		"\t\tvar exports = module.exports;",
		"\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: \"Module\" });",
		// The browser half requires exactly this one platform seed word, so the
		// wrapper binds it once, like the official clientBundle preset does.
		"\t\tlet react = require(\"react\");",
		body,
		// The browser half's public surface. The source never touches `exports`
		// itself; the build owns the wrapper and these assignments.
		"\t\texports.apply = apply;",
		"\t\texports.inject = inject;",
		"\t\texports.NotifyRuntime = NotifyRuntime;",
		"\t\texports.createSettingsStore = createSettingsStore;",
		"\t\texports.createConfigFormStore = createConfigFormStore;",
		"\t\texports.createLocalSettingsStore = createLocalSettingsStore;",
		"\t\texports.SETTINGS_NAMESPACE = SETTINGS_NAMESPACE;",
		"\t\texports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;",
		"\t\treturn module.exports;",
		"\t}",
		"});",
		"",
	].join("\n");
}

/** The complete set of files this build must produce, keyed by lib-relative path. */
async function computeOutputs() {
	const outputs = new Map();
	for (const rel of await hostInputs()) {
		outputs.set(rel, await readFile(join(srcDir, rel), "utf8"));
	}
	outputs.set("client.js", await composeClientBundle());
	return outputs;
}

/** sha256 of every src/ input, keyed by src-relative path. */
async function fingerprint() {
	const inputs = {};
	for (const rel of await listFiles(srcDir)) {
		const bytes = await readFile(join(srcDir, rel));
		inputs[rel] = createHash("sha256").update(bytes).digest("hex");
	}
	return inputs;
}

const inputs = await fingerprint();

if (verifyOnly) {
	let stamp;
	try {
		stamp = JSON.parse(await readFile(stampPath, "utf8"));
	} catch {
		console.error("build --verify: lib/.build-stamp.json is missing; run: node scripts/build.mjs");
		process.exit(1);
	}
	const expected = await computeOutputs();
	const problems = [];
	for (const [rel, hash] of Object.entries(inputs)) {
		if (stamp.inputs[rel] !== hash) problems.push(`src/${rel} changed since the last build`);
	}
	for (const rel of Object.keys(stamp.inputs)) {
		if (inputs[rel] === undefined) problems.push(`src/${rel} was removed since the last build`);
	}
	for (const [rel, text] of expected) {
		let actual;
		try {
			actual = await readFile(join(libDir, rel), "utf8");
		} catch {
			problems.push(`lib/${rel} is missing`);
			continue;
		}
		if (actual !== text) problems.push(`lib/${rel} is stale; run: node scripts/build.mjs`);
	}
	if (stamp.outputs.join(",") !== [...expected.keys()].sort().join(",")) {
		problems.push("lib/ output list changed; run: node scripts/build.mjs");
	}
	if (problems.length > 0) {
		for (const problem of problems) console.error(`build --verify: ${problem}`);
		process.exit(1);
	}
	console.log(`build --verify: lib/ matches src/ (${Object.keys(inputs).length} inputs)`);
	process.exit(0);
}

await rm(libDir, { recursive: true, force: true });
const outputs = await computeOutputs();
for (const [rel, text] of outputs) {
	const target = join(libDir, rel);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, text, "utf8");
}
const stamp = { packageName, inputs, outputs: [...outputs.keys()].sort() };
await writeFile(stampPath, `${JSON.stringify(stamp, null, "\t")}\n`, "utf8");
console.log(`build: wrote ${outputs.size} files to lib/ from ${Object.keys(inputs).length} src inputs`);

// Self-check: the host entry must import cleanly after the copy.
await import(`${pathToFileURL(join(libDir, "index.js")).href}?build=${Date.now()}`);
