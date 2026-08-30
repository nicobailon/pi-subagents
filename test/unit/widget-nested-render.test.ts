import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines, widgetRenderKey } from "../../src/tui/render.ts";
import type { AsyncJobState, NestedRunSummary } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function withMockedDateNow<T>(now: number, fn: () => T): T {
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
}

function withoutRunningGlyphs(lines: string[]): string[] {
	return lines.map((line) => line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "•"));
}

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
	it("renders a bounded collapsed tree and full child rows when expanded", () => {
		const child = nested("nested-reviewer", "root-run", "running", { sessionName: "  nested-reviewer: Review nested run  ", currentTool: "read", model: "gpt-5.6-luna:medium", thinking: "medium" });
		const collapsed = buildWidgetLines([job(child)], theme as any, 120, false).join("\n");
		assert.match(collapsed, /↳ └─ \[\d{2}:\d{2}:\d{2}\] . nested-reviewer: Review nested run · running · gpt-5.6-luna · thinking medium · read/);
		assert.equal((collapsed.match(/thinking medium/g) ?? []).length, 1);

		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /↳ \[\d{2}:\d{2}:\d{2}\] . nested-reviewer: Review nested run · running · gpt-5.6-luna · thinking medium · read/);

		const epoch = buildWidgetLines([job(nested("epoch", "root-run", "running", { lastUpdate: 0, startedAt: 0 }))], theme as any, 120, false).join("\n");
		assert.match(epoch, /↳ └─ \[\d{2}:\d{2}:\d{2}\] . epoch · running/);
	});

	it("shows four direct leaves and one overflow row while retaining completed siblings", () => {
		const root = nested("parallel-owner", "root-run", "running", {
			mode: "parallel",
			steps: ["one", "two", "three", "four", "five"].map((agent, index) => ({
				agent,
				status: index === 0 ? "complete" as const : "running" as const,
				model: index === 0 ? "gpt-5.6-luna:medium" : "gpt-5.6-luna",
				thinking: "medium",
			})),
		});
		const collapsed = buildWidgetLines([job(root)], theme as any, 160, false).join("\n");
		assert.match(collapsed, /parallel-owner · running/);
		for (const [agent, state] of [["one", "complete"], ["two", "running"], ["three", "running"], ["four", "running"]] as const) {
			const line = collapsed.split("\n").find((candidate) => candidate.includes(` ${agent} ·`));
			assert.ok(line);
			assert.match(line!, /\[\d{2}:\d{2}:\d{2}\] /);
			assert.match(line!, /gpt-5.6-luna/);
			assert.match(line!, /thinking medium/);
			assert.match(line!, new RegExp(state));
		}
		assert.doesNotMatch(collapsed, /five · running/);

		const chain = nested("chain-owner", "root-run", "running", {
			mode: "chain",
			steps: ["first", "second"].map((agent) => ({ agent, status: "running" as const })),
		});
		const chainCollapsed = buildWidgetLines([job(chain)], theme as any, 160, false).join("\n");
		for (const agent of ["first", "second"]) {
			const line = chainCollapsed.split("\n").find((candidate) => candidate.includes(` ${agent} ·`));
			assert.ok(line);
			assert.match(line!, /\[\d{2}:\d{2}:\d{2}\] /);
		}
		assert.match(collapsed, /\+1 more nested leaves/);
		assert.equal((collapsed.match(/thinking medium/g) ?? []).length, 4);
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
		assert.match(expanded, /✓ owner · complete/);
		assert.doesNotMatch(expanded, /Step 1\/1: owner/);
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
			steps: [{ agent: "completed-step", sessionName: "  completed-step: Finalize report  ", status: "completed", endedAt: 2_000 }],
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
		assert.match(expanded, /\[\d{2}:\d{2}:\d{2}\] . completed-step: Finalize report · completed/);
	});

	it("keeps event-time timestamps stable while nested running glyphs use the supplied frame", () => {
		const state = job(nested("nested-reviewer", "root-run", "running", { currentTool: "read", currentToolStartedAt: 0 }));
		const first = withMockedDateNow(0, () => buildWidgetLines([state], theme as any, 120, true, 0));
		const unrelatedRender = withMockedDateNow(125, () => buildWidgetLines([state], theme as any, 120, true, 0));
		const nextFrame = withMockedDateNow(1_000, () => buildWidgetLines([state], theme as any, 120, true, 1));
		assert.deepEqual(unrelatedRender, first);
		assert.notDeepEqual(nextFrame, first);
		assert.deepEqual(withoutRunningGlyphs(nextFrame), withoutRunningGlyphs(first));
	});

	it("rerenders when only nested state changes", () => {
		const first = job(nested("nested-reviewer", "root-run", "running"));
		const second = job(nested("nested-reviewer", "root-run", "complete"));
		const renamed = job(nested("nested-reviewer", "root-run", "running", { sessionName: "nested-reviewer: Review nested run" }));
		assert.notEqual(widgetRenderKey(first), widgetRenderKey(second));
		assert.notEqual(widgetRenderKey(first), widgetRenderKey(renamed));
	});
});
