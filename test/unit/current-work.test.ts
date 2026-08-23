import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildCurrentWorkProjection } from "../../src/extension/current-work.ts";
import { persistForegroundRunHistory, restoreForegroundRunHistory } from "../../src/runs/foreground/foreground-history.ts";

function makeState(overrides: Record<string, unknown> = {}) {
	return {
		baseCwd: "/private/project",
		currentSessionId: "session-a",
		asyncJobs: new Map(),
		fleetJobs: new Map(),
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		...overrides,
	} as any;
}

describe("current-work projection", () => {
	it("scopes roots to the current native session and gives stable opaque keys", () => {
		const state = makeState({
			asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map([
			["live", { runId: "internal-live", sessionId: "session-a", mode: "single", startedAt: 10, updatedAt: 20, currentAgent: "worker", description: "Review safely", currentPath: "/private/project/secret.ts", currentToolArgs: "PRIVATE_ARGS" }],
			["foreign", { runId: "internal-foreign", sessionId: "session-b", mode: "single", startedAt: 10, updatedAt: 20, currentAgent: "secret" }],
		]),
		});
	const keys = { sessionId: null, next: 0, keys: new Map<string, string>() };
	const first = buildCurrentWorkProjection(state, "session-a", { keys, generatedAt: 30 });
	const second = buildCurrentWorkProjection(state, "session-a", { keys, generatedAt: 31 });
	assert.equal(first.roots.length, 1);
	assert.equal(first.roots[0]?.agent, "worker");
	assert.match(first.roots[0]?.key ?? "", /^work-/);
	assert.equal(first.roots[0]?.key, second.roots[0]?.key);
	assert.equal(first.roots[0]?.goal, "Review safely");
	assert.equal(JSON.stringify(first).includes("internal-live"), false);
	assert.equal(JSON.stringify(first).includes("/private/project"), false);
	assert.equal(JSON.stringify(first).includes("PRIVATE_ARGS"), false);
	});

	it("projects lifecycle, activity, tokens, and bounded hierarchy", () => {
		const state = makeState({ asyncJobs: new Map([
			["async-internal", {
				asyncId: "async-internal", sessionId: "session-a", mode: "parallel", status: "running", description: "Inspect", startedAt: 100, updatedAt: 140,
				totalTokens: { input: 2, output: 3, total: 5 },
				steps: Array.from({ length: 4 }, (_, index) => ({ agent: `agent-${index}`, label: `role-${index}`, status: "running", startedAt: 110 + index })),
			}],
		]) });
		const projection = buildCurrentWorkProjection(state, "session-a", { maxChildrenPerNode: 2, generatedAt: 150 });
		const root = projection.roots[0]!;
		assert.equal(root.state, "running");
		assert.equal(root.activity, undefined);
		assert.deepEqual(root.tokens, { input: 2, output: 3, total: 5 });
		assert.equal(root.children?.length, 2);
		assert.equal(projection.omitted.children, 2);
		assert.equal(root.children?.[0]?.role, "role-0");
	});

	it("excludes workflow roots and workflow-owned children before projection", () => {
		const state = makeState({
			foregroundControls: new Map([["workflow", { runId: "wf", sessionId: "session-a", mode: "single", parentWorkflowRunId: "workflow-root", startedAt: 1, updatedAt: 2 }]]),
			asyncJobs: new Map([["direct", { asyncId: "direct", sessionId: "session-a", mode: "single", status: "running", startedAt: 1, steps: [
				{ agent: "visible", status: "running", children: [
					{ id: "nested-direct", agent: "nested-visible", state: "running" },
					{ id: "nested-workflow", agent: "nested-hidden", state: "running", workflowKey: "workflow-lane" },
				] },
				{ agent: "hidden", status: "running", parentWorkflowRunId: "workflow-root" },
			] }]]),
		});
		const projection = buildCurrentWorkProjection(state, "session-a", { generatedAt: 3 });
		assert.equal(projection.roots.length, 1);
		assert.equal(projection.roots[0]?.children?.length, 1);
		assert.equal(projection.roots[0]?.children?.[0]?.agent, "visible");
		assert.deepEqual(projection.roots[0]?.children?.[0]?.children?.map((child) => child.agent), ["nested-visible"]);
	});

	it("normalizes pending and detached, preserves foreground attention and terminal history, and omits owned history", () => {
		const state = makeState({
			foregroundControls: new Map([["live", { runId: "live", sessionId: "session-a", mode: "single", startedAt: 1, updatedAt: 2, currentAgent: "worker", currentActivityState: "needs_attention", currentTool: "read", currentToolStartedAt: 2, currentToolArgs: "SECRET TOOL INPUT", tokens: 9 }]]),
			foregroundRuns: new Map([
				["failed", { runId: "failed", sessionId: "session-a", mode: "single", cwd: "/private", updatedAt: 4, children: [{ index: 0, agent: "f", status: "failed" }]}],
				["paused", { runId: "paused", sessionId: "session-a", mode: "single", cwd: "/private", updatedAt: 3, children: [{ index: 0, agent: "p", status: "paused" }]}],
				["complete", { runId: "complete", sessionId: "session-a", mode: "single", cwd: "/private", updatedAt: 3, children: [{ index: 0, agent: "c", status: "completed" }]}],
				["owned", { runId: "owned", sessionId: "session-a", parentWorkflowRunId: "private", mode: "single", cwd: "/private", updatedAt: 5, children: [{ index: 0, agent: "hidden", status: "completed" }]}],
			]),
			asyncJobs: new Map([["pending", { asyncId: "pending", sessionId: "session-a", mode: "chain", status: "pending", startedAt: 1, steps: [{ index: 0, agent: "one", status: "pending" }, { index: 1, agent: "two", status: "detached" }] }]]),
		});
		const projection = buildCurrentWorkProjection(state, "session-a", { generatedAt: 6 });
		const live = projection.roots.find((root) => root.agent === "worker")!;
		assert.equal(live.activity?.state, "needs_attention");
		assert.equal(live.activity?.currentTool, "read");
		assert.deepEqual(live.tokens, { input: 0, output: 0, total: 9 });
		assert.equal(JSON.stringify(live).includes("SECRET TOOL INPUT"), false);
		assert.equal(projection.roots.find((root) => root.children?.[0]?.agent === "f")?.state, "failed");
		assert.equal(projection.roots.find((root) => root.children?.[0]?.agent === "p")?.state, "paused");
		assert.equal(projection.roots.find((root) => root.children?.[0]?.agent === "c")?.state, "complete");
		const chain = projection.roots.find((root) => root.mode === "chain")!;
		assert.equal(chain.state, "queued");
		assert.equal(chain.children?.[0]?.mode, "single");
		assert.equal(chain.children?.[1]?.state, "running");
		assert.equal(JSON.stringify(projection).includes("owned"), false);
	});

	it("keeps queued and attention-requiring work ahead of newer terminal history under root pressure", () => {
		const state = makeState({
			foregroundControls: new Map([["attention", { runId: "attention", sessionId: "session-a", mode: "single", startedAt: 1, updatedAt: 10, currentAgent: "reviewer", currentActivityState: "needs_attention" }]]),
			asyncJobs: new Map([
				["queued", { asyncId: "queued", sessionId: "session-a", mode: "single", status: "queued", description: "Queued work", startedAt: 2, updatedAt: 9, agents: ["worker"] }],
				...Array.from({ length: 4 }, (_, index) => [`terminal-${index}`, { asyncId: `terminal-${index}`, sessionId: "session-a", mode: "single", status: "complete", startedAt: 20 + index, updatedAt: 30 + index, agents: ["done"] }]),
			]),
		});
		const projection = buildCurrentWorkProjection(state, "session-a", { maxRoots: 2, generatedAt: 40 });
		assert.deepEqual(projection.roots.map((root) => [root.state, root.activity?.state]), [["running", "needs_attention"], ["queued", undefined]]);
		assert.equal(projection.omitted.roots, 4);
	});

	it("preserves workflow ownership through foreground history persistence", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-current-work-history-"));
		try {
			const original = makeState({ foregroundRuns: new Map([["owned", {
				runId: "owned", parentWorkflowRunId: "workflow-private", workflowKey: "lane-private", sessionId: "session-a", mode: "single", cwd: "/private", updatedAt: 5,
				children: [{ index: 0, agent: "hidden", status: "completed" }],
			}]]) });
			persistForegroundRunHistory(original, { resultsDir });
			const restored = makeState();
			assert.equal(restoreForegroundRunHistory(restored, { resultsDir, sessionId: "session-a" }), 1);
			assert.equal(buildCurrentWorkProjection(restored, "session-a", { generatedAt: 6 }).roots.length, 0);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("sanitizes strings and reports byte-bounded omissions", () => {
		const state = makeState({ foregroundControls: new Map(Array.from({ length: 8 }, (_, index) => [`${index}`, {
			runId: `internal-${index}`, sessionId: "session-a", mode: "single", startedAt: index, updatedAt: index,
			description: "goal\u001b[31m" + "x".repeat(500), currentAgent: "agent",
		}])) });
		const projection = buildCurrentWorkProjection(state, "session-a", { maxRoots: 2, maxSerializedBytes: 500, generatedAt: 1 });
		assert.equal(projection.roots.length, 0);
		assert.equal(projection.omitted.byteLimitExceeded, true);
		assert.equal(projection.omitted.roots, 8);
	});
});
