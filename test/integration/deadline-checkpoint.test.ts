import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import type { AsyncStatusPayload } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, createSubagentExecutor,
	ASYNC_DIR, tempDir, mockPi, makeAsyncExecutor, readAsyncPayload,
	waitForAsyncState, waitForAsyncResultFile,
} from "../support/async-execution-fixture.ts";

type CheckpointStatus = AsyncStatusPayload & {
	steering?: { recent: Array<{ id: string; source?: string; targets: Array<{ state: string }> }> };
};

function checkpoint(status: AsyncStatusPayload) {
	return (status as CheckpointStatus).steering?.recent.find((request) => request.source === "deadline-checkpoint");
}

function journal(id: string): Array<{ type: string; requestId?: string; source?: string }> {
	return fs.readFileSync(path.join(ASYNC_DIR, id, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("async single-agent deadline checkpoint lifecycle", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	for (const outcome of ["handoff", "timeout"] as const) {
		it(`propagates ${outcome === "handoff" ? "call override" : "config default"} through the executor and runner: ${outcome}`, {
			skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined,
			timeout: 30_000,
		}, async () => {
			const release = path.join(tempDir, "checkpoint-release");
			mockPi.onCall({
				...(outcome === "handoff"
					? { queuedInputReleasePath: release }
					: { steps: [{ waitForPath: release, jsonl: [events.assistantMessage("current work complete")] }] }),
				queuedMessageOutput: "Checkpoint handoff: changed files, tests, remaining work, commit state.",
			});
			// The overridden default would disarm the checkpoint entirely if call precedence broke.
			const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })], {
				checkpointBeforeDeadlineMs: outcome === "handoff" ? 20_000 : 5_000,
			});
			const result = await executor.execute(`checkpoint-${outcome}`, {
				agent: "worker", task: "Explore the repository", async: true, clarify: false,
				timeoutMs: 10_000,
				...(outcome === "handoff" ? { checkpointBeforeDeadlineMs: 5_000 } : {}),
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			const id = result.details?.asyncId;
			assert.ok(id, "expected an async launch");
			const queued = await waitForAsyncState(id, (status) => checkpoint(status)?.targets[0]?.state === "queued");
			assert.equal(queued.state, "running");
			const request = checkpoint(queued)!;
			const steers = fs.readFileSync(path.join(mockPi.dir, "steers.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(steers.length, 1);
			assert.equal(steers[0].mode, "steer");
			assert.match(steers[0].text, /Deadline checkpoint from the runner/);
			assert.match(steers[0].text, /Finish the current tool call only/);
			assert.match(steers[0].text, /changed files, build\/test state, remaining work, and commit\/PR state/);
			// Consume only after the runner has acknowledged the queued request. No
			// assistant or terminal event precedes this synchronized boundary.
			if (outcome === "handoff") fs.writeFileSync(release, "continue");
			await waitForAsyncResultFile(id, 15_000);
			const payload = await readAsyncPayload(id);
			const terminal = await waitForAsyncState(id, (status) => status.state !== "running");
			if (outcome === "handoff") {
				assert.equal(payload.success, true, payload.error);
				assert.match(payload.results[0]?.output ?? "", /^Checkpoint handoff:/);
				assert.notEqual(payload.timedOut, true);
				assert.equal(checkpoint(terminal)?.targets[0]?.state, "delivered");
			} else {
				assert.equal(payload.success, false);
				assert.equal(payload.timedOut, true);
				assert.equal(payload.results[0]?.timedOut, true);
				assert.equal(checkpoint(terminal)?.targets[0]?.state, "failed");
			}
			const receipts = journal(id).filter((event) => event.requestId === request.id);
			assert.equal(receipts.filter((event) => event.type === "subagent.steer.requested").length, 1);
			assert.equal(receipts.filter((event) => event.type === "subagent.steer.queued").length, 1);
			assert.equal(receipts.filter((event) => event.type === `subagent.steer.${outcome === "handoff" ? "delivered" : "failed"}`).length, 1);
			assert.equal(receipts.filter((event) => event.type === `subagent.steer.${outcome === "handoff" ? "failed" : "delivered"}`).length, 0);
		});
	}

	it("cleans up after early completion without issuing a late checkpoint or timeout", {
		skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined,
		timeout: 25_000,
	}, async () => {
		mockPi.onCall({ output: "finished early" });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);
		const result = await executor.execute("checkpoint-early", {
			agent: "worker", task: "Explore the repository", async: true, clarify: false,
			timeoutMs: 8_000, checkpointBeforeDeadlineMs: 3_000,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		const id = result.details?.asyncId;
		assert.ok(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "finished early");
		const terminal = await waitForAsyncState(id, (status) => status.state === "complete");
		assert.ok(terminal.deadlineAt);
		assert.ok(Date.now() < terminal.deadlineAt - 3_000, "child must finish before checkpoint is due");
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, terminal.deadlineAt! - Date.now()) + 300));
		// Process-terminal bookkeeping may arrive later; no checkpoint steering may occur.
		assert.deepEqual(journal(id).filter((event) => event.type.startsWith("subagent.steer.")), [], "no checkpoint steering after early completion");
		assert.equal(checkpoint(await waitForAsyncState(id, (status) => status.state === "complete")), undefined);
		assert.equal(fs.existsSync(path.join(mockPi.dir, "steers.jsonl")), false);
		assert.notEqual((await readAsyncPayload(id)).timedOut, true);
		assert.ok(terminal.pid);
		assert.throws(() => process.kill(terminal.pid!, 0), { code: "ESRCH" }, "runner exits rather than waiting for timers");
	});
});
