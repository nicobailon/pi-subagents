import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { releaseActiveRunIndex, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { resultFilePath, writeAsyncResultFile, writePendingAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

const routeRoots: string[] = [];

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function stateWithForeground(id: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map([[id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 }]]),
		lastForegroundControlId: id,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function nested(rootRunId: string, id: string) {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedChild(route, rootRunId, id, 0);
	return route;
}

function writeNestedChild(route: ReturnType<typeof createNestedRoute>, parentRunId: string, id: string, parentStepIndex?: number) {
	writeNestedEvent(route, {
		type: "subagent.nested.updated",
		ts: 100,
		parentRunId,
		...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
		child: { id, parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth: 1, path: [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }], state: "running", agent: "worker" },
	});
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = stateWithForeground("foreground-only");
	state.foregroundControls.set(route.rootRunId, { runId: route.rootRunId, mode: "single", startedAt: 1, updatedAt: 1, nestedRoute: route });
	return state;
}

describe("subagent run id resolver", () => {
	it("prefers exact foreground, then exact async, then exact nested before prefix matches", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-resolver-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "shared-id"), { recursive: true });
			nested("root-shared", "shared-id");
			nested("root-prefix", "shared-id-child");

			assert.equal(resolveSubagentRunId("shared-id", { state: stateWithForeground("shared-id"), asyncDirRoot: asyncRoot, resultsDir })?.kind, "foreground");
			assert.equal(resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir })?.kind, "async");
			fs.rmSync(path.join(asyncRoot, "shared-id"), { recursive: true, force: true });
			const resolved = resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(resolved?.kind, "nested");
			assert.equal(resolved?.id, "shared-id");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports one combined ambiguity for prefixes across namespaces", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "fanout-x-async"), { recursive: true });
			nested("root-fanout", "fanout-x-nested");
			assert.throws(
				() => resolveSubagentRunId("fanout-x", { asyncDirRoot: asyncRoot, resultsDir }),
				/Ambiguous subagent run id prefix 'fanout-x' matched: async:fanout-x-async, nested:fanout-x-nested/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("limits nested lookup to active state routes when state is provided", () => {
		const allowed = nested("root-allowed", "shared-nested");
		nested("root-outside", "shared-nested");

		assert.throws(
			() => resolveSubagentRunId("shared-nested"),
			/ambiguous across authorized registries|ambiguous across registries/i,
		);
		assert.equal(resolveSubagentRunId("shared-nested", { state: stateWithForeground("foreground-only") }), undefined);
		const resolved = resolveSubagentRunId("shared-nested", { state: stateWithNestedRoute(allowed) });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.kind === "nested" ? resolved.match.rootRunId : undefined, "root-allowed");
	});

	it("limits nested lookup to descendants of a scoped child address", () => {
		const route = createNestedRoute("root-scoped");
		routeRoots.push(path.dirname(route.eventSink));
		writeNestedChild(route, "root-scoped", "same-child-zero", 0);
		writeNestedChild(route, "root-scoped", "same-child-one", 1);

		assert.throws(
			() => resolveSubagentRunId("same-child", { nested: { routes: [route] } }),
			/Ambiguous subagent run id prefix 'same-child'/,
		);
		const resolved = resolveSubagentRunId("same-child", { nested: { routes: [route], descendantOf: { parentRunId: "root-scoped", parentStepIndex: 0 } } });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.id, "same-child-zero");
		assert.equal(resolved?.kind === "nested" ? resolved.match.run.parentStepIndex : undefined, 0);
	});

	it("reports async prefix ambiguity without parsing resolver error text", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-async-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "dupe-aaa-one"), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, "dupe-aaa-two"), { recursive: true });

			assert.throws(
				() => resolveSubagentRunId("dupe-aaa", { asyncDirRoot: asyncRoot, resultsDir }),
				/Ambiguous subagent run id prefix 'dupe-aaa' matched: async:dupe-aaa-one, async:dupe-aaa-two/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not resolve unindexed result files by prefix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-result-prefix-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			fs.writeFileSync(path.join(resultsDir, "legacy-run.json"), JSON.stringify({ id: "legacy-run", sessionId: "session-a", success: true }), "utf-8");

			const exact = resolveSubagentRunId("legacy-run", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(exact?.kind, "async");
			assert.equal(exact?.id, "legacy-run");
			assert.equal(resolveSubagentRunId("legacy", { asyncDirRoot: asyncRoot, resultsDir }), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves workflow tool-call ids through active and result indexes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-resolver-tool-call-index-"));
		try {
			const asyncRoot = path.join(root, "async");
			const resultsDir = path.join(root, "results");
			const activeDir = path.join(asyncRoot, "workflow-active");
			fs.mkdirSync(activeDir, { recursive: true });
			fs.writeFileSync(path.join(activeDir, "status.json"), JSON.stringify({ runId: "workflow-active", toolCallId: "call-active", state: "running", mode: "workflow", startedAt: 1, lastUpdate: 1, steps: [] }), "utf-8");
			updateActiveRunIndex(activeDir, "running", "call-active");

			const active = resolveSubagentRunId("call-active", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(active?.kind, "async");
			assert.equal(active?.id, "workflow-active");
			releaseActiveRunIndex(activeDir);
			assert.equal(resolveSubagentRunId("call-active", { asyncDirRoot: asyncRoot, resultsDir }), undefined);

			writeAsyncResultFile(resultFilePath(resultsDir, "workflow-done"), { id: "workflow-done", runId: "workflow-done", toolCallId: "call-done", sessionId: "session-a", state: "complete", success: true });
			const done = resolveSubagentRunId("call-done", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(done?.kind, "async");
			assert.equal(done?.id, "workflow-done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers a newer pending payload when resolving run and tool-call ids", (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-resolver-pending-payload-"));
		try {
			const asyncRoot = path.join(root, "async");
			const resultsDir = path.join(root, "results");
			const resultPath = resultFilePath(resultsDir, "workflow-done");
			writeAsyncResultFile(resultPath, { id: "workflow-done", runId: "workflow-done", toolCallId: "call-done", sessionId: "session-a", success: false });
			writePendingAsyncResultFile(resultPath, { id: "workflow-done", runId: "workflow-done", toolCallId: "call-done", sessionId: "session-a", success: true });

			t.mock.method(fsDefault, "renameSync", () => {
				const error = new Error("destination exists") as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			});
			syncBuiltinESMExports();

			const pendingPath = path.join(resultsDir, "result-pending", "session-a", "workflow-done.json");
			const byRunId = resolveSubagentRunId("workflow-done", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(byRunId?.kind, "async");
			assert.equal(byRunId?.kind === "async" ? byRunId.location.resultPath : undefined, pendingPath);

			const byToolCallId = resolveSubagentRunId("call-done", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(byToolCallId?.kind, "async");
			assert.equal(byToolCallId?.id, "workflow-done");
			assert.equal(byToolCallId?.kind === "async" ? byToolCallId.location.resultPath : undefined, pendingPath);
			assert.equal(JSON.parse(fs.readFileSync(pendingPath, "utf-8")).success, true);
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, false);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves oversized workflow tool-call ids through bounded indexes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-resolver-long-tool-call-index-"));
		try {
			const asyncRoot = path.join(root, "async");
			const resultsDir = path.join(root, "results");
			const toolCallId = `call_${"界".repeat(100)}`;
			const activeDir = path.join(asyncRoot, "workflow-active-long");
			fs.mkdirSync(activeDir, { recursive: true });
			fs.writeFileSync(path.join(activeDir, "status.json"), JSON.stringify({ runId: "workflow-active-long", toolCallId, state: "running", mode: "workflow", startedAt: 1, lastUpdate: 1, steps: [] }), "utf-8");
			updateActiveRunIndex(activeDir, "running", toolCallId);

			assert.equal(resolveSubagentRunId(toolCallId, { asyncDirRoot: asyncRoot, resultsDir })?.id, "workflow-active-long");
			releaseActiveRunIndex(activeDir);

			writeAsyncResultFile(resultFilePath(resultsDir, "workflow-done-long"), { id: "workflow-done-long", runId: "workflow-done-long", toolCallId, sessionId: "session-a", state: "complete", success: true });
			assert.equal(resolveSubagentRunId(toolCallId, { asyncDirRoot: asyncRoot, resultsDir })?.id, "workflow-done-long");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unsafe nested id tokens before lookup", () => {
		assert.throws(() => resolveSubagentRunId("../run"), /safe id token/);
		assert.throws(() => resolveSubagentRunId("a/b"), /safe id token/);
		assert.throws(() => resolveSubagentRunId(""), /safe id token/);
	});
});
