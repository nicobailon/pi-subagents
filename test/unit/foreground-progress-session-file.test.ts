import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

function replyingFactory(): ChildSessionFactory {
	let listener: ((event: ChildSessionEvent) => void) | undefined;
	const session: ChildSession = {
		subscribe(callback) { listener = callback; return () => {}; },
		async prompt() {
			listener?.({ type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: { path: "x" } });
			listener?.({ type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", content: [] } });
			listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} } });
		},
		async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
		messages: [], sessionId: "progress-session-file", modelId: "mock/test-model",
	};
	return { async create() { return session; }, async dispose() {}, async disposeForParent() {} };
}

async function progressRows(sessionFile: string | undefined): Promise<AgentProgress[]> {
	const rows: AgentProgress[] = [];
	await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "read x", {
		childSessionFactory: replyingFactory(),
		...(sessionFile ? { sessionFile } : {}),
		onUpdate: (update) => {
			const progress = update.details.progress?.[0];
			if (progress) rows.push(progress);
		},
	});
	return rows;
}

describe("foreground progress session file", () => {
	it("names the child's session file in every progress update, from the first", async () => {
		const sessionFile = join(mkdtempSync(join(tmpdir(), "pi-subagents-")), "run-0", "session.jsonl");

		const rows = await progressRows(sessionFile);

		assert.ok(rows.length > 0);
		assert.deepEqual(rows.map((row) => row.sessionFile), rows.map(() => sessionFile));
	});

	it("leaves the field out for a child without a session file", async () => {
		const rows = await progressRows(undefined);

		assert.ok(rows.length > 0);
		assert.ok(rows.every((row) => !("sessionFile" in row)));
	});
});
