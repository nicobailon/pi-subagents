import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ASYNC_STATUS_SNAPSHOT_KIND,
	ASYNC_STATUS_SNAPSHOT_VERSION,
	ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX,
	buildAsyncStatusSnapshot,
	buildAsyncStatusSnapshotForState,
	encodeAsyncStatusSnapshotWidget,
} from "../../src/runs/background/async-status-snapshot.ts";

const privateNeedle = "PRIVATE_LEAK_NEEDLE";

function json(value: unknown): string {
	return JSON.stringify(value);
}

describe("async status snapshot", () => {
	it("projects current async jobs with a versioned safe shape", () => {
		const snapshot = buildAsyncStatusSnapshot([{
			asyncId: "run-1",
			asyncDir: `/tmp/${privateNeedle}/run`,
			cwd: `/repo/${privateNeedle}`,
			sessionRoot: `/sessions/${privateNeedle}`,
			sessionDir: `/session-dir/${privateNeedle}`,
			outputFile: `/output/${privateNeedle}.log`,
			sessionFile: `/session-file/${privateNeedle}.jsonl`,
			sessionId: "session-a",
			status: "running",
			mode: "parallel",
			agents: ["worker"],
			description: `task ${privateNeedle}`,
			startedAt: 100,
			updatedAt: 150,
			currentTool: "bash\n\u001b]8;;bad\u0007",
			currentPath: `/current/${privateNeedle}`,
			steps: [{
				index: 0,
				agent: "worker",
				status: "running",
				startedAt: 110,
				currentTool: "read",
				currentToolArgs: `args ${privateNeedle}`,
				recentOutput: [`output ${privateNeedle}`],
				error: `error ${privateNeedle}`,
				transcriptPath: `/transcript/${privateNeedle}.jsonl`,
			}],
		}], { generatedAt: 200 });

		assert.equal(snapshot.kind, ASYNC_STATUS_SNAPSHOT_KIND);
		assert.equal(snapshot.version, ASYNC_STATUS_SNAPSHOT_VERSION);
		assert.equal(snapshot.generatedAt, 200);
		assert.equal(snapshot.runs.length, 1);
		assert.deepEqual(snapshot.runs[0], {
			id: "run-1",
			kind: "subagent",
			label: "worker",
			state: "running",
			startedAt: 100,
			updatedAt: 150,
			activity: { currentTool: "bash" },
			children: [{
				id: "step:0",
				kind: "step",
				label: "worker",
				state: "running",
				startedAt: 110,
				updatedAt: 110,
				activity: { currentTool: "read" },
			}],
		});
		assert.equal(json(snapshot).includes(privateNeedle), false);
		assert.equal(json(snapshot).includes("currentPath"), false);
		assert.equal(json(snapshot).includes("currentToolArgs"), false);
		assert.equal(json(snapshot).includes("recentOutput"), false);
		assert.equal(json(snapshot).includes("transcriptPath"), false);
	});

	it("normalizes pending child steps to queued", () => {
		const snapshot = buildAsyncStatusSnapshot([{
			asyncId: "run",
			asyncDir: "/tmp/run",
			status: "queued",
			agents: ["worker"],
			steps: [{ agent: "worker", status: "pending" }],
		} as any], { generatedAt: 1 });

		assert.equal(snapshot.runs[0]?.children?.[0]?.state, "queued");
	});

	it("applies run, child, depth, string, and byte caps", () => {
		const jobs = Array.from({ length: 5 }, (_, runIndex) => ({
			asyncId: `run-${runIndex}`,
			asyncDir: `/tmp/run-${runIndex}`,
			status: "running" as const,
			mode: "workflow" as const,
			agents: [`agent-${runIndex}-${"x".repeat(50)}`],
			startedAt: runIndex,
			updatedAt: runIndex,
			steps: Array.from({ length: 5 }, (_, stepIndex) => ({
				agent: `child-${stepIndex}-${"y".repeat(50)}`,
				status: "running" as const,
				children: [{
					id: `nested-${stepIndex}`,
					parentRunId: `run-${runIndex}`,
					depth: 1,
					path: [],
					state: "running" as const,
					agent: "nested",
				}],
			})),
		}));

		const snapshot = buildAsyncStatusSnapshot(jobs, {
			generatedAt: 10,
			maxRuns: 2,
			maxChildrenPerNode: 2,
			maxDepth: 1,
			maxStringLength: 16,
			maxSerializedBytes: 1200,
		});

		assert.equal(snapshot.runs.length, 2);
		assert.equal(snapshot.omitted.runs, 3);
		assert.equal(snapshot.runs[0]?.children?.length, 2);
		assert.ok(snapshot.omitted.children >= 6);
		assert.ok((snapshot.runs[0]?.label.length ?? 0) <= 16);
		assert.ok(Buffer.byteLength(json(snapshot), "utf8") <= 1200);

		const byteCapped = buildAsyncStatusSnapshot(jobs, { maxSerializedBytes: 512 });
		assert.equal(byteCapped.omitted.byteLimitExceeded, true);
		assert.ok(Buffer.byteLength(json(byteCapped), "utf8") <= 512);
	});

	it("uses current-session state and retained fleet jobs without rebuilding history", () => {
		const state = {
			currentSessionId: "session-a",
			foregroundControls: new Map(),
			asyncJobs: new Map([["active", { asyncId: "active", asyncDir: "/tmp/active", sessionId: "session-a", status: "running", agents: ["worker"] }]]),
			fleetJobs: new Map([
				["terminal", { asyncId: "terminal", asyncDir: "/tmp/terminal", sessionId: "session-a", status: "complete", agents: ["reviewer"], updatedAt: 300, outputFile: `/tmp/${privateNeedle}.log` }],
				["foreign", { asyncId: "foreign", asyncDir: "/tmp/foreign", sessionId: "other", status: "running", agents: ["hidden"] }],
			]),
		} as any;

		const snapshot = buildAsyncStatusSnapshotForState(state, "session-a", { generatedAt: 1 });
		assert.deepEqual(snapshot.runs.map((run) => run.id).sort(), ["active", "terminal"]);
		assert.equal(snapshot.runs.find((run) => run.id === "terminal")?.endedAt, 300);
		assert.equal(json(snapshot).includes(privateNeedle), false);
		assert.deepEqual(buildAsyncStatusSnapshotForState(state, "other").runs, []);
	});

	it("encodes RPC widget payloads as a string-array snapshot", () => {
		const lines = encodeAsyncStatusSnapshotWidget([{ asyncId: "run", asyncDir: "/tmp/run", status: "queued", agents: ["planner"] } as any], { generatedAt: 5 });
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.startsWith(ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX));
		const snapshot = JSON.parse(lines[0]!.slice(ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX.length));
		assert.equal(snapshot.kind, ASYNC_STATUS_SNAPSHOT_KIND);
		assert.equal(snapshot.version, 1);
		assert.equal(snapshot.runs[0].id, "run");
	});
});
