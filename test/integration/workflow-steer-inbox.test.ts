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
import type { SteeringStatus } from "../../src/shared/types.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, ASYNC_DIR,
	createSubagentExecutor, waitForMockPiCall, waitForAsyncState, tempDir, mockPi,
	makeAsyncExecutor, readAsyncPayload, RESULTS_DIR, waitForAsyncEvent,
} from "../support/async-execution-fixture.ts";

type SteeringTargets = { steering?: { recent: Array<{ id: string; targets: Array<{ index: number; state: string; reason?: string }> }> } };

function recentSteering(status: AsyncStatusPayload, requestId: string): { index: number; state: string; reason?: string } | undefined {
	return (status as SteeringTargets).steering?.recent?.find((request) => request.id === requestId)?.targets[0];
}

describe("async workflow steer inbox", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	for (const outcome of ["complete", "failed", "stopped"]) it(`settles steering without terminal status when result index publication fails (${outcome})`, { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const release = path.join(tempDir, "index-failure-release");
		const indexPath = path.join(RESULTS_DIR, "result-index");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("done")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-index-steering";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);
		const launch = await executor.execute("index-steering", {
			workflowScript: `await runs.run("A", { agent: "worker", task: "Wait" }); ${outcome === "failed" ? 'throw new Error("script failed")' : 'return "done"'}`,
			async: true,
		}, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined);
		const runId = launch.details!.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);
		await waitForMockPiCall(mockPi, 0, 10_000);
		const session = mockPi.sessions[0]!.session!;
		const originalSteer = session.steer;
		let entered = false;
		let releaseSteer!: () => void;
		const blocked = new Promise<void>((resolve) => { releaseSteer = resolve; });
		session.steer = async () => { entered = true; await blocked; };
		try {
			requestAsyncSteer(asyncDir, { id: "queued", message: "later", mode: "follow_up" });
			requestAsyncSteer(asyncDir, { id: "unresolved", message: "pending" });
			await waitForAsyncState(runId, (candidate) => entered && recentSteering(candidate, "queued")?.state === "queued" && recentSteering(candidate, "unresolved")?.state === "routed", 15_000);
			fs.rmSync(indexPath, { recursive: true, force: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(indexPath, "not a directory");
			if (outcome === "stopped") {
				const stop = await executor.execute("stop-index-steering", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx);
				assert.notEqual(stop.isError, true);
			} else fs.writeFileSync(release, "go");
			await waitForAsyncEvent(runId, "subagent.workflow.result_write_failed");
			const before = fs.readFileSync(path.join(asyncDir, "status.json"), "utf8");
			const status = JSON.parse(before) as { state: string; endedAt?: number; activityState?: string; steering: SteeringStatus };
			assert.equal(status.state, "running", "failed index publication cannot authorize terminal status");
			assert.equal(status.endedAt, undefined);
			assert.equal(status.activityState, "needs_attention");
			assert.equal(status.steering.pending, 0);
			assert.equal(status.steering.failed, 2);
			assert.equal(status.steering.delivered, 0);
			assert.ok(status.steering.recent.every((request) => request.targets[0]?.state === "failed" && request.targets[0].reason === `run became ${outcome} before steering delivery settled; delivery unconfirmed`));
			assert.equal(fs.existsSync(path.join(ASYNC_DIR, ".active-runs", runId)), true);
			assert.equal(fs.existsSync(path.join(RESULTS_DIR, `${runId}.json`)), false);
			assert.equal(fs.existsSync(path.join(RESULTS_DIR, "result-pending", "session-index-steering", `${runId}.json`)), true);
			const unpublished = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "result-pending", "session-index-steering", `${runId}.json`), "utf8"));
			assert.equal(unpublished.state, outcome, "computed outcome is retained only in unpublished result");
			if (outcome !== "complete") assert.equal(unpublished.activityState, "needs_attention", "failure finalization preserves steering attention");
			assert.equal(fs.existsSync(steerInboxClosedPath(asyncDir)), true);
			const journal = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
			assert.equal(journal.split("\n").filter((line) => line.includes('"type":"subagent.steer.failed"')).length, 2);
			assert.doesNotMatch(journal, /"type":"subagent.workflow.completed"/);
			releaseSteer();
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), before);
			assert.equal(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"), journal);
		} finally {
			session.steer = originalSteer;
			releaseSteer();
			fs.writeFileSync(release, "go");
			fs.rmSync(indexPath, { recursive: true, force: true });
		}
	});

	for (const shutdown of [false, true]) it(`accounts for 21 same-scan requests beyond display history (${shutdown ? "shutdown" : "delivered"})`, { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const release = path.join(tempDir, "batch-accounting-release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("done")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-batch-accounting";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);
		const launch = await executor.execute("batch-accounting", { workflowScript: `return await runs.run("A", { agent: "worker", task: "Wait" });`, async: true }, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined);
		const runId = launch.details!.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);
		await waitForMockPiCall(mockPi, 0, 10_000);
		const session = mockPi.sessions[0]!.session!;
		const originalSteer = session.steer.bind(session);
		const originalFollowUp = session.followUp.bind(session);
		let releaseSteers!: () => void;
		const blocked = new Promise<void>((resolve) => { releaseSteers = resolve; });
		let calls = 0;
		session.followUp = async (text) => {
			calls++;
			assert.deepEqual(fs.readdirSync(steerRequestsDir(asyncDir)), []);
			await originalFollowUp(text);
		};
		session.steer = async (text) => {
			calls++;
			assert.deepEqual(fs.readdirSync(steerRequestsDir(asyncDir)), [], "entire batch consumed before first delivery callback");
			if (shutdown) await blocked;
			else await originalSteer(text);
		};
		const accounting = (candidate: AsyncStatusPayload) => (candidate as { steering?: SteeringStatus }).steering;
		try {
			for (let index = 0; index < 21; index++) requestAsyncSteer(asyncDir, { id: `batch-${index}`, message: `batch-${index}`, targetIndex: 0, ts: index + 1, ...(shutdown && (index === 0 || index === 20) ? { mode: "follow_up" as const } : {}) });
			const active = await waitForAsyncState(runId, (candidate) => calls === 21 && accounting(candidate)?.recent.every((request) => request.targets[0]?.state === (shutdown ? request.id === "batch-20" ? "queued" : "routed" : "delivered")) === true, 15_000);
			assert.equal(accounting(active)!.requested, 21);
			assert.equal(accounting(active)!.pending, shutdown ? 21 : 0, "queued acknowledgments still count once as pending");
			if (shutdown) {
				const queuedEvents = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "subagent.steer.queued");
				assert.deepEqual(queuedEvents.map((event) => event.requestId), ["batch-0", "batch-20"], "both evicted and retained queued receipts remain pending");
			}
			assert.equal(accounting(active)!.recent.length, 20);
			assert.equal(accounting(active)!.recent.some((request) => request.id === "batch-0"), false, "first unresolved receipt was evicted");
			fs.writeFileSync(release, "go");
			const terminal = await waitForAsyncState(runId, (candidate) => candidate.state === "complete", 15_000);
			const counters = accounting(terminal)!;
			assert.equal(counters.pending, 0);
			assert.equal(counters.delivered, shutdown ? 0 : 21);
			assert.equal(counters.failed, shutdown ? 21 : 0);
			assert.equal(counters.recent.length, 20, "history cap must not grow");
			if (shutdown) assert.ok(counters.recent.every((request) => request.targets[0]?.state === "failed" && request.targets[0].reason?.includes("delivery unconfirmed")));
			const before = fs.readFileSync(path.join(asyncDir, "status.json"), "utf8");
			const journal = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
			const terminalEvents = journal.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.requestId?.startsWith("batch-") && event.type === `subagent.steer.${shutdown ? "failed" : "delivered"}`);
			assert.equal(terminalEvents.length, counters.delivered + counters.failed);
			assert.equal(new Set(terminalEvents.map((event) => event.requestId)).size, 21, "every request has exactly one terminal event");
			releaseSteers();
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), before);
			assert.equal(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"), journal);
		} finally {
			session.steer = originalSteer;
			session.followUp = originalFollowUp;
			releaseSteers();
			fs.writeFileSync(release, "go");
		}
	});

	for (const stop of [false, true]) it(`settles consumed pending deliveries before ${stop ? "stop" : "completion"} and ignores late callbacks`, { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const release = path.join(tempDir, "pending-steer-release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("done")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-pending-steer";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);
		const launch = await executor.execute("pending-steer", { workflowScript: `return await runs.run("A", { agent: "worker", task: "Wait" });`, async: true }, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined);
		const runId = launch.details!.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);
		await waitForMockPiCall(mockPi, 0, 10_000);
		const session = mockPi.sessions[0]!.session!;
		const originalSteer = session.steer;
		let settle!: () => void;
		let entered = false;
		session.steer = async () => {
			entered = true;
			await new Promise<void>((resolve, reject) => { settle = stop ? () => reject(new Error("late rejection")) : resolve; });
		};
		try {
			requestAsyncSteer(asyncDir, { id: "pending", message: "pending", targetIndex: 0 });
			await waitForAsyncState(runId, (candidate) => entered && recentSteering(candidate, "pending")?.state === "routed", 15_000);
			assert.deepEqual(fs.readdirSync(steerRequestsDir(asyncDir)), [], "pending request is consumed, not available to file drain");
			if (stop) {
				requestAsyncSteer(asyncDir, { id: "file-resident", message: "not consumed", targetIndexes: [0, 99] });
				const stopped = await executor.execute("stop-pending", { action: "stop", id: runId }, new AbortController().signal, undefined, ctx);
				assert.notEqual(stopped.isError, true, stopped.content[0]?.text);
			} else fs.writeFileSync(release, "go");
			const terminal = await waitForAsyncState(runId, (candidate) => candidate.state === (stop ? "stopped" : "complete"), 15_000);
			assert.equal(recentSteering(terminal, "pending")?.state, "failed");
			assert.match(recentSteering(terminal, "pending")!.reason!, /before steering delivery settled/);
			assert.equal(fs.existsSync(steerInboxClosedPath(asyncDir)), true);
			if (stop) {
				const targets = (terminal as SteeringTargets).steering!.recent.find((request) => request.id === "file-resident")!.targets;
				assert.deepEqual(targets.map(({ index, state }) => [index, state]), [[0, "failed"], [99, "failed"]]);
				assert.ok(targets.every(({ reason }) => reason?.includes("before steering request was consumed")));
			}
			const before = fs.readFileSync(path.join(asyncDir, "status.json"), "utf8");
			const journalBefore = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
			assert.equal(journalBefore.split("\n").filter((line) => line.includes('"type":"subagent.steer.failed"') && line.includes('"requestId":"pending"')).length, 1);
			settle();
			await new Promise((resolve) => setTimeout(resolve, 350));
			assert.equal(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"), before, "late callback must not rewrite durable terminal state");
			assert.equal(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8"), journalBefore, "late callback must not append contradictory evidence");
		} finally {
			session.steer = originalSteer;
			settle?.();
			fs.writeFileSync(release, "go");
		}
	});

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
			requestAsyncSteer(asyncDir, { message: "Follow up later", id: "workflow-follow-up", mode: "follow_up" });
			const queued = await waitForAsyncState(runId, (candidate) => recentSteering(candidate, "workflow-follow-up")?.state === "queued", 15_000);
			const counters = (queued as { steering: SteeringStatus }).steering;
			assert.equal(counters.requested, 2);
			assert.equal(counters.delivered, 1);
			assert.equal(counters.pending, 1, "routed to queued must not double-count the pending target");
		} finally {
			fs.writeFileSync(release, "go");
		}

		const payload = await readAsyncPayload(runId);
		assert.equal(payload.success, true);
		const terminal = await waitForAsyncState(runId, (candidate) => candidate.state === "complete", 15_000);
		const counters = (terminal as { steering: SteeringStatus }).steering;
		assert.equal(counters.pending, 0);
		assert.equal(counters.delivered, 1);
		assert.equal(counters.failed, 1);
		assert.equal(recentSteering(terminal, "workflow-follow-up")?.state, "failed");
		assert.match(recentSteering(terminal, "workflow-follow-up")!.reason!, /delivery unconfirmed/);
	});

	for (const parallel of [false, true]) it(`routes every explicit target without sibling fallback (${parallel ? "parallel" : "sequential"})`, { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const releaseA = path.join(tempDir, "target-release-a");
		const releaseB = path.join(tempDir, "target-release-b");
		mockPi.onCall({ steps: [{ waitForPath: releaseA, jsonl: [events.assistantMessage("A done")] }] });
		mockPi.onCall({ steps: [{ waitForPath: releaseB, jsonl: [events.assistantMessage("B done")] }] });
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionId = () => "session-workflow-targets";
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);
		const launch = await executor.execute("workflow-targets", {
			workflowScript: parallel
				? `return await Promise.all([runs.run("A", { agent: "worker", task: "A" }), runs.run("B", { agent: "worker", task: "B" })]);`
				: `await runs.run("A", { agent: "worker", task: "A" }); return await runs.run("B", { agent: "worker", task: "B" });`,
			async: true,
		}, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const runId = launch.details?.asyncId as string;
		const asyncDir = path.join(ASYNC_DIR, runId);
		const deliveredTexts = (): string[] => {
			const file = path.join(mockPi.dir, "steers.jsonl");
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text) : [];
		};
		const check = async (id: string, address: { targetIndex?: number; targetIndexes?: number[] }, expected: Array<[number, string]>, deliveries: number, alreadyWritten = false) => {
			if (!alreadyWritten) requestAsyncSteer(asyncDir, { id, message: id, ...address });
			const status = await waitForAsyncState(runId, (candidate) => {
				const targets = (candidate as SteeringTargets).steering?.recent.find((request) => request.id === id)?.targets;
				return targets !== undefined && targets.every((target) => target.state === "delivered" || target.state === "failed");
			}, 15_000);
			const targets = (status as SteeringTargets).steering!.recent.find((request) => request.id === id)!.targets;
			assert.deepEqual(targets.map(({ index, state }) => [index, state]), expected);
			assert.equal(deliveredTexts().filter((text) => text.includes(id)).length, deliveries);
			const journal = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.requestId === id);
			assert.equal(journal.filter((event) => event.type === "subagent.steer.requested").length, 1);
			for (const [index, state] of expected) assert.equal(journal.filter((event) => event.index === index && event.type === `subagent.steer.${state}`).length, 1);
			return targets;
		};
		try {
			await waitForMockPiCall(mockPi, 0, 10_000);
			// Hold a transport-written request outside the watched inbox until A disappears.
			// This controls queue-to-consumption delay without changing the watcher or child lifecycle.
			const heldDir = path.join(tempDir, "held-steer");
			if (!parallel) {
				requestAsyncSteer(heldDir, { id: "disappeared-A", message: "disappeared-A", targetIndex: 0 });
				fs.writeFileSync(releaseA, "go");
			}
			await waitForMockPiCall(mockPi, 1, 10_000);
			await waitForAsyncState(runId, (candidate) => (candidate.steps?.length ?? 0) === 2, 15_000);
			if (parallel) {
				const targets = await check("ambiguous", {}, [[0, "failed"]], 0);
				assert.match(targets[0]!.reason!, /2 live children/);
			} else {
				for (const file of fs.readdirSync(steerRequestsDir(heldDir))) fs.renameSync(path.join(steerRequestsDir(heldDir), file), path.join(steerRequestsDir(asyncDir), file));
				await check("disappeared-A", {}, [[0, "failed"]], 0, true);
				const targets = await check("dead-A", { targetIndex: 0 }, [[0, "failed"]], 0);
				assert.match(targets[0]!.reason!, /not live/);
				await check("unique-B", {}, [[1, "delivered"]], 1);
			}
			await check("aggregate", { targetIndexes: [0, 1] }, [[0, parallel ? "delivered" : "failed"], [1, "delivered"]], parallel ? 2 : 1);
			if (parallel) {
				const deliveries = fs.readFileSync(path.join(mockPi.dir, "steers.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { text: string; sessionId: string });
				assert.equal(new Set(deliveries.filter(({ text }) => text.includes("aggregate")).map(({ sessionId }) => sessionId)).size, 2, "aggregate must reach two distinct children");
			}
			await check("out-of-range", { targetIndex: 99 }, [[99, "failed"]], 0);
			await check("mixed-range", { targetIndexes: [1, 99] }, [[1, "delivered"], [99, "failed"]], 1);
		} finally {
			fs.writeFileSync(releaseA, "go");
			fs.writeFileSync(releaseB, "go");
		}
		assert.equal((await readAsyncPayload(runId)).success, true);
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
