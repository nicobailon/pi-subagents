import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { listRetainedChildren } from "../../src/runs/background/retained-children.ts";

function writeRetainedRun(root: string, index: number, sessionId = "parent-a", parentWorkflowRunId: string | null = "workflow-a"): void {
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
		state: "complete",
		startedAt: index,
		endedAt: 1_000 + index,
		lastUpdate: 1_000 + index,
		...(parentWorkflowRunId ? { parentWorkflowRunId } : {}),
		steps: [{
			agent: "worker",
			status: "complete",
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

			const children = listRetainedChildren(path.join(root, "runs"), "parent-a");

			assert.equal(children.length, 10);
			assert.deepEqual(children.map((child) => child.runId), Array.from({ length: 10 }, (_, offset) => `child-${11 - offset}`));
			assert.equal(children[0]?.agent, "worker");
			assert.equal(children[0]?.completedAt, 1_011);
			assert.ok((children[0]?.taskSummary.length ?? 0) <= 120);
			assert.equal(children[0]?.taskSummary.startsWith("Task 11 with spacing"), true);
			assert.deepEqual(children[0]?.tokenTotals, { input: 11, output: 12, total: 23 });
			assert.equal(children.some((child) => child.runId === "child-50" || child.runId === "child-51"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
