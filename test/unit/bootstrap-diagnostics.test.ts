import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyExtensionBootstrapDiagnostic,
	EXTENSION_BOOTSTRAP_SUSPECTED,
} from "../../src/runs/shared/bootstrap-diagnostics.ts";
import { isRetryableModelFailure } from "../../src/runs/shared/model-fallback.ts";

describe("extension bootstrap diagnostics", () => {
	it("classifies explicit Pi extension loader failures as non-retryable", () => {
		const stderr = [
			"Pi startup diagnostics",
			"Failed to load extension /tmp/broken-extension.ts: Cannot find package 'missing-dependency'",
			"startup aborted",
		].join("\n");
		const diagnostic = classifyExtensionBootstrapDiagnostic(stderr);
		assert.equal(diagnostic?.classification, EXTENSION_BOOTSTRAP_SUSPECTED);
		assert.equal(diagnostic?.retryable, false);
		assert.equal(diagnostic?.evidence, stderr);
		assert.match(diagnostic?.diagnosticLine ?? "", /broken-extension/);
		assert.equal(isRetryableModelFailure(diagnostic?.summary), false);
	});

	it("does not classify generic module, import, extension, or tool failures", () => {
		for (const stderr of [
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-dependency'",
			"SyntaxError: The requested module './extension.ts' does not provide an export",
			"Error loading extension /tmp/broken-extension.ts",
			"bash failed (exit 1): Failed to import tool module",
			"read failed (exit 1): Failed to load extension metadata",
		]) {
			assert.equal(classifyExtensionBootstrapDiagnostic(stderr), undefined, stderr);
		}
	});
});
