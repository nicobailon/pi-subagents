import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { DIRS, type AsyncStatus, type SubagentState } from "../../src/shared/types.ts";

const cleanupRoots: string[] = [];

function createState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
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

function createExecutor(state: SubagentState, cwd: string) {
	return createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
		state,
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => path.join(cwd, "sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [{ name: "worker" }] as never }),
	});
}

function createContext(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: {},
		sessionManager: {
			getSessionId() { return "session-1644"; },
			getSessionFile() { return null; },
		},
		modelRegistry: { getAvailable() { return []; } },
	} as never;
}

function makeIds(label: string): { parentRunId: string; childRunId: string } {
	const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return { parentRunId: `workflow-parent-${suffix}`, childRunId: `workflow-child-${suffix}` };
}

function writeRetainedChild(input: {
	root: string;
	childRunId: string;
	sessionId: string;
	state?: AsyncStatus["state"];
	stepStatus?: NonNullable<AsyncStatus["steps"]>[number]["status"];
	writeSession?: boolean;
}): void {
	const childDir = path.join(DIRS.async, input.childRunId);
	fs.mkdirSync(childDir, { recursive: true });
	const sessionFile = path.join(input.root, `${input.childRunId}.jsonl`);
	if (input.writeSession !== false) fs.writeFileSync(sessionFile, "{}\n", "utf-8");
	const state = input.state ?? "complete";
	const stepStatus = input.stepStatus ?? "complete";
	fs.writeFileSync(path.join(childDir, "status.json"), JSON.stringify({
		runId: input.childRunId,
		sessionId: input.sessionId,
		mode: "single",
		state,
		startedAt: 100,
		endedAt: state === "complete" ? 200 : undefined,
		cwd: input.root,
		sessionFile,
		steps: [{ agent: "worker", status: stepStatus, sessionFile }],
	}), "utf-8");
}

function writeWorkflowStatus(input: {
	parentRunId: string;
	childRunId: string;
	key?: string;
	sessionId?: string;
	parentState?: AsyncStatus["state"];
	steps?: Array<Record<string, unknown>>;
	workflowChildren?: unknown;
	malformed?: boolean;
}): string {
	const asyncDir = path.join(DIRS.async, input.parentRunId);
	fs.mkdirSync(asyncDir, { recursive: true });
	const statusPath = path.join(asyncDir, "status.json");
	if (input.malformed) {
		fs.writeFileSync(statusPath, "{not-json", "utf-8");
	} else {
		fs.writeFileSync(statusPath, JSON.stringify({
			runId: input.parentRunId,
			sessionId: input.sessionId ?? "session-1644",
			mode: "workflow",
			state: input.parentState ?? "complete",
			startedAt: 100,
			endedAt: 200,
			steps: input.steps ?? [{ agent: "worker", workflowKey: input.key ?? "advisor", runId: input.childRunId, status: "complete" }],
			...(input.workflowChildren === undefined ? {} : { workflowChildren: input.workflowChildren }),
		}), "utf-8");
	}
	fs.writeFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({ type: "subagent.workflow.child.completed", runId: input.parentRunId, childRunId: input.childRunId })}\n`, "utf-8");
	return asyncDir;
}

async function runMissingReceiptResume(input: {
	root: string;
	parentRunId: string;
	key?: string;
	state?: SubagentState;
}): Promise<string> {
	const state = input.state ?? createState("session-1644");
	const executor = createExecutor(state, input.root);
	const key = input.key ?? "advisor";
	const result = await executor.execute(
		`resume-hint-request-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		{
			async: false,
			mission: false,
			workflowScript: `return runs.run("follow-up", { resume: { workflowRunId: ${JSON.stringify(input.parentRunId)}, key: ${JSON.stringify(key)}, latest: true }, task: "Continue" });`,
		},
		new AbortController().signal,
		undefined,
		createContext(input.root),
	);
	return result.content.map((part) => part.text ?? "").join("\n");
}

function cleanupRun(runId: string): void {
	fs.rmSync(path.join(DIRS.async, runId), { recursive: true, force: true });
}

afterEach(() => {
	for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workflow keyed resume recovery hint", () => {
	it("names a directly resumable child when the parent receipt is missing", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-resume-hint-"));
		cleanupRoots.push(root);
		const { parentRunId, childRunId } = makeIds("positive");
		writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
		const workflowChildren = {
			version: 1,
			parentToolCallId: "tool-call",
			workflowRunId: parentRunId,
			inventoryComplete: true,
			workflowState: "completed",
			children: [{ childId: "advisor", runId: childRunId, state: "completed" }],
		};
		writeWorkflowStatus({ parentRunId, childRunId, workflowChildren });

		const text = await runMissingReceiptResume({ root, parentRunId });

		assert.match(text, new RegExp(`Direct resumable child for workflow key 'advisor': subagent\\(\\{ action: "resume", id: ${JSON.stringify(childRunId)}, message: "\\.\\.\\." \\}\\)`));
		assert.match(text, /terminal receipt writing failed/);
		const target = resolveAsyncResumeTarget({ id: childRunId }, {}, { requireSessionFile: true, sessionId: "session-1644" });
		assert.equal(target.kind, "revive");
		assert.equal(target.runId, childRunId);
		cleanupRun(parentRunId);
		cleanupRun(childRunId);
	});

	it("does not hint when status proof or direct resumability is not safe", async () => {
		const cases: Array<{
			name: string;
			configure: (root: string, parentRunId: string, childRunId: string) => SubagentState | undefined;
		}> = [
			{
				name: "running parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, parentState: "running" });
					return undefined;
				},
			},
			{
				name: "queued parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, parentState: "queued" });
					return undefined;
				},
			},
			{
				name: "paused parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, parentState: "paused" });
					return undefined;
				},
			},
			{
				name: "stopped parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, parentState: "stopped" });
					return undefined;
				},
			},
			{
				name: "rejected parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, parentState: "rejected" });
					return undefined;
				},
			},
			{
				name: "live child",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644", state: "running", stepStatus: "running" });
					writeWorkflowStatus({ parentRunId, childRunId });
					return undefined;
				},
			},
			{
				name: "pending child",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644", state: "running", stepStatus: "pending" });
					writeWorkflowStatus({ parentRunId, childRunId });
					return undefined;
				},
			},
			{
				name: "stopped child",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644", state: "stopped", stepStatus: "stopped" });
					writeWorkflowStatus({ parentRunId, childRunId });
					return undefined;
				},
			},
			{
				name: "missing session",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644", writeSession: false });
					writeWorkflowStatus({ parentRunId, childRunId });
					return undefined;
				},
			},
			{
				name: "foreign parent",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, sessionId: "other-session" });
					return undefined;
				},
			},
			{
				name: "duplicate status key",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, steps: [
						{ agent: "worker", workflowKey: "advisor", runId: childRunId, status: "complete" },
						{ agent: "worker", workflowKey: "advisor", runId: childRunId, status: "complete" },
					] });
					return undefined;
				},
			},
			{
				name: "workflow child mismatch",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({
						parentRunId,
						childRunId,
						workflowChildren: {
							version: 1,
							parentToolCallId: "tool-call",
							workflowRunId: parentRunId,
							inventoryComplete: true,
							workflowState: "completed",
							children: [{ childId: "advisor", runId: "other-child", state: "completed" }],
						},
					});
					return undefined;
				},
			},
			{
				name: "complete summary missing key",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({
						parentRunId,
						childRunId,
						workflowChildren: {
							version: 1,
							parentToolCallId: "tool-call",
							workflowRunId: parentRunId,
							inventoryComplete: true,
							workflowState: "completed",
							children: [],
						},
					});
					return undefined;
				},
			},
			{
				name: "unsafe child id",
				configure(root, parentRunId, childRunId) {
					writeWorkflowStatus({
						parentRunId,
						childRunId,
						steps: [{ agent: "worker", workflowKey: "advisor", runId: "../outside", status: "complete" }],
					});
					return undefined;
				},
			},
			{
				name: "whitespace child id",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({
						parentRunId,
						childRunId,
						steps: [{ agent: "worker", workflowKey: "advisor", runId: `${childRunId} `, status: "complete" }],
					});
					return undefined;
				},
			},
			{
				name: "malformed receipt",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					const asyncDir = writeWorkflowStatus({ parentRunId, childRunId });
					fs.writeFileSync(path.join(asyncDir, "workflow-receipt.json"), "{not-json", "utf-8");
					return undefined;
				},
			},
			{
				name: "malformed parent status",
				configure(root, parentRunId, childRunId) {
					writeRetainedChild({ root, childRunId, sessionId: "session-1644" });
					writeWorkflowStatus({ parentRunId, childRunId, malformed: true });
					return undefined;
				},
			},
		];

		for (const testCase of cases) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-workflow-resume-hint-${testCase.name.replaceAll(" ", "-")}-`));
			cleanupRoots.push(root);
			const { parentRunId, childRunId } = makeIds(testCase.name.replaceAll(" ", "-"));
			const state = testCase.configure(root, parentRunId, childRunId);
			const text = await runMissingReceiptResume({ root, parentRunId, state });
			assert.doesNotMatch(text, /Direct resumable child for workflow key/);
			cleanupRun(parentRunId);
			cleanupRun(childRunId);
		}
	});
});
