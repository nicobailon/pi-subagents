import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inspectSessionLease } from "../../src/runs/shared/session-lease.ts";

type Run = { asyncId: string; asyncDir: string };

export async function verifyRevival(
	tool: Parameters<ExtensionAPI["registerTool"]>[0],
	ctx: ExtensionContext,
	source: Run,
	waitForFile: (file: string, predicate: (text: string) => boolean) => Promise<void>,
	nextCompletion: (text: string) => Promise<void>,
): Promise<void> {
	assert.equal(JSON.parse(fs.readFileSync("/stage/startup-hook-ready.json", "utf8")).mode, "revival");
	const sourceStatus = JSON.parse(fs.readFileSync(`${source.asyncDir}/status.json`, "utf8"));
	const sessionFile: string = sourceStatus.steps[0].sessionFile;
	assert.ok(fs.existsSync(sessionFile));
	const initialLease = inspectSessionLease(sessionFile);
	assert.equal(initialLease.state, "free");
	const { canonicalSessionFile, canonicalSessionId } = initialLease;
	const root = path.dirname(source.asyncDir);
	const before = new Set(fs.readdirSync(root));
	const completed = nextCompletion("standalone child response verified REVIVAL_");
	// Establish a real owner first, then challenge it while its provider call holds the lease.
	const winnerLaunch = await tool.execute(
		"REVIVAL_A", { action: "resume", id: source.asyncId, message: "REVIVAL_A", acceptance: false, timeoutMs: 20000 },
		new AbortController().signal, undefined, ctx,
	);
	const winner = winnerLaunch.details as Run;
	const winnerStatus = JSON.parse(fs.readFileSync(`${winner.asyncDir}/status.json`, "utf8"));
	assert.notEqual(winnerStatus.pid, process.pid);
	assert.doesNotThrow(() => process.kill(winnerStatus.pid, 0));
	const lease = inspectSessionLease(sessionFile);
	assert.ok(lease.state === "owned");
	assert.equal(lease.canonicalSessionFile, canonicalSessionFile);
	assert.equal(lease.canonicalSessionId, canonicalSessionId);
	assert.equal(lease.owner.canonicalSessionFile, canonicalSessionFile);
	assert.equal(lease.owner.runId, winner.asyncId);
	assert.equal(lease.owner.sourceRunId, source.asyncId);
	assert.equal(lease.owner.parentSessionId, ctx.sessionManager.getSessionId());
	assert.equal(lease.owner.pid, winnerStatus.pid);
	await waitForFile("/stage/lifecycle.jsonl", (text) => text.trim().split("\n").map((line) => JSON.parse(line)).some((event) => event.event === "request" && event.pid === lease.owner.pid));
	const request = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "request" && event.pid === lease.owner.pid);
	assert.ok(JSON.stringify(request.messages).includes("standalone child response verified SINGLE"), "revival must load the actual previous SDK conversation");
	const refusal = await tool.execute(
		"REVIVAL_B", { action: "resume", id: source.asyncId, message: "REVIVAL_B", acceptance: false, timeoutMs: 20000 },
		new AbortController().signal, undefined, ctx,
	).then(() => assert.fail("a second revival must not acquire the owned session"), String);
	assert.ok(refusal.includes(`'${canonicalSessionFile}' is already owned by run '${winner.asyncId}'`), "a second revival must refuse the exact owned session and name its owner");
	fs.writeFileSync("/stage/revival-competition.json", JSON.stringify({ winner, refusal, owner: { runId: lease.owner.runId, sourceRunId: lease.owner.sourceRunId, pid: lease.owner.pid } }, null, 2));
	const contenders = fs.readdirSync(root).filter((name) => !before.has(name));
	assert.equal(contenders.length, 2, "both requests must reach independent configured runners");
	const losingId = contenders.find((id) => id !== winner.asyncId)!;
	await waitForFile(`${root}/${losingId}/process-terminal.json`, (text) => JSON.parse(text).state !== "pending");
	const losingTerminal = JSON.parse(fs.readFileSync(`${root}/${losingId}/process-terminal.json`, "utf8"));
	assert.equal(losingTerminal.state, "observed");
	const losingStatus = JSON.parse(fs.readFileSync(`${root}/${losingId}/status.json`, "utf8"));
	assert.equal(losingStatus.state, "failed");
	assert.notEqual(losingStatus.pid, winnerStatus.pid);
	assert.notEqual(losingStatus.processTerminal.runnerProcessInstanceId, winnerStatus.processTerminal.runnerProcessInstanceId);
	assert.throws(() => process.kill(losingStatus.pid, 0), { code: "ESRCH" });
	assert.ok(!fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).some((event) => event.pid === losingStatus.pid), "loser must not enter the provider/session");
	const retainedLease = inspectSessionLease(sessionFile);
	assert.ok(retainedLease.state === "owned", "loser cleanup must not release the winner's lease");
	assert.equal(retainedLease.canonicalSessionId, canonicalSessionId);
	assert.deepEqual(
		{ token: retainedLease.owner.token, runId: retainedLease.owner.runId, sourceRunId: retainedLease.owner.sourceRunId, parentSessionId: retainedLease.owner.parentSessionId, pid: retainedLease.owner.pid },
		{ token: lease.owner.token, runId: lease.owner.runId, sourceRunId: lease.owner.sourceRunId, parentSessionId: lease.owner.parentSessionId, pid: lease.owner.pid },
		"loser cleanup must not replace or release the winner's lease",
	);
	fs.writeFileSync("/stage/release", "go");
	await completed;
	await finish(winner, "complete", lease.owner.token);

	const failedCompletion = nextCompletion("fixture revival failure");
	const failedLaunch = await tool.execute("revival-failure", { action: "resume", id: winner.asyncId, message: "REVIVAL_FAIL", acceptance: false, timeoutMs: 20000 }, new AbortController().signal, undefined, ctx);
	const failed = failedLaunch.details as Run;
	await failedCompletion;
	await waitForFile(`${failed.asyncDir}/process-terminal.json`, (text) => JSON.parse(text).state !== "pending");
	const failedCandidate = JSON.parse(fs.readFileSync(`${failed.asyncDir}/process-terminal-candidate.json`, "utf8"));
	assert.equal(typeof failedCandidate.revivalLeaseToken, "string");
	await finish(failed, "failed", failedCandidate.revivalLeaseToken);
	assert.match(JSON.parse(fs.readFileSync(`${failed.asyncDir}/status.json`, "utf8")).error, /fixture revival failure/);
	fs.writeFileSync("/stage/revival-result.json", JSON.stringify({ source, winner, loser: losingId, failed, sessionFile }, null, 2));

	async function finish(run: Run, state: string, token: string): Promise<void> {
		await waitForFile(`${run.asyncDir}/process-terminal.json`, (text) => JSON.parse(text).state !== "pending");
		const status = JSON.parse(fs.readFileSync(`${run.asyncDir}/status.json`, "utf8"));
		const terminal = JSON.parse(fs.readFileSync(`${run.asyncDir}/process-terminal.json`, "utf8"));
		const candidate = JSON.parse(fs.readFileSync(`${run.asyncDir}/process-terminal-candidate.json`, "utf8"));
		assert.equal(status.state, state);
		assert.equal(status.sessionId, ctx.sessionManager.getSessionId());
		assert.equal(status.steps[0].sessionFile, sessionFile);
		assert.equal(terminal.state, "observed");
		assert.equal(terminal.canonicalSession.leaseDisposition, "released");
		assert.equal(terminal.canonicalSession.canonicalSessionLeaseReleased, true);
		assert.equal(candidate.revivalLeaseToken, token);
		assert.equal(candidate.revivalLeaseReleaseAcknowledged, true);
		assert.equal(inspectSessionLease(sessionFile).state, "free");
		assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
		const handshake = fs.readFileSync("/stage/handshake.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.runId === run.asyncId);
		assert.deepEqual(handshake.map((event) => [event.action, event.stateBefore]), [["ack", "ready"], ["confirm", "acknowledged"], ["proceed", "confirmed"]]);
		assert.ok(handshake.every((event) => event.tokenMatches && !event.childStartedBeforeCommit));
		const lifecycle = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.pid === status.pid);
		assert.deepEqual(lifecycle.map((event) => event.event), ["start", "request", "shutdown"]);
	}
}
