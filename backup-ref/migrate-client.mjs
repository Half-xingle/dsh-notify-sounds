// One-shot migration helper (not part of the build or the published package).
//
// Produces src/client/index.js from backup-ref/client.orig.js (recovered from
// git): the original single-file browser bundle minus its `__ModuleLoader__.load`
// wrapper and minus one level of factory indentation. The result is plain script
// text -- no import/export -- which scripts/build.mjs wraps back into the
// lazy-CJS factory. Its `//#region` markers stay as section navigation.
//
// Run: node backup-ref/migrate-client.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const lines = (await readFile(join(here, "client.orig.js"), "utf8")).split(/\r?\n/);

/** 1-based line number of the first line matching `pattern` at or after `from`. */
function find(pattern, from = 1) {
	const re = new RegExp(pattern);
	const index = lines.findIndex((line, i) => i + 1 >= from && re.test(line));
	if (index < 0) throw new Error(`migrate-client: anchor not found: ${pattern}`);
	return index + 1;
}

// The factory body opens after `factory: (require) => {` and its prototype
// preamble, and closes before the `exports.*` assignments (the build owns those).
// The body starts at the `let react = require(...)` line: the wrapper binds
// `require`/`module`/`exports` and re-declares `react` itself.
const factoryOpen = find("^\\s*factory: \\(require\\) => \\{");
const bodyStart = find("let react = require\\(\"react\"\\);", factoryOpen);
const assignmentsStart = find("^\\s*exports\\.apply = apply;", bodyStart);
// Drop the blank line that separates the body from the exports assignments.
const bodyEnd = assignmentsStart - 2;

const body = lines
	.slice(bodyStart, bodyEnd)
	.map((line) => (line.startsWith("\t") ? line.slice(1) : line));

while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
for (const line of body) {
	if (/^\s*(?:import|export)\s/.test(line)) {
		throw new Error(`migrate-client: top-level import/export is not allowed in the source: ${line.trim()}`);
	}
}

const header = [
	"/**",
	" * dsh-notify-sounds 閳?browser half (plain script text, not an ES module).",
	" *",
	" * scripts/build.mjs wraps this file in the client module system's lazy-CJS",
	" * factory (`window.__ModuleLoader__.load({ id, factory })`, id === package",
	" * name), adds one level of indentation, and owns the `require`, `module`,",
	" * and `exports` bindings. Therefore this file must NOT contain a top-level",
	" * `import` or `export`, must not redeclare `require`/`module`/`exports`, and",
	" * must not touch `exports` 閳?the build appends the public surface itself.",
	" * `//#region` markers are section navigation only.",
	" */",
	"",
];

const text = `${[...header, ...body].join("\n")}\n`;
await writeFile(join(root, "src", "client", "index.js"), text, "utf8");
console.log(`migrate-client: wrote src/client/index.js (${text.split("\n").length} lines)`);
