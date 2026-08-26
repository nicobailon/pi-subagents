import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatRetainedChildren, listRetainedChildren } from "../../src/runs/background/retained-children.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";

interface WriteRunOptions {
	sessionId?: string;
	parentWorkflowRunId?: string | null;
	state?: "complete" | "failed" | "paused" | "stopped";
	stepStatus?: "complete" | "completed" | "failed" | "paused" | "stopped";
	sessionFile?: "present" | "missing" | "omitted";
	runner?: "external-cli" | "external-job";
	recoveryDescriptor?: "present" | "missing" | "invalid";
	recoverySourceRunId?: string;
	recoveryAgent?: string;
	recoveryCwd?: string;
}

function writeRetainedRun(root: string, index: number, options: WriteRunOptions = {}): void {
	const runId = `child-${index}`;
	const sessionFile = path.join(root, "sessions", `${runId}.jsonl`);
	if (options.sessionFile !== "missing" && options.sessionFile !== "omitted") {
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "", "utf-8");
	}
	const asyncDir = path.join(root, "runs", runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	const state = options.state ?? "complete";
	const stepStatus = options.stepStatus ?? state;
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId,
		sessionId: options.sessionId ?? "parent-a",
		mode: "single",
		state,
		startedAt: index,
		endedAt: 1_000 + index,
		lastUpdate: 1_000 + index,
		cwd: root,
		...(options.parentWorkflowRunId === null ? {} : { parentWorkflowRunId: options.parentWorkflowRunId ?? "workflow-a", workflowKey: `lane-${index}` }),
		steps: [{
			agent: "worker",
			status: stepStatus,
			description: `  Task ${index}  with   spacing ${"x".repeat(140)}  `,
			endedAt: 1_000 + index,
			...(options.runner === "external-cli" ? { runner: { type: "external-cli", command: "codex", args: [], promptDelivery: "stdin", capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false } } } : {}),
			...(options.runner === "external-job" ? { runner: { type: "external-job", provider: "surf-oracle", options: {}, capabilities: { stop: false, steer: false, resume: false, structuredOutput: false, toolEvents: false } } } : {}),
			...(options.sessionFile === "omitted" ? {} : { sessionFile }),
			tokens: { input: index, output: index + 1, total: index * 2 + 1 },
		}],
	}), "utf-8");
	updateActiveRunIndex(asyncDir, state);
	if (options.recoveryDescriptor === "invalid") {
		fs.writeFileSync(path.join(asyncDir, "recovery-descriptor.json"), JSON.stringify({
			version: 2,
			sourceRunId: runId,
			agent: "worker",
			cwd: options.recoveryCwd ?? root,
			systemPromptMode: "replace",
			outputMode: "inline",
		}), "utf-8");
	} else if (options.recoveryDescriptor !== "missing") {
		fs.writeFileSync(path.join(asyncDir, "recovery-descriptor.json"), JSON.stringify({
			version: 1,
			runFanoutBudget: createRunFanoutBudget(runId, 64),
			sourceRunId: options.recoverySourceRunId ?? runId,
			agent: options.recoveryAgent ?? "worker",
			cwd: options.recoveryCwd ?? root,
			systemPromptMode: "replace",
			inheritGlobalContext: false,
			inheritProjectContext: false,
			inheritSkills: false,
			outputMode: "inline",
			maxSubagentDepth: 2,
			share: false,
		}), "utf-8");
	}
}

describe("retained child roster", () => {
	it("returns terminal workflow children newest first and formats a 10-row roster", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-children-"));
		try {
			for (let index = 0; index < 12; index++) writeRetainedRun(root, index);
			writeRetainedRun(root, 50, { sessionId: "parent-b" });
			writeRetainedRun(root, 51, { parentWorkflowRunId: null });
			writeRetainedRun(root, 52, { parentWorkflowRunId: "workflow-failed", state: "failed" });

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");
			const formatted = formatRetainedChildren(children);

			assert.equal(children.length, 13);
			assert.deepEqual(children.map((child) => child.runId), ["child-52", ...Array.from({ length: 12 }, (_, offset) => `child-${11 - offset}`)]);
			assert.equal(formatted.match(/^- child-/gm)?.length, 10);
			assert.doesNotMatch(formatted, /^- child-2 /m);
			assert.equal(children[0]?.agent, "worker");
			assert.equal(children[0]?.completedAt, 1_052);
			assert.equal(children[0]?.state, "failed");
			assert.equal(children[0]?.parentRunId, "workflow-failed");
			assert.equal(children[0]?.workflowKey, "lane-52");
			assert.ok((children[0]?.taskSummary.length ?? 0) <= 120);
			assert.equal(children[0]?.taskSummary.startsWith("Task 52 with spacing"), true);
			assert.deepEqual(children[0]?.tokenTotals, { input: 52, output: 53, total: 105 });
			assert.equal(children[0]?.resumability.state, "resumable");
			assert.match(formatted, /resumability: resumable\n  session: .*child-52\.jsonl\n  resume: subagent\(\{ action: "resume", id: "child-52", message: "\.\.\." \}\)/);
			assert.equal(children.some((child) => child.runId === "child-50" || child.runId === "child-51"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps an older resumable child visible behind ten newer non-resumable children", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-children-"));
		try {
			writeRetainedRun(root, 0);
			for (let index = 1; index <= 10; index++) writeRetainedRun(root, index, { recoveryDescriptor: "missing" });

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");
			const formatted = formatRetainedChildren(children);

			assert.equal(children.length, 11);
			assert.deepEqual(children.map((child) => child.runId), Array.from({ length: 11 }, (_, offset) => `child-${10 - offset}`));
			assert.equal(formatted.match(/^- child-/gm)?.length, 10);
			assert.match(formatted, /resume: subagent\(\{ action: "resume", id: "child-0"/);
			assert.doesNotMatch(formatted, /No resumable retained child is listed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps non-resumable retained children visible with exact reasons", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-children-"));
		try {
			writeRetainedRun(root, 1, { sessionFile: "omitted" });
			writeRetainedRun(root, 2, { sessionFile: "missing" });
			writeRetainedRun(root, 3, { state: "stopped", stepStatus: "stopped" });
			writeRetainedRun(root, 4, { runner: "external-cli" });
			writeRetainedRun(root, 5, { recoveryDescriptor: "missing" });
			writeRetainedRun(root, 6, { recoveryDescriptor: "invalid" });
			writeRetainedRun(root, 7, { recoverySourceRunId: "other-run" });
			writeRetainedRun(root, 8, { recoveryAgent: "reviewer" });
			writeRetainedRun(root, 9, { runner: "external-job" });

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");
			const formatted = formatRetainedChildren(children);

			assert.deepEqual(children.map((child) => [child.runId, child.resumability]), [
				["child-9", { state: "not-resumable", reason: "external runner" }],
				["child-8", { state: "not-resumable", reason: "recovery descriptor belongs to agent reviewer" }],
				["child-7", { state: "not-resumable", reason: "recovery descriptor belongs to run other-run" }],
				["child-6", { state: "not-resumable", reason: `invalid recovery descriptor: Invalid async recovery descriptor '${path.join(root, "runs", "child-6", "recovery-descriptor.json")}': version must be 1.` }],
				["child-5", { state: "not-resumable", reason: "missing recovery descriptor" }],
				["child-4", { state: "not-resumable", reason: "external runner" }],
				["child-3", { state: "not-resumable", reason: "stopped run" }],
				["child-2", { state: "not-resumable", reason: `persisted session file is missing: ${path.join(root, "sessions", "child-2.jsonl")}` }],
				["child-1", { state: "not-resumable", reason: "no persisted session file" }],
			]);
			assert.match(formatted, /resumability: not resumable \(recovery descriptor belongs to agent reviewer\)/);
			assert.match(formatted, /resumability: not resumable \(recovery descriptor belongs to run other-run\)/);
			assert.match(formatted, /resumability: not resumable \(invalid recovery descriptor:/);
			assert.match(formatted, /resumability: not resumable \(missing recovery descriptor\)/);
			assert.match(formatted, /resumability: not resumable \(external runner\)/);
			assert.match(formatted, /resumability: not resumable \(stopped run\)/);
			assert.match(formatted, /resumability: not resumable \(no persisted session file\)/);
			assert.doesNotMatch(formatted, /resume: subagent/);
			assert.match(formatted, /No resumable retained child is listed\. Launch a same-role fallback challenge and label it as fallback\./);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise a retained child when its required cwd is missing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-children-missing-cwd-"));
		try {
			const missingCwd = path.join(root, "removed-worktree");
			writeRetainedRun(root, 1, { recoveryCwd: missingCwd });

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");
			const formatted = formatRetainedChildren(children);

			assert.equal(children[0]?.resumability.state, "not-resumable");
			assert.match(children[0]?.resumability.state === "not-resumable" ? children[0].resumability.reason : "", /required cwd is missing|resume dependency unavailable/);
			assert.doesNotMatch(formatted, /resume: subagent/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
