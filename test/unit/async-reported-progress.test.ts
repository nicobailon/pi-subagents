import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { formatAsyncRunList, listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

const LONG_REPORT = `[2/2] First child latest ${"x".repeat(600)}`;

function toolCall(id: string, message: string, isError = false): unknown[] {
	return [
		{ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: id, args: { reason: "progress_update", message } },
		{ type: "message_end", message: { role: "toolResult", toolName: "contact_supervisor", toolCallId: id, ...(isError ? { isError: true } : {}), content: [] } },
	];
}

describe("async reported progress", () => {
	it("persists each parallel child's latest successful first line in the restored status summary", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-reported-progress-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, "pending-first.json"), JSON.stringify({
			matchArgIncludes: "first task",
			jsonl: [...toolCall("first-a", "[1/2] First child begins\nnot displayed"), ...toolCall("first-b", `Progress: ${LONG_REPORT}`), ...toolCall("first-fail", "failed replacement", true)],
		}));
		fs.writeFileSync(path.join(queue, "pending-second.json"), JSON.stringify({
			matchArgIncludes: "second task",
			jsonl: toolCall("second-a", "UPDATE: Second child checking isolation\nnot displayed"),
		}));
		const fake = createFakeChildSessions(() => queue);
		const asyncDir = path.join(root, "runs", "progress-isolation");
		fs.mkdirSync(asyncDir, { recursive: true });
		const config: SubagentRunConfig = {
			id: "progress-isolation",
			steps: [{ parallel: [{ agent: "worker", task: "first task" }, { agent: "worker", task: "second task" }] }],
			resultPath: path.join(root, "result.json"), cwd: root, asyncDir, sessionId: "progress-test",
			artifactConfig: { enabled: false }, share: false, placeholder: "{previous}",
		};
		try {
			await runSubagent(config, fake.factory);
			const summary = listAsyncRuns(path.join(root, "runs"), { runId: config.id, sessionId: config.sessionId })[0];
			assert.ok(summary);
			assert.equal(summary.steps[0]?.progressText, LONG_REPORT.slice(0, 512));
			assert.equal(summary.steps[1]?.progressText, "Second child checking isolation");
			assert.ok(summary.steps.every((step) => typeof step.progressUpdatedAt === "number"));
			assert.doesNotMatch(formatAsyncRunList([summary]), /progress:/);
			const running = { ...summary, steps: summary.steps.map((step) => ({ ...step, status: "running" as const })) };
			assert.match(formatAsyncRunList([running]), /\| progress: Second child checking isolation$/m);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
