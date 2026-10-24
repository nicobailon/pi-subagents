/** subagent({ action: "resume", id }) with no message relaunches a stopped workflow from its saved launch. */

import assert from "node:assert/strict";
import fsDefault, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";
import { DIRS, type AsyncStatus } from "../../src/shared/types.ts";
import { runtimeReplacedAbortReason } from "../../src/workflows/workflow-reuse.ts";
import { readWorkflowResumeClaim } from "../../src/workflows/workflow-resume-claim.ts";
import { recordSessionReplacement } from "../../src/shared/session-succession.ts";
import { waitForAsyncResultFile, waitForAsyncState } from "../support/async-execution-fixture.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installSingleExecutionHooks, makeExecutor, mockPi, tempDir } from "../support/single-execution-fixture.ts";

const terminalStates = ["complete", "failed", "partial", "paused", "stopped", "rejected"];
// SAFETY: the executor writes these status.json files from AsyncStatus values.
const readStatusFile = (runId: string) => JSON.parse(fs.readFileSync(path.join(DIRS.async, runId, "status.json"), "utf-8")) as AsyncStatus;
const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

describe("resuming a stopped workflow by id", { skip: !available || !createSubagentExecutor ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	const setup = (config: Record<string, unknown> = {}) => {
		const workflowControllers = new Map<string, AbortController>();
		const executor = makeExecutor([makeAgent("echo")], config, false, undefined, true, new Map(), workflowControllers, undefined, undefined, undefined, undefined, () => {});
		const ctxFor = (sessionId: string) => {
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => sessionId;
			return ctx;
		};
		let calls = 0;
		const call = (params: Record<string, unknown>, sessionId: string) => executor.executePublic(`resume-test-${++calls}-${Date.now()}`, params, new AbortController().signal, undefined, ctxFor(sessionId));
		const launch = async (params: Record<string, unknown>, sessionId: string) => {
			const started = await call({ async: true, mission: false, ...params }, sessionId);
			assert.equal(started.isError, undefined, text(started));
			return started.details.asyncId!;
		};
		const waitFor = async (runId: string, predicate: (status: AsyncStatus) => boolean) => {
			await waitForAsyncState(runId, () => predicate(readStatusFile(runId)), 30_000);
			return readStatusFile(runId);
		};
		const settled = async (runId: string) => {
			const status = await waitFor(runId, (candidate) => terminalStates.includes(candidate.state));
			await waitForAsyncResultFile(runId, 30_000);
			return status;
		};
		const replaceWhen = async (runId: string, ready: (status: AsyncStatus) => boolean) => {
			await waitFor(runId, ready);
			workflowControllers.get(runId)!.abort(runtimeReplacedAbortReason());
			return await settled(runId);
		};
		const resume = (id: string, sessionId: string) => call({ action: "resume", id }, sessionId);
		return { call, launch, waitFor, settled, replaceWhen, resume };
	};
	const stageStarted = (key: string) => (status: AsyncStatus) => Boolean(status.steps?.find((step) => step.workflowKey === key)?.runId)
		|| (status.workflow?.trace.some((entry) => entry.key === key && entry.state === "started") ?? false);
	const claimOf = (runId: string) => readWorkflowResumeClaim(path.join(DIRS.async, runId)) ?? {};

	it("relaunches a runtime-replaced workflow once, reusing its finished child", { timeout: 60_000 }, async () => {
		const nonce = `resume-by-id-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const script = `const first = await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); const second = await runs.run("stage2", { agent: "echo", task: "Stage two ${nonce}" }); return [first.output, second.output];`;
		const { launch, settled, replaceWhen, resume } = setup();
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, hangUntilAbort: true });
		const sourceId = await launch({ workflowScript: script }, sessionId);
		assert.equal((await replaceWhen(sourceId, stageStarted("stage2"))).workflow?.stopCause, "runtime-replaced");
		const callsBefore = mockPi.callCount();

		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, output: "stage two done" });
		const resumed = await resume(sourceId, sessionId);
		assert.equal(resumed.isError, undefined, text(resumed));
		const newRunId = resumed.details.asyncId!;
		assert.ok(text(resumed).startsWith(`Resumed workflow '${sourceId}' as ${newRunId}.\n`), text(resumed));
		assert.deepEqual((({ newRunId: claimed, trigger }) => ({ claimed, trigger }))(claimOf(sourceId)), { claimed: newRunId, trigger: "manual" });
		const first = readStatusFile(newRunId);
		assert.equal(first.workflow?.reusedFrom, sourceId);
		assert.deepEqual(first.workflow?.resumeOrigin, { sourceRunId: sourceId, attempt: 0 });

		const done = await settled(newRunId);
		assert.equal(done.state, "complete", done.error);
		assert.deepEqual(done.workflow?.value, ["stage one done", "stage two done"]);
		assert.equal(mockPi.callCount(), callsBefore + 1, "only stage2 launched after the resume");
		assert.equal(done.steps?.find((step) => step.workflowKey === "stage1")?.reused, true);
		assert.deepEqual(done.workflow?.resumeOrigin, { sourceRunId: sourceId, attempt: 0 }, "the origin survives into the terminal status");

		const again = await resume(sourceId, sessionId);
		assert.equal(again.isError, true);
		assert.equal(text(again), `Cannot resume workflow '${sourceId}': resumed as ${newRunId}; wait on it or stop it.`);
	});

	it("refuses a workflow launched from tasks or chain", { timeout: 60_000 }, async () => {
		const nonce = `resume-structured-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const { launch, replaceWhen, resume } = setup({ disabledFeatures: ["workflow-scripts"] });
		mockPi.onCall({ matchArgIncludes: `Structured ${nonce}`, hangUntilAbort: true });
		const sourceId = await launch({ tasks: [{ agent: "echo", task: `Structured ${nonce}` }], chatProgress: "off" }, sessionId);
		assert.equal((await replaceWhen(sourceId, (status) => Boolean(status.steps?.some((step) => step.status === "running")))).workflow?.stopCause, "runtime-replaced");
		const refused = await resume(sourceId, sessionId);
		assert.equal(text(refused), `Cannot resume workflow '${sourceId}': launched from tasks/chain; resume it by hand. Relaunch it by hand with options: { reuseFrom: "${sourceId}" }.`);
		assert.deepEqual(fs.readdirSync(path.join(DIRS.async, sourceId)).filter((name) => name.startsWith("resumed-by.")), [], "no claim was taken");
	});

	it("refuses a resume from another session and allows it from a session that replaced the owner", { timeout: 60_000 }, async () => {
		const nonce = `resume-owner-${Date.now()}`;
		const ownerSession = `session-${nonce}-owner`;
		const script = `await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); await runs.run("stage2", { agent: "echo", task: "Stage two ${nonce}" }); return "done";`;
		const { launch, settled, replaceWhen, resume } = setup();
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, hangUntilAbort: true });
		const sourceId = await launch({ workflowScript: script }, ownerSession);
		await replaceWhen(sourceId, stageStarted("stage2"));
		const sourceDir = path.join(DIRS.async, sourceId);
		const snapshot = () => (fs.readdirSync(sourceDir, { recursive: true }) as string[]).sort()
			.map((name) => [name, fs.statSync(path.join(sourceDir, name)).isFile() ? fs.readFileSync(path.join(sourceDir, name), "utf-8") : "<dir>"]);
		const before = snapshot();

		const foreign = await resume(sourceId, `session-${nonce}-other`);
		assert.equal(foreign.isError, true);
		assert.equal(text(foreign), `Cannot resume workflow '${sourceId}': it was started in another session; reopen that session to resume it.`);
		assert.deepEqual(snapshot(), before, "nothing was written into the other session's run");

		// After /new in the same Pi process the new session owns the runs of the one it replaced.
		const successor = `session-${nonce}-successor`;
		recordSessionReplacement(successor, ownerSession);
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, output: "stage two done" });
		const resumed = await resume(sourceId, successor);
		assert.equal(resumed.isError, undefined, text(resumed));
		assert.equal((await settled(resumed.details.asyncId!)).state, "complete");
	});

	it("gives back a plain relaunch's claim when its storage cannot be created", { timeout: 60_000 }, async (t) => {
		const nonce = `reuse-storage-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const script = `await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); await runs.run("stage2", { agent: "echo", task: "Stage two ${nonce}" }); return "done";`;
		const { launch, settled, replaceWhen, call } = setup();
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, hangUntilAbort: true });
		const sourceId = await launch({ workflowScript: script }, sessionId);
		await replaceWhen(sourceId, stageStarted("stage2"));

		// The relaunch takes the claim, then fails to create its storage.
		const originalMkdirSync = fsDefault.mkdirSync;
		t.mock.method(fsDefault, "mkdirSync", ((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
			if (path.resolve(String(target)) === path.resolve(DIRS.results)) throw new Error("no space left");
			return originalMkdirSync(target, options);
		}) as typeof fsDefault.mkdirSync);
		syncBuiltinESMExports();
		let failed: Awaited<ReturnType<typeof call>>;
		try {
			failed = await call({ async: true, mission: false, workflowScript: script, reuseFrom: sourceId }, sessionId);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
		assert.equal(failed.isError, true);
		assert.equal(text(failed), "Failed to create async workflow storage: no space left");
		assert.equal(readWorkflowResumeClaim(path.join(DIRS.async, sourceId)), undefined, "the claim was given back");

		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, output: "stage two done" });
		const relaunchId = await launch({ workflowScript: script, reuseFrom: sourceId }, sessionId);
		assert.equal((await settled(relaunchId)).state, "complete");
	});

	it("releases the claim when the relaunch is refused for capacity, so a later resume succeeds", { timeout: 90_000 }, async () => {
		const nonce = `resume-capacity-${Date.now()}`;
		const sessionId = `session-${nonce}`;
		const release = path.join(tempDir, `${nonce}.release`);
		const script = `await runs.run("stage1", { agent: "echo", task: "Stage one ${nonce}" }); await runs.run("stage2", { agent: "echo", task: "Stage two ${nonce}" }); return "done";`;
		const { launch, settled, waitFor, replaceWhen, resume } = setup({ maxActiveAsyncRunsPerSession: 1 });
		mockPi.onCall({ matchArgIncludes: `Stage one ${nonce}`, output: "stage one done" });
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, hangUntilAbort: true });
		const sourceId = await launch({ workflowScript: script }, sessionId);
		await replaceWhen(sourceId, stageStarted("stage2"));

		// Another workflow holds the session's only slot.
		mockPi.onCall({ matchArgIncludes: `Blocker ${nonce}`, waitForPath: release, output: "blocker done" });
		const blockerId = await launch({ workflowScript: `await runs.run("block", { agent: "echo", task: "Blocker ${nonce}" });` }, sessionId);
		await waitFor(blockerId, stageStarted("block"));
		const refused = await resume(sourceId, sessionId);
		assert.equal(refused.isError, true);
		assert.equal(text(refused), `Cannot resume workflow '${sourceId}': capacity refused: Active async run capacity exhausted: 1/1 used.`);
		assert.equal(readWorkflowResumeClaim(path.join(DIRS.async, sourceId)), undefined, "the claim was released");

		fs.writeFileSync(release, "go");
		await settled(blockerId);
		mockPi.onCall({ matchArgIncludes: `Stage two ${nonce}`, output: "stage two done" });
		const resumed = await resume(sourceId, sessionId);
		assert.equal(resumed.isError, undefined, text(resumed));
		assert.equal((await settled(resumed.details.asyncId!)).state, "complete");
	});
});
