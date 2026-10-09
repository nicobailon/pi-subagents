import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveRuntimeModuleExtension, resolveRuntimeModulePath, runtimeModuleExtensions } from "../../src/shared/runtime-module-path.ts";

test("resolveRuntimeModuleExtension prefers a compiled .js sibling over the caller's own extension", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-subagents-runtime-module-"));
	try {
		// A source checkout ships only .ts siblings.
		writeFileSync(path.join(dir, "sibling.ts"), "");
		assert.equal(resolveRuntimeModuleExtension(dir, "sibling"), ".ts");

		// The published package ships compiled .js; it wins when both are present
		// (an in-place update that leaves a stale .ts shim behind must not be used).
		writeFileSync(path.join(dir, "sibling.js"), "");
		assert.equal(resolveRuntimeModuleExtension(dir, "sibling"), ".js");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveRuntimeModulePath falls back to .js when no sibling exists", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-subagents-runtime-module-"));
	try {
		assert.equal(resolveRuntimeModulePath(dir, "missing"), path.join(dir, "missing.js"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runtimeModuleExtensions covers both source and published layouts", () => {
	assert.deepEqual([...runtimeModuleExtensions()], [".js", ".ts"]);
});
