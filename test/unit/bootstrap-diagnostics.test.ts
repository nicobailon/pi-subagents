import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	classifyExtensionBootstrapDiagnostic,
	EXTENSION_BOOTSTRAP_SUSPECTED,
} from "../../src/runs/shared/bootstrap-diagnostics.ts";
import { isRetryableModelFailure } from "../../src/runs/shared/model-fallback.ts";

const ACTUAL_PI_EXTENSION_DIAGNOSTIC =
	'Error: Failed to load extension "/tmp/.pi/extensions/broken-extension.ts": Failed to load extension: Cannot find package \'missing-dependency\'';

describe("extension bootstrap diagnostics", () => {
	it("classifies the diagnostic shape emitted by @earendil-works/pi-coding-agent as non-retryable", () => {
		const stderr = [
			"Pi startup diagnostics",
			`  ${ACTUAL_PI_EXTENSION_DIAGNOSTIC}`,
			"startup aborted",
		].join("\n");
		const diagnostic = classifyExtensionBootstrapDiagnostic(stderr);
		assert.equal(diagnostic?.classification, EXTENSION_BOOTSTRAP_SUSPECTED);
		assert.equal(diagnostic?.retryable, false);
		assert.equal(diagnostic?.evidence, stderr);
		assert.equal(diagnostic?.diagnosticLine, ACTUAL_PI_EXTENSION_DIAGNOSTIC.slice("Error: ".length));
		assert.equal(isRetryableModelFailure(diagnostic?.summary), false);
	});

	it("classifies quoted Windows and POSIX extension targets with optional leading Error and whitespace", () => {
		for (const stderr of [
			'\tError: Failed to load extension "C:\\work tree\\.pi\\extensions\\broken.ts": syntax error',
			' Failed to load extension \'/home/me/work tree/.pi/extensions/broken.ts\': syntax error',
			"Failed to load extension /tmp/.pi/extensions/broken.ts: syntax error",
			"Error: Failed to load extension C:\\repo\\.pi\\extensions\\broken.ts: syntax error",
		]) {
			assert.equal(classifyExtensionBootstrapDiagnostic(stderr)?.classification, EXTENSION_BOOTSTRAP_SUSPECTED, stderr);
		}
	});

	it("does not classify generic loader near-misses without a definitive extension target", () => {
		for (const stderr of [
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-dependency'",
			"SyntaxError: The requested module './extension.ts' does not provide an export",
			"Error loading extension /tmp/broken-extension.ts",
			"bash failed (exit 1): Failed to import tool module",
			"read failed (exit 1): Failed to load extension metadata",
			"Failed to load extension metadata: corrupt cache",
			"Error: Failed to load extension metadata: corrupt cache",
			"Error: Failed to load extension: missing target",
			'Error: Failed to load extension "": missing target',
			'Error: Failed to load extension metadata for "/tmp/broken.ts": corrupt cache',
			'Wrapper: Failed to load extension "/tmp/broken.ts": syntax error',
		]) {
			assert.equal(classifyExtensionBootstrapDiagnostic(stderr), undefined, stderr);
		}
	});
});
