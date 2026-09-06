/**
 * Integration tests for the durable steer inbox of async WORKFLOW runs.
 *
 * `watchAsyncControlInbox` is installed only by subagent-runner.ts, and the runner never executes
 * workflow scripts, so before this fix no process consumed `control/steer-requests/` for a
 * workflow run: a queued request file sat on disk until the run ended and the requester's
 * "delivered" receipt was never backed by a delivery.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { events, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { requestAsyncSteer, steerInboxClosedPath, steerRequestsDir } from "../../src/runs/background/control-channel.ts";
import type { AsyncStatusPayload } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, ASYNC_DIR,
	createSubagentExecutor, waitForMockPiCall, waitForAsyncState, tempDir, mockPi,
	makeAsyncExecutor, readAsyncPayload,
} from "../support/async-execution-fixture.ts";

type SteeringTargets = { steering?: { recent: Array<{ id: string; targets: Array<{ index: number; state: string; reason?: string }> }> } };

function recentSteering(status: AsyncStatusPayload, requestId: string): { index: number; state: string; reason?: string } | undefined {
	return (status as SteeringTargets).steering?.recent?.find((request) => request.id === requestId)?.targets[0];
}

describe("async workflow steer inbox", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("delivers an inbox steer request to a live async workflow child", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const release = path.join(tempDir, "workflow-steer-release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("steered workflow child")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-workflow-steer";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const launch = await executor.execute(
			`workflow-steer-inbox-${Date.now().toString(36)}`,
			{ workflowScript: `return await runs.run("waits", { agent: "worker", task: "Wait for guidance" });`, async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const runId = launch.details?.asyncId as string;
		assert.ok(runId, "expected an async workflow run id");
		const asyncDir = path.join(ASYNC_DIR, runId);

		try {
			// The child is now live and parked on the release path, so the workflow run is genuinely
			// steerable: the only question is whether anything consumes its inbox.
			await waitForMockPiCall(mockPi, 0, 10_000);
			requestAsyncSteer(asyncDir, { message: "Focus on the failing test.", id: "workflow-steer-1", ts: Date.now() });

			const status = await waitForAsyncState(runId, (candidate) => recentSteering(candidate, "workflow-steer-1") !== undefined, 15_000);
			const target = recentSteering(status, "workflow-steer-1");
			assert.equal(target?.state, "delivered", `expected a real delivery, got ${JSON.stringify(target)}`);
			// The request file must be consumed, not left on disk for the life of the run.
			assert.deepEqual(fs.readdirSync(steerRequestsDir(asyncDir)), []);

			const steers = fs.readFileSync(path.join(mockPi.dir, "steers.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { text: string });
			assert.match(steers[0]?.text ?? "", /Focus on the failing test\./, "the live child must receive the steer text");

			const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.match(eventsText, /"type":"subagent\.steer\.routed"[^\n]*"requestId":"workflow-steer-1"/);
			assert.match(eventsText, /"type":"subagent\.steer\.delivered"[^\n]*"requestId":"workflow-steer-1"/);
		} finally {
			fs.writeFileSync(release, "go");
		}

		const payload = await readAsyncPayload(runId);
		assert.equal(payload.success, true);
	});

	it("settles a delivery still in flight when the workflow ends, instead of leaving it at routed", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const childRelease = path.join(tempDir, "inflight-child-release");
		const steerRelease = path.join(tempDir, "inflight-steer-release");
		// The child finishes as soon as childRelease appears, but its steer() stays unresolved until
		// steerRelease appears, so the delivery is guaranteed to still be in flight at teardown.
		mockPi.onCall({ steerWaitForPath: steerRelease, steps: [{ waitForPath: childRelease, jsonl: [events.assistantMessage("done")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-workflow-steer-inflight";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const launch = await executor.execute(
			`workflow-steer-inflight-${Date.now().toString(36)}`,
			{ workflowScript: `return await runs.run("waits", { agent: "worker", task: "Wait for guidance" });`, async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const runId = launch.details?.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);

		try {
			await waitForMockPiCall(mockPi, 0, 10_000);
			requestAsyncSteer(asyncDir, { message: "Held in flight.", id: "workflow-steer-inflight", ts: Date.now() });
			// Wait for the request to be consumed and routed, so the delivery is genuinely in flight.
			await waitForAsyncState(runId, (candidate) => recentSteering(candidate, "workflow-steer-inflight")?.state === "routed", 15_000);

			// Let the workflow finish while that delivery is still pending.
			fs.writeFileSync(childRelease, "go");
			await waitForAsyncState(runId, (candidate) => candidate.state === "complete", 15_000);

			// Now release the delivery. Teardown must still be holding persistence open for it.
			fs.writeFileSync(steerRelease, "go");
			const settled = await waitForAsyncState(
				runId,
				(candidate) => {
					const state = recentSteering(candidate, "workflow-steer-inflight")?.state;
					return state === "delivered" || state === "queued" || state === "failed";
				},
				15_000,
			);
			// The receipt must reach a terminal state. Left at "routed" it claims the steer is still being
			// delivered to a run that has already ended.
			assert.notEqual(recentSteering(settled, "workflow-steer-inflight")?.state, "routed");
		} finally {
			if (!fs.existsSync(childRelease)) fs.writeFileSync(childRelease, "go");
			if (!fs.existsSync(steerRelease)) fs.writeFileSync(steerRelease, "go");
		}
	});

	it("closes the inbox and fails a late steer request when the workflow ends", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-workflow-steer-closed";
		const executor = makeAsyncExecutor([]);

		const launch = await executor.execute(
			`workflow-steer-closed-${Date.now().toString(36)}`,
			{ workflowScript: "return 'done'", async: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const runId = launch.details?.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);

		await waitForAsyncState(runId, (candidate) => candidate.state === "complete", 15_000);
		// A terminal run must refuse new steering rather than accept a request nothing will read.
		assert.equal(fs.existsSync(steerInboxClosedPath(asyncDir)), true, "the steer inbox must be closed at teardown");
		assert.throws(
			() => requestAsyncSteer(asyncDir, { message: "Too late.", id: "workflow-steer-late", ts: Date.now() }),
			/no longer accepts steering requests/,
		);
	});
});
