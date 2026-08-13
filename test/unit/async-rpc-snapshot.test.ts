import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASYNC_RPC_WIDGET_PREFIX, buildAsyncRpcRunSnapshot, encodeAsyncRpcWidgetLines } from "../../src/runs/background/async-rpc-snapshot.ts";
import type { AsyncJobState } from "../../src/shared/types.ts";

describe("async RPC snapshot", () => {
	it("projects runtime workflow steps without exposing artifact paths", () => {
		const job: AsyncJobState = {
			asyncId: "workflow-1",
			asyncDir: "/secret/async-dir",
			cwd: "/secret/repo",
			status: "running",
			mode: "workflow",
			steps: [
				{ agent: "worker", workflowKey: "a", description: "dynamic a", status: "running", index: 0, currentTool: "bash", currentToolArgs: "token=company-secret", recentOutput: ["company-secret"] },
				{ agent: "worker", workflowKey: "b", description: "dynamic b", status: "completed", index: 1, recentOutput: ["done b"] },
				{ agent: "worker", workflowKey: "c", description: "dynamic c", status: "running", index: 2 },
			],
		};
		const run = buildAsyncRpcRunSnapshot(job);
		assert.deepEqual(run.children.map((child) => child.key), ["a", "b", "c"]);
		assert.deepEqual(run.children.map((child) => child.task), ["dynamic a", "dynamic b", "dynamic c"]);
		assert.equal(JSON.stringify(run).includes("/secret"), false);
		assert.equal(JSON.stringify(run).includes("company-secret"), false);
	});

	it("encodes a versioned string widget payload", () => {
		const lines = encodeAsyncRpcWidgetLines([{ asyncId: "r1", asyncDir: "/tmp/r1", status: "queued", steps: [] }], 123);
		assert.equal(lines.length, 1);
		assert.ok(lines[0]!.startsWith(ASYNC_RPC_WIDGET_PREFIX));
		const parsed = JSON.parse(lines[0]!.slice(ASYNC_RPC_WIDGET_PREFIX.length)) as { version: number; generatedAt: number; runs: Array<{ asyncId: string }> };
		assert.equal(parsed.version, 1);
		assert.equal(parsed.generatedAt, 123);
		assert.equal(parsed.runs[0]?.asyncId, "r1");
	});
});
