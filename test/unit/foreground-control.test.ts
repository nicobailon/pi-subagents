import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentProgress, ForegroundRunControl } from "../../src/shared/types.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	foregroundSchedulingSettled,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	updateForegroundChild,
} from "../../src/runs/foreground/foreground-control.ts";

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
		model: "openai/gpt-5.6-terra:high",
		thinking: "high",
		inputTokens: tokens - 20,
		outputTokens: 20,
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
		let firstDetaches = 0;
		beginForegroundChild(control, {
			index: 0,
			agent: "reviewer",
			description: "Review correctness",
			interrupt: () => { firstInterrupts++; return true; },
			detach: () => { firstDetaches++; return true; },
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
		assert.equal(control.inputTokens, 100);
		assert.equal(control.outputTokens, 20);
		assert.equal(control.model, "openai/gpt-5.6-terra:high");
		assert.equal(control.thinking, "high");
		assert.equal(control.activeChildren?.get(1)?.tokens, undefined);
		assert.equal(control.interrupt?.(), true);
		assert.equal(firstInterrupts, 1);
		assert.equal(secondInterrupts, 0);
		assert.equal(control.detach?.(), true);
		assert.equal(firstDetaches, 1);

		updateForegroundChild(control, 1, progress(1, "reviewer", 240));
		finishForegroundChild(control, 1);
		assert.equal(control.currentIndex, 0);
		assert.equal(control.tokens, 120);
		assert.deepEqual([...control.activeChildren!.keys()], [0]);

		finishForegroundChild(control, 0);
		assert.equal(control.activeChildren?.size, 0);
		assert.equal(control.currentIndex, undefined);
		assert.equal(control.model, undefined);
		assert.equal(control.inputTokens, undefined);
		assert.equal(control.outputTokens, undefined);
		assert.equal(control.interrupt, undefined);
		assert.equal(control.detach, undefined);
	});

	it("settles scheduling only after every owner releases", () => {
		const control: ForegroundRunControl = {
			runId: "owned-run",
			mode: "parallel",
			startedAt: 1,
			updatedAt: 1,
			schedulingOwners: 1,
		};

		retainForegroundSchedulingOwner(control);
		settleForegroundSchedulingOwner(control);
		assert.equal(foregroundSchedulingSettled(control), false);
		settleForegroundSchedulingOwner(control);
		assert.equal(foregroundSchedulingSettled(control), true);
		assert.equal(control.schedulingOwners, 0);
	});
});
