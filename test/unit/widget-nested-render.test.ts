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
	it("uses aggregate lines when collapsed and full child rows when expanded", () => {
		const child = nested("nested-reviewer", "root-run", "running", { currentTool: "read" });
		const collapsed = buildWidgetLines([job(child)], theme as any, 120, false).join("\n");
		assert.match(collapsed, /↳ \[\d{2}:\d{2}:\d{2}\] \+1 nested run \(1 running\)/);
		assert.doesNotMatch(collapsed, /nested-reviewer · running/);

		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /↳ \[\d{2}:\d{2}:\d{2}\] . nested-reviewer · running · read/);

		const epoch = buildWidgetLines([job(nested("epoch", "root-run", "running", { lastUpdate: 0, startedAt: 0 }))], theme as any, 120, false).join("\n");
		assert.match(epoch, /↳ \[\d{2}:\d{2}:\d{2}\] \+1 nested run/);
	});

	it("collapses descendants beyond the nested depth budget", () => {
		const root = nested("nested-root", "root-run", "running", {
			children: [nested("nested-child", "nested-root", "running", {
				parentStepIndex: undefined,
				children: [nested("nested-grandchild", "nested-child", "running", {
					parentStepIndex: undefined,
					children: [nested("nested-great-grandchild", "nested-grandchild")],
				})],
			})],
		});
		const expanded = buildWidgetLines([job(root)], theme as any, 160, true).join("\n");
		assert.match(expanded, /nested-grandchild/);
		assert.match(expanded, /\+1 nested run \(1 running\)/);
		assert.doesNotMatch(expanded, /nested-great-grandchild · running/);
	});

	it("shows running descendants even after the parent step is complete", () => {
		const child = nested("still-running", "root-run", "running");
		const state = job(child);
		state.status = "complete";
		state.steps![0]!.status = "complete";
		const expanded = buildWidgetLines([state], theme as any, 120, true).join("\n");
		assert.match(expanded, /✓ Step 1\/1: owner · complete/);
		assert.match(expanded, /↳ \[\d{2}:\d{2}:\d{2}\] . still-running · running/);
	});

	it("degrades stale child summaries to id and state", () => {
		const child = nested("missing-metadata", "root-run", "failed", { agent: undefined, error: "owner gone" });
		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /\[\d{2}:\d{2}:\d{2}\] . missing-metadata · failed · Failed · owner gone/);
	});

	it("timestamps every nested lifecycle state and completed steps", () => {
		const states: NestedRunSummary["state"][] = ["queued", "running", "complete", "failed", "paused", "stopped"];
		const root = nested("matrix-root", "root-run", "running", {
			steps: [{ agent: "completed-step", status: "completed", endedAt: 2_000 }],
			children: states.map((state, index) => nested(`child-${state}`, "matrix-root", state, {
				parentStepIndex: undefined,
				startedAt: 1_000 + index,
				...(state === "running" ? { lastActivityAt: 2_000 + index } : { endedAt: 2_000 + index }),
			})),
		});
		const expanded = buildWidgetLines([job(root)], theme as any, 200, true).join("\n");
		for (const state of states) {
			assert.match(expanded, new RegExp(`\\[\\d{2}:\\d{2}:\\d{2}\\] . child-${state} · ${state}`));
		}
		assert.match(expanded, /\[\d{2}:\d{2}:\d{2}\] . completed-step · completed/);
	});

	it("keeps event-time timestamps stable instead of advancing with wall time", async () => {
		const state = job(nested("nested-reviewer", "root-run", "running", { currentTool: "read", currentToolStartedAt: 0 }));
		const first = buildWidgetLines([state], theme as any, 120, true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = buildWidgetLines([state], theme as any, 120, true);
		assert.deepEqual(second, first);
	});

	it("rerenders when only nested state changes", () => {
		const first = job(nested("nested-reviewer", "root-run", "running"));
		const second = job(nested("nested-reviewer", "root-run", "complete"));
		assert.notEqual(widgetRenderKey(first), widgetRenderKey(second));
	});
});
