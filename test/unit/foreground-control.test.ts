import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProgress, ForegroundRunControl } from "../../src/shared/types.ts";
import { beginForegroundChild, finishForegroundChild, updateForegroundChild } from "../../src/runs/foreground/foreground-control.ts";

function progress(index: number, agent: string, tokens: number): AgentProgress {
	return {
		index,
		agent,
		status: "running",
		task: `${agent} task`,
		recentTools: [],
		recentOutput: [],
		toolCount: index + 1,
		tokens,
		durationMs: 10,
	};
}

describe("foreground child control", () => {
	it("tracks concurrent children independently and promotes the latest active child", () => {
		const control: ForegroundRunControl = {
			runId: "parallel-run",
			mode: "parallel",
			startedAt: 1,
			updatedAt: 1,
			activeChildren: new Map(),
		};
		let firstInterrupts = 0;
		let secondInterrupts = 0;
		beginForegroundChild(control, {
			index: 0,
			agent: "reviewer",
			description: "Review correctness",
			interrupt: () => { firstInterrupts++; return true; },
		});
		beginForegroundChild(control, {
			index: 1,
			agent: "reviewer",
			description: "Review quality",
			interrupt: () => { secondInterrupts++; return true; },
		});

		assert.equal(control.activeChildren?.size, 2);
		assert.equal(control.currentIndex, 1);
		updateForegroundChild(control, 0, progress(0, "reviewer", 120));
		assert.equal(control.currentIndex, 0);
		assert.equal(control.tokens, 120);
		assert.equal(control.activeChildren?.get(1)?.tokens, undefined);
		assert.equal(control.interrupt?.(), true);
		assert.equal(firstInterrupts, 1);
		assert.equal(secondInterrupts, 0);

		updateForegroundChild(control, 1, progress(1, "reviewer", 240));
		finishForegroundChild(control, 1);
		assert.equal(control.currentIndex, 0);
		assert.equal(control.tokens, 120);
		assert.deepEqual([...control.activeChildren!.keys()], [0]);

		finishForegroundChild(control, 0);
		assert.equal(control.activeChildren?.size, 0);
		assert.equal(control.currentIndex, undefined);
		assert.equal(control.interrupt, undefined);
	});
});
