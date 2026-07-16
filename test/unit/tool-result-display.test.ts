import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCompactToolResultDisplay, buildCompactWaitResultDisplay, renderCompactAwareToolCall, renderCompactResultOnToolCall, resolveToolResultDisplay } from "../../src/tui/tool-result-display.ts";

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

	it("summarizes fleet, transcript, and ordinary status results", () => {
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "status", view: "fleet" }, content: "No active subagent fleet." }),
			"0 active · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({
				...base,
				args: { action: "status", view: "fleet" },
				content: "Subagent fleet: 3 tracked\n\nAsync runs:\n- run-a | running | parallel\n- run-b | queued | chain\n- run-c | running | single",
			}),
			"3 tracked · 2 running · 1 queued · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({
				...base,
				args: { action: "status", view: "transcript", id: "12345678-abcd", index: 2 },
				content: "Run: 12345678-abcd\nState: running\nTranscript tail:",
			}),
			"transcript · running · run 12345678 · child 3 · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "status", runId: "abcdef012345" }, content: "Run: abcdef012345\nState: complete\nProgress: step 1/1" }),
			"complete · step 1/1 · run abcdef01 · Ctrl+E expand",
		);
	});

	it("summarizes list counts and management outcomes", () => {
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "list" }, content: "Executable agents:\n- delegate\n- worker\n\nChains:\n- (none)\n\nProactive skill subagent suggestions:\n- design review" }),
			"2 agents · 0 chains · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "get", agent: "reviewer" } }),
			"done · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule-status", id: "schedule-123456" } }),
			"done · job schedule · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "status", dir: "C:\\tmp\\async-runs\\run-directory" }, content: "State: running" }),
			"running · dir run-directory · Ctrl+E expand",
		);
	});

	it("summarizes scheduled parallel and chain launches", () => {
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule", tasks: [{}, {}] } }),
			"scheduled · parallel 2 · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: { action: "schedule", chain: [{}, {}, {}] } }),
			"scheduled · chain 3 · Ctrl+E expand",
		);
	});

	it("distinguishes detached async single, parallel, and chain launch acknowledgements", () => {
		assert.equal(
			buildCompactToolResultDisplay({
				...base,
				args: { agent: "worker" },
				details: { mode: "single", asyncId: "12345678-abcd" },
			}),
			"started · run 12345678 · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: {}, details: { mode: "parallel", asyncId: "parallel-id" } }),
			"started · run parallel · Ctrl+E expand",
		);
		assert.equal(
			buildCompactToolResultDisplay({ ...base, args: {}, details: { mode: "chain", asyncId: "chain-id" } }),
			"started · run chain-id · Ctrl+E expand",
		);
	});

	it("renders compact summaries on the tool-call line", () => {
		const state: Record<string, unknown> = {};
		const call = renderCompactAwareToolCall("subagent list", { state });
		const result = renderCompactResultOnToolCall("· 8 agents · 0 chains · Ctrl+E expand", state);
		assert.deepEqual(call.render(120).map((line) => line.trimEnd()), ["subagent list · 8 agents · 0 chains · Ctrl+E expand"]);
		assert.deepEqual(result.render(120), []);
	});

	it("summarizes successful waits without exposing orchestration guidance", () => {
		assert.equal(
			buildCompactWaitResultDisplay({
				...base,
				args: { id: "9599e8ca-f11e" },
				content: "Waited 28.0s for run; done. Outcome: 1 complete. Completion/control events have been observed.",
			}),
			"done · 28.0s · run 9599e8ca · Ctrl+E expand",
		);
		assert.equal(
			buildCompactWaitResultDisplay({ ...base, args: { all: true }, content: "Waited 2m; attention required." }),
			"attention · 2m · all work · Ctrl+E expand",
		);
		assert.equal(buildCompactWaitResultDisplay({ ...base, args: {}, content: "Wait timed out", isError: true }), undefined);
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
