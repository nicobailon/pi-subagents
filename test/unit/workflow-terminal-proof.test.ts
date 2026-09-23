import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AsyncStatus, ProcessTerminal, WorkflowChildSummary } from "../../src/shared/types.ts";
import { readWorkflowTerminalProof } from "../../src/runs/background/workflow-terminal-proof.ts";

type Steps = NonNullable<AsyncStatus["steps"]>;

function summary(overrides: Partial<WorkflowChildSummary> = {}): WorkflowChildSummary {
	return {
		version: 1,
		parentToolCallId: "parent-tool-call",
		workflowRunId: "workflow-run",
		inventoryComplete: true,
		workflowState: "completed",
		children: [{ childId: "main", runId: "child-run", state: "completed" }],
		...overrides,
	};
}

const asyncChild = [{ agent: "worker", workflowKey: "main", runId: "child-run", async: true, status: "completed" }] as Steps;

function observedChild(): ProcessTerminal {
	return {
		version: 1,
		state: "observed",
		runId: "child-run",
		runnerProcessInstanceId: "runner-1",
		observedAt: 1_234,
		instances: [{ kind: "runner", processInstanceId: "runner-1", closeObservedAt: 1_234, exitCode: 0, signal: null }],
	};
}

function withFixture(run: (dirs: { root: string; asyncDir: string; writeChild: (status: object, proof?: ProcessTerminal) => void }) => void): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-terminal-proof-"));
	const asyncDir = path.join(root, "workflow-run");
	fs.mkdirSync(asyncDir, { recursive: true });
	const writeChild = (status: object, proof?: ProcessTerminal) => {
		const childDir = path.join(root, "child-run");
		fs.mkdirSync(childDir, { recursive: true });
		fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({ runId: "child-run", mode: "single", startedAt: 1, lastUpdate: 2, ...status }));
		if (proof) fs.writeFileSync(path.join(childDir, "process-terminal.json"), JSON.stringify(proof));
	};
	try {
		run({ root, asyncDir, writeChild });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const runnerIdentity = { version: 1, runId: "child-run", runnerProcessInstanceId: "runner-1" };

describe("readWorkflowTerminalProof", () => {
	it("keeps an open inventory pending", () => withFixture(({ asyncDir }) => {
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, asyncChild, summary({ inventoryComplete: false, workflowState: "running" }), 0, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "pending", dispatchClosed: false, reason: "Workflow dispatch is still open.",
		});
	}));

	it("keeps closed dispatch pending until the child's exit is observed", () => withFixture(({ asyncDir, writeChild }) => {
		writeChild({ state: "complete", processTerminal: { ...runnerIdentity, state: "pending" } });
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, asyncChild, summary(), 0, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "pending", dispatchClosed: true,
			reason: "async workflow child main process-terminal proof is missing",
		});
	}));

	it("does not accept a missing child roster as an empty workflow", () => withFixture(({ asyncDir }) => {
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, undefined, summary(), 0, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "unknown", dispatchClosed: true,
			reason: "workflow child roster is missing",
		});
		assert.equal(readWorkflowTerminalProof(asyncDir, [], summary({ children: [] }), 0, 2_000).state, "observed");
	}));

	it("returns observed after every async child has writer-exit evidence", () => withFixture(({ asyncDir, writeChild }) => {
		const proof = observedChild();
		writeChild({ state: "complete", processTerminal: { ...runnerIdentity, state: "pending" } }, proof);
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, asyncChild, summary({ workflowState: "stopped" }), 0, 1_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "observed", dispatchClosed: true, observedAt: 1_234, children: [proof],
		});
	}));

	it("accepts a child whose runner failed before starting", () => withFixture(({ asyncDir, writeChild }) => {
		const notStarted = { ...runnerIdentity, state: "not-started" } as ProcessTerminal;
		writeChild({ state: "failed", error: "runner failed to start", processTerminal: notStarted });
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, asyncChild, summary({ workflowState: "failed" }), 0, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "observed", dispatchClosed: true, observedAt: 2_000, children: [notStarted],
		});
	}));

	it("needs no process evidence for synchronous children that run inside the host", () => withFixture(({ asyncDir }) => {
		const syncChild = [{ agent: "worker", workflowKey: "main", async: false, status: "completed" }] as Steps;
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, syncChild, summary({ children: [{ childId: "main", state: "completed" }] }), 0, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "observed", dispatchClosed: true, observedAt: 2_000, children: [],
		});
	}));

	it("reports host commands as unknown", () => withFixture(({ asyncDir }) => {
		assert.deepEqual(readWorkflowTerminalProof(asyncDir, [], summary({ children: [] }), 1, 2_000), {
			version: 1, kind: "workflow", runId: "workflow-run", state: "unknown", dispatchClosed: true, reason: "Workflow host commands have no process-terminal proof.",
		});
	}));
});
