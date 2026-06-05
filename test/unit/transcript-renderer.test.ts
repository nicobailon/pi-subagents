import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTranscriptComponents } from "../../src/watch/transcript-renderer.ts";

function textOf(component: unknown): string {
	if (!component || typeof component !== "object") return "";
	const rendered = (component as { render?: (width: number) => string[] }).render?.(80);
	return rendered?.join("\n") ?? "";
}

describe("renderTranscriptComponents", () => {
	it("renders user and assistant entries with Pi components", () => {
		const components = renderTranscriptComponents([
			{ type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
			{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
		], { warnings: [] });
		const text = components.map(textOf).join("\n");
		assert.match(text, /hello/);
		assert.match(text, /hi/);
	});

	it("renders warnings as fallback text", () => {
		const components = renderTranscriptComponents([], { warnings: ["bad line"] });
		assert.match(components.map(textOf).join("\n"), /bad line/);
	});
});
