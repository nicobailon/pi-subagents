/** A reopened or reloaded session relaunches its own interrupted async workflows once, off session start. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";
import { DIRS, type AsyncStatus } from "../../src/shared/types.ts";
import { writeWorkflowLaunchRecord, type WorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { readWorkflowResumeClaim } from "../../src/workflows/workflow-resume-claim.ts";
import { resolveWorkflowResource } from "../../src/workflows/workflow-resources.ts";
import { registerWorkflowResource } from "../../src/api/workflow-resources.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installSingleExecutionHooks, mockPi, tempDir } from "../support/single-execution-fixture.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details: { asyncId?: string; asyncDir?: string } };
type Tool = { execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: unknown): Promise<ToolResult> };
type SentMessage = { message: { customType?: string; content?: unknown; display?: boolean }; options?: { triggerTurn?: boolean } };

const terminalStates = ["complete", "failed", "partial", "paused", "stopped", "rejected"];
/** The completion owner a Pi process that has since exited wrote into its runs; never this process's. */
const DEAD_PI_COMPLETION_OWNER = "completion-owner-of-an-exited-pi";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const readStatusFile = (runId: string) => {
	try {
		// SAFETY: the executor and the reconciler write these status.json files from AsyncStatus values.
		return JSON.parse(fs.readFileSync(path.join(DIRS.async, runId, "status.json"), "utf-8")) as AsyncStatus;
	} catch {
		return undefined;
	}
};
const waitUntil = async <T>(label: string, read: () => T | undefined | false, timeoutMs = 20_000): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};
/** Runs that resumed `sourceRunId`. */
const resumedRuns = (sourceRunId: string) => fs.readdirSync(DIRS.async)
	.filter((entry) => readStatusFile(entry)?.workflow?.resumeOrigin?.sourceRunId === sourceRunId);
const claimFiles = (runId: string) => fs.readdirSync(path.join(DIRS.async, runId)).filter((name) => name.startsWith("resumed-by.")).sort();
/** The completion notices delivered for `runId`. */
const noticesFor = (sent: SentMessage[], runId: string) => sent
	.filter((entry) => entry.message.customType === "subagent-notify" && typeof entry.message.content === "string" && entry.message.content.split("\n").includes(`Workflow run: ${runId}`))
	.map((entry) => entry.message.content as string);
/** Every line of a notice that says how the run continues or tells the reader what to do with it. */
const nextSteps = (notice: string) => notice.split("\n").filter((line) => /Auto-resumed as |Resumed as |Relaunched as |Not auto-resumed: |Resume by hand|Relaunch|reuseFrom/.test(line));
const oneNotice = async (sent: SentMessage[], runId: string) => {
	const [notice, ...more] = await waitUntil(`the notice of ${runId}`, () => noticesFor(sent, runId).length > 0 && noticesFor(sent, runId));
	assert.deepEqual(more, [], "one notice per interrupted run");
	return notice!;
};

describe("auto-resuming interrupted workflows at session start", { skip: !available || !createSubagentExecutor ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	const writeAgents = () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "echo.md"), "---\nname: echo\ndescription: Echoes\n---\nEcho the task.\n");
		fs.writeFileSync(path.join(agentDir, "agents", "bg.md"), "---\nname: bg\ndescription: Background echo\nasync: true\n---\nEcho the task.\n");
	};
	const writeConfig = (config: Record<string, unknown>) => {
		const dir = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions", "subagent");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
	};
	const sessionFileFor = (sessionId: string) => path.join(tempDir, `${sessionId}.jsonl`);
	type StartedRuntime = { shutDownNow: (reason: string) => Promise<unknown> };

	/**
	 * One extension runtime. The session_start handlers are called together and `atSessionStart` runs
	 * right after they return synchronously, before any launch they started could have run.
	 */
	const startRuntime = async (reason: string, sessionId: string, options: { previousSessionFile?: string; atSessionStart?: (runtime: StartedRuntime) => void; ui?: boolean } = {}) => {
		const handlers = new Map<string, Handler[]>();
		const sent: SentMessage[] = [];
		const notifications: Array<{ text: string; level: string }> = [];
		const staleSends: SentMessage[] = [];
		let stale = false;
		let tool: Tool | undefined;
		const pi = new Proxy({
			events: createEventBus(),
			on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
			registerTool(definition: Tool & { name: string }) { if (definition.name === "subagent") tool = definition; },
			sendMessage(message: SentMessage["message"], sendOptions?: SentMessage["options"]) {
				// Pi makes a runtime's pi stale once its session shuts down.
				if (stale) { staleSends.push({ message, options: sendOptions }); throw new Error("This extension ctx is stale after session replacement or reload."); }
				sent.push({ message, options: sendOptions });
			},
			getSessionName() { return undefined; },
		}, { get: (target, prop) => prop in target ? target[prop as keyof typeof target] : () => undefined });
		const ctx = {
			...makeMinimalCtx(tempDir),
			isIdle: () => true,
			// A session with a UI (interactive or RPC) that records its notices, unless `ui: false` (a print run); any other UI call does nothing.
			hasUI: options.ui !== false,
			ui: new Proxy({ notify: (text: string, level: string) => { notifications.push({ text, level }); } }, { get: (target, prop) => prop in target ? target[prop as keyof typeof target] : () => undefined }),
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFileFor(sessionId), getEntries: () => [], getBranch: () => [] },
		};
		const previousChildEnv = process.env[SUBAGENT_CHILD_ENV];
		delete process.env[SUBAGENT_CHILD_ENV];
		try {
			registerSubagentExtension(pi as never);
		} finally {
			if (previousChildEnv !== undefined) process.env[SUBAGENT_CHILD_ENV] = previousChildEnv;
		}
		const started = (handlers.get("session_start") ?? []).map((handler) => handler({ reason, ...(options.previousSessionFile ? { previousSessionFile: options.previousSessionFile } : {}) }, ctx));
		// Pi's reload runs session_shutdown, whose cleanup is synchronous; calling every handler at once
		// keeps that cleanup inside the caller's synchronous step.
		const shutDownNow = (shutdownReason: string) => { stale = true; return Promise.all((handlers.get("session_shutdown") ?? []).map((handler) => handler({ reason: shutdownReason }, ctx))); };
		options.atSessionStart?.({ shutDownNow });
		await Promise.all(started);
		assert.ok(tool, "subagent tool registered");
		const autoResumeMessages = () => sent.filter((entry) => entry.message.customType === "subagent-auto-resume");
		return { tool, ctx, sent, notifications, staleSends: () => staleSends, autoResumeMessages, shutDown: async (shutdownReason: string) => { stale = true; for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: shutdownReason }, ctx); } };
	};

	/** What a killed Pi leaves behind: a running status under a dead pid, its saved launch, and the active-run marker. */
	const writeCrashedRun = (sessionId: string, launch: WorkflowLaunchRecord, lastUpdate: number, options: { pid?: number; cwd?: string } = {}) => {
		const runId = `crashed-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
		const asyncDir = path.join(DIRS.async, runId);
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		assert.ok(deadPid);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId, sessionId: sessionFileFor(sessionId), mode: "workflow", state: "running", pid: options.pid ?? deadPid, completionOwnerId: DEAD_PI_COMPLETION_OWNER, startedAt: lastUpdate - 1000, lastUpdate, cwd: options.cwd ?? tempDir, steps: [],
			workflow: { trace: [], emits: [], console: [], scriptDigest: launch.scriptDigest },
		}));
		writeWorkflowLaunchRecord(asyncDir, launch);
		updateActiveRunIndex(asyncDir, "running");
		return runId;
	};
	const scriptLaunch = (script: string): WorkflowLaunchRecord => ({ version: 1, source: "script", params: { workflowScript: script, cwd: tempDir, async: true, mission: false }, scriptDigest: sha256(script) });

	it("relaunches a workflow replaced by /reload once, reusing its finished child and re-attaching its running one", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-reload-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const release = path.join(tempDir, `${nonce}.release`);
		fs.writeFileSync(path.join(tempDir, `${nonce}.js`), `const first = await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); const second = await runs.run("stage2", { agent: "bg", task: "Stage two ${nonce}" }); const third = await runs.run("stage3", { agent: "echo", task: "Stage three ${nonce}" }); return [first.output, second.output, third.output];`);
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, waitForPath: release, output: "stage two done" });
		mockPi.onCall({ matchArgIncludes: `Stage three ${nonce}`, output: "stage three done" });

		const first = await startRuntime("startup", sessionId);
		const launched = await first.tool.execute("auto-reload-launch", { workflow: `./${nonce}.js`, async: true }, new AbortController().signal, undefined, first.ctx);
		const sourceId = launched.details.asyncId;
		assert.ok(sourceId, launched.content[0]?.text);
		const stage2RunId = await waitUntil("stage2 to start", () => readStatusFile(sourceId)?.steps?.find((step) => step.workflowKey === "stage2" && step.async === true)?.runId);
		await waitUntil("the stage2 runner", () => mockPi.callCount() >= 2);

		await first.shutDown("reload");
		const second = await startRuntime("reload", sessionId);
		const resumedId = await waitUntil("the resumed run", () => resumedRuns(sourceId)[0]);
		assert.equal(readStatusFile(sourceId)?.workflow?.stopCause, "runtime-replaced");
		assert.deepEqual(readStatusFile(resumedId)?.workflow?.resumeOrigin, { sourceRunId: sourceId, attempt: 0 });
		assert.equal(readWorkflowResumeClaim(path.join(DIRS.async, sourceId))?.trigger, "auto");
		await waitUntil("stage2 re-attached", () => readStatusFile(resumedId)?.steps?.find((step) => step.workflowKey === "stage2")?.runId);
		fs.writeFileSync(release, "go");
		const done = await waitUntil("the resumed run to finish", () => { const status = readStatusFile(resumedId); return status && terminalStates.includes(status.state) ? status : undefined; }, 15_000);
		assert.equal(done.state, "complete", done.error);
		assert.deepEqual(done.workflow?.value, ["stage one done", "stage two done", "stage three done"]);
		assert.equal(done.steps?.find((step) => step.workflowKey === "stage1")?.reused, true);
		assert.equal(done.steps?.find((step) => step.workflowKey === "stage2")?.runId, stage2RunId);
		assert.equal(mockPi.callCount(), 3, "only stage3 launched after the reload");
		assert.deepEqual(second.autoResumeMessages(), []);
		// The stopped run's notice says once that it continues, and gives no other instruction.
		assert.deepEqual(noticesFor(first.sent, sourceId), [], "the replaced runtime delivers nothing");
		assert.deepEqual(nextSteps(await oneNotice(second.sent, sourceId)), [`Auto-resumed as ${resumedId}.`]);

		// Another reload finds the run already resumed and claims nothing.
		const claimsBefore = claimFiles(sourceId);
		await second.shutDown("reload");
		const third = await startRuntime("reload", sessionId);
		assert.deepEqual(claimFiles(sourceId), claimsBefore);
		assert.deepEqual(resumedRuns(sourceId), [resumedId]);
		await third.shutDown("quit");
	});

	it("resumes a run whose Pi exited, once, without delaying session start; leaves one older than 24 hours", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-exit-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const script = `const only = await runs.run("only", { agent: "echo", task: "Only ${nonce}" }); return only.output;`;
		mockPi.onCall({ matchArgIncludes: `Only ${nonce}`, output: "only done" });
		const recentId = writeCrashedRun(sessionId, scriptLaunch(script), Date.now() - 60_000);
		const oldId = writeCrashedRun(sessionId, scriptLaunch(script), Date.now() - 25 * 60 * 60 * 1000);

		let atStart: { claimed?: string; launched: boolean } | undefined;
		const runtime = await startRuntime("startup", sessionId, {
			atSessionStart: () => {
				const claimed = readWorkflowResumeClaim(path.join(DIRS.async, recentId))?.newRunId;
				atStart = { claimed, launched: claimed !== undefined && fs.existsSync(path.join(DIRS.async, claimed, "status.json")) };
			},
		});
		assert.ok(atStart?.claimed, "session start claimed the run");
		assert.equal(atStart.launched, false, "session start returned before the launch ran");
		assert.equal(readStatusFile(recentId)?.workflow?.stopCause, "owner-exited");
		const resumedId = await waitUntil("the resumed run", () => resumedRuns(recentId)[0]);
		assert.equal(resumedId, atStart.claimed);
		assert.deepEqual(readStatusFile(resumedId)?.workflow?.resumeOrigin, { sourceRunId: recentId, attempt: 1 });
		const done = await waitUntil("the resumed run to finish", () => { const status = readStatusFile(resumedId); return status && terminalStates.includes(status.state) ? status : undefined; }, 15_000);
		assert.equal(done.state, "complete", done.error);

		// Its Pi exited; the reopened session delivers its notice once: what happened, then that it continues.
		const notice = await oneNotice(runtime.sent, recentId);
		assert.match(notice, new RegExp(`that ran workflow ${recentId} exited before the workflow finished\\. Marked run failed by stale-run reconciliation\\. Its finished children are kept\\.`));
		assert.deepEqual(nextSteps(notice), [`Auto-resumed as ${resumedId}.`]);
		assert.equal(readStatusFile(oldId)?.workflow?.stopCause, "owner-exited");
		assert.deepEqual(claimFiles(oldId), [], "a run interrupted more than 24 hours ago is not claimed");
		assert.deepEqual(resumedRuns(oldId), []);
		assert.equal(runtime.sent.some((entry) => entry.options?.triggerTurn === true), false, "nothing starts a turn");
		assert.equal(noticesFor(runtime.sent, recentId).length, 1, "still one notice");
		await runtime.shutDown("quit");
	});

	it("does not resume another session's runs after /new, or when autoResume is off", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-skip-${Date.now()}`;
		const script = `return "${nonce}";`;
		const oldSession = `session-${nonce}-old`;
		const inheritedId = writeCrashedRun(oldSession, scriptLaunch(script), Date.now() - 60_000);
		const fresh = await startRuntime("new", `session-${nonce}-new`, { previousSessionFile: sessionFileFor(oldSession) });
		assert.equal(readStatusFile(inheritedId)?.workflow?.stopCause, "owner-exited", "the new session reconciled the run it inherited");
		assert.deepEqual(claimFiles(inheritedId), []);
		assert.deepEqual(nextSteps(await oneNotice(fresh.sent, inheritedId)), [`Resume by hand: subagent({ action: "resume", id: "${inheritedId}" })`], "its notice says how to resume it by hand");
		await fresh.shutDown("quit");

		writeConfig({ autoResume: false });
		const offSession = `session-${nonce}-off`;
		const offId = writeCrashedRun(offSession, scriptLaunch(script), Date.now() - 60_000);
		const off = await startRuntime("startup", offSession);
		assert.equal(readStatusFile(offId)?.workflow?.stopCause, "owner-exited");
		assert.deepEqual(claimFiles(offId), []);
		// Its Pi exited; the session that owns it delivers its notice once, with the way to resume it by hand.
		const offNotice = await oneNotice(off.sent, offId);
		assert.match(offNotice, new RegExp(`that ran workflow ${offId} exited before the workflow finished`));
		assert.deepEqual(nextSteps(offNotice), [`Resume by hand: subagent({ action: "resume", id: "${offId}" })`]);
		assert.equal(noticesFor(off.sent, offId).length, 1, "still one notice");
		await off.shutDown("quit");
		// The same runs are resumed once their own session reopens with the setting on.
		writeConfig({});
		const reopenedOff = await startRuntime("startup", offSession);
		await waitUntil("the run of the reopened session", () => resumedRuns(offId)[0]);
		await reopenedOff.shutDown("quit");
		const reopenedOld = await startRuntime("resume", oldSession);
		await waitUntil("the run of the reopened old session", () => resumedRuns(inheritedId)[0]);
		await reopenedOld.shutDown("quit");
	});

	it("does not auto-resume in a session with no UI, and resumes once when the session reopens with one", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-headless-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const script = `const only = await runs.run("only", { agent: "echo", task: "Only ${nonce}" }); return only.output;`;
		mockPi.onCall({ matchArgIncludes: `Only ${nonce}`, output: "only done" });
		const sourceId = writeCrashedRun(sessionId, scriptLaunch(script), Date.now() - 60_000);

		// A one-shot print run (`pi -c -p`) has no UI; it would wait on the resumed workflow at turn settle.
		const headless = await startRuntime("startup", sessionId, { ui: false });
		assert.equal(readStatusFile(sourceId)?.workflow?.stopCause, "owner-exited");
		assert.deepEqual(nextSteps(await oneNotice(headless.sent, sourceId)), [`Resume by hand: subagent({ action: "resume", id: "${sourceId}" })`]);
		assert.deepEqual(claimFiles(sourceId), []);
		assert.deepEqual(resumedRuns(sourceId), []);
		await headless.shutDown("quit");

		const reopened = await startRuntime("startup", sessionId);
		const resumedId = await waitUntil("the resumed run", () => resumedRuns(sourceId)[0]);
		const done = await waitUntil("the resumed run to finish", () => { const status = readStatusFile(resumedId); return status && terminalStates.includes(status.state) ? status : undefined; }, 15_000);
		assert.equal(done.state, "complete", done.error);
		assert.deepEqual(resumedRuns(sourceId), [resumedId], "resumed once");
		await reopened.shutDown("quit");
	});

	it("delivers the notice of a run another session repaired once its own session reopens, and only once", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-repaired-elsewhere-${Date.now()}`;
		const ownerSession = `session-${nonce}-owner`;
		const script = `return "${nonce}";`;
		const sourceId = writeCrashedRun(ownerSession, scriptLaunch(script), Date.now() - 60_000);

		// Another session relaunches it through options.reuseFrom, which repairs it there.
		const other = await startRuntime("startup", `session-${nonce}-other`);
		fs.writeFileSync(path.join(tempDir, `${nonce}.js`), script);
		const launched = await other.tool.execute("repaired-elsewhere", { workflow: `./${nonce}.js`, async: true, mission: false, reuseFrom: sourceId }, new AbortController().signal, undefined, other.ctx);
		const relaunchId = launched.details.asyncId;
		assert.ok(relaunchId, launched.content[0]?.text);
		assert.equal(readStatusFile(sourceId)?.workflow?.stopCause, "owner-exited");
		await waitUntil("the relaunch to finish", () => terminalStates.includes(readStatusFile(relaunchId)?.state ?? ""));
		await other.shutDown("quit");
		assert.deepEqual(noticesFor(other.sent, sourceId), [], "the session that does not own it delivers nothing");

		const reopened = await startRuntime("startup", ownerSession);
		assert.deepEqual(nextSteps(await oneNotice(reopened.sent, sourceId)), [`Relaunched as ${relaunchId}.`]);
		await reopened.shutDown("quit");
		assert.equal(fs.existsSync(path.join(DIRS.results, `${sourceId}.json`)), false, "delivery consumed the result");
		const again = await startRuntime("startup", ownerSession);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(noticesFor(again.sent, sourceId), [], "a later reopen delivers nothing");
		await again.shutDown("quit");
	});

	it("resumes the run from the new runtime when /reload lands between the session-start claim and the launch", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-window-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const script = `const only = await runs.run("only", { agent: "echo", task: "Only ${nonce}" }); return only.output;`;
		mockPi.onCall({ matchArgIncludes: `Only ${nonce}`, output: "only done" });
		const sourceId = writeCrashedRun(sessionId, scriptLaunch(script), Date.now() - 60_000);
		const sourceDir = path.join(DIRS.async, sourceId);

		let firstClaim: string | undefined;
		let secondClaim: string | undefined;
		let oldShutdown: Promise<unknown> | undefined;
		let reloaded: ReturnType<typeof startRuntime> | undefined;
		const first = await startRuntime("startup", sessionId, {
			atSessionStart: ({ shutDownNow }) => {
				firstClaim = readWorkflowResumeClaim(sourceDir)?.newRunId;
				// The reload happens before the first runtime's launch step runs.
				oldShutdown = shutDownNow("reload");
				reloaded = startRuntime("reload", sessionId, { atSessionStart: () => { secondClaim = readWorkflowResumeClaim(sourceDir)?.newRunId; } });
			},
		});
		await oldShutdown;
		const second = await reloaded!;
		assert.ok(firstClaim, "the first session start claimed the run");
		assert.ok(secondClaim, "the reloaded session start claimed it again");
		assert.equal(secondClaim, firstClaim, "the reload claimed it again under the same new run id");

		const resumedId = await waitUntil("the resumed run", () => resumedRuns(sourceId)[0]);
		assert.equal(resumedId, firstClaim, "the new runtime launched it under the first claim's id, so `Auto-resumed as <id>.` stays true");
		const done = await waitUntil("the resumed run to finish", () => { const status = readStatusFile(resumedId); return status && terminalStates.includes(status.state) ? status : undefined; }, 15_000);
		assert.equal(done.state, "complete", done.error);
		assert.deepEqual(resumedRuns(sourceId), [resumedId], "exactly one run continues it");
		assert.equal(fs.existsSync(path.join(sourceDir, "resume-refused.json")), false);
		assert.deepEqual(claimFiles(sourceId).map((name) => name.replace(/released.*/, "released")), ["resumed-by.1.json.released", "resumed-by.2.json"]);
		assert.deepEqual([...first.autoResumeMessages(), ...second.autoResumeMessages()], []);
		await second.shutDown("quit");
	});

	it("aborts a resumed run whose launch finishes after its runtime was cleaned up", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-stale-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const resourceName = "test.cleaned-during-launch";
		const script = `const only = await runs.run("only", { agent: "echo", task: "Only ${nonce}" }); return only.output;`;
		// Long enough to outlast the test's checks, short enough that a run nothing aborts still ends.
		mockPi.onCall({ matchArgIncludes: `Only ${nonce}`, delay: 10_000, output: "late" });
		const sourceId = writeCrashedRun(sessionId, { version: 1, source: "resource", params: { workflow: resourceName, cwd: tempDir, async: true, mission: false }, scriptDigest: sha256(script) }, Date.now() - 60_000);
		// The launch resolves the resource after its last check; cleaning the runtime there is "cleaned while launching".
		let cleanUpDuringLaunch: (() => void) | undefined;
		const registration = registerWorkflowResource({ sessionId, definition: { name: resourceName, version: 1, resolve: () => { cleanUpDuringLaunch?.(); return { script }; } } });
		try {
			await startRuntime("startup", sessionId, {
				atSessionStart: ({ shutDownNow }) => { cleanUpDuringLaunch = () => { cleanUpDuringLaunch = undefined; void shutDownNow("reload"); }; },
			});
			const resumedId = await waitUntil("the resumed run", () => resumedRuns(sourceId)[0]);
			const stopped = await waitUntil("the resumed run to stop", () => { const status = readStatusFile(resumedId); return status && terminalStates.includes(status.state) ? status : undefined; }, 15_000);
			assert.equal(stopped.workflow?.stopCause, "runtime-replaced", stopped.error);
		} finally {
			registration.dispose();
		}
	});

	it("says in the notice why a reload did not resume a workflow, and how to continue it", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-notice-${Date.now()}`;
		const release = path.join(tempDir, `${nonce}.release`);
		fs.writeFileSync(path.join(tempDir, `${nonce}.js`), `const held = await runs.run("held", { agent: "echo", task: "Held ${nonce}" }); return held.output;`);
		mockPi.onCall({ matchArgIncludes: `Held ${nonce}`, waitForPath: release, output: "held done" });
		const launchHeld = async (runtime: Awaited<ReturnType<typeof startRuntime>>) => {
			const launched = await runtime.tool.execute(`launch-${nonce}`, { workflow: `./${nonce}.js`, async: true }, new AbortController().signal, undefined, runtime.ctx);
			const runId = launched.details.asyncId;
			assert.ok(runId, launched.content[0]?.text);
			await waitUntil("the held child to start", () => readStatusFile(runId)?.steps?.some((step) => step.workflowKey === "held" && step.status === "running"));
			return runId;
		};
		try {
			// A reload whose auto-resume is refused says why in the notice, with the way to continue by hand.
			const sessionId = `session-${nonce}-reload`;
			const before = await startRuntime("startup", sessionId);
			const refusedId = await launchHeld(before);
			fs.rmSync(path.join(DIRS.async, refusedId, "launch.json"));
			await before.shutDown("reload");
			const reloaded = await startRuntime("reload", sessionId);
			const refusal = JSON.parse(fs.readFileSync(path.join(DIRS.async, refusedId, "resume-refused.json"), "utf-8")) as { reason: string; byHand: string };
			assert.equal(refusal.byHand, `Relaunch it by hand with options: { reuseFrom: "${refusedId}" }.`);
			assert.deepEqual(nextSteps(await oneNotice(reloaded.sent, refusedId)), [`Not auto-resumed: ${refusal.reason.replace(/\.$/, "")}. ${refusal.byHand}`]);
			assert.deepEqual(resumedRuns(refusedId), []);
			await reloaded.shutDown("quit");
		} finally {
			fs.writeFileSync(release, "go");
		}
	});

	it("keeps the launch's own refusal when it fails after a /reload during the launch", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-stale-fail-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const resourceName = "test.gone-during-launch";
		const sourceId = writeCrashedRun(sessionId, { version: 1, source: "resource", params: { workflow: resourceName, cwd: tempDir, async: true, mission: false }, scriptDigest: sha256("return 1;") }, Date.now() - 60_000);
		// The launch resolves the resource after its last check: a reload there, then the resource is gone.
		let reloadDuringLaunch: (() => void) | undefined;
		const registration = registerWorkflowResource({ sessionId, definition: { name: resourceName, version: 1, resolve: () => { reloadDuringLaunch?.(); throw new Error("the resource is gone"); } } });
		try {
			const runtime = await startRuntime("startup", sessionId, {
				atSessionStart: ({ shutDownNow }) => { reloadDuringLaunch = () => { reloadDuringLaunch = undefined; void shutDownNow("reload"); }; },
			});
			// Written by the launch itself; its follow-up runs before this poll sees the file.
			const refusal = await waitUntil("the refusal", () => { try { return JSON.parse(fs.readFileSync(path.join(DIRS.async, sourceId, "resume-refused.json"), "utf-8")) as { reason: string; byHand: string }; } catch { return undefined; } });
			const resolved = resolveWorkflowResource(resourceName, undefined, sessionId);
			assert.equal(resolved.ok, false);
			assert.equal(refusal.reason, `workflow resource '${resourceName}' can no longer be resolved: ${resolved.ok ? "" : resolved.error}`);
			assert.equal(refusal.byHand, `Relaunch it by hand with options: { reuseFrom: "${sourceId}" }.`);
			assert.equal(readWorkflowResumeClaim(path.join(DIRS.async, sourceId)), undefined, "the claim was given back");
			assert.deepEqual([...runtime.autoResumeMessages(), ...runtime.staleSends()], [], "the cleaned-up runtime posts nothing");
		} finally {
			registration.dispose();
		}
	});

	it("points to runs another session left when its Pi died, without touching them", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `elsewhere-${Date.now()}`;
		const script = `return "${nonce}";`;
		const now = Date.now();
		const deadPid = () => { const pid = spawnSync(process.execPath, ["-e", ""]).pid; assert.ok(pid); return pid; };
		const historyDir = path.join(DIRS.results, "foreground-history");
		const writeForegroundRecord = (sessionId: string, runId: string) => {
			fs.mkdirSync(historyDir, { recursive: true });
			fs.writeFileSync(path.join(historyDir, `${runId}.json`), JSON.stringify({ runId, mode: "single", cwd: tempDir, sessionId: sessionFileFor(sessionId), updatedAt: now - 60_000, ownerPid: deadPid(), children: [{ agent: "echo", index: 0, status: "running" }] }));
		};
		// A session id is its file path; a saved session file starts with the header that names its id.
		const headerIds = new Map<string, string>();
		const session = (name: string, file: "header" | "no-header" | "none" = "header") => {
			const id = `session-${nonce}-${name}`;
			headerIds.set(id, randomUUID());
			if (file !== "none") fs.writeFileSync(sessionFileFor(id), file === "header" ? `${JSON.stringify({ type: "session", version: 3, id: headerIds.get(id), cwd: tempDir })}\n` : "{}\n");
			return id;
		};

		// Two runs (an async workflow and a foreground run; the same run seen from both sources counts once).
		const foreign = session("foreign");
		const foreignRun = writeCrashedRun(foreign, scriptLaunch(script), now - 60_000);
		writeForegroundRecord(foreign, `fg-${nonce}`);
		writeForegroundRecord(foreign, foreignRun);
		// One run each, in sessions whose paths a shell would quote or expand.
		const spaced = session("with space");
		const dollar = session("with $demo");
		const foreignRuns = [foreignRun, writeCrashedRun(spaced, scriptLaunch(script), now - 60_000), writeCrashedRun(dollar, scriptLaunch(script), now - 60_000)];
		// Not pointed to: a live owner, another folder, older than a day, a session that cannot be reopened (no file, or no
		// header id), an inherited session.
		foreignRuns.push(
			writeCrashedRun(session("alive"), scriptLaunch(script), now - 60_000, { pid: process.pid }),
			writeCrashedRun(session("elsewhere"), scriptLaunch(script), now - 60_000, { cwd: path.join(tempDir, "other") }),
			writeCrashedRun(session("old"), scriptLaunch(script), now - 25 * 60 * 60 * 1000),
			writeCrashedRun(session("unsaved", "none"), scriptLaunch(script), now - 60_000),
			writeCrashedRun(session("headerless", "no-header"), scriptLaunch(script), now - 60_000),
		);
		const inherited = session("inherited");
		writeCrashedRun(inherited, scriptLaunch(script), now - 60_000);
		const current = session("current");
		const headless = session("headless");

		// Every file of the other sessions' runs, their active-run markers, the foreground history, and the session files.
		const filesUnder = (root: string) => fs.existsSync(root) ? (fs.readdirSync(root, { recursive: true }) as string[]).map((name) => path.join(root, name)) : [];
		const snapshot = () => Object.fromEntries([
			...foreignRuns.flatMap((runId) => [...filesUnder(path.join(DIRS.async, runId)), path.join(DIRS.async, ".active-runs", runId)]),
			...filesUnder(historyDir),
			...fs.readdirSync(tempDir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(tempDir, name)),
		].filter((file) => fs.existsSync(file) && fs.statSync(file).isFile()).map((file) => [file, fs.readFileSync(file, "utf-8")]));
		const before = snapshot();
		assert.equal(Object.keys(before).filter((file) => file.endsWith("status.json")).length, foreignRuns.length);
		const elsewhere = (runtime: { notifications: Array<{ text: string; level: string }> }) => runtime.notifications.filter((notice) => notice.text.includes("in another session"));

		const withUi = await startRuntime("new", current, { previousSessionFile: sessionFileFor(inherited) });
		// Each line names the session by its header id, the same on every platform whatever its path.
		const byText = (left: { text: string }, right: { text: string }) => left.text.localeCompare(right.text);
		assert.deepEqual(elsewhere(withUi).sort(byText), [
			{ text: `2 subagent runs were interrupted in another session. Reopen it to resume them: \`pi --session ${headerIds.get(foreign)}\``, level: "info" },
			{ text: `1 subagent run was interrupted in another session. Reopen it to resume it: \`pi --session ${headerIds.get(spaced)}\``, level: "info" },
			{ text: `1 subagent run was interrupted in another session. Reopen it to resume it: \`pi --session ${headerIds.get(dollar)}\``, level: "info" },
		].sort(byText));
		assert.deepEqual(withUi.sent.filter((entry) => String(entry.message.content).includes("in another session")), [], "never sent to the model");
		await withUi.shutDown("quit");
		const withoutUi = await startRuntime("startup", headless, { ui: false });
		assert.deepEqual(elsewhere(withoutUi), []);
		await withoutUi.shutDown("quit");
		assert.deepEqual(snapshot(), before, "nothing of the other sessions changed");
	});

	it("reports a launch that cannot start once, records why, and does not retry it", { timeout: 30_000 }, async () => {
		writeAgents();
		const nonce = `auto-fail-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const resourceName = "test.gone";
		const sourceId = writeCrashedRun(sessionId, { version: 1, source: "resource", params: { workflow: resourceName, cwd: tempDir, async: true, mission: false }, scriptDigest: sha256("return 1;") }, Date.now() - 60_000);

		const runtime = await startRuntime("startup", sessionId);
		const [message] = await waitUntil("the failure message", () => runtime.autoResumeMessages().length > 0 && runtime.autoResumeMessages());
		const resolved = resolveWorkflowResource(resourceName, undefined, sessionId);
		assert.equal(resolved.ok, false);
		const resolveError = resolved.ok ? "" : resolved.error.replace(/\.$/, "");
		assert.equal(message?.message.content, `Auto-resume of workflow ${sourceId} failed: workflow resource '${resourceName}' can no longer be resolved: ${resolveError}. Relaunch it by hand with options: { reuseFrom: "${sourceId}" }.`);
		assert.equal(message?.message.display, true);
		assert.equal(message?.options?.triggerTurn, false);
		assert.equal(readWorkflowResumeClaim(path.join(DIRS.async, sourceId)), undefined, "the claim was given back");
		assert.equal(fs.existsSync(path.join(DIRS.async, sourceId, "resume-refused.json")), true);
		assert.deepEqual(resumedRuns(sourceId), []);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(runtime.autoResumeMessages().length, 1);
		await runtime.shutDown("quit");

		const claimsBefore = claimFiles(sourceId);
		const reopened = await startRuntime("startup", sessionId);
		assert.deepEqual(claimFiles(sourceId), claimsBefore, "the next session start does not try again");
		await reopened.shutDown("quit");
		assert.deepEqual(reopened.autoResumeMessages(), []);
	});
});
