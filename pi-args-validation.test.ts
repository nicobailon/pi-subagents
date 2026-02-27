import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePiArgs } from "./pi-args-validation.ts";

describe("validatePiArgs", () => {
	it("allows empty piArgs", () => {
		assert.doesNotThrow(() => validatePiArgs([]));
	});

	it("allows non-reserved args", () => {
		assert.doesNotThrow(() =>
			validatePiArgs(["--sandbox-profile", "intro-sec", "--model", "anthropic/claude-sonnet-4-5"]),
		);
	});

	it("does not block args that only contain reserved tokens as substrings", () => {
		assert.doesNotThrow(() => validatePiArgs(["--mode-lite", "--session-name", "-print"]));
	});

	it("rejects exact reserved args", () => {
		assert.throws(
			() => validatePiArgs(["--mode"]),
			/piArgs conflict: "--mode" is reserved/,
		);
		assert.throws(
			() => validatePiArgs(["-p"]),
			/piArgs conflict: "-p" is reserved/,
		);
		assert.throws(
			() => validatePiArgs(["--print"]),
			/piArgs conflict: "--print" is reserved/,
		);
		assert.throws(
			() => validatePiArgs(["--no-session"]),
			/piArgs conflict: "--no-session" is reserved/,
		);
		assert.throws(
			() => validatePiArgs(["--session"]),
			/piArgs conflict: "--session" is reserved/,
		);
	});

	it("rejects reserved args passed with equals syntax", () => {
		assert.throws(
			() => validatePiArgs(["--mode=json"]),
			/piArgs conflict: "--mode=json" is reserved/,
		);
		assert.throws(
			() => validatePiArgs(["--session=abc"]),
			/piArgs conflict: "--session=abc" is reserved/,
		);
	});

	it("includes reserved args list in the error message", () => {
		try {
			validatePiArgs(["--mode"]);
			assert.fail("expected validatePiArgs to throw");
		} catch (error) {
			const message = (error as Error).message;
			assert.match(message, /Reserved args:/);
			assert.match(message, /--mode/);
			assert.match(message, /-p/);
			assert.match(message, /--print/);
			assert.match(message, /--no-session/);
			assert.match(message, /--session/);
		}
	});
});
