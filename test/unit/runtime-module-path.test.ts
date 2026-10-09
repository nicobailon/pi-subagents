import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveRuntimeModuleExtension, resolveRuntimeModulePath } from "../../src/shared/runtime-module-path.ts";

test("resolveRuntimeModuleExtension follows the siblings on disk and prefers compiled .js", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-subagents-runtime-module-"));
	try {
		assert.equal(resolveRuntimeModulePath(dir, "sibling"), path.join(dir, "sibling.js"));
		// A source checkout ships only .ts siblings.
		writeFileSync(path.join(dir, "sibling.ts"), "");
		assert.equal(resolveRuntimeModuleExtension(dir, "sibling"), ".ts");
		// A stale .ts left behind by an in-place update must not shadow the compiled .js.
		writeFileSync(path.join(dir, "sibling.js"), "");
		assert.equal(resolveRuntimeModuleExtension(dir, "sibling"), ".js");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
