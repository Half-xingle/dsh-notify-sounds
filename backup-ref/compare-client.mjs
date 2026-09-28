// One-shot verification helper (backup-ref/, not shipped): proves the
// reconstructed lib/client.js is semantically identical to the pre-refactor
// bundle, i.e. the migration only moved code and changed indentation.
//
// Run: node backup-ref/compare-client.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const read = async (rel) => (await readFile(join(root, rel), "utf8")).split(/\r?\n/);
const orig = await read("backup-ref/client.orig.js");
const built = await read("lib/client.js");

// The source of truth for the body is the original factory body: everything
// between the `let react` preamble line and the exports assignments. The rebuilt
// body additionally carries the module navigation header, so it starts at the
// first real section marker.
const find = (lines, pattern, from = 1) => {
	const re = new RegExp(pattern);
	const i = lines.findIndex((line, index) => index + 1 >= from && re.test(line));
	if (i < 0) throw new Error(`anchor not found: ${pattern}`);
	return i + 1;
};

const origBodyStart = find(orig, "^\\s*//#region settings contract");
const origBodyEnd = find(orig, "^\\s*exports\\.apply = apply;", origBodyStart) - 2;
const builtBodyStart = find(built, "^\\s*//#region settings contract");
const builtBodyEnd = find(built, "^\\s*exports\\.apply = apply;", builtBodyStart) - 2;

const norm = (lines) => lines.map((line) => line.replace(/\s+$/, "")).map((line) => line.replace(/^\t+/, ""));
const a = norm(orig.slice(origBodyStart, origBodyEnd));
const b = norm(built.slice(builtBodyStart, builtBodyEnd));

let mismatches = 0;
const report = [];
const max = Math.max(a.length, b.length);
for (let i = 0; i < max; i += 1) {
	if (a[i] !== b[i]) {
		mismatches += 1;
		if (report.length < 15) report.push({ line: i + 1, orig: a[i], built: b[i] });
	}
}

// The exports surface must match exactly, too.
const origExports = orig
	.filter((line) => /^\s*exports\.\w+ =/.test(line))
	.map((line) => line.trim().replace(/\s+/g, " "));
const builtExports = built
	.filter((line) => /^\s*exports\.\w+ =/.test(line))
	.map((line) => line.trim().replace(/\s+/g, " "));
const exportsMatch = origExports.length === builtExports.length && origExports.every((line, i) => line === builtExports[i]);

console.log(`body lines: orig=${a.length} built=${b.length}`);
console.log(`body line mismatches (ignoring leading indentation): ${mismatches}`);
for (const row of report) {
	console.log(`  L${row.line}\n    orig : ${JSON.stringify(row.orig)}\n    built: ${JSON.stringify(row.built)}`);
}
console.log(`exports surface: ${exportsMatch ? "identical" : "DIFFERENT"}`);
if (!exportsMatch) {
	console.log("  orig :", origExports.join(", "));
	console.log("  built:", builtExports.join(", "));
}

if (mismatches === 0 && exportsMatch) {
	console.log("compare-client: OK — the migration only moved code and changed indentation");
} else {
	process.exitCode = 1;
}
