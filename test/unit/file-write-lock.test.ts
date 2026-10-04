import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

for (const writeFails of [true, false]) it(`preserves release failure signals when the protected write ${writeFails ? "fails" : "succeeds"}`, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-write-lock-errors-"));
	const source = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(new URL("../../src/shared/file-write-lock.ts", import.meta.url).href)});
const releaseError = Object.assign(new Error("injected release error"), { code: "EACCES" });
require("proper-lockfile").lockSync = () => () => { throw releaseError; };
const { withFileWriteLock } = await import(${JSON.stringify(new URL("../../src/shared/file-write-lock.ts", import.meta.url).href)});
const primary = Object.assign(new Error("injected write error", { cause: new Error("original cause") }), { code: "EIO" });
const warnings = []; console.warn = message => warnings.push(message);
assert.throws(() => withFileWriteLock(${JSON.stringify(path.join(root, "data.json"))}, () => {
	if (${writeFails}) throw primary;
	return "saved";
}), error => error === (${writeFails} ? primary : releaseError));
assert.equal(warnings.length, ${writeFails} ? 1 : 0);
if (${writeFails}) { assert.match(warnings[0], /injected release error/); assert.equal(primary.code, "EIO"); assert.equal(primary.cause.message, "original cause"); }
`;
	try {
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], { encoding: "utf-8", timeout: 10_000 });
		assert.equal(child.status, 0, child.stderr);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
