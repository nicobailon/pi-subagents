import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAsyncWidgetPlacement } from "../../src/extension/config.ts";

describe("async widget placement config", () => {
	it("preserves the compatible above-editor default", () => {
		assert.equal(resolveAsyncWidgetPlacement({}), "aboveEditor");
		assert.equal(resolveAsyncWidgetPlacement({ asyncWidgetPlacement: "aboveEditor" }), "aboveEditor");
	});

	it("accepts below-editor placement", () => {
		assert.equal(resolveAsyncWidgetPlacement({ asyncWidgetPlacement: "belowEditor" }), "belowEditor");
	});

	it("warns and falls back for invalid placement", () => {
		const warnings: string[] = [];
		const placement = resolveAsyncWidgetPlacement(
			{ asyncWidgetPlacement: "sidebar" } as never,
			(message) => warnings.push(message),
		);
		assert.equal(placement, "aboveEditor");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /Ignoring invalid asyncWidgetPlacement/);
	});
});
