import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_MIN_FOREGROUND_TIMEOUT_MS,
	normalizeForegroundTimeoutMs,
	resolveMinForegroundTimeoutMs,
} from "../../src/shared/types.ts";
import { SubagentParams } from "../../src/extension/schemas.ts";

test("foreground timeout config defaults to five minutes", () => {
	assert.equal(resolveMinForegroundTimeoutMs({}), DEFAULT_MIN_FOREGROUND_TIMEOUT_MS);
	assert.equal(resolveMinForegroundTimeoutMs({ minForegroundTimeoutMs: 0 }), DEFAULT_MIN_FOREGROUND_TIMEOUT_MS);
	assert.equal(resolveMinForegroundTimeoutMs({ minForegroundTimeoutMs: 120_000.5 }), DEFAULT_MIN_FOREGROUND_TIMEOUT_MS);
});

test("foreground timeout config accepts positive integer overrides", () => {
	assert.equal(resolveMinForegroundTimeoutMs({ minForegroundTimeoutMs: 600_000 }), 600_000);
});

test("foreground timeout values are raised to the configured floor", () => {
	assert.equal(normalizeForegroundTimeoutMs(undefined, 300_000), undefined);
	assert.equal(normalizeForegroundTimeoutMs(180_000, 300_000), 300_000);
	assert.equal(normalizeForegroundTimeoutMs(600_000, 300_000), 600_000);
});

test("public timeout schema leaves the runtime floor configurable", () => {
	assert.equal(SubagentParams.properties.timeoutMs.minimum, 1);
	assert.equal(SubagentParams.properties.maxRuntimeMs.minimum, 1);
});
