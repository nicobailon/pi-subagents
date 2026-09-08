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
	assert.equal(inspectSessionLease(sessionFile).state, "free");
	const root = path.dirname(source.asyncDir);
	const before = new Set(fs.readdirSync(root));
	const completed = nextCompletion("standalone child response verified REVIVAL_");
	// Public resume retains the model/session contract; model overrides are invalid.
	// Race two valid requests, then hold the winner's real provider call while the
	// other configured runner attempts to acquire the same canonical session.
	const attempts = await Promise.allSettled(["REVIVAL_A", "REVIVAL_B"].map((message) => tool.execute(
		message, { action: "resume", id: source.asyncId, message, acceptance: false, timeoutMs: 20000 },
		new AbortController().signal, undefined, ctx,
	)));
	const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
	const losers = attempts.filter((attempt) => attempt.status === "rejected");
	assert.equal(winners.length, 1, "exactly one revival may acquire the session");
	assert.equal(losers.length, 1);
	const winner = winners[0].value.details as Run;
	const lease = inspectSessionLease(sessionFile);
	assert.equal(lease.state, "owned");
	assert.ok(lease.state === "owned");
	assert.equal(lease.owner.runId, winner.asyncId);
	assert.equal(lease.owner.sourceRunId, source.asyncId);
	assert.equal(lease.owner.parentSessionId, ctx.sessionManager.getSessionId());
	assert.match(String(losers[0].reason), /already owned by run/);
	assert.ok(String(losers[0].reason).includes(winner.asyncId));
	fs.writeFileSync("/stage/revival-competition.json", JSON.stringify({ winner, refusal: String(losers[0].reason), owner: { runId: lease.owner.runId, sourceRunId: lease.owner.sourceRunId, pid: lease.owner.pid } }, null, 2));
	await waitForFile("/stage/lifecycle.jsonl", (text) => text.trim().split("\n").map((line) => JSON.parse(line)).some((event) => event.event === "request" && event.pid === lease.owner.pid));
	const request = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.event === "request" && event.pid === lease.owner.pid);
	assert.ok(JSON.stringify(request.messages).includes("standalone child response verified SINGLE"), "revival must load the actual previous SDK conversation");
	const contenders = fs.readdirSync(root).filter((name) => !before.has(name));
	assert.equal(contenders.length, 2, "both requests must reach independent configured runners");
	const losingId = contenders.find((id) => id !== winner.asyncId)!;
	await waitForFile(`${root}/${losingId}/process-terminal.json`, (text) => JSON.parse(text).state !== "pending");
	const losingTerminal = JSON.parse(fs.readFileSync(`${root}/${losingId}/process-terminal.json`, "utf8"));
	assert.equal(losingTerminal.state, "observed");
	const losingStatus = JSON.parse(fs.readFileSync(`${root}/${losingId}/status.json`, "utf8"));
	assert.throws(() => process.kill(losingStatus.pid, 0), { code: "ESRCH" });
	assert.equal(inspectSessionLease(sessionFile).state, "owned", "loser cleanup must not release the winner's lease");
	assert.ok(!fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).some((event) => event.pid === losingStatus.pid), "loser must not enter the provider/session");
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
		assert.deepEqual(handshake.map((event) => [event.action, event.stateBefore]), [["ack", "ready"], ["proceed", "acknowledged"]]);
		assert.ok(handshake.every((event) => event.tokenMatches && !event.childStartedBeforeCommit));
		const lifecycle = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.pid === status.pid);
		assert.deepEqual(lifecycle.map((event) => event.event), ["start", "request", "shutdown"]);
	}
}
