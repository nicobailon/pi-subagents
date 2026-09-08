import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../../src/agents/agents.ts";
import { executeAsyncChain } from "../../src/runs/background/async-execution.ts";
import { requestAsyncStop } from "../../src/runs/background/control-channel.ts";
import { resolveControlConfig } from "../../src/runs/shared/subagent-control.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../../src/shared/types.ts";

export async function verifySharedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: string,
	waitForFile: (file: string, predicate: (text: string) => boolean) => Promise<void>,
	completed: Promise<unknown>,
): Promise<void> {
	// Public workflows deliberately create independent runs. This existing private
	// execution seam exercises two SDK sessions inside ONE configured runner; it
	// does not restore the removed public chain API or invent another scheduler.
	const launch = executeAsyncChain(randomUUID(), {
		chain: [{ parallel: ["LEFT", "RIGHT"].map((task) => ({ agent: "binary-smoke", task, output: false, acceptance: false })) }],
		agents: discoverAgents(ctx.cwd, "project").agents,
		ctx: { pi, cwd: ctx.cwd, currentSessionId: ctx.sessionManager.getSessionId(), parentSessionId: ctx.sessionManager.getSessionId(), currentModel: ctx.model },
		artifactConfig: DEFAULT_ARTIFACT_CONFIG,
		artifactsDir: "/stage/shared-artifacts",
		shareEnabled: false,
		sessionRoot: "/stage/shared-sessions",
		maxSubagentDepth: 2,
		globalConcurrencyLimit: 2,
		controlConfig: resolveControlConfig(undefined, { enabled: true }),
		timeoutMs: 20000,
	});
	assert.notEqual(launch.isError, true, JSON.stringify(launch));
	fs.writeFileSync("/stage/launch.json", JSON.stringify(launch, null, 2));
	const { asyncId, asyncDir } = launch.details;
	assert.ok(asyncId && asyncDir);
	await waitForFile("/stage/lifecycle.jsonl", (text) => text.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "request").length === 2);
	const active = JSON.parse(fs.readFileSync(`${asyncDir}/status.json`, "utf8"));
	assert.equal(active.steps.length, 2);
	assert.equal(active.state, "running");
	// The provider's two held requests are the execution witness. The ordinary
	// status projection can lag them; it is not the authority for whether prompt
	// execution has begun. Neither held session may have shut down before stop.
	const held = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.pid === active.pid);
	assert.equal(held.filter((event) => event.event === "request").length, 2);
	assert.equal(held.filter((event) => event.event === "shutdown").length, 0);
	fs.writeFileSync("/stage/shared-active-witness.json", JSON.stringify({ pid: active.pid, heldRequests: 2, shutdowns: 0, projectedSteps: active.steps.map((step: { status: string }) => step.status) }));
	if (mode === "parallel-stop") fs.writeFileSync("/stage/parallel-control.json", JSON.stringify(requestAsyncStop(asyncDir)));
	else fs.writeFileSync("/stage/release", "go");
	await completed;
	await waitForFile(`${asyncDir}/process-terminal.json`, (text) => JSON.parse(text).state !== "pending");
	const status = JSON.parse(fs.readFileSync(`${asyncDir}/status.json`, "utf8"));
	const terminal = JSON.parse(fs.readFileSync(`${asyncDir}/process-terminal.json`, "utf8"));
	assert.equal(status.state, mode === "parallel-stop" ? "stopped" : "complete");
	assert.equal(status.sessionId, ctx.sessionManager.getSessionId());
	assert.equal(status.runId, asyncId);
	assert.equal(terminal.state, "observed");
	assert.equal(terminal.instances.length, 1, "one host process, no per-session CLI writers");
	assert.equal(terminal.instances[0].exitCode, 0);
	assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
	const lifecycle = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.pid !== process.pid);
	assert.ok(lifecycle.every((event) => event.pid === status.pid));
	const starts = lifecycle.filter((event) => event.event === "start");
	const shutdowns = lifecycle.filter((event) => event.event === "shutdown");
	assert.equal(starts.length, 2);
	assert.equal(shutdowns.length, 2);
	assert.equal(new Set(starts.map((event) => event.sessionId)).size, 2);
	assert.deepEqual(shutdowns.map((event) => event.sessionId).sort(), starts.map((event) => event.sessionId).sort());
	assert.ok(starts.every((event) => event.sdkIdentity && event.provider === "standalone-smoke" && event.model === "local"));
	if (mode === "shared-run") {
		const transcripts = status.steps.map((step: { transcriptPath: string }) => fs.readFileSync(step.transcriptPath, "utf8"));
		assert.ok(transcripts[0].includes("standalone child response verified LEFT"));
		assert.ok(transcripts[1].includes("standalone child response verified RIGHT"));
		const sessions = shutdowns.map((event) => fs.readFileSync(event.sessionFile, "utf8"));
		assert.equal(new Set(shutdowns.map((event) => event.sessionFile)).size, 2);
		for (const label of ["LEFT", "RIGHT"]) assert.equal(sessions.filter((text) => text.includes(`standalone child response verified ${label}`)).length, 1);
	} else {
		assert.ok(status.steps.every((step: { status: string }) => step.status === "stopped"));
	}
	fs.writeFileSync("/stage/shared-result.json", JSON.stringify({ asyncId, asyncDir, mode, sessions: starts.map((event) => event.sessionId), terminal }, null, 2));
}
