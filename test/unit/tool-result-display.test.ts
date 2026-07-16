import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompactToolResultDisplay, resolveToolResultDisplay } from "../../src/tui/tool-result-display.ts";

describe("tool result display config", () => {
	it("defaults to the compatible full display", () => {
		assert.equal(resolveToolResultDisplay({}), "full");
		assert.equal(resolveToolResultDisplay({ toolResultDisplay: "full" }), "full");
		assert.equal(resolveToolResultDisplay({ toolResultDisplay: "compact" }), "compact");
	});

	it("warns and falls back to full for invalid values", () => {
		const warnings: string[] = [];
		const display = resolveToolResultDisplay(
			{ toolResultDisplay: "quiet" } as never,
			{ warn: (message) => warnings.push(message) },
		);

		assert.equal(display, "full");
		assert.ok(warnings.some((message) => message.includes("Ignoring invalid toolResultDisplay")));
	});
});

describe("compact tool result presentation", () => {
	const base = {
		toolResultDisplay: "compact" as const,
		expanded: false,
		isError: false,
		expandKey: "Ctrl+E",
	};

	it("distinguishes fleet, transcript, and ordinary status calls", () => {
		assert.equal(buildCompactToolResultDisplay({ ...base, args: { action: "status", view: "fleet" } }), "Subagent fleet · Ctrl+E expand");
		assert.equal(
			buildCompactToolResultDisplay({
				...base,
				args: { action: "status", view: "transcript", id: "12345678-abcd", index: 2 },
			}),
			"Subagent transcript · run 12345678 · child 3 · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "status", runId: "abcdef012345" } }),
			"Subagent status · run abcdef01 · Ctrl+E expand",
		);
	});

	it("summarizes management actions and their argument targets", () => {
		assert.equal(buildCompactToolResultDisplay({ ...base, args: { action: "list" } }), "Subagent list · Ctrl+E expand");
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "get", agent: "reviewer" } }),
			"Subagent get · agent reviewer · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule-status", id: "schedule-123456" } }),
			"Subagent schedule status · job schedule · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "status", dir: "C:\\tmp\\async-runs\\run-directory" } }),
			"Subagent status · dir run-directory · Ctrl+E expand",
		);
	});

	it("summarizes scheduled parallel and chain launches", () => {
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule", tasks: [{}, {}] } }),
			"Subagent schedule · parallel (2) · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule", chain: [{}, {}, {}] } }),
			"Subagent schedule · chain (3) · Ctrl+E expand",
		);
	});

	it("distinguishes detached async single, parallel, and chain launch acknowledgements", () => {
		assert.equal(
			buildCompactToolResultDisplay({
				...base,
				args: { agent: "worker" },
				details: { mode: "single", asyncId: "12345678-abcd" },
			}),
			"Async subagent · run 12345678 · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: {}, details: { mode: "parallel", asyncId: "parallel-id" } }),
			"Async subagent parallel · run parallel · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: {}, details: { mode: "chain", asyncId: "chain-id" } }),
			"Async subagent chain · run chain-id · Ctrl+E expand",
		);
	});

	it("uses the full renderer for expanded rows, errors, full mode, unknown actions, and foreground execution", () => {
		const statusArgs = { action: "status", id: "12345678" };
		assert.equal(buildCompactToolResultDisplay({ ...base, args: statusArgs, expanded: true }), undefined);
		assert.equal(buildCompactToolResultDisplay({ ...base, args: statusArgs, isError: true }), undefined);
		assert.equal(buildCompactToolResultDisplay({ ...base, args: statusArgs, toolResultDisplay: "full" }), undefined);
		assert.equal(buildCompactToolResultDisplay({ ...base, args: { action: "unknown" } }), undefined);
		assert.equal(buildCompactToolResultDisplay({ ...base, args: { agent: "worker" }, details: { mode: "single" } }), undefined);
		assert.equal(buildCompactToolResultDisplay({ ...base, args: {}, details: { mode: "parallel" } }), undefined);
	});
});
