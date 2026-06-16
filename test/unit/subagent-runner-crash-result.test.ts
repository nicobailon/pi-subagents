import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRunnerCrashResultPayload } from "../../src/runs/background/crash-result.ts";

describe("buildRunnerCrashResultPayload", () => {
	it("writes a failed result shape that async consumers can display", () => {
		const payload = buildRunnerCrashResultPayload({
			id: "run-123",
			agent: "worker",
			mode: "single",
			reason: "uncaughtException: boom",
			startedAt: 1000,
			now: 1600,
			asyncDir: "/tmp/run-123",
			cwd: "/repo",
			sessionId: "session-1",
			topLevelIntercomTarget: "supervisor-target",
			childIntercomTarget: "subagent-worker-run-123-1",
			taskIndex: 2,
			totalTasks: 4,
		}) as {
			success: boolean;
			state: string;
			summary: string;
			error: string;
			exitCode: number;
			results: Array<{ agent: string; output: string; error: string; success: boolean; exitCode: number; intercomTarget?: string }>;
			durationMs: number;
			intercomTarget?: string;
			taskIndex?: number;
			totalTasks?: number;
		};

		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.summary, "Runner crashed: uncaughtException: boom");
		assert.equal(payload.error, payload.summary);
		assert.equal(payload.durationMs, 600);
		assert.equal(payload.intercomTarget, "supervisor-target");
		assert.equal(payload.taskIndex, 2);
		assert.equal(payload.totalTasks, 4);
		assert.deepEqual(payload.results, [{
			agent: "worker",
			output: "",
			error: "Runner crashed: uncaughtException: boom",
			success: false,
			exitCode: 1,
			intercomTarget: "subagent-worker-run-123-1",
		}]);
	});
});
