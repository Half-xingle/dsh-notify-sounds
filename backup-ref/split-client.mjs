// One-shot migration helper (not part of the build or the published package).
//
// Splits the pre-refactor single-file browser bundle into src/client/*.js.
// It reads backup-ref/client.orig.js (recovered from git), slices it by ANCHOR
// REGEX rather than by line number, and drops one level of factory indentation.
//
// Run: node backup-ref/split-client.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const lines = (await readFile(join(here, "client.orig.js"), "utf8")).split(/\r?\n/);

/**
 * 1-based line number of the first line matching `pattern` at or after `from`.
 * @param pattern - regular expression source matched against each line.
 * @param from - first 1-based line to consider.
 * @returns the matched line number.
 */
function find(pattern, from = 1) {
	const re = new RegExp(pattern);
	const index = lines.findIndex((line, i) => i + 1 >= from && re.test(line));
	if (index < 0) throw new Error(`split-client: anchor not found: ${pattern}`);
	return index + 1;
}

const regionStart = (name) => find(`//#region ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const regionEnd = (name) => find("//#endregion", regionStart(name));
/** First line of the JSDoc block immediately above the first match. */
function docStart(pattern, from = 1) {
	let at = find(pattern, from);
	while (at > 1 && !/^\s*\/\*\*/.test(lines[at - 2])) at -= 1;
	return at;
}

/** Slice [from, to] (1-based, inclusive) and drop one leading factory tab. */
function slice(from, to) {
	return lines.slice(from - 1, to).map((line) => (line.startsWith("\t") ? line.slice(1) : line));
}

/** Drop trailing blank lines. */
function trimEnd(list) {
	const out = [...list];
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	return out;
}

async function write(rel, body) {
	const text = trimEnd(body).join("\n");
	await writeFile(join(root, rel), `${text}\n`, "utf8");
	console.log(`split-client: wrote ${rel} (${text.split("\n").length} lines)`);
}

// The store factories are the first JSDoc block inside the settings-contract
// region; everything above it is constants.
const storesFrom = docStart("function createConfigFormStore", regionStart("settings contract"));
const contractEnd = find("^\\s*$", storesFrom) - 1; // blank line before the JSDoc block

// contract.js — constants plus the Web Notification helpers.
await write("src/client/contract.js", [
	...slice(regionStart("settings contract"), storesFrom - 2),
	"",
	...slice(regionStart("desktop notifications"), regionEnd("desktop notifications")),
]);

// settings.js — the configForms adapter and the browser-local fallback store.
await write("src/client/settings.js", slice(storesFrom - 1, regionEnd("settings contract") - 1));

// audio.js — the note sequences and the audio engine.
await write("src/client/audio.js", [
	...slice(find("Note sequences:"), regionStart("notify runtime") - 2),
	"",
	...slice(regionStart("audio engine"), regionEnd("audio engine")),
]);

// runtime.js — the session-edge watcher.
await write("src/client/runtime.js", slice(regionStart("notify runtime"), regionEnd("notify runtime") - 1));

// card.js — the settings card component and its token-based styles.
await write("src/client/card.js", slice(regionStart("settings card"), regionEnd("settings card") - 1));

// locale.js — the zh/en dictionaries.
await write("src/client/locale.js", slice(regionStart("locale"), regionEnd("locale") - 1));

// entry.js — inject + apply.
await write("src/client/entry.js", slice(regionStart("plugin entry"), regionEnd("plugin entry") - 1));
