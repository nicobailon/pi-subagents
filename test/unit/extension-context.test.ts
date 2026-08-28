import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withCachedUiContext } from "../../src/shared/extension-context.ts";

describe("cached extension UI context", () => {
	it("clears a context replaced by session reload and returns no UI result", () => {
		let cleared = false;
		const result = withCachedUiContext({
			get hasUI() {
				throw new Error("This extension ctx is stale after session replacement or reload.");
			},
		} as never, () => {
			cleared = true;
		}, () => "unreachable");

		assert.equal(result, undefined);
		assert.equal(cleared, true);
	});

	it("does not hide non-stale context errors", () => {
		assert.throws(() => withCachedUiContext({
			get hasUI() {
				throw new Error("UI bridge unavailable");
			},
		} as never, () => {}, () => "unreachable"), /UI bridge unavailable/);
	});
});
