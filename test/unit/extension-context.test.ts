import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canRenderComponents, withCachedUiContext } from "../../src/shared/extension-context.ts";

describe("component UI support", () => {
	it("renders in the TUI, and over RPC only when the host sets PI_SUBAGENTS_COMPONENT_UI=1", () => {
		const previous = process.env.PI_SUBAGENTS_COMPONENT_UI;
		const custom = (_factory: unknown, _options?: unknown) => Promise.resolve(undefined);
		try {
			delete process.env.PI_SUBAGENTS_COMPONENT_UI;
			assert.equal(canRenderComponents({ mode: "tui", ui: { custom } } as never), true);
			assert.equal(canRenderComponents({ mode: "rpc", ui: { custom } } as never), false);
			process.env.PI_SUBAGENTS_COMPONENT_UI = "1";
			assert.equal(canRenderComponents({ mode: "rpc", ui: { custom } } as never), true);
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_COMPONENT_UI;
			else process.env.PI_SUBAGENTS_COMPONENT_UI = previous;
		}
	});
});

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
