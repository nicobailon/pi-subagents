import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatRetainedChildren, listRetainedChildren } from "../../src/runs/background/retained-children.ts";

function writeRetainedRun(root: string, index: number, sessionId = "parent-a", parentWorkflowRunId: string | null = "workflow-a", state: "complete" | "failed" | "paused" = "complete"): void {
	const runId = `child-${index}`;
	const sessionFile = path.join(root, "sessions", `${runId}.jsonl`);
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "", "utf-8");
	const asyncDir = path.join(root, "runs", runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
		runId,
		sessionId,
		mode: "single",
		state,
		startedAt: index,
		endedAt: 1_000 + index,
		lastUpdate: 1_000 + index,
		...(parentWorkflowRunId ? { parentWorkflowRunId, workflowKey: `lane-${index}` } : {}),
		steps: [{
			agent: "worker",
			status: state,
			description: `  Task ${index}  with   spacing ${"x".repeat(140)}  `,
			endedAt: 1_000 + index,
			sessionFile,
			tokens: { input: index, output: index + 1, total: index * 2 + 1 },
		}],
	}), "utf-8");
}

describe("retained child roster", () => {
	it("returns only the newest 10 completed workflow children owned by the parent session", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retained-children-"));
		try {
			for (let index = 0; index < 12; index++) writeRetainedRun(root, index);
			writeRetainedRun(root, 50, "parent-b");
			writeRetainedRun(root, 51, "parent-a", null);
			writeRetainedRun(root, 52, "parent-a", "workflow-failed", "failed");

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");

			assert.equal(children.length, 10);
			assert.deepEqual(children.map((child) => child.runId), ["child-52", ...Array.from({ length: 9 }, (_, offset) => `child-${11 - offset}`)]);
			assert.equal(children[0]?.agent, "worker");
			assert.equal(children[0]?.completedAt, 1_052);
			assert.equal(children[0]?.state, "failed");
			assert.equal(children[0]?.parentRunId, "workflow-failed");
			assert.equal(children[0]?.workflowKey, "lane-52");
			assert.ok((children[0]?.taskSummary.length ?? 0) <= 120);
			assert.equal(children[0]?.taskSummary.startsWith("Task 52 with spacing"), true);
			assert.deepEqual(children[0]?.tokenTotals, { input: 52, output: 53, total: 105 });
			assert.match(formatRetainedChildren(children), /resume: subagent\(\{ action: "resume", id: "child-52", message: "\.\.\." \}\)/);
			assert.equal(children.some((child) => child.runId === "child-50" || child.runId === "child-51"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
