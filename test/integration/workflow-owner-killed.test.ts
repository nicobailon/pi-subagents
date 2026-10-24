import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, waitForAsyncState, ASYNC_DIR, tempDir, mockPi } from "../support/async-execution-fixture.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function pollFor<T>(label: string, read: () => T | undefined, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

type JournalRecord = { type: "start" | "settle"; key: string; runId?: string };
function readJournal(runId: string): JournalRecord[] {
	try {
		return fs.readFileSync(path.join(ASYNC_DIR, runId, "workflow-children.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as JournalRecord);
	} catch {
		return [];
	}
}

const terminal = (status: AsyncStatus) => status.state === "complete" || status.state === "failed";

/**
 * Runs a three-stage workflow in a separate host process and SIGKILLs the host once stage1's result
 * is journaled and stage2's background runner is live. `finish` releases stage2 and waits for its
 * runner, which outlives the host by design, so no process is left behind.
 */
function startKilledWorkflow(nonce: string, sessionId: string) {
	const release = path.join(tempDir, `${nonce}.release`);
	const script = `const first = await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); const second = await runs.run("stage2", { agent: "bg", task: "Stage two ${nonce}" }); const third = await runs.run("stage3", { agent: "echo", task: "Stage three ${nonce}" }); return { first: first.output, firstReused: first.reused === true, second: second.output, secondReused: second.reused === true, third: third.output };`;
	const args = { nonce };
	mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
	mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, waitForPath: release, output: "stage two done" });
	const callsBefore = mockPi.callCount();
	const hostOutput = path.join(tempDir, `${nonce}-host.json`);
	// The host inherits the test env: the same temp root and DIRS, the mock queue, and
	// PI_SUBAGENTS_TEST_PARENT_PID naming this test process, so its detached runner exits with the test.
	const host: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--import", pathToFileURL(path.join(repo, "test/support/register-loader.mjs")).href, path.join(repo, "test/support/killable-workflow-host.mjs"), tempDir, sessionId, JSON.stringify({ workflowScript: script, args, async: true, mission: false }), hostOutput], { cwd: repo, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
	let hostStderr = "";
	host.stderr?.on("data", (chunk) => { hostStderr += String(chunk); });
	const hostExited = once(host, "exit");
	let stage2RunId: string | undefined;
	const killed = (async () => {
		const launched = await pollFor("the host to launch the workflow", () => readJson<{ isError: boolean; text?: string; runId?: string }>(hostOutput), 30_000).catch((error: Error) => assert.fail(`${error.message}; host stderr: ${hostStderr}`));
		assert.equal(launched.isError, false, launched.text);
		const killedId = launched.runId!;
		const journal = await pollFor("settle(stage1) and start(stage2) in the host's journal", () => {
			const records = readJournal(killedId);
			return records.some((record) => record.type === "settle" && record.key === "stage1") && records.some((record) => record.type === "start" && record.key === "stage2") ? records : undefined;
		}, 30_000);
		stage2RunId = journal.find((record) => record.type === "start" && record.key === "stage2")?.runId;
		assert.ok(stage2RunId);
		await pollFor("stage2's child to start", () => mockPi.callCount() >= callsBefore + 2 ? true : undefined, 30_000);
		assert.equal(process.kill(host.pid!, "SIGKILL"), true);
		const [, signal] = await Promise.race([hostExited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("host did not exit after SIGKILL")), 10_000))]);
		assert.equal(signal, "SIGKILL");
		assert.equal((readJson<AsyncStatus>(path.join(ASYNC_DIR, killedId, "status.json")))?.state, "running", "a killed host leaves its run marked running");
		return { killedId, stage2RunId };
	})();
	const finish = async () => {
		fs.writeFileSync(release, "go");
		if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
		if (stage2RunId) await waitForAsyncState(stage2RunId, (status) => ["complete", "failed", "stopped", "paused"].includes(status.state), 30_000).catch(() => undefined);
	};
	return { script, args, release, callsBefore, killed, finish };
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Opens the session again in this process through the extension's session start, as `pi --session <file>` does. */
async function reopenSession(sessionFile: string, agentDir: string) {
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ customType?: string; content?: unknown }> = [];
	const pi = new Proxy({
		events: createEventBus(),
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		sendMessage(message: { customType?: string; content?: unknown }) { sent.push(message); },
		getSessionName() { return undefined; },
	}, { get: (target, prop) => prop in target ? target[prop as keyof typeof target] : () => undefined });
	const ctx = {
		...makeMinimalCtx(tempDir),
		isIdle: () => true,
		// Reopened with a UI, as `pi -c` does; a print run does not auto-resume. Every UI call does nothing.
		hasUI: true,
		ui: new Proxy({}, { get: () => () => undefined }),
		sessionManager: { getSessionId: () => path.basename(sessionFile), getSessionFile: () => sessionFile, getEntries: () => [], getBranch: () => [] },
	};
	const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, childEnv: process.env[SUBAGENT_CHILD_ENV] };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env[SUBAGENT_CHILD_ENV];
	try {
		registerSubagentExtension(pi as never);
	} finally {
		if (previous.childEnv !== undefined) process.env[SUBAGENT_CHILD_ENV] = previous.childEnv;
	}
	await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({ reason: "startup" }, ctx)));
	return {
		sent,
		close: async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
			if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		},
	};
}

describe("a workflow whose Pi process is killed", { skip: process.platform === "win32" ? "SIGKILL of a host process is POSIX-only here" : undefined }, () => {
	installAsyncExecutionHooks();

	it("reuses its finished child, re-attaches its running child, and launches the rest once after a SIGKILL", { timeout: 120_000 }, async () => {
		assert.ok(available && createSubagentExecutor, "fixture must not skip");
		const nonce = `owner-killed-${Date.now()}`;
		const run = startKilledWorkflow(nonce, `session-killed-${nonce}`);
		try {
			const { killedId, stage2RunId } = await run.killed;
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage: () => {} },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => path.join(tempDir, "sessions"),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo"), makeAgent("bg", { defaultAsync: true })] }),
			});
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => `session-relaunch-${nonce}`;
			mockPi.onCall({ matchArgIncludes: `Stage three ${nonce}`, output: "stage three done" });
			const relaunch = await executor.execute(`${nonce}-relaunch`, { workflowScript: run.script, args: run.args, async: true, mission: false, reuseFrom: killedId }, new AbortController().signal, undefined, ctx);
			assert.notEqual(relaunch.isError, true, relaunch.content[0]?.text);
			const relaunchId = relaunch.details.asyncId!;
			const killed = readJson<AsyncStatus>(path.join(ASYNC_DIR, killedId, "status.json"));
			assert.equal(killed?.state, "failed");
			assert.equal(killed?.workflow?.stopCause, "owner-exited");

			await waitForAsyncState(relaunchId, (status) => (status as AsyncStatus).workflow?.trace.some((entry) => entry.key === "stage2" && entry.state === "started") ?? false, 30_000);
			assert.equal(mockPi.callCount(), run.callsBefore + 2, "the relaunch launched nothing for stage1 or stage2");
			fs.writeFileSync(run.release, "go");
			const done = await waitForAsyncState(relaunchId, terminal, 60_000) as AsyncStatus;
			assert.equal(done.state, "complete", done.error);
			assert.equal(done.workflow?.reusedFrom, killedId);
			assert.deepEqual(done.workflow?.value, { first: "stage one done", firstReused: true, second: "stage two done", secondReused: true, third: "stage three done" });
			assert.equal(done.steps?.find((step) => step.workflowKey === "stage2")?.runId, stage2RunId, "stage2 is the same run, not a second copy");
			assert.equal(mockPi.callCount(), run.callsBefore + 3, "stage1 and stage2 ran once each, stage3 exactly once");
		} finally {
			await run.finish();
		}
	});

	it("resumes it once on its own when its session reopens after the SIGKILL", { timeout: 60_000 }, async () => {
		assert.ok(available && createSubagentExecutor, "fixture must not skip");
		// The input under test: with auto-resume off, nothing continues the killed run.
		const AUTO_RESUME = true;
		const nonce = `owner-killed-reopen-${Date.now()}`;
		const sessionFile = path.join(tempDir, `session-${nonce}.jsonl`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "echo.md"), "---\nname: echo\ndescription: Echoes\n---\nEcho the task.\n");
		fs.writeFileSync(path.join(agentDir, "agents", "bg.md"), "---\nname: bg\ndescription: Background echo\nasync: true\n---\nEcho the task.\n");
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ autoResume: AUTO_RESUME }));
		const run = startKilledWorkflow(nonce, sessionFile);
		let reopened: Awaited<ReturnType<typeof reopenSession>> | undefined;
		try {
			const { killedId } = await run.killed;
			mockPi.onCall({ matchArgIncludes: `Stage three ${nonce}`, output: "stage three done" });
			reopened = await reopenSession(sessionFile, agentDir);
			const resumedRuns = () => fs.readdirSync(ASYNC_DIR).filter((entry) => readJson<AsyncStatus>(path.join(ASYNC_DIR, entry, "status.json"))?.workflow?.resumeOrigin?.sourceRunId === killedId);
			const resumedId = await pollFor("the run that resumes the killed one", () => resumedRuns()[0], 30_000);
			assert.deepEqual(readJson<AsyncStatus>(path.join(ASYNC_DIR, resumedId, "status.json"))?.workflow?.resumeOrigin, { sourceRunId: killedId, attempt: 1 });

			await waitForAsyncState(resumedId, (status) => (status as AsyncStatus).workflow?.trace.some((entry) => entry.key === "stage2" && entry.state === "started") ?? false, 30_000);
			assert.equal(mockPi.callCount(), run.callsBefore + 2, "the resume launched nothing for stage1 or stage2");
			fs.writeFileSync(run.release, "go");
			const done = await waitForAsyncState(resumedId, terminal, 30_000) as AsyncStatus;
			assert.equal(done.state, "complete", done.error);
			assert.deepEqual(done.workflow?.value, { first: "stage one done", firstReused: true, second: "stage two done", secondReused: true, third: "stage three done" });
			assert.equal(mockPi.callCount(), run.callsBefore + 3, "stage3 ran exactly once");
			assert.deepEqual(resumedRuns(), [resumedId], "exactly one run continues it");

			const notices = () => reopened!.sent.filter((message) => message.customType === "subagent-notify" && typeof message.content === "string" && message.content.split("\n").includes(`Workflow run: ${killedId}`)).map((message) => String(message.content));
			const [notice] = await pollFor("the killed run's notice", () => notices().length > 0 ? notices() : undefined, 15_000);
			assert.match(notice!, new RegExp(`that ran workflow ${killedId} exited before the workflow finished\\.`));
			const lines = notice!.split("\n");
			assert.equal(lines[lines.indexOf(`Workflow run: ${killedId}`) + 1], `Auto-resumed as ${resumedId}.`);
			assert.equal(notices().length, 1, "one notice for the killed run");
		} finally {
			await reopened?.close();
			await run.finish();
		}
	});
});
