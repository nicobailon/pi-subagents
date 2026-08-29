import assert from "node:assert/strict";
import test from "node:test";
import { backgroundProcessOptions } from "../../src/runs/shared/background-process-options.ts";

test("Windows background runners stay hidden without requesting a new console", () => {
	assert.deepEqual(backgroundProcessOptions("win32"), {
		detached: false,
		windowsHide: true,
	});
});

test("background runners remain detached on Unix", () => {
	assert.deepEqual(backgroundProcessOptions("linux"), {
		detached: true,
		windowsHide: true,
	});
});
