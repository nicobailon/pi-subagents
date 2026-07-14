import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines, widgetRenderKey } from "../../src/tui/render.ts";
import type { AsyncJobState, NestedRunSummary } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function nested(id: string, parentRunId: string, state: NestedRunSummary["state"] = "running", extra: Partial<NestedRunSummary> = {}): NestedRunSummary {
	return {
		id,
		parentRunId,
		parentStepIndex: 0,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 0 }],
		state,
		agent: id,
		lastUpdate: 1_000,
		...extra,
	};
}

function job(child: NestedRunSummary): AsyncJobState {
	return {
		asyncId: "root-run",
		asyncDir: "/tmp/root-run",
		status: "running",
		mode: "single",
		agents: ["owner"],
		startedAt: 0,
		updatedAt: 1_500,
		steps: [{ index: 0, agent: "owner", status: "running", children: [child] }],
		stepsTotal: 1,
		nestedChildren: [child],
	};
}

describe("nested widget rendering", () => {
	it("keeps nested descendants under their owning child in expanded Flow and out of aggregate counts", () => {
		const child = nested("nested-reviewer", "root-run", "running", { currentTool: "read" });
		const collapsed = buildWidgetLines([job(child)], theme as any, 120, false).join("\n");
		assert.doesNotMatch(collapsed, /nested-reviewer/);
		assert.match(collapsed, /1 running/);

		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /Flow/);
		assert.match(expanded, /nested-reviewer · running · read/);
	});

	it("bounds nested Flow summaries to direct owning descendants", () => {
		const root = nested("nested-root", "root-run", "running", { children: [nested("nested-child", "nested-root", "running")] });
		const expanded = buildWidgetLines([job(root)], theme as any, 160, true).join("\n");
		assert.match(expanded, /nested-root · running/);
		assert.doesNotMatch(expanded, /nested-child · running/);
	});

	it("shows running descendants even after the parent step is complete", () => {
		const child = nested("still-running", "root-run", "running");
		const state = job(child);
		state.status = "complete";
		state.steps![0]!.status = "complete";
		const expanded = buildWidgetLines([state], theme as any, 120, true).join("\n");
		assert.match(expanded, /1 completed/);
		assert.match(expanded, /still-running · running/);
	});

	it("degrades stale child summaries to id and state", () => {
		const child = nested("missing-metadata", "root-run", "failed", { agent: undefined, error: "owner gone" });
		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /missing-metadata · failed/);
	});

	it("rerenders when only nested state changes", () => {
		const first = job(nested("nested-reviewer", "root-run", "running"));
		const second = job(nested("nested-reviewer", "root-run", "complete"));
		assert.notEqual(widgetRenderKey(first), widgetRenderKey(second));
	});
});
