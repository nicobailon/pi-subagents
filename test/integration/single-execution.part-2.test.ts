/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it } from "node:test";
import {
	tempDir, mockPi, available, runSync, getFinalOutput,
	createSubagentExecutor, executorMod, escapeRegExp, writePackageSkill,
	writeWatchdogSettings, withIsolatedWatchdogSettings, childWatchdogStatus,
	mockAssistantMessage, readCall, readCallArgs, readAllCallArgs, makeExecutor,
	installSingleExecutionHooks,
	type ProgressSummary, type ArtifactPaths, type LaunchResolvedExtensions,
	type RuntimeAcknowledgedExtensions, type RunSyncResult, type ExecutorToolResult,
} from "../support/single-execution-fixture.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { SUBAGENT_FOREGROUND_COMPLETE_EVENT } from "../../src/shared/types.ts";
import {
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	resolveMockPiCallArgs,
} from "../support/helpers.ts";
import registerSubagentExtension from "../../src/extension/index.ts";
import { handleSubagentControlNotice } from "../../src/extension/control-notices.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	SUBAGENT_DELEGATION_STARTED_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationResponse,
	type SubagentDelegationStarted,
} from "../../src/api/delegation.ts";
import { CHAIN_RUNS_DIR, DIRS, INTERCOM_DETACH_REQUEST_EVENT, INTERCOM_DETACH_RESPONSE_EVENT, SUBAGENT_CONTROL_EVENT, TEMP_ARTIFACTS_DIR, type AsyncStatus, type ChildWatchdogProgress, type ControlEvent, type SubagentState } from "../../src/shared/types.ts";
import { ACTIVE_RUN_INDEX_DIR } from "../../src/runs/background/active-run-index.ts";
import { encodeIndexSegment } from "../../src/runs/background/index-segment.ts";
import { waitForSubagents } from "../../src/runs/background/subagent-wait.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../../src/watchdog/child-status.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { MainWatchdogRuntime } from "../../src/watchdog/runtime.ts";
import { SUBAGENT_CHILD_ENV, type ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";
import { createNestedRoute, parseNestedEventRecords } from "../../src/runs/shared/nested-events.ts";
import { resolveMissionStoreLocation } from "../../src/missions/store.ts";
import { missionStatePath } from "../../src/missions/workflow-state.ts";
import { discardPreservedWorktrees } from "../../src/runs/shared/parallel-handoff.ts";
import { createWorktrees } from "../../src/runs/shared/worktree.ts";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { clearExclusions, recordModelFailure } from "../../src/runs/shared/model-exclusions.ts";
import { createWorkflowChildPermit, workflowChildPermitConsumed } from "../../src/shared/workflow-child-permit.ts";
import { toSubagentDelegationExecutionParams } from "../../src/slash/delegation-adapters.ts";

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	for (const mode of ["abort", "attached", "detached"] as const) {
		it(`foreground setup lifecycle: ${mode}`, { skip: !createSubagentExecutor || process.platform === "win32" ? "requires real POSIX setup hook" : undefined, timeout: 20_000 }, async () => {
			execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
			execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
			fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
			execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
			const holdPath = path.join(tempDir, ".git", "hold-hook");
			const releaseChild = path.join(tempDir, ".git", "release-child");
			const launchMarker = path.join(tempDir, ".git", "model-launched.txt");
			const server = createServer();
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address() as { port: number };
			const hook = path.join(tempDir, ".git", "setup-hook.cjs");
			fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs');
if (!fs.existsSync(${JSON.stringify(holdPath)})) { console.log('{}'); } else {
 const socket = require('node:net').connect(${address.port}, '127.0.0.1', () => socket.write('ready'));
 socket.on('data', data => { if (data.toString() === 'release') { socket.end(); console.log('{}'); } else socket.write('ack'); });
 setTimeout(() => process.exit(90), 15000).unref();
}\n`, { mode: 0o755 });
			const baseDir = createTempDir();
			const bus = createEventBus();
			const executor = makeExecutor([makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })], { worktreeBaseDir: baseDir, worktreeSetupHook: hook }, false, { sessionId: "session-123", count: 0 }, true, new Map(), undefined, undefined, bus);
			let notified = false;
			let notify!: () => void;
			const notification = new Promise<void>((resolve) => { notify = resolve; });
			bus.on(SUBAGENT_FOREGROUND_COMPLETE_EVENT, () => { notified = true; notify(); });
			const controller = new AbortController();
			let socket: Socket | undefined;
			let child: Promise<ExecutorToolResult> | undefined;
			let setup: Promise<ExecutorToolResult> | undefined;
			try {
				let childSettled = false;
				let childCompleted!: () => void;
				const completed = new Promise<void>((resolve) => { childCompleted = resolve; });
				if (mode !== "abort") {
					let childReady!: () => void;
					const ready = new Promise<void>((resolve) => { childReady = resolve; });
					mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Ready" })] }, { waitForPath: releaseChild, jsonl: [events.assistantMessage("child A done")] }] });
					child = executor.execute("lifecycle-A", { async: false, agent: "worker", task: "A", worktree: true, acceptance: false }, controller.signal, (update) => {
						if (update.details?.progress?.some((entry) => entry.currentTool === "contact_supervisor")) childReady();
						if (update.details?.progress?.some((entry) => entry.status === "completed")) childCompleted();
					}, makeMinimalCtx(tempDir));
					void child.then(() => { childSettled = true; });
					await Promise.race([ready, child.then((result) => { throw new Error(`A returned before ready: ${JSON.stringify(result)}`); })]);
					if (mode === "detached") {
						bus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "lifecycle-detach" });
						assert.equal((await child).details.results[0]?.detached, true);
					}
				}
				fs.writeFileSync(holdPath, "hold");
				const connection = once(server, "connection");
				mockPi.onCall({ output: "child B done", writeFiles: [{ path: launchMarker, content: "launched" }] });
				const otherOwner = makeExecutor([makeAgent("worker")], { worktreeBaseDir: baseDir, worktreeSetupHook: hook });
				setup = otherOwner.execute("lifecycle-B", { async: false, agent: "worker", task: "B", worktree: true, acceptance: false }, controller.signal, undefined, makeMinimalCtx(tempDir));
				[socket] = await Promise.race([connection, setup.then((result) => { throw new Error(`Setup returned before hook ready: ${JSON.stringify(result)}`); })]) as [Socket];
				await once(socket, "data"); // Real hook ready; the owner serviced I/O while setup remains held.
				if (mode === "abort") {
					controller.abort();
					const result = await setup;
					assert.equal(result.isError, true);
					assert.equal(mockPi.callCount(), 0);
					assert.equal(fs.existsSync(launchMarker), false, "aborted setup must not reach child side effects");
					assert.ok(result.details.parallelHandoff?.path, result.content[0]?.text);
					const handoff = JSON.parse(fs.readFileSync(result.details.parallelHandoff.path, "utf8"));
					const cleanup = handoff.groups[0].cleanup;
					assert.equal(cleanup.state, "complete");
					assert.equal(cleanup.tasks.length, 1);
					assert.match(cleanup.errors.join("\n"), /"processTree":"observed"/);
					for (const task of cleanup.tasks) {
						assert.equal(task.worktreeRemoved, true);
						assert.equal(task.branchRemoved, true);
						assert.equal(fs.existsSync(task.path), false);
						assert.equal(execFileSync("git", ["branch", "--list", task.branch], { cwd: tempDir, encoding: "utf8" }).trim(), "");
					}
				} else {
					fs.writeFileSync(releaseChild, "release");
					await completed;
					const ack = once(socket, "data");
					socket.write("ping");
					await ack;
					assert.equal(mode === "detached" ? notified : childSettled, false, "A must await finalization behind B setup");
					socket.write("release");
					const [a, b] = await Promise.all([child!, setup]);
					if (mode === "detached") await notification;
					assert.equal(fs.readFileSync(launchMarker, "utf8"), "launched");
					for (const result of [a, b]) {
						assert.equal(result.isError, undefined, result.content[0]?.text);
						assert.ok(result.details.parallelHandoff?.path);
						const handoff = JSON.parse(fs.readFileSync(result.details.parallelHandoff.path, "utf8"));
						assert.equal(handoff.groups[0].cleanup.state, "complete");
						for (const task of handoff.groups[0].cleanup.tasks) {
							assert.equal(task.worktreeRemoved, true);
							assert.equal(task.branchRemoved, true);
							assert.equal(fs.existsSync(task.path), false);
						}
					}
				}
			} finally {
				controller.abort();
				fs.writeFileSync(releaseChild, "release");
				socket?.end("release");
				await Promise.allSettled([child, setup]);
				socket?.destroy();
				await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
				removeTempDir(baseDir);
			}
		});
	}

	it("keeps async workflows failed when a coordinated child is mixed with a real failure", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		mockPi.onCall({
			matchArgIncludes: "Ask then continue",
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Fail for real", exitCode: 1, stderr: "real child failure" });
		const piEvents = createEventBus();
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor(
			[makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })],
			{},
			false,
			undefined,
			true,
			asyncJobs,
			undefined,
			undefined,
			piEvents,
		);
		let detachAccepted = false;
		piEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as { requestId?: unknown }).requestId === "async-workflow-detach-with-failure") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "async-workflow-detach-with-failure" });
		}, 10);
		detachTimer.unref();

		const started = await executor.execute(
			"async-scripted-workflow-detached-and-failed",
			{
				workflowScript: `
					await runs.all([
						{ key: "detaches", agent: "worker", task: "Ask then continue" },
						{ key: "fails", agent: "worker", task: "Fail for real" }
					]);
					throw new Error("manual hard failure");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.ok(started.details.asyncDir);
		const workflowRunId = started.details.asyncId;
		const statusPath = path.join(started.details.asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);

		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && status.state !== "failed" && status.state !== "paused"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);
		assert.equal(status.state, "failed");
		assert.equal(status.activityState, undefined);
		assert.match(status.error ?? "", /manual hard failure/);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "detaches" && entry.state === "completed"), true);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "fails" && entry.state === "failed"), true);
		assert.equal(status.steps?.find((step) => step.workflowKey === "detaches")?.status, "completed");
		assert.equal(status.steps?.find((step) => step.workflowKey === "detaches")?.activityState, undefined);
		assert.equal(status.steps?.find((step) => step.workflowKey === "fails")?.status, "failed");
		assert.equal(asyncJobs.get(workflowRunId)?.status, "failed");
		assert.equal(asyncJobs.get(workflowRunId)?.activityState, undefined);

		let persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			state?: string;
			activityState?: string;
			error?: string;
			workflow?: { trace?: Array<{ key?: string; state?: string }> };
			results?: Array<{ workflowKey?: string; detached?: boolean; success?: boolean }>;
		};
		assert.equal(persistedResult.state, "failed");
		assert.equal(persistedResult.activityState, undefined);
		assert.match(persistedResult.error ?? "", /manual hard failure/);
		assert.equal(persistedResult.workflow?.trace?.some((entry) => entry.key === "detaches" && entry.state === "completed"), true);
		assert.equal(persistedResult.workflow?.trace?.some((entry) => entry.key === "fails" && entry.state === "failed"), true);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.detached, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.success, true);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "fails")?.success, false);

		await new Promise((resolve) => setTimeout(resolve, 750));
		persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(persistedResult.state, "failed", "real workflow failure must not be overwritten by detached child completion");
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("inherits workflow-level worktree isolation and allows a child opt-out", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "isolated", writeFiles: [{ path: "isolated.txt", content: "isolated\n" }] });
		mockPi.onCall({ output: "shared", writeFiles: [{ path: "shared.txt", content: "shared\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-worktree-default",
			{
				async: false,
				worktree: true,
				workflowScript: `
					const isolated = await runs.run("isolated", { agent: "worker", task: "Isolated" });
					const shared = await runs.run("shared", { agent: "worker", task: "Shared", worktree: false });
					return { isolated: isolated.artifactPaths, shared: shared.artifactPaths };
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(tempDir, "isolated.txt")), false);
		assert.equal(fs.readFileSync(path.join(tempDir, "shared.txt"), "utf-8"), "shared\n");
		const output = result.content[0]?.text ?? "";
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 1, output);
		assert.equal(fs.existsSync(handoffPaths[0]!), true);
	});

	it("supports dynamic parallel phases followed by sequential worktree children", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "api built", writeFiles: [{ path: "api.txt", content: "api\n" }] });
		mockPi.onCall({ output: "ui built", writeFiles: [{ path: "ui.txt", content: "ui\n" }] });
		mockPi.onCall({ output: "joined", writeFiles: [{ path: "joined.txt", content: "joined\n" }] });
		mockPi.onCall({ output: "shared", writeFiles: [{ path: "shared.txt", content: "shared\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-dynamic-worktree-phases",
			{
				async: false,
				worktree: true,
				workflowScript: `
					const targets = ["api", "ui"];
					const built = await runs.all(targets.map((target) => ({
						key: "build-" + target,
						agent: "worker",
						task: "Build " + target
					})));
					const joined = await runs.run("join", { agent: "worker", task: built.map((child) => child.key).join(",") });
					const shared = await runs.run("shared", { agent: "worker", task: joined.key, worktree: false });
					return {
						built: built.map((child) => ({ key: child.key, artifactPaths: child.artifactPaths })),
						joined: { key: joined.key, artifactPaths: joined.artifactPaths },
						shared: shared.key
					};
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 4, result.content[0]?.text ?? "workflow produced no output");
		assert.equal(fs.existsSync(path.join(tempDir, "api.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "ui.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "joined.txt")), false);
		assert.equal(fs.readFileSync(path.join(tempDir, "shared.txt"), "utf-8"), "shared\n");

		const output = result.content[0]?.text ?? "";
		assert.match(output, /build-api/);
		assert.match(output, /build-ui/);
		assert.match(output, /join/);
		assert.match(output, /shared/);
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 3, output);
		const worktreePaths = new Set<string>();
		for (const handoffPath of handoffPaths) {
			const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
				groups: Array<{
					children: Array<{ patch: { changed: boolean; path: string } }>;
					cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
				}>;
			};
			assert.equal(handoff.groups.length, 1);
			assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
			assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
			assert.equal(handoff.groups[0]?.cleanup.state, "complete");
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
			worktreePaths.add(handoff.groups[0]!.cleanup.tasks[0]!.path);
		}
		assert.equal(worktreePaths.size, 3);
		for (const worktreePath of worktreePaths) assert.equal(fs.existsSync(worktreePath), false);
	});

	it("applies a workflow usage budget across scripted child launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-usage-budget",
			{
				async: false,
				workflowScript: `
					await runs.run("first", { agent: "echo", task: "First task" });
					await runs.run("second", { agent: "echo", task: "Second task" });
				`,
				usageBudget: { tokens: { hard: 10 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Usage budget exhausted/);
		assert.equal(result.details.mode, "workflow");
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.usageBudget?.exhausted, true);
		assert.deepEqual(result.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "budget_exhausted" });
		assert.equal(result.details.workflow?.receipt?.entries.first?.terminalOutcome, undefined);
		assert.deepEqual(result.details.workflow?.receipt?.entries.second?.terminalOutcome, { state: "partial", reason: "budget_exhausted" });
	});

	it("admits a zero run-level tool budget only for marked structured delegated execution", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const zeroBudget = { hard: 0, block: "*" as const };
		const params = { agent: "echo", task: "Answer without tools", toolBudget: zeroBudget };
		const ctx = makeMinimalCtx(tempDir);
		const executor = makeExecutor([makeAgent("echo")]);

		const ordinary = await executor.execute(
			"ordinary-zero-budget",
			{ ...params, delegatedAllowZeroToolBudget: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(ordinary.isError, true);
		assert.match(ordinary.content[0]?.text ?? "", /toolBudget\.hard must be an integer >= 1/);

		const unmarkedDelegated = await executor.executeDelegated(
			"unmarked-delegated-zero-budget",
			params,
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(unmarkedDelegated.isError, true);
		assert.match(unmarkedDelegated.content[0]?.text ?? "", /toolBudget\.hard must be an integer >= 1/);

		mockPi.onCall({ output: "answered" });
		const structuredDelegated = await executor.executeDelegated(
			"structured-delegated-zero-budget",
			{ ...params, delegatedAllowZeroToolBudget: true },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(structuredDelegated.isError, undefined);
		assert.deepEqual(structuredDelegated.details.toolBudget, zeroBudget);
		assert.deepEqual(readCall().runtime?.toolBudget, zeroBudget);
		assert.equal(mockPi.callCount(), 1);
	});

	it("passes an agent-level tool budget to an async single child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const toolBudget = { soft: 100, hard: 150, block: "*" as const };
		mockPi.onCall({ output: "budget probe done" });
		const ctx = makeMinimalCtx(tempDir);
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: ctx.sessionManager.getSessionId(),
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const piEvents = createEventBus();
		const executor = createSubagentExecutor!({
			pi: { events: piEvents, getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo", { toolBudget })] }),
			allowMutatingManagementActions: true,
		});
		let asyncDir: string | undefined;
		let resultPath: string | undefined;

		try {
			const result = await executor.execute(
				"agent-tool-budget-async-single",
				{ agent: "echo", task: "Run the async budget probe", async: true },
				new AbortController().signal,
				undefined,
				ctx,
			);

			asyncDir = result.details.asyncDir;
			assert.equal(result.isError, undefined, result.content[0]?.text ?? "async launch failed");
			assert.ok(result.details.asyncId);
			resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);

			const status = JSON.parse(fs.readFileSync(path.join(asyncDir!, "status.json"), "utf-8")) as { runId?: string; sessionId?: string };
			assert.equal(status.runId, result.details.asyncId);
			assert.equal(status.sessionId, state.currentSessionId);
			const waited = await waitForSubagents({ id: result.details.asyncId, timeoutMs: 30_000 }, undefined, {
				state,
				events: piEvents,
			});
			assert.equal(waited.isError, undefined, JSON.stringify(waited));
			assert.equal(waited.details.wait, undefined, JSON.stringify(waited));
			assert.equal(waited.details.completions?.find((completion) => completion.runId === result.details.asyncId)?.state, "complete", JSON.stringify(waited));
			const persisted = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string };
			assert.equal(persisted.state, "complete");
			assert.deepEqual(readCall().runtime?.toolBudget, toolBudget);
			assert.equal(mockPi.callCount(), 1);
		} finally {
			// bg_wait completes at the logical result, not the parent's process-close publication.
			// Await that publication even on assertion failure, before reading proof or deleting artifacts.
			if (asyncDir) {
				const eventsPath = path.join(asyncDir, "events.jsonl");
				const deadline = Date.now() + 10_000;
				while (true) {
					let journal = "";
					try {
						journal = fs.readFileSync(eventsPath, "utf-8");
					} catch (error) {
						if (!["ENOENT", "EINTR", "EAGAIN", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
					}
					// Ignore an in-flight final record and malformed diagnostics, not terminal proof.
					const terminal = journal.split("\n").slice(0, -1).some((line) => {
						try {
							return JSON.parse(line)?.type === "subagent.run.process_terminal";
						} catch {
							return false;
						}
					});
					if (terminal) break;
					assert.ok(Date.now() <= deadline, `Timed out waiting for async event 'subagent.run.process_terminal': ${eventsPath}`);
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				const processTerminalPath = path.join(asyncDir, "process-terminal.json");
				const processTerminal = JSON.parse(fs.readFileSync(processTerminalPath, "utf-8")) as { state?: string };
				assert.match(processTerminal.state ?? "", /^(observed|unknown)$/);
				fs.rmSync(asyncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			}
			if (resultPath) fs.rmSync(resultPath, { force: true });
		}
	});

	it("keeps delegated agent and config tool budgets at a minimum of one", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		const cases = [
			makeExecutor([makeAgent("echo", { toolBudget: { hard: 0 } })]),
			makeExecutor([makeAgent("echo")], { toolBudget: { hard: 0 } }),
		];
		for (const [index, executor] of cases.entries()) {
			const result = await executor.executeDelegated(
				`delegated-default-zero-budget-${index}`,
				{ agent: "echo", task: "Do work", delegatedAllowZeroToolBudget: true },
				new AbortController().signal,
				undefined,
				ctx,
			);
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /(?:agent\.|config\.)?toolBudget\.hard must be an integer >= 1/);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects string \"none\" acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"string-none-acceptance",
			{ agent: "echo", task: "Do work", acceptance: "none" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /acceptance level "none" requires a reason/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("accepts JSON-encoded acceptance objects and diagnoses malformed strings", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptance = {
			level: "checked" as const,
			criteria: [{ id: "criterion-1", must: "Return required evidence" }],
		};
		const acceptedOutput = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		const executor = makeExecutor([makeAgent("echo")]);
		for (const [index, input] of [acceptance, JSON.stringify(acceptance)].entries()) {
			mockPi.onCall({ output: acceptedOutput });
			const result = await executor.execute(
				`acceptance-object-string-${index}`,
				{ async: false, agent: "echo", task: "Return the required evidence", acceptance: input as never },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "acceptance run failed");
			assert.equal(result.details.results[0]?.acceptance?.status, "checked");
		}

		const malformed = await executor.execute(
			"malformed-acceptance-object-string",
			{ async: false, agent: "echo", task: "Do not spawn", acceptance: '{"level":"checked"' as never },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /acceptance JSON string must encode a valid acceptance object/i);
		assert.equal(mockPi.callCount(), 2);
	});

	it("rejects invalid verified acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const invalidPolicies = [
			"verified",
			{ level: "verified" },
			{ level: "verified", verify: [] },
		] as const;

		for (const [index, acceptance] of invalidPolicies.entries()) {
			const result = await executor.execute(
				`invalid-verified-acceptance-${index}`,
				{ agent: "echo", task: "Do work", acceptance: acceptance as never },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /(?:verified.*object form|verify.*at least one runtime command)/i);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects invalid verified async chain acceptance before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"invalid-verified-async-chain-acceptance",
			{ chain: [{ agent: "echo", task: "Do work", acceptance: { level: "verified", verify: [] } }], async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /verify.*at least one runtime command/i);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects unknown action strings at runtime", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"unknown-action",
			{ action: "not-a-real-action" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Unknown action: not-a-real-action/);
		assert.match(result.content[0]?.text ?? "", /Valid:/);
	});

	it("records and renders stored lane merge evidence through management actions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const manifestPath = path.join(tempDir, "lane-handoff.json");
		fs.writeFileSync(manifestPath, JSON.stringify({
			version: 1,
			runId: "lane-action",
			mode: "single",
			source: "async",
			cwd: tempDir,
			createdAt: 1,
			updatedAt: 1,
			groups: [{
				stepIndex: 0,
				baseCommit: "base-commit",
				repoRoot: tempDir,
				children: [{
					index: 0,
					taskIndex: 0,
					agent: "worker",
					status: "completed",
					summary: "done",
					patch: { path: path.join(tempDir, "worker.patch"), branch: "lane-action-branch", changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 },
				}],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: path.join(tempDir, "worktree"), branch: "lane-action-branch", worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}],
		}, null, 2), "utf-8");
		const executor = makeExecutor([makeAgent("echo")]);
		const merge = {
			prNumber: 1623,
			reviewedHead: "8888888888888888888888888888888888888888",
			mergeCommit: "9999999999999999999999999999999999999999",
			treeEquivalent: true,
			postMergeChecks: "recorded",
			attestedBy: "nicobailon",
			attestedAt: "2026-08-27T16:23:00.000Z",
		};

		const recorded = await executor.execute(
			"lane-record-action",
			{ action: "lane.recordMerge", laneId: "lane-action", handoffPath: manifestPath, merge },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(recorded.isError, undefined, recorded.content[0]?.text ?? "");
		assert.match(recorded.content[0]?.text ?? "", /Cleanup eligibility: terminal-eligible/);
		assert.equal(recorded.details.parallelHandoff?.cleanupEligibility?.state, "terminal-eligible");

		const rendered = await executor.execute(
			"lane-status-action",
			{ action: "lane.status", laneId: "lane-action", handoffPath: manifestPath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(rendered.isError, undefined, rendered.content[0]?.text ?? "");
		assert.match(rendered.content[0]?.text ?? "", /Cleanup eligibility: terminal-eligible/);
		assert.match(rendered.content[0]?.text ?? "", /action: "worktree\.cleanup"/);

		const invalid = await executor.execute(
			"lane-invalid-action",
			{ action: "lane.recordMerge", laneId: "lane-action", handoffPath: manifestPath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.content[0]?.text ?? "", /merge must be an object/);
	});

	it("routes watchdog.configure through the management action path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const gpt = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
		const opus = { provider: "anthropic", id: "claude-opus-4-8", reasoning: true };
		const models = [gpt, opus];
		const watchdog = new MainWatchdogRuntime({ cwd: tempDir });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			watchdog,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const ctx = {
			...makeMinimalCtx(tempDir),
			model: gpt,
			modelRegistry: {
				getAvailable: () => models,
				find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: (model: unknown) => Boolean(model),
			},
		};

		const result = await executor.execute(
			"watchdog-configure",
			{ action: "watchdog.configure", model: "recommended" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /session model configured: anthropic\/claude-opus-4-8:high/);
		assert.equal(watchdog.getSnapshot(tempDir).config.main.model, "anthropic/claude-opus-4-8");
	});

	it("rejects duplicate concurrent subagent execution calls", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Duplicate call" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows concurrent delegated foreground execution calls", async () => {
		mockPi.onCall({ output: "first delegated call", delay: 100 });
		mockPi.onCall({ output: "second delegated call", delay: 100 });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);
		const ctx = makeMinimalCtx(tempDir);

		const [first, second] = await Promise.all([
			executor.executeDelegated("first", { agent: "echo", task: "First delegated call" }, new AbortController().signal, undefined, ctx),
			executor.executeDelegated("second", { agent: "second", task: "Second delegated call" }, new AbortController().signal, undefined, ctx),
		]);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
	});

	it("routes registered structured text delegation through the concurrent executor", async () => {
		const literalJsonText = '{"looks":"json"}';
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{}")], delay: 20 },
				{
					jsonl: [{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: literalJsonText }],
							model: "mock/test-model",
							stopReason: "stop",
							usage: {
								input: 11,
								output: 7,
								cacheRead: 3,
								cacheWrite: 2,
								cost: { total: 0.0125 },
							},
						},
					}],
					delay: 60,
				},
			],
		});
		mockPi.onCall({ output: "registered structured second node", delay: 100 });
		const extensionEvents = createEventBus();
		const runtimeHandlers = new Map<string, Array<(event: unknown, ctx: ReturnType<typeof makeMinimalCtx>) => void>>();
		const fakePi = new Proxy({
			events: extensionEvents,
			on(event: string, handler: (event: unknown, ctx: ReturnType<typeof makeMinimalCtx>) => void) {
				const handlers = runtimeHandlers.get(event) ?? [];
				handlers.push(handler);
				runtimeHandlers.set(event, handlers);
				return () => runtimeHandlers.set(event, (runtimeHandlers.get(event) ?? []).filter((entry) => entry !== handler));
			},
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			sendMessage() {},
			getSessionName() { return undefined; },
		}, {
			get(target, prop) {
				if (prop in target) return target[prop as keyof typeof target];
				return () => undefined;
			},
		});
		const ctx = {
			...makeMinimalCtx(tempDir),
			modelRegistry: {
				getAvailable: () => [{ provider: "mock", id: "test-model", reasoning: true }],
			},
			sessionManager: {
				getSessionId: () => "registered-delegation-session",
				getSessionFile: () => path.join(tempDir, "registered-delegation-session.jsonl"),
				getEntries: () => [],
			},
		};
		const started: SubagentDelegationStarted[] = [];
		const responses: SubagentDelegationResponse[] = [];
		extensionEvents.on(SUBAGENT_DELEGATION_STARTED_EVENT, (payload) => {
			if ((payload as { ownerRunId?: unknown }).ownerRunId === "owner-delegation") {
				started.push(payload as SubagentDelegationStarted);
			}
		});
		extensionEvents.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
			if ((payload as { ownerRunId?: unknown }).ownerRunId === "owner-delegation") {
				responses.push(payload as SubagentDelegationResponse);
			}
		});

		const firstRequest = {
			requestId: "registered-a",
			ownerRunId: "owner-delegation",
			nodeId: "node-a",
			agent: "worker",
			task: "Return literal JSON-looking text",
			context: "fresh",
			cwd: tempDir,
			model: "mock/test-model",
			thinking: "high",
			result: { kind: "text" },
		} satisfies SubagentDelegationRequest;
		const secondRequest = {
			requestId: "registered-b",
			ownerRunId: "owner-delegation",
			nodeId: "node-b",
			agent: "reviewer",
			task: "Run the second logical node",
			context: "fresh",
			cwd: tempDir,
			model: "mock/test-model",
			thinking: "high",
			result: { kind: "text" },
		} satisfies SubagentDelegationRequest;

		try {
			const previousChildEnv = process.env[SUBAGENT_CHILD_ENV];
			delete process.env[SUBAGENT_CHILD_ENV];
			try {
				registerSubagentExtension(fakePi as never);
			} finally {
				if (previousChildEnv === undefined) delete process.env[SUBAGENT_CHILD_ENV];
				else process.env[SUBAGENT_CHILD_ENV] = previousChildEnv;
			}
			for (const handler of runtimeHandlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
			extensionEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, firstRequest);
			extensionEvents.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, secondRequest);

			const callDeadlineAt = Date.now() + 30_000;
			while (mockPi.callCount() < 2 && responses.length < 2 && Date.now() < callDeadlineAt) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(mockPi.callCount(), 2, `different logical nodes should use the concurrent delegated execution path: ${JSON.stringify(responses)}`);
			assert.deepEqual(started.map(({ requestId, ownerRunId, nodeId }) => ({ requestId, ownerRunId, nodeId })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
				{ requestId: "registered-a", ownerRunId: "owner-delegation", nodeId: "node-a" },
				{ requestId: "registered-b", ownerRunId: "owner-delegation", nodeId: "node-b" },
			]);

			const responseDeadlineAt = Date.now() + 30_000;
			while (responses.length < 2 && Date.now() < responseDeadlineAt) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(responses.length, 2);
			assert.ok(responses.every((response) => response.status === "completed"));
			const terminalResponses = responses.filter((response) => response.status !== "invalid_request");
			assert.equal(terminalResponses.length, 2);
			for (const response of terminalResponses) {
				assert.equal(response.ownerRunId, "owner-delegation");
				assert.equal(response.model, "mock/test-model:high");
				assert.equal(response.thinking, "high");
				assert.match(response.launchContractDigest ?? "", /^[0-9a-f]{64}$/);
			}
			const literalResponse = terminalResponses.find((response) => response.result?.kind === "text" && response.result.text === literalJsonText);
			assert.ok(literalResponse);
			assert.deepEqual(literalResponse.result, { kind: "text", text: literalJsonText });
			assert.deepEqual(literalResponse.usage && {
				input: literalResponse.usage.input,
				output: literalResponse.usage.output,
				cacheRead: literalResponse.usage.cacheRead,
				cacheWrite: literalResponse.usage.cacheWrite,
				cost: literalResponse.usage.cost,
				turns: literalResponse.usage.turns,
				toolCalls: literalResponse.usage.toolCalls,
			}, {
				input: 11,
				output: 7,
				cacheRead: 3,
				cacheWrite: 2,
				cost: 0.0125,
				turns: 1,
				toolCalls: 1,
			});
			assert.equal(typeof literalResponse.usage?.durationMs, "number");
			const plainResponse = terminalResponses.find((response) => response.result?.kind === "text" && response.result.text === "registered structured second node");
			assert.ok(plainResponse);
		} finally {
			for (const handler of runtimeHandlers.get("session_shutdown") ?? []) {
				await handler({}, ctx);
			}
		}
	});

	it("allows concurrent async launches in one turn", async () => {
		mockPi.onCall({ output: "async one" });
		mockPi.onCall({ output: "async two" });
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")]);
		const ctx = makeMinimalCtx(tempDir);
		const [first, second] = await Promise.all([
			executor.execute("first", { agent: "echo", task: "First", async: true }, new AbortController().signal, undefined, ctx),
			executor.execute("second", { agent: "second", task: "Second", async: true }, new AbortController().signal, undefined, ctx),
		]);
		assert.doesNotMatch(first.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		assert.doesNotMatch(second.content[0]?.text ?? "", /Issue exactly ONE subagent call per turn/);
		const deadlineAt = Date.now() + 30_000;
		while (mockPi.callCount() < 2 && Date.now() < deadlineAt) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(mockPi.callCount(), 2, "both detached mock children should start before test cleanup");
	});

	it("does not impose a cumulative spawn cap by default", async () => {
		mockPi.onCall({ output: "continued after forty launches" });
		const spawnState = { sessionId: "session-123", count: 40 };
		const executor = makeExecutor([makeAgent("echo")], {}, false, spawnState);
		const ctx = makeMinimalCtx(tempDir);

		const result = await executor.execute("forty-one", { agent: "echo", task: "Continue work" }, new AbortController().signal, undefined, ctx);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(spawnState.count, 40, "unlimited sessions should bypass cumulative accounting");
	});

	it("blocks total subagent spawns after an opt-in per-session quota", async () => {
		mockPi.onCall({ output: "first call completed" });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 });
		const ctx = makeMinimalCtx(tempDir);

		const first = await executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const second = await executor.execute("second", { agent: "echo", task: "Second call" }, new AbortController().signal, undefined, ctx);

		assert.equal(first.isError, undefined);
		assert.equal(second.isError, true);
		assert.match(second.content[0]?.text ?? "", /Subagent spawn limit reached for this session \(1\/1 used, 1 requested\)/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("qualifies inherited nested claims with the generated nested run id", async () => {
		mockPi.onCall({ output: "nested completed" });
		const descriptor = createRunFanoutBudget("root-run", 2);
		try {
			const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), undefined, {
				fanoutChild: true,
				depth: 1,
				waitTool: { enabled: true },
				fast: false,
				runFanoutBudget: { ...descriptor, parentPath: "tasks[0]" },
			});
			const result = await executor.execute("nested", { agent: "echo", task: "Nested work" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "nested run failed");
			const claims = fs.readdirSync(path.join(descriptor.directory, "claims"));
			assert.equal(claims.length, 1);
			const claim = JSON.parse(fs.readFileSync(path.join(descriptor.directory, "claims", claims[0]!), "utf-8")) as { path: string };
			assert.match(claim.path, /^tasks\[0\]\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/single$/);
		} finally {
			fs.rmSync(descriptor.directory, { recursive: true, force: true });
		}
	});

	it("rejects an over-limit static run fan-out before creating session artifacts", async () => {
		const sessionDir = path.join(tempDir, "run-fanout-preflight");
		const executor = makeExecutor([makeAgent("echo"), makeAgent("second")], { maxSubagentSpawnsPerRun: 1 });
		const result = await executor.execute(
			"run-fanout-preflight",
			{ tasks: [{ agent: "echo", task: "First" }, { agent: "second", task: "Second" }], sessionDir },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Run fan-out limit reached at tasks\[1\] \(0\/1 used; 2 requested, 1 remaining\)/);
		assert.deepEqual(result.details.runFanoutBudget, { used: 0, limit: 1, remaining: 1 });
		assert.equal(result.details.runFanoutRejection?.path, "tasks[1]");
		assert.equal(fs.existsSync(sessionDir), false);
		assert.equal(mockPi.callCount(), 0);
	});

	it("reports structured spawn-budget usage through status", async () => {
		const spawnState = { sessionId: "session-123", count: 3, configuredLimit: 4, granted: 1, grantHistory: [] };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 4 }, false, spawnState);

		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.match(status.content[0]?.text ?? "", /^Status target: active runs\nSpawn budget: 3\/5 used, 2 remaining/);
		assert.deepEqual(status.details?.spawnBudget, {
			used: 3,
			configuredLimit: 4,
			granted: 1,
			limit: 5,
			remaining: 2,
			grantRemaining: 3,
			grantHistory: [],
		});
	});

	it("preflights static chains before creating run artifacts", async () => {
		const sessionDir = path.join(tempDir, "preflight-session");
		const executor = makeExecutor(
			[makeAgent("echo"), makeAgent("second")],
			{ maxSubagentSpawnsPerSession: 1 },
		);
		const result = await executor.execute(
			"chain-preflight",
			{
				chain: [
					{ agent: "echo", task: "First" },
					{ agent: "second", task: "Second" },
				],
				sessionDir,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /0\/1 used, 2 requested\).*1 remaining/);
		assert.match(result.content[0]?.text ?? "", /no children were started/);
		assert.equal(fs.existsSync(sessionDir), false);
		assert.equal(mockPi.callCount(), 0);
	});

	it("applies bounded root-interactive spawn-budget grants", async () => {
		mockPi.onCall({ output: "continued after grant" });
		const spawnState = { sessionId: "session-123", count: 1 };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 1 }, false, spawnState);
		const decisions = [false, true];
		let confirmations = 0;
		const interactiveCtx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: { confirm: async () => { confirmations += 1; return decisions.shift() ?? false; } },
		};

		const canceled = await executor.execute(
			"cancel-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const granted = await executor.execute(
			"grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const run = await executor.execute(
			"after-grant",
			{ agent: "echo", task: "Continue" },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);
		const exhausted = await executor.execute(
			"grant-again",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			interactiveCtx,
		);

		assert.equal(canceled.isError, undefined);
		assert.match(canceled.content[0]?.text ?? "", /grant canceled; no capacity was added/i);
		assert.equal(granted.isError, undefined);
		assert.match(granted.content[0]?.text ?? "", /grant applied: \+1/i);
		assert.equal(confirmations, 2);
		assert.equal(granted.details?.spawnBudget?.limit, 2);
		assert.equal(run.isError, undefined);
		assert.equal(spawnState.count, 2);
		assert.equal(exhausted.isError, true);
		assert.match(exhausted.content[0]?.text ?? "", /only 0 of the original configured limit remains grantable/);
	});

	it("rechecks spawn-budget state after confirmation", async () => {
		const spawnState = { sessionId: "session-123", count: 0 };
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 }, false, spawnState);
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: { confirm: async () => { spawnState.count = 1; return true; } },
		};

		const result = await executor.execute(
			"grant-race",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /budget, or active-child state changed/);
		assert.equal(result.details?.spawnBudget?.granted, 0);
	});

	it("rejects spawn-budget grants outside a settled root interactive session", async () => {
		mockPi.onCall({ output: "still running", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 });
		const headless = await executor.execute(
			"headless-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childSafe = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerSession: 2 }, false, undefined, false);
		const child = await childSafe.execute(
			"child-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		const asyncActive = makeExecutor(
			[makeAgent("echo")],
			{ maxSubagentSpawnsPerSession: 2 },
			false,
			undefined,
			true,
			new Map([["async-active", { asyncId: "async-active", asyncDir: tempDir, status: "running", sessionId: "session-123" }]]),
		);
		const detached = await asyncActive.execute(
			"async-active-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		const running = executor.execute(
			"running",
			{ agent: "echo", task: "Long run" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const active = await executor.execute(
			"active-grant",
			{ action: "grant-spawn-budget", additional: 1 },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), hasUI: true },
		);
		await running;

		assert.equal(headless.isError, true);
		assert.match(headless.content[0]?.text ?? "", /root interactive parent session/);
		assert.equal(child.isError, true);
		assert.match(child.content[0]?.text ?? "", /root interactive parent session/);
		assert.equal(detached.isError, true);
		assert.match(detached.content[0]?.text ?? "", /rejected while current-session children are queued or running/);
		assert.equal(active.isError, true);
		assert.match(active.content[0]?.text ?? "", /rejected while current-session children are queued or running/);
	});

	it("allows management actions while an execution call is in progress", async () => {
		mockPi.onCall({ output: "first call completed", delay: 100 });
		const executor = makeExecutor([makeAgent("echo")]);
		const ctx = makeMinimalCtx(tempDir);

		const first = executor.execute("first", { agent: "echo", task: "First call" }, new AbortController().signal, undefined, ctx);
		const status = await executor.execute("status", { action: "status" }, new AbortController().signal, undefined, ctx);
		const firstResult = await first;

		assert.equal(firstResult.isError, undefined);
		assert.equal(status.isError, undefined);
		assert.doesNotMatch(status.content[0]?.text ?? "", /Rejected: a subagent call is already in progress/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("creates a plan-only worktree cleanup action without removing managed state", { skip: !createSubagentExecutor ? "executor not importable" : process.platform === "win32" ? "worktree paths differ on Windows" : undefined }, async () => {
		const repo = path.join(tempDir, "cleanup-repo");
		const baseDir = path.join(tempDir, "cleanup-worktrees");
		fs.mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "base"], { cwd: repo, stdio: "ignore" });
		const setup = await createWorktrees(repo, "action", 1, { baseDir });
		const worktree = setup.worktrees[0]!;
		const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
		const baseCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
		fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
		fs.writeFileSync(manifestPath, JSON.stringify({
			version: 1,
			runId: "cleanup-action-run",
			mode: "parallel",
			source: "async",
			cwd: repo,
			createdAt: 1,
			updatedAt: 1,
			groups: [{
				stepIndex: 0,
				baseCommit,
				repoRoot: repo,
				children: [{
					index: 0,
					taskIndex: 0,
					agent: "worker",
					status: "completed",
					summary: "done",
					patch: { path: path.join(repo, ".pi", "subagents", "artifacts", "worktree.patch"), branch: worktree.branch, changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 },
				}],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: worktree.path, branch: worktree.branch, worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}],
		}, null, 2), "utf-8");
		fs.writeFileSync(path.join(repo, ".pi", "subagents", "artifacts", "status.json"), JSON.stringify({ runId: "cleanup-action-run", state: "complete" }), "utf-8");
		try {
			const executor = makeExecutor([makeAgent("echo")], { worktreeBaseDir: baseDir });
			const result = await executor.executePublic("cleanup-plan", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "plan" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, result.content[0]?.text ?? "cleanup plan failed");
			const text = result.content[0]?.text ?? "";
			assert.match(text, /Will remove/);
			assert.match(text, /Plan-only mode: no worktrees or branches were removed/);
			const planFiles = fs.readdirSync(path.join(repo, ".pi", "subagents", "cleanup-plans"));
			assert.equal(planFiles.length, 1);
			const planId = planFiles[0]!.replace(/\.json$/, "");
			const childSafe = makeExecutor([makeAgent("echo")], { worktreeBaseDir: baseDir }, false, undefined, false);
			const childSafeResult = await childSafe.executePublic("cleanup-child-safe", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "plan" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(childSafeResult.isError, true);
			assert.match(childSafeResult.content[0]?.text ?? "", /child-safe subagent fanout mode/i);
			const apply = await executor.executePublic("cleanup-apply", { action: "worktree.cleanup", repo: "cleanup-repo", mode: "apply", planId }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(apply.isError, true);
			assert.match(apply.content[0]?.text ?? "", /plan.*only|apply\/removal is not available/i);
			assert.ok(fs.existsSync(worktree.path));
			assert.notEqual(execFileSync("git", ["-C", repo, "branch", "--list", worktree.branch], { encoding: "utf-8" }).trim(), "");
		} finally {
			try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree.path], { stdio: "ignore" }); } catch {}
			try { execFileSync("git", ["-C", repo, "branch", "-D", worktree.branch], { stdio: "ignore" }); } catch {}
		}
	});



	it("reports total cost for foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single result" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-cost",
			{ agent: "echo", task: "Single task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.deepEqual(result.details?.totalCost, { inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
		assert.deepEqual(result.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
	});

	it("ignores stale foreground control notification contexts after reload", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const staleEvents = {
			on: createEventBus().on,
			emit() { throw new Error("This extension ctx is stale after session replacement or reload."); },
		};
		const updates: ExecutorToolResult[] = [];
		const executor = createSubagentExecutor!({
			pi: { events: staleEvents, getSessionName: () => undefined },
			state,
			config: { control: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running"], notifyChannels: ["event"] } },
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
			allowMutatingManagementActions: true,
		});

		const result = await executor.execute(
			"stale-control-context",
			{ agent: "echo", task: "Investigate behavior", async: false },
			new AbortController().signal,
			(update: ExecutorToolResult) => updates.push(update),
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "foreground run failed");
		assert.equal(result.details.results[0]?.exitCode, 0);
		const controlEvents = updates.flatMap((update) => update.details?.controlEvents ?? []);
		assert.equal(controlEvents[0]?.type, "active_long_running");
	});

	it("emits resolved model and thinking for nested foreground starts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "nested result" });
		const route = createNestedRoute("root-nested-model");
		try {
			const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini", thinking: "high" })], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), undefined, {
				fanoutChild: true,
				depth: 1,
				waitTool: { enabled: true },
				fast: false,
				nestedRoute: route,
				nestedParent: { parentRunId: "parent-run", parentChildIndex: 2, depth: 1, path: [] },
			});

			const result = await executor.execute(
				"nested-model-start",
				{ agent: "echo", task: "Nested task" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const records = fs.readdirSync(route.eventSink)
				.sort()
				.flatMap((name) => parseNestedEventRecords(fs.readFileSync(path.join(route.eventSink, name), "utf-8"), route));
			const started = records.find((record) => record.type === "subagent.nested.started");
			assert.equal(started?.child.model, "openai/gpt-5-mini");
			assert.equal(started?.child.thinking, "high");
			assert.deepEqual(started?.child.steps, [{ agent: "echo", status: "running", model: "openai/gpt-5-mini", thinking: "high" }]);
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("rejects implementation runs without mutation-capable tools before spawn", async () => {
		mockPi.onCall({ output: "should not spawn" });
		const agents = [makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "readonly-contract-run",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
		});

	it("fails implementation runs that complete without mutation attempts", async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("preserves terminal empty-output diagnostics after useful foreground work", async () => {
		const partialOutput = "I’ll inspect the retained candidate before changing it.";
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				events.assistantMessage(partialOutput),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 0,
		});

		const result = await runSync(tempDir, [makeAgent("worker")], "worker", "Implement the approved file changes", {
			runId: "foreground-aborted-empty-output",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
		assert.doesNotMatch(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, partialOutput);
	});

	it("reports why an unsafe foreground compaction abort cannot resume without falling back", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "mock/test-model",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Fallback must not run" });

		const result = await runSync(tempDir, [makeAgent("worker", { model: "mock/test-model", fallbackModels: ["mock/fallback-model"] })], "worker", "Inspect the current source", {
			runId: "foreground-compaction-abort-no-session",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Subagent produced no output after terminal assistant stopReason "aborted"\./);
		assert.match(result.error ?? "", /Compaction-induced child abort could not be resumed safely: retained session unavailable\./);
		assert.equal(mockPi.callCount(), 1);
	});

	it("agent contract v1 reports omitted acceptance separately without injecting a prompt", async () => {
		mockPi.onCall({ output: "Plan only" });
		const agents = [makeAgent("worker", { tools: ["read", "write"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "v1-no-acceptance",
			agentContract: { version: 1 },
		});
		const call = readCall();

		assert.equal(result.exitCode, 0);
		assert.equal(result.agentContract?.version, 1);
		assert.deepEqual(result.execution, { status: "completed", success: true, exitCode: 0 });
		assert.equal(result.acceptance?.status, "not-required");
		assert.equal(result.review?.status, "not-requested");
		assert.deepEqual(result.effects, {});
		assert.doesNotMatch(call.args.join("\n"), /## Acceptance Contract/);
	});

	it("does not inject inferred acceptance into reviewer prompts", async () => {
		mockPi.onCall({ output: "VERDICT: PASS" });
		const result = await runSync(tempDir, [makeAgent("reviewer", { tools: ["read"], completionGuard: false })], "reviewer", "Review the diff and return findings only.", {
			runId: "reviewer-inferred-acceptance",
		});

		assert.equal(result.exitCode, 0);
		assert.doesNotMatch(readCall().args.join("\n"), /## Acceptance Contract/);
	});

	it("agent contract v1 keeps acceptance rejection out of execution status", async () => {
		mockPi.onCall({ output: "Done\n```acceptance-report\n{\"criteriaSatisfied\":[{\"id\":\"criterion-1\",\"status\":\"not-satisfied\",\"evidence\":\"no proof\"}]}\n```" });
		const agents = [makeAgent("worker", { tools: ["read"], completionGuard: false })];

		const result = await runSync(tempDir, agents, "worker", "Summarize the fix", {
			runId: "v1-acceptance-reject",
			agentContract: { version: 1 },
			acceptance: { level: "checked", criteria: ["Return required proof"] },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.execution?.status, "completed");
		assert.equal(result.execution?.success, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.match(result.acceptance.runtimeChecks?.[0]?.message ?? "", /not-satisfied/);
	});

	it("agent contract v1 records explicit completion guard as an effect", async () => {
		mockPi.onCall({ output: "Plan only" });
		const agents = [makeAgent("worker", { tools: ["read", "write"], completionGuard: true })];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "v1-completion-effect",
			agentContract: { version: 1 },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.execution?.status, "completed");
		assert.equal(result.effects?.fileMutation?.status, "missing");
		assert.equal(result.effects?.fileMutation?.expected, true);
		assert.equal(result.effects?.fileMutation?.attempted, false);
	});

	it("direct single tool calls support outputSchema", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true, note: "captured" } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true, note: "captured" },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" }, note: { type: "string" } } }, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		const child = result.details?.results?.[0];
		assert.deepEqual(child?.structuredOutput, { ok: true, note: "captured" });
		assert.match(child?.finalOutput ?? "", /"ok": true/);
		if (child?.artifactPaths?.outputPath) assert.match(fs.readFileSync(child.artifactPaths.outputPath, "utf-8"), /"note": "captured"/);
	});

	it("routes retained workflow follow-ups to distinct outputs without overwriting the writer report", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		for (const relative of [false, true]) {
			const writerPath = path.join(tempDir, `writer-${relative}.md`);
			const challengeOutput = relative ? "challenge-relative.md" : path.join(tempDir, "challenge-absolute.md");
			mockPi.onCall({ output: "original writer report" });
			mockPi.onCall({ output: "retained challenge report" });
			const result = await makeExecutor([makeAgent("echo")], {}, true).execute(
				`workflow-retained-output-${relative}`,
				{
					async: false,
					workflowScript: `
						const writer = await runs.run("writer", { agent: "echo", task: "Write report", acceptance: false, output: ${JSON.stringify(writerPath)} });
						const challenge = await runs.run("challenge", { resume: writer.runId, task: "Challenge report", output: ${JSON.stringify(challengeOutput)} });
						return { writer, challenge };
					`,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
			const { writer, challenge } = result.details.workflow?.value as { writer: { ok: boolean; runId: string; outputReference: string }; challenge: { ok: boolean; runId: string; outputReference: string } };
			assert.equal(writer.ok, true);
			assert.equal(challenge.ok, true);
			assert.notEqual(challenge.runId, writer.runId);
			assert.equal(writer.outputReference, writerPath);
			const challengePath = relative ? path.join(TEMP_ARTIFACTS_DIR, "outputs", `workflow-retained-output-${relative}`, challengeOutput) : challengeOutput;
			assert.equal(challenge.outputReference, challengePath);
			assert.notEqual(challenge.outputReference, writer.outputReference);
			assert.equal(fs.readFileSync(writer.outputReference, "utf-8"), "original writer report");
			assert.equal(fs.readFileSync(challenge.outputReference, "utf-8"), "retained challenge report");
			assert.deepEqual(result.details.results.map((child) => child.savedOutputPath), [writerPath, challengePath]);
		}
		assert.equal(mockPi.callCount(), 4);
	});

	it("applies explicit structured-output contract fields when resuming a foreground workflow child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const firstSchema = { type: "object", required: ["first"], properties: { first: { type: "boolean" } } };
		const firstEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { first: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		const resumedEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({ stdoutRaw: firstEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { first: true } });
		mockPi.onCall({ stdoutRaw: resumedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-explicit-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First", outputSchema: ${JSON.stringify(firstSchema)}, agentContract: { version: 1 }, acceptance: false, output: true });
					return runs.run("resumed", { resume: first.runId, task: "Resume", outputSchema: ${JSON.stringify(schema)}, agentContract: { version: 1 }, acceptance: false, output: false });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const resumed = result.details.workflow?.value as { ok?: boolean; structuredOutput?: unknown; savedOutputPath?: string };
		assert.equal(resumed.ok, true);
		assert.deepEqual(resumed.structuredOutput, { ok: true });
		assert.equal(resumed.savedOutputPath, undefined);
	});

	it("preserves the structured-output contract when resume fields are omitted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
		const structuredEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({ stdoutRaw: structuredEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		mockPi.onCall({ stdoutRaw: structuredEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n", structuredOutputCapture: { ok: true } });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-inherited-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First", outputSchema: ${JSON.stringify(schema)}, agentContract: { version: 1 }, acceptance: false, output: false });
					return runs.run("resumed", { resume: first.runId, task: "Resume" });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const resumed = result.details.workflow?.value as { ok?: boolean; structuredOutput?: unknown };
		assert.equal(resumed.ok, true);
		assert.deepEqual(resumed.structuredOutput, { ok: true });
	});

	it("auto-resumes a workflow child after a setup abort", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("read", { path: "src/index.ts" }),
				events.toolEnd("read"),
				events.toolResult("read", "file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai-codex/gpt-5.6-luna",
						stopReason: "error",
						errorMessage: "This operation was aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after workflow auto-resume" });

		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-auto-resume-setup-abort",
			{
				async: false,
				workflowScript: `return runs.run("review", { agent: "echo", task: "Review the current diff", acceptance: false });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const child = result.details.workflow?.value as { ok?: boolean; runId?: string; output?: string; continuation?: { runIds?: string[] } };
		assert.equal(child.ok, true);
		assert.match(child.output ?? "", /Recovered after workflow auto-resume/u);
		assert.deepEqual(result.details.results[0]?.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 });
		// The workflow-level setup recovery is a distinct launch, so its receipt
		// retains both the failed source run and the resumed child run. The
		// compaction planner no longer hides this source by resuming it first.
		assert.equal(child.continuation?.runIds?.length, 2);
		assert.notEqual(child.continuation?.runIds?.[0], child.runId);
		assert.equal(child.continuation?.runIds?.at(-1), child.runId);
		assert.equal(mockPi.callCount(), 2);
	});

	it("preserves an agent default output contract when foreground workflow resume omits output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredOutput = path.join(tempDir, "configured-resume-output.md");
		const agent = makeAgent("echo", { output: configuredOutput, outputMode: "file-only" });
		const executor = makeExecutor([agent]);
		mockPi.onCall({ output: "first report" });
		mockPi.onCall({ output: "resumed report" });

		const firstResult = await executor.execute(
			"workflow-agent-output-first",
			{ async: false, workflowScript: `return runs.run("first", { agent: "echo", task: "First", acceptance: false });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(firstResult.isError, undefined, firstResult.content[0]?.text ?? "workflow failed");
		const first = firstResult.details.workflow?.value as { runId?: string };
		const firstChild = firstResult.details.results[0];
		assert.ok(first.runId);
		assert.equal(firstChild?.savedOutputPath, configuredOutput);
		assert.equal(firstChild?.outputMode, "file-only");

		agent.output = undefined;
		agent.outputMode = undefined;
		const resumedResult = await executor.execute(
			"workflow-agent-output-resumed",
			{ async: false, workflowScript: `return runs.run("resumed", { resume: ${JSON.stringify(first.runId)}, task: "Resume" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumedResult.isError, undefined, resumedResult.content[0]?.text ?? "workflow failed");
		const resumed = resumedResult.details.results[0];
		assert.match(resumed?.finalOutput ?? "", new RegExp(`Output saved to: ${escapeRegExp(configuredOutput)}`));
		assert.equal(fs.readFileSync(configuredOutput, "utf-8"), "resumed report");
	});

	it("preserves failed foreground resume errors and transcript metadata", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		mockPi.onCall({ output: "first report" });
		const firstResult = await executor.execute(
			"workflow-resume-failure-first",
			{ async: false, workflowScript: `return runs.run("first", { agent: "echo", task: "First" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(firstResult.isError, undefined, firstResult.content[0]?.text ?? "workflow failed");
		const first = firstResult.details.workflow?.value as { runId?: string };
		assert.ok(first.runId);

		const partialOutput = "I’ll re-read the current implementation before changing it.";
		mockPi.onCall({ output: partialOutput });
		const resumedResult = await executor.execute(
			"workflow-resume-failure-resumed",
			{ async: false, workflowScript: `return runs.run("resumed", { resume: ${JSON.stringify(first.runId)}, task: "Implement the approved file changes" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(resumedResult.isError, true);
		const resumedText = resumedResult.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		assert.match(resumedText, /Subagent completed without making edits for an implementation task/);
		assert.doesNotMatch(resumedText, new RegExp(`^${escapeRegExp(partialOutput)}`));
		const child = resumedResult.details.results[0];
		assert.equal(child?.finalOutput, partialOutput);
		assert.match(child?.error ?? "", /Subagent completed without making edits for an implementation task/);
		assert.ok(child?.transcriptPath);
		assert.equal(child?.transcriptPath, child?.artifactPaths?.transcriptPath);
		assert.ok(child?.artifactPaths?.outputPath);
		assert.match(fs.readFileSync(child.transcriptPath, "utf-8"), /first|re-read|implementation/i);
	});

	it("fails closed on an invalid explicit foreground resume output schema", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first result" });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-invalid-explicit-resume-schema",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First" });
					return runs.run("resumed", { resume: first.runId, task: "Resume", outputSchema: null });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputSchema must be a JSON Schema object/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("workflow children with outputSchema can satisfy inherited checked acceptance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptanceReport = {
			criteriaSatisfied: [{ id: "proof", status: "satisfied", evidence: "structured output returned ok true" }],
			changedFiles: ["none"],
			testsAddedOrUpdated: ["none"],
			commandsRun: [{ command: "not run", result: "not-run", summary: "mock structured-output child" }],
			validationOutput: ["mock output validated"],
			residualRisks: ["none"],
			noStagedFiles: true,
			diffSummary: "no file changes",
		};
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true }, acceptanceReport } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
			structuredOutputAcceptanceReport: acceptanceReport,
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-schema-acceptance-sidecar",
			{
				async: false,
				acceptance: { level: "checked", report: "on", criteria: [{ id: "proof", must: "Return required proof" }] },
				workflowScript: `
					const child = await runs.run("schema", {
						agent: "echo",
						task: "Return structured data",
						outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details.results[0];
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.deepEqual(child?.structuredOutput, { ok: true });
		assert.equal(child?.acceptance?.status, "checked");
		assert.equal(child?.acceptance?.runtimeChecks.some((check) => check.status === "failed"), false);
	});

	it("rejects workflow outputSchema children that omit checked acceptance sidecars", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-schema-acceptance-missing-sidecar",
			{
				async: false,
				acceptance: { level: "checked", report: "on", criteria: [{ id: "proof", must: "Return required proof" }] },
				workflowScript: `
					const child = await runs.run("schema", {
						agent: "echo",
						task: "Return structured data",
						outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details.results[0];
		assert.equal(result.isError, true);
		assert.equal(child?.exitCode, 1);
		assert.equal(child?.structuredOutput?.ok, true);
		assert.equal(child?.acceptance?.status, "rejected");
		assert.match(result.content[0]?.text ?? "", /acceptance/i);
	});

	it("uses fenced acceptance reports when outputSchema acceptance report capture is off", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptanceReport = {
			criteriaSatisfied: [{ id: "proof", status: "satisfied", evidence: "fenced proof" }],
			changedFiles: [], testsAddedOrUpdated: [],
			commandsRun: [{ command: "mock", result: "passed", summary: "passed" }],
			validationOutput: ["validated"], residualRisks: [], noStagedFiles: true,
		};
		mockPi.onCall({
			matchArgIncludes: "Finish with a fenced JSON block tagged `acceptance-report`",
			stdoutRaw: [
				events.assistantMessage(`done\n\`\`\`acceptance-report\n${JSON.stringify(acceptanceReport)}\n\`\`\``),
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});

		const result = await makeExecutor([makeAgent("echo")]).execute(
			"single-schema-fenced-acceptance",
			{
				agent: "echo", task: "Return structured data",
				outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
				acceptance: { level: "checked", report: "off", criteria: [{ id: "proof", must: "Return required proof" }] },
			},
			new AbortController().signal, undefined, makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.results[0]?.acceptance?.status, "checked");
	});

	it("accepts recovered tool errors before valid structured output but rejects later errors", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const recoveredError = { type: "tool_result_end", message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "EISDIR" }] } };
		const structuredEvents = [
			{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
			{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
			{ type: "tool_execution_end", toolName: "structured_output" },
		];
		mockPi.onCall({
			stdoutRaw: [recoveredError, ...structuredEvents].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);
		const params = { agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false } as const;

		const recovered = await executor.execute("single-schema-recovered-error", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(recovered.isError, undefined);
		assert.deepEqual(recovered.details?.results?.[0]?.structuredOutput, { ok: true });

		mockPi.reset();
		mockPi.onCall({
			stdoutRaw: [...structuredEvents, recoveredError].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const terminal = await executor.execute("single-schema-terminal-error", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(terminal.isError, true);
		assert.match(terminal.details?.results?.[0]?.error ?? "", /read failed/);
	});

	it("rejects structured output captured without a structured_output tool call", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "spoofed", structuredOutputCapture: { ok: true } });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema-spoof",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false, artifacts: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details?.results?.[0];
		assert.equal(result.isError, true);
		assert.equal(child?.structuredOutputFailed, true);
		assert.match(child?.error ?? "", /Missing structured_output call/);
		assert.ok(child?.structuredOutputPath);
		assert.equal(fs.existsSync(path.dirname(child.structuredOutputPath)), false);
	});

	it("does not create a temporary structured output directory before file-only validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = tempDir;
		try {
			const executor = makeExecutor([makeAgent("echo")]);

			const result = await executor.execute(
				"single-schema-file-only-missing-path",
				{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, outputMode: "file-only", acceptance: false, artifacts: false },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
			assert.equal(mockPi.callCount(), 0);
			assert.equal(fs.readdirSync(tempDir).some((name) => name.startsWith("pi-subagent-structured-")), false);
		} finally {
			if (previousTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmpdir;
		}
	});

	it("allows a structured_output tool call at the exact strict turn boundary", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			stdoutRaw: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "structured-1", name: "structured_output", arguments: { value: { ok: true } } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"single-schema-strict-boundary",
			{ agent: "echo", task: "Return structured data", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const child = result.details?.results?.[0];
		assert.equal(result.isError, undefined);
		assert.deepEqual(child?.structuredOutput, { ok: true });
	});

	it("returns captured output when the foreground executor fails an implementation run", async () => {
		mockPi.onCall({ output: "Oracle review:\n- finding one\n- finding two" });
		const executor = makeExecutor([makeAgent("oracle")]);

		const result = await executor.execute(
			"failed-single-output",
			{ agent: "oracle", task: "Implement the approved file changes" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, true);
		assert.match(text, /completed without making edits/);
		assert.match(text, /Output:\nOracle review:\n- finding one\n- finding two/);
		assert.match(text, /Output artifact: /);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled implementation tasks conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Patch the cold start test", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Patch the cold start test", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("resolves explicit agent aliases to canonical execution names", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Implemented" });
		const executor = makeExecutor([makeAgent("worker", { aliases: ["developer"], completionGuard: false })]);

		const result = await executor.execute("single", { agent: "developer", task: "Implement" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results[0]?.agent, "worker");
		assert.match(result.content[0]?.text ?? "", /Implemented/);
	});

	it("returns error for unknown agent without retaining the prompt", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const sentinel = "PROMPT_AUDIT_SENTINEL_UNKNOWN";
		const result = await runSync(tempDir, agents, "nonexistent", sentinel, {});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /^Unknown agent: nonexistent\nEffective cwd: /);
		assert.match(result.error ?? "", /Consulted agent-definition directories:[\s\S]*Discovered agents:/);
		assert.doesNotMatch(result.error ?? "", /echo \(project\)/);
		assert.equal(result.task, "[prompt redacted]");
		assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("surfaces a non-retryable provider failure when the child produced no output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					model: "openai/gpt-5-mini",
					errorMessage: "Invalid request: malformed payload",
					usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			}],
			exitCode: 1,
		});
		const executor = makeExecutor([makeAgent("echo", { model: "openai/gpt-5-mini" })]);

		const result = await executor.execute(
			"non-retryable-provider-failure",
			{ agent: "echo", task: "Task", async: false, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid request: malformed payload/u);
		assert.match(result.details.results[0]?.error ?? "", /Invalid request: malformed payload/u);
		assert.equal(mockPi.callCount(), 1);
	});

	it("fails closed before spawn when cached exclusions leave zero launch candidates", async () => {
		recordModelFailure({ modelId: "gpt-5-mini", provider: "openai", reason: "sk-secret-token-xyz" });
		recordModelFailure({ modelId: "claude-sonnet-4", provider: "anthropic", reason: "sk-secret-token-xyz" });
		mockPi.onCall({ output: "should not spawn" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		await assert.rejects(
			runSync(tempDir, agents, "worker", "Do work", {
				runId: "cached-exclusion-zero-candidates",
				acceptance: false,
				availableModels: [
					{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
					{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
				],
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /No usable subagent models remain after registry, scope, and cached-exclusion filtering/);
				assert.equal(error.message.includes("sk-secret-token-xyz"), false);
				return true;
			},
		);
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails closed before spawn when fallback-only configuration resolves no launch candidates", async () => {
		mockPi.onCall({ output: "should not spawn" });
		const agents = [makeAgent("worker", { fallbackModels: ["does-not-exist"] })];

		await assert.rejects(
			runSync(tempDir, agents, "worker", "Do work", {
				runId: "fallback-only-zero-candidates",
				acceptance: false,
				availableModels: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
			}),
			/Unknown subagent model 'does-not-exist'/,
		);
		assert.equal(mockPi.callCount(), 0);
	});

	it("does not retry a non-zero exit after tool activity", async () => {
		mockPi.onCall({ jsonl: [events.toolStart("read", { path: "package.json" })], exitCode: 1 });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Read a file", {
			runId: "startup-no-retry-after-tool",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("stops model fallback and flags contextOverflow when the input exceeds the context window", async () => {
		mockPi.onCall({ output: "", stderr: "This model's maximum context length is 8192 tokens", exitCode: 1 });
		mockPi.onCall({ output: "must not run" });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Summarize a huge file", {
			runId: "context-overflow-stops-fallback",
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.contextOverflow, true);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
		assert.ok(result.error?.includes("context"), "error should mention context overflow");
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("forwards configured response aliases to the resolved foreground fallback without rewriting its route", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ jsonl: [], stderr: "429 rate limit exceeded", exitCode: 1 });
		mockPi.onCall({ jsonl: [events.assistantMessage("Declared echo accepted", "claude-opus-5")] });
		const executor = makeExecutor([makeAgent("echo", {
			model: "mock/primary",
			fallbackModels: ["ias-claude-opus-5:high"],
		})], { modelResponseAliases: { "databricks-bedrock/ias-claude-opus-5": ["claude-opus-5"] } });
		const result = await executor.executePublic(
			"foreground-response-alias-fallback",
			{ agent: "echo", task: "Say hello", async: false, context: "fresh", acceptance: false },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [
					{ provider: "mock", id: "primary" },
					{ provider: "databricks-bedrock", id: "ias-claude-opus-5" },
				] },
			},
		);
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.deepEqual(result.details.results[0]?.attemptedModels, ["mock/primary", "databricks-bedrock/ias-claude-opus-5:high"]);
		assert.equal(result.details.results[0]?.model, "databricks-bedrock/ias-claude-opus-5:high");
		const args = readAllCallArgs()[1]!;
		assert.equal(args[args.indexOf("--model") + 1], "databricks-bedrock/ias-claude-opus-5:high");
		assert.equal(mockPi.callCount(), 2);
	});

	it("fails when a configured provider-qualified model starts on a different child model", async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("wrong provider", "openai-codex/gpt-5.6-sol")] });
		const agents = [makeAgent("echo", { model: "opencode-go/ox-alpha-free:max" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "foreground-model-verification-mismatch",
			acceptance: false,
			modelResponseAliases: { "opencode-go/ox-alpha-free": ["declared-echo"] },
			availableModels: [
				{ provider: "opencode-go", id: "ox-alpha-free", fullId: "opencode-go/ox-alpha-free" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol" },
			],
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.model, "opencode-go/ox-alpha-free:max");
		assert.deepEqual(result.attemptedModels, ["opencode-go/ox-alpha-free:max"]);
		assert.match(result.error ?? "", /model_verification_failed/);
		assert.match(result.error ?? "", /Expected 'opencode-go\/ox-alpha-free:max'/);
		assert.match(result.error ?? "", /observed 'openai-codex\/gpt-5\.6-sol'/);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.match(result.modelAttempts?.[0]?.error ?? "", /model_verification_failed/);
		const args = readAllCallArgs()[0]!;
		assert.equal(args[args.indexOf("--model") + 1], "opencode-go/ox-alpha-free:max");
		assert.equal(mockPi.callCount(), 1);
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("rejects an unresolved agent model before spawning Pi", async () => {
		const agents = [makeAgent("echo", { model: "fast" })];

		await assert.rejects(
			runSync(tempDir, agents, "echo", "Task", {
				availableModels: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
			}),
			/Unknown subagent model 'fast'/,
		);
		assert.equal(mockPi.callCount(), 0);
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("cancels final drain while agent_end reports a retry and waits for agent_settled", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("retrying response"), { type: "agent_end", willRetry: true }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled response"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Retry once", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "settled response");
		assert.ok(Date.now() - startedAt >= 1200, "foreground runner must not terminate during the retry delay");
	});

	it("does not drain on settlement from a compaction attempt that will retry", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [{ type: "compaction_end", willRetry: true }, { type: "agent_settled" }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after compaction retry"), { type: "agent_start" }, { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Retry after compaction", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "settled after compaction retry");
		assert.ok(Date.now() - startedAt >= 1200, "foreground runner must not terminate during compaction retry");
	});

	it("treats agent_settled as a clean terminal watermark", async () => {
		const nonTerminalMessage = events.assistantMessage("settled without a terminal assistant stop") as { message: { stopReason: string } };
		nonTerminalMessage.message.stopReason = "length";
		mockPi.onCall({ jsonl: [nonTerminalMessage, { type: "agent_settled" }], keepAliveAfterFinalMessageMs: 5000 });
		const startedAt = Date.now();
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Wait until settled", { acceptance: false });
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(getFinalOutput(result.messages), "settled without a terminal assistant stop");
		assert.ok(Date.now() - startedAt < 4000, "agent_settled should trigger bounded child cleanup");
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("retries with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("retries with fallback models when a zero-exit attempt has empty output", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "openai/gpt-5-mini",
					stopReason: "error",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from empty output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-empty-output",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.equal(result.finalOutput, "Recovered from empty output");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("prefers empty-output fallback over an earlier tool error", async () => {
		mockPi.onCall({
			stdoutRaw: [
				events.toolResult("read", "ENOENT: no such file or directory", true),
				events.toolResult("read", "recovered file contents"),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
						model: "openai/gpt-5-mini",
						stopReason: "stop",
						usage: { input: 0, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			].map((event) => JSON.stringify(event)).join("\n"),
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-empty-output-after-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.match(result.modelAttempts?.[0]?.error ?? "", /no output/i);
		assert.equal(mockPi.callCount(), 2);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127", true)],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not retry raw connection stderr after child activity", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("completed side effect", "openai/gpt-5-mini")],
			stderr: "APIConnectionError: Connection closed.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-raw-stderr",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Connection closed/u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery for a generic empty assistant abort after a compaction retry", async () => {
		const sessionFile = path.join(tempDir, "generic-empty-after-compaction-retry-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{ type: "compaction_end", willRetry: true },
				{ type: "agent_settled" },
				{ type: "agent_start" },
				events.assistantMessage("The compaction retry produced useful output.", "openai/gpt-5-mini"),
				{ type: "agent_settled" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-compaction-retry",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery after compaction_end willRetry false and a continued agent turn", async () => {
		const sessionFile = path.join(tempDir, "generic-empty-after-successful-compaction-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				{ type: "compaction_end", willRetry: false },
				{ type: "agent_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-successful-compaction",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("does not use compaction recovery for a generic provider abort after normal settlement", async () => {
		const sessionFile = path.join(tempDir, "generic-provider-after-compaction-session.jsonl");
		mockPi.onCall({
			jsonl: [
				{ type: "compaction_start" },
				events.assistantMessage("Compaction completed and the child settled normally.", "openai/gpt-5-mini"),
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: sessionFile, content: "{}\n" }],
			stderr: "APIConnectionError: Connection reset by provider transport.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "Compaction recovery must not run" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-compaction-recovery-after-normal-settlement",
			sessionFile,
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Connection reset by provider transport/u);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("resumes the retained session once after a compaction-induced abort following completed tool work", async () => {
		const sessionFile = path.join(tempDir, "abort-recovery-session.jsonl");
		mockPi.onCall({
			jsonl: [
				events.toolStart("write", { path: "side-effect.txt", content: "done" }),
				events.toolEnd("write"),
				events.toolResult("write", "Wrote side-effect.txt"),
				{ type: "compaction_start" },
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						model: "openai/gpt-5-mini",
						stopReason: "aborted",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
				{ type: "agent_settled" },
			],
			writeFiles: [{ path: "side-effect.txt", content: "done" }, { path: sessionFile, content: "{}\n" }],
			keepAliveAfterFinalMessageMs: 5_000,
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered from retained session" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "resume-provider-after-tool",
			sessionFile,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "Recovered from retained session");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini"]);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
		const [firstArgs, resumedArgs] = readAllCallArgs();
		assert.equal(firstArgs?.[firstArgs.indexOf("--session") + 1], sessionFile);
		assert.equal(resumedArgs?.[resumedArgs.indexOf("--session") + 1], sessionFile);
		assert.match(readAllCallArgs(true)[1]?.at(-1) ?? "", /Continue from the current files and transcript/);
		assert.equal(fs.readFileSync(path.join(tempDir, "side-effect.txt"), "utf-8"), "done");
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("streams progress while a foreground child has not emitted output", async () => {
		const updates: Array<{ text: string; durationMs: number | undefined }> = [];
		const releasePath = path.join(tempDir, "release-foreground-progress");
		mockPi.onCall({ output: "Done", waitForPath: releasePath });

		const runPromise = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			onUpdate: (update: { content: Array<{ type: string; text?: string }>; details?: { progress?: ProgressSummary[] } }) => {
				updates.push({
					text: update.content[0]?.text ?? "",
					durationMs: update.details?.progress?.[0]?.durationMs,
				});
			},
		});
		const deadline = Date.now() + 5_000;
		while (updates.filter((update) => update.text === "(running...)").length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fs.writeFileSync(releasePath, "release", "utf-8");
		const result = await runPromise;

		const runningUpdates = updates.filter((update) => update.text === "(running...)");
		assert.equal(result.exitCode, 0);
		assert.ok(runningUpdates.length >= 2, "expected an initial update and a heartbeat before child output");
		assert.ok((runningUpdates.at(-1)?.durationMs ?? 0) > (runningUpdates[0]?.durationMs ?? 0), "expected heartbeat duration to advance");
	});

	it("suppresses unchanged delegated heartbeats without changing ordinary foreground updates", async () => {
		const updates: Array<{ text: string; durationMs: number | undefined }> = [];
		const releasePath = path.join(tempDir, "release-delegated-progress");
		mockPi.onCall({ output: "Done", waitForPath: releasePath });

		const runPromise = runSync!(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			suppressUnchangedDelegationUpdates: true,
			onUpdate: (update: { content: Array<{ type: string; text?: string }>; details?: { progress?: ProgressSummary[] } }) => {
				updates.push({
					text: update.content[0]?.text ?? "",
					durationMs: update.details?.progress?.[0]?.durationMs,
				});
			},
		});
		const initialDeadline = Date.now() + 5_000;
		while (updates.filter((update) => update.text === "(running...)").length < 1 && Date.now() < initialDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(updates.filter((update) => update.text === "(running...)").length, 1, "duration-only delegated heartbeats should be coalesced");

		fs.writeFileSync(releasePath, "release", "utf-8");
		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.ok(updates.some((update) => update.text === "Done"), "changed terminal output should still be delivered");
	});

	it("delivers delegated activity-state transitions despite heartbeat suppression", async () => {
		const attentionUpdates: Array<{ details?: { progress?: ProgressSummary[] } }> = [];
		const attentionReleasePath = path.join(tempDir, "release-delegated-attention");
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("Started")] },
				{ waitForPath: attentionReleasePath, jsonl: [events.assistantMessage("Done")] },
			],
		});
		const attentionRun = runSync!(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			suppressUnchangedDelegationUpdates: true,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
			onUpdate: (update: { details?: { progress?: ProgressSummary[] } }) => attentionUpdates.push(update),
		});
		try {
			const turnDeadline = Date.now() + 15_000;
			while (!attentionUpdates.some((update) => (update.details?.progress?.[0]?.turnCount ?? 0) > 0) && Date.now() < turnDeadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(attentionUpdates.some((update) => (update.details?.progress?.[0]?.turnCount ?? 0) > 0), "test fixture should complete one assistant turn before waiting for idle attention");

			const deadline = Date.now() + 15_000;
			while (!attentionUpdates.some((update) => update.details?.progress?.[0]?.activityState === "needs_attention") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(attentionUpdates.some((update) => update.details?.progress?.[0]?.activityState === "needs_attention"), "needs_attention transition should not be coalesced");
		} finally {
			fs.writeFileSync(attentionReleasePath, "release", "utf-8");
			await attentionRun;
		}

		const activeUpdates: Array<{ details?: { progress?: ProgressSummary[] } }> = [];
		const activeReleasePath = path.join(tempDir, "release-delegated-active");
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { message: "waiting" })] },
				{ waitForPath: activeReleasePath, jsonl: [events.toolEnd("contact_supervisor"), events.toolResult("contact_supervisor", "done")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const activeRun = runSync!(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			suppressUnchangedDelegationUpdates: true,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterMs: 200,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["active_long_running"],
				notifyChannels: ["event"],
			},
			onUpdate: (update: { details?: { progress?: ProgressSummary[] } }) => activeUpdates.push(update),
		});
		try {
			const deadline = Date.now() + 5_000;
			while (!activeUpdates.some((update) => update.details?.progress?.[0]?.activityState === "active_long_running") && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.ok(activeUpdates.some((update) => update.details?.progress?.[0]?.activityState === "active_long_running"), "active_long_running transition should not be coalesced");
		} finally {
			fs.writeFileSync(activeReleasePath, "release", "utf-8");
			await activeRun;
		}
	});

	it("does not deliver idle attention before a child completes its first assistant turn", async () => {
		const updates: Array<{ details?: { progress?: ProgressSummary[] } }> = [];
		const releasePath = path.join(tempDir, "release-zero-turn-attention");
		mockPi.onCall({ output: "Done", waitForPath: releasePath });

		const runPromise = runSync!(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				activeNoticeAfterMs: 999_999,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
			onUpdate: (update: { details?: { progress?: ProgressSummary[] } }) => updates.push(update),
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(updates.some((update) => update.details?.progress?.[0]?.activityState === "needs_attention"), false);
		} finally {
			fs.writeFileSync(releasePath, "release", "utf-8");
			const result = await runPromise;
			assert.equal(result.exitCode, 0);
		}
	});

	it("reports foreground context window usage without changing cumulative spend", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 11, output: 7, cacheRead: 30, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {});

		assert.equal(result.progress.tokens, 18);
		assert.equal(result.progress.window, 41);
		assert.equal(result.progress.windowPeak, 41);
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("does not flag a delayed active tool as idle attention", async () => {
		const updates: Array<{ details?: { progress?: ProgressSummary[] } }> = [];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash", { command: "sleep 2" })] },
				{ delay: 2_000, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "done")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "delayed-tool-attention",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, activeNoticeAfterMs: 999_999, notifyOn: ["needs_attention"] },
			onUpdate: (update: { details?: { progress?: ProgressSummary[] } }) => updates.push(update),
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(controlEvents.some((event) => event.type === "needs_attention"), false);
		assert.equal(updates.some((update) => update.details?.progress?.some((progress) => progress.currentTool === "bash")), true);
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("injects an agent-file-relative local skill into the foreground child prompt", async () => {
		mockPi.onCall({ output: "Done" });
		const agentFile = path.join(tempDir, "agents", "nested", "worker.md");
		const skillFile = path.join(path.dirname(agentFile), "skills", "local", "SKILL.md");
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, "---\ndescription: local skill description\n---\nLocal skill body\n", "utf-8");
		const agents = [makeAgent("worker", { filePath: agentFile, skills: ["local"], skillPath: ["./skills"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["local"]);
		const prompt = readCall().systemPrompts.map((record) => record.text ?? "").join("\n");
		assert.match(prompt, /local skill description/);
		assert.match(prompt, new RegExp(escapeRegExp(skillFile)));
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-subagents skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-subagents"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-subagents skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-subagents"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-subagents");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts without retaining the effective prompt", async () => {
		mockPi.onCall({
			output: "Result text",
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["ext.ok"], omitted: 0 },
		});
		const privateExtension = path.join(tempDir, "extensions", "private-extension.ts");
		const agents = [makeAgent("echo", { extensions: [privateExtension] })];
		const artifactsDir = path.join(tempDir, "artifacts");
		const sentinel = "PROMPT_AUDIT_SENTINEL_1021";

		const result = await runSync(tempDir, agents, "echo", sentinel, {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(result.artifactPaths.inputPath, "should have a redacted input artifact");
		assert.doesNotMatch(fs.readFileSync(result.artifactPaths.inputPath, "utf-8"), new RegExp(sentinel));
		assert.match(fs.readFileSync(result.artifactPaths.inputPath, "utf-8"), /live Prompt Audit only/);
		assert.ok(result.transcriptPath, "should expose transcript path on the result");
		assert.equal(result.transcriptPath, result.artifactPaths.transcriptPath);
		assert.ok(fs.existsSync(result.transcriptPath), "transcript should be written");
		const transcript = fs.readFileSync(result.transcriptPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { recordType?: string; source?: string; text?: string });
		assert.equal(transcript[0]?.recordType, "message");
		assert.equal(transcript[0]?.source, "foreground");
		assert.match(transcript[0]?.text ?? "", /live Prompt Audit only/);
		assert.doesNotMatch(fs.readFileSync(result.transcriptPath, "utf-8"), new RegExp(sentinel));
		assert.match(transcript.at(-1)?.text ?? "", /^Result text/);
		assert.equal(result.transcriptError, undefined);
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
		const metadataText = fs.readFileSync(result.artifactPaths.metadataPath, "utf-8");
		const metadata = JSON.parse(metadataText) as { task?: string; launchContractDigest?: string; launchResolvedExtensions?: LaunchResolvedExtensions; runtimeAcknowledgedExtensions?: RuntimeAcknowledgedExtensions };
		assert.doesNotMatch(metadataText, new RegExp(sentinel));
		assert.equal(metadata.task, "[prompt redacted]");
		assert.equal(result.task, "[prompt redacted]");
		assert.equal(result.progress.task, "[prompt redacted]");
		assert.match(readCallArgs().join("\n"), new RegExp(sentinel));
		assert.equal(metadata.launchContractDigest, result.launchContractDigest);
		assert.equal(result.launchResolvedExtensions?.source, "launch-resolved");
		assert.equal(result.launchResolvedExtensions?.disableAmbientExtensions, true);
		assert.deepEqual(metadata.launchResolvedExtensions, result.launchResolvedExtensions);
		assert.deepEqual(result.runtimeAcknowledgedExtensions, { version: 1, source: "child-runtime", ids: ["ext.ok"], omitted: 0 });
		assert.deepEqual(metadata.runtimeAcknowledgedExtensions, result.runtimeAcknowledgedExtensions);
		assert.ok(!JSON.stringify(result.launchResolvedExtensions).includes(tempDir), "projection should not expose raw extension paths");
	});

	it("routes foreground artifacts to the configured session directory", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "session artifact result" });
		const sessionFile = path.join(tempDir, "sessions", "parent-session", "session.jsonl");
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		const executor = makeExecutor([makeAgent("echo")], { artifactDir: "session" });

		const result = await executor.execute(
			"session-artifact-dir",
			{ agent: "echo", task: "Write session-scoped artifacts", runId: "session-artifacts" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		const expectedDir = path.join(path.dirname(sessionFile), "subagent-artifacts");
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.artifacts?.dir, expectedDir);
		assert.ok(result.details?.artifacts?.files[0]?.outputPath.startsWith(`${expectedDir}${path.sep}`));
		assert.equal(fs.readFileSync(result.details.artifacts.files[0].outputPath, "utf-8"), "session artifact result");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi/subagents", "artifacts")), false);
	});



	it("writes a failure stub to foreground output artifacts when no output was produced", async () => {
		mockPi.onCall({ output: "", stderr: "model unavailable", exitCode: 1 });
		const artifactsDir = path.join(tempDir, "artifacts-failed-output");

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "failed-no-output",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			acceptance: false,
		});

		assert.equal(result.exitCode, 1);
		assert.ok(result.artifactPaths?.outputPath, "should expose an output artifact path");
		const artifact = fs.readFileSync(result.artifactPaths.outputPath, "utf-8");
		assert.match(artifact, /Subagent run failed before producing output\./);
		assert.match(artifact, /Error:\nmodel unavailable/);
		assert.match(artifact, /Transcript:/);
		assert.match(artifact, /Metadata:/);
	});

	it("does not surface transcript paths when transcript artifacts are disabled", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts-disabled-transcript");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run-no-transcript",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeTranscript: false, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.transcriptPath, undefined);
		assert.equal(result.transcriptError, undefined);
		assert.ok(result.artifactPaths?.metadataPath, "should have metadata path");
		const metadata = JSON.parse(fs.readFileSync(result.artifactPaths.metadataPath, "utf-8")) as { transcriptPath?: string; transcriptError?: string };
		assert.equal(metadata.transcriptPath, undefined);
		assert.equal(metadata.transcriptError, undefined);
		assert.equal(fs.existsSync(result.artifactPaths.transcriptPath!), false);
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("top-level reviewer runs do not inherit bundled chain artifact reads", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "plan.md"), "chain plan");
		fs.writeFileSync(path.join(tempDir, "progress.md"), "chain progress");
		mockPi.onCall({ output: "Review done" });
		const reviewer = discoverAgents(tempDir, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer, "expected bundled reviewer");
		assert.equal(reviewer.defaultReads, undefined);
		const executor = makeExecutor([reviewer]);

		await executor.execute(
			"single-reviewer-without-chain-artifacts",
			{ agent: "reviewer", task: "Review the supplied files." },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /\[Read from:/);
		assert.doesNotMatch(taskArg, /plan\.md|progress\.md/);
	});

	it("routes foreground single relative outputs to the run output artifact directory by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default report" });
		const executor = makeExecutor([makeAgent("researcher", { output: "context.md" })]);

		const result = await executor.execute(
			"single-default-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(path.join(TEMP_ARTIFACTS_DIR, "outputs"))}.*context\\.md`));
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("routes foreground single relative outputs to configured singleRunOutputBaseDir", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "configured report" });
		const configuredBase = path.join(tempDir, "configured-outputs");
		const executor = makeExecutor(
			[makeAgent("researcher", { output: "context.md" })],
			{ singleRunOutputBaseDir: configuredBase },
		);

		const result = await executor.execute(
			"single-configured-output-base",
			{ agent: "researcher", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const expectedOutputPath = path.join(configuredBase, "context.md");
		const taskArg = readCallArgs().at(-1) ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(expectedOutputPath)}`));
		assert.equal(fs.readFileSync(expectedOutputPath, "utf-8"), "configured report");
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("makes task-level output overrides authoritative in the child system prompt", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "override report" });
		const overridePath = path.join(tempDir, "custom-report.md");
		const executor = makeExecutor([
			makeAgent("researcher", {
				output: "default-report.md",
				systemPrompt: "Output format (`default-report.md`):\n\nWrite the full report to default-report.md.",
			}),
		]);

		const result = await executor.execute(
			"single-output-override-system-prompt",
			{ agent: "researcher", task: "Write report", output: overridePath },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = resolveMockPiCallArgs(call).at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(taskArg, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Output format \(`default-report\.md`\):/);
		assert.match(systemPrompt, /Runtime output path override:/);
		assert.match(systemPrompt, new RegExp(`Write your findings to exactly this path: ${escapeRegExp(overridePath)}`));
		assert.match(systemPrompt, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("persists read-only file-only output without requiring a child write tool", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "complete read-only analysis" });
		const outputPath = path.join(tempDir, "read-only-analysis.md");
		const executor = makeExecutor([makeAgent("analyst", {
			tools: ["read", "grep", "find", "ls"],
			systemPrompt: "Analyze without modifying files.",
		})]);

		const result = await executor.execute(
			"single-read-only-output",
			{ agent: "analyst", task: "Analyze the runtime", output: outputPath, outputMode: "file-only", acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const call = readCall();
		const taskArg = resolveMockPiCallArgs(call).at(-1) ?? "";
		const systemPrompt = call.systemPrompts[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "complete read-only analysis");
		assert.match(result.content[0]?.text ?? "", /Output saved to:/);
		for (const instruction of [taskArg, systemPrompt]) {
			assert.match(instruction, /Return the complete artifact in your final response\./);
			assert.match(instruction, /runtime will persist it to exactly this path:/);
			assert.match(instruction, /Do not call contact_supervisor merely because no write-capable tool is available\./);
			assert.doesNotMatch(instruction, /Write your findings to exactly this path/);
		}
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to(?: exactly this path)?:/);
	});

	it("rejects explicit reviewed acceptance at every execution nesting level before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const cases = [
			{ agent: "echo", task: "Review", acceptance: "reviewed" },
			{ agent: "echo", task: "Review", acceptance: { level: "reviewed" } },
			{ tasks: [{ agent: "echo", task: "Review", acceptance: "reviewed" }] },
			{ chain: [{ agent: "echo", task: "Review", acceptance: { level: "reviewed" } }] },
			{ chain: [{ parallel: [{ agent: "echo", task: "Review", acceptance: "reviewed" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" } }, parallel: { agent: "echo", acceptance: { level: "reviewed" } }, collect: { as: "reviews" } }] },
		];
		for (const [index, params] of cases.entries()) {
			const executor = makeExecutor();
			const result = await executor.execute(
				`reviewed-acceptance-${index}`,
				params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /achieved status.*omit acceptance.*acceptance\.review\.required/i);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects explicit reviewed acceptance before appending a chain step", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"append-reviewed-acceptance",
			{
				action: "append-step",
				id: "missing-run",
				step: { agent: "echo", task: "Review the previous work", acceptance: { level: "reviewed" } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Cannot append step:.*achieved status.*acceptance\.review\.required/i);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects mismatched foreground timeout aliases before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-alias-validation",
			{ agent: "echo", task: "Task", timeoutMs: 100, maxRuntimeMs: 200 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /aliases/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("applies the foreground timeout default without overriding explicit or agent values", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "package default" });
		mockPi.onCall({ output: "explicit timeout" });
		mockPi.onCall({ output: "max runtime alias" });
		mockPi.onCall({ output: "agent timeout" });

		const defaultExecutor = makeExecutor();
		const defaultResult = await defaultExecutor.execute(
			"foreground-timeout-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(defaultResult.details?.timeoutMs, executorMod?.DEFAULT_FOREGROUND_TIMEOUT_MS);
		assert.equal(defaultResult.details?.timeoutMs, 30 * 60 * 1000);

		const explicitResult = await defaultExecutor.execute(
			"foreground-timeout-explicit",
			{ agent: "echo", task: "Task", async: false, timeoutMs: 2_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.details?.timeoutMs, 2_000);

		const aliasResult = await defaultExecutor.execute(
			"foreground-timeout-alias",
			{ agent: "echo", task: "Task", async: false, maxRuntimeMs: 3_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(aliasResult.details?.timeoutMs, 3_000);

		const agentResult = await makeExecutor([
			makeAgent("echo", { defaultTimeoutMs: 4_000 }),
		]).execute(
			"foreground-timeout-agent-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(agentResult.details?.timeoutMs, 4_000);
	});

	it("threads the global config timeout default from deps.config, without overriding explicit or agent values", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const NINETY_MIN = 90 * 60 * 1000;
		mockPi.onCall({ output: "config default" });
		mockPi.onCall({ output: "explicit over config" });
		mockPi.onCall({ output: "agent over config" });
		mockPi.onCall({ output: "invalid config ignored" });

		// A global config.timeoutMs replaces the built-in 30-minute foreground backstop.
		const configExecutor = makeExecutor([makeAgent("echo")], { timeoutMs: NINETY_MIN });
		const configResult = await configExecutor.execute(
			"config-timeout-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(configResult.details?.timeoutMs, NINETY_MIN);

		// An explicit call value still wins over the global config default.
		const explicitResult = await configExecutor.execute(
			"config-timeout-explicit",
			{ agent: "echo", task: "Task", async: false, timeoutMs: 2_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.details?.timeoutMs, 2_000);

		// An agent frontmatter default still wins over the global config default (single launches).
		const agentResult = await makeExecutor([makeAgent("echo", { defaultTimeoutMs: 4_000 })], { timeoutMs: NINETY_MIN }).execute(
			"config-timeout-agent-default",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(agentResult.details?.timeoutMs, 4_000);

		// An invalid config value is ignored -> falls back to the built-in 30-minute default.
		const invalidResult = await makeExecutor([makeAgent("echo")], { timeoutMs: -1 }).execute(
			"config-timeout-invalid",
			{ agent: "echo", task: "Task", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalidResult.details?.timeoutMs, executorMod?.DEFAULT_FOREGROUND_TIMEOUT_MS);
	});

	it("applies the global config timeout default to foreground workflow scripts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const executor = makeExecutor([makeAgent("echo")], { timeoutMs: 250 });

		const configResult = await executor.execute(
			"workflow-config-timeout-default",
			{ async: false, workflowScript: `return await runs.run("slow", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(configResult.isError, true);
		assert.match(configResult.content[0]?.text ?? "", /Workflow script timed out after 250ms/);
		assert.deepEqual(configResult.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "timeout" });

		const explicitResult = await executor.execute(
			"workflow-config-timeout-explicit",
			{ async: false, timeoutMs: 150, workflowScript: `return await runs.run("slow", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicitResult.isError, true);
		assert.match(explicitResult.content[0]?.text ?? "", /Workflow script timed out after 150ms/);
		assert.deepEqual(explicitResult.details.workflow?.receipt?.terminalOutcome, { state: "partial", reason: "timeout" });

		const childLocalExecutor = makeExecutor([makeAgent("echo")], { timeoutMs: 10_000 });
		mockPi.onCall({ matchArgIncludes: "Fail normally", stderr: "upstream request timed out", exitCode: 1 });
		const ordinaryFailure = await childLocalExecutor.execute(
			"workflow-child-timeout-prose",
			{ async: false, workflowScript: `return await runs.run("failed", { agent: "echo", task: "Fail normally" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(ordinaryFailure.isError, true);
		assert.equal(ordinaryFailure.details.workflow?.receipt?.terminalOutcome, undefined);

		mockPi.onCall({ matchArgIncludes: "Child local timeout", delay: 5_000, output: "too late" });
		const childTimeout = await childLocalExecutor.execute(
			"workflow-child-local-timeout",
			{ async: false, workflowScript: `return await runs.run("slow-child", { agent: "echo", task: "Child local timeout", timeoutMs: 150 });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(childTimeout.isError, true);
		assert.equal(childTimeout.details.workflow?.receipt?.terminalOutcome, undefined);
		assert.deepEqual(childTimeout.details.workflow?.receipt?.entries["slow-child"]?.terminalOutcome, { state: "partial", reason: "timeout" });
	});

	it("runs omitted async launches in the background when the global default is enabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")], {}, true);

		const result = await executor.execute(
			"global-async-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(typeof result.details?.asyncId, "string");
	});

	it("keeps omitted async launches foreground when the global default is disabled", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "config foreground default finished" });
		const executor = makeExecutor([makeAgent("echo")], {}, false);

		const result = await executor.execute(
			"global-foreground-opt-out",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /config foreground default finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("applies agent frontmatter defaults to single-agent launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 2_000,
			}),
		]);

		const result = await executor.execute(
			"agent-launch-defaults",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(typeof result.details?.asyncId, "string");
		assert.equal(result.details?.timeoutMs, 2_000);
	});

	it("applies agent acceptance defaults and lets explicit calls override them", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default acceptance disabled" });
		mockPi.onCall({ stdoutRaw: `${JSON.stringify(events.assistantMessage("explicit checked response without a report"))}\n` });
		const executor = makeExecutor([
			makeAgent("echo", { defaultAcceptance: { level: "none", reason: "lightweight response" } }),
		]);

		const defaulted = await executor.execute(
			"agent-acceptance-default",
			{ agent: "echo", task: "Return a concise answer" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(defaulted.isError, undefined);
		assert.equal(defaulted.details?.results?.[0]?.acceptance?.status, "not-required");
		assert.equal(defaulted.details?.results?.[0]?.acceptance?.effectiveAcceptance.reason, "lightweight response");

		const explicit = await executor.execute(
			"agent-acceptance-explicit",
			{ agent: "echo", task: "Return a concise answer", acceptance: "checked" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(explicit.isError, true);
		assert.equal(explicit.details?.results?.[0]?.acceptance?.status, "rejected");
	});

	it("lets agent frontmatter override the global async default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "agent foreground default finished" });
		const executor = makeExecutor(
			[makeAgent("echo", { defaultAsync: false })],
			{},
			true,
		);

		const result = await executor.execute(
			"agent-foreground-default",
			{ agent: "echo", task: "Task" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /agent foreground default finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("lets explicit single-agent launch values override frontmatter defaults", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "explicit foreground finished" });
		const executor = makeExecutor([
			makeAgent("echo", {
				defaultAsync: true,
				defaultTimeoutMs: 1,
			}),
		]);

		const result = await executor.execute(
			"explicit-launch-values",
			{
				agent: "echo",
				task: "Task",
				async: false,
				timeoutMs: 2_000,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /explicit foreground finished/);
		assert.equal(result.details?.asyncId, undefined);
	});

	it("allows timeout settings for async runs before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"timeout-async-validation",
			{ agent: "echo", task: "Task", async: true, timeoutMs: 1_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Async:/);
		assert.equal(result.details?.timeoutMs, 1_000);
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("passes maxSubagentDepth through to the child runtime config", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(readCall().runtime?.depth, 1);
			assert.equal(readCall().runtime?.maxDepth, 1);
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes the effective wait-tool setting through to child execution", async () => {
		mockPi.onCall({ output: "ok" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "wait-tool-env",
			waitToolEnabled: false,
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(readCall().runtime?.waitTool, { enabled: false });
	});

	it("passes prompt inheritance flags through to child execution", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		const call = readCall();
		assert.equal(call.runtime?.inheritProjectContext, false);
		assert.equal(call.runtime?.inheritSkills, false);
		assert.equal(call.launch?.noContextFiles, true);
		assert.equal(call.launch?.noSkills, true);
	});

	it("passes fanout routing only when nested fanout is explicitly authorized", async () => {
		mockPi.onCall({ output: "ok" });
		const fanoutAgents = [makeAgent("delegator", { tools: ["read", "subagent"] })];
		const fanout = await runSync(tempDir, fanoutAgents, "delegator", "Task", { runId: "fanout-run", index: 2 });
		assert.equal(fanout.exitCode, 0);
		const fanoutRuntime = readCall().runtime;
		assert.equal(fanoutRuntime?.fanoutChild, true);
		assert.equal(fanoutRuntime?.nestedParent?.parentRunId, "fanout-run");
		assert.equal(fanoutRuntime?.nestedParent?.parentChildIndex, 2);
		assert.equal(fanoutRuntime?.nestedParent?.depth, 1);

		mockPi.reset();
		mockPi.onCall({ output: "ok" });
		const inheritedToolAgents = [makeAgent("inherited-delegator", { allowNestedSubagents: true })];
		const inheritedToolFanout = await runSync(tempDir, inheritedToolAgents, "inherited-delegator", "Task", { runId: "inherited-tool-fanout", index: 3 });
		assert.equal(inheritedToolFanout.exitCode, 0);
		const inheritedRuntime = readCall().runtime;
		assert.equal(inheritedRuntime?.fanoutChild, true);
		assert.equal(inheritedRuntime?.nestedParent?.parentRunId, "inherited-tool-fanout");
		assert.equal(inheritedRuntime?.nestedParent?.parentChildIndex, 3);

		mockPi.reset();
		mockPi.onCall({ output: "ok" });
		const nonFanoutAgents = [makeAgent("worker", { tools: ["read"] })];
		const nonFanout = await runSync(tempDir, nonFanoutAgents, "worker", "Task", { runId: "non-fanout-run" });
		assert.equal(nonFanout.exitCode, 0);
		const workerRuntime = readCall().runtime;
		assert.equal(workerRuntime?.fanoutChild, false);
		assert.equal(workerRuntime?.nestedParent, undefined);
		assert.equal(workerRuntime?.nestedRoute, undefined);
	});

	it("passes supervisor metadata through to child execution", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
			intercomSessionName: "subagent-echo-78f659a3-3",
			orchestratorIntercomTarget: "subagent-chat-parent",
		});

		assert.equal(result.exitCode, 0);
		const runtime = readCall().runtime;
		assert.equal(runtime?.intercomSessionName, "subagent-echo-78f659a3-3");
		assert.equal(runtime?.orchestratorTarget, "subagent-chat-parent");
		assert.equal(runtime?.runId, "78f659a3");
		assert.equal(runtime?.agent, "echo");
		assert.equal(runtime?.childIndex, 2);
	});

	it("fails with actionable diagnostics when a requested extension tool is not loaded", async () => {
		mockPi.onCall({ output: "Model incorrectly claimed success", missingTools: ["fixture_search"] });
		const agents = [makeAgent("extension-worker", { tools: ["read", "fixture_search"], fallbackModels: ["mock/fallback-model"] })];

		const result = await runSync(tempDir, agents, "extension-worker", "Use fixture search", { runId: "missing-extension-tool" });

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: fixture_search/);
		assert.match(result.error ?? "", /must run as background children \(`async: true`\)/);
		assert.match(result.error ?? "", /subagentOnlyExtensions/);
		assert.match(result.error ?? "", /strict allowlist/);
		assert.doesNotMatch(result.finalOutput ?? "", /Model incorrectly claimed success/);
		assert.equal(result.messages?.length, 0);
		assert.equal(result.usage.turns, 0);
		assert.equal(result.modelAttempts?.length, 1);
	});

	it("records blocked mutation effects when foreground implementation tools are missing", async () => {
		mockPi.onCall({ output: "I cannot edit because fixture_search is missing", missingTools: ["fixture_search"] });
		const agents = [makeAgent("worker", { tools: ["read", "fixture_search"] })];

		const result = await runSync(tempDir, agents, "worker", "Implement the requested source fix", { runId: "missing-implementation-tool" });

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /these child tools were unavailable: fixture_search/);
		assert.doesNotMatch(result.error ?? "", /completed without making edits/);
		assert.equal(result.effects?.fileMutation?.status, "blocked");
		assert.equal(result.effects?.fileMutation?.expected, true);
		assert.equal(result.effects?.fileMutation?.attempted, false);
		assert.match(result.effects?.fileMutation?.message ?? "", /these child tools were unavailable: fixture_search/);
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const call = readCall();
		assert.ok(call.launch?.hooks.includes("pi-subagents:prompt-runtime"));
		const extensionPaths = call.launch?.extensionPaths ?? [];
		assert.ok(extensionPaths.some((entry) => entry.replace(/\\/g, "/").endsWith("custom-tool.ts")));
		assert.ok(extensionPaths.some((entry) => entry.replace(/\\/g, "/").endsWith("allowed-ext.ts")));
		assert.ok(!extensionPaths.some((entry) => entry.endsWith("subagent-prompt-runtime.ts")), "runtime hooks are inline, not extension files");
	});

	it("passes subagent-only extensions through to child execution", { skip: process.platform === "win32" ? "extension path resolution intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read"],
			subagentOnlyExtensions: ["./child-only-tool.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "subagent-only-extension",
		});

		assert.equal(result.exitCode, 0);
		const call = readCall();
		assert.ok(call.launch?.hooks.includes("pi-subagents:prompt-runtime"));
		assert.ok((call.launch?.extensionPaths ?? []).some((entry) => entry.replace(/\\/g, "/").endsWith("child-only-tool.ts")));
	});

	it("ignores child watchdog status when foreground child watchdogs are not configured", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-without-watchdog-config"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `unconfigured watchdog status should not delay final drain, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-without-watchdog-config");
			assert.equal(result.watchdog, undefined);
		});
	});

	it("waits for child watchdog settlement before foreground final-drain cleanup", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("done-before-watchdog"), childWatchdogStatus("reviewing", 1)] },
					{ delay: 1400, jsonl: [childWatchdogStatus("idle", 2)] },
				],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed >= 1200, `watchdog settlement should delay final drain, took ${elapsed}ms`);
			assert.ok(elapsed < 6000, `settled watchdog should still allow cleanup, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog");
			assert.equal(result.watchdog?.phase, "idle");
		});
	});

	it("falls back after child watchdog tail timeout without failing successful foreground output", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir, 150);
			mockPi.onCall({
				jsonl: [events.assistantMessage("done-before-watchdog-timeout"), childWatchdogStatus("reviewing", 1)],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const agents = makeAgentConfigs(["echo"]);

			const start = Date.now();
			const result = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run" });
			const elapsed = Date.now() - start;

			assert.ok(elapsed < 5000, `watchdog tail fallback should not hang, took ${elapsed}ms`);
			assert.equal(result.exitCode, 0);
			assert.equal(result.finalOutput, "done-before-watchdog-timeout");
			const watchdog = result.watchdog;
			assert.equal(watchdog?.phase, "stale");
			assert.equal(watchdog?.timedOut, true);
		});
	});

	it("blocks or warns on launches that violate configured watchdog rules", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			const settingsPath = path.join(tempDir, ".pi", "settings.json");
			const writeRules = (action: "warn" | "block") => {
				fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
				fs.writeFileSync(settingsPath, JSON.stringify({ subagents: { watchdog: { rules: { action, roleModels: { echo: { deny: ["mock/*"], note: "echo must not use mock models" } } } } } }, null, 2), "utf-8");
			};
			const sent: unknown[] = [];
			const watchdog = new MainWatchdogRuntime({ cwd: tempDir, displayWarning: (details) => { sent.push(details); } });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				watchdog,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo")] }),
				allowMutatingManagementActions: true,
			} as never);
			const callsBefore = mockPi.callCount();

			writeRules("block");
			const blocked = await executor.execute("rules-block", { async: false, agent: "echo", task: "Do work", model: "mock/test-model" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(blocked.isError, true);
			assert.match(blocked.content[0]?.text ?? "", /Launch blocked by subagents\.watchdog\.rules: Agent 'echo' was launched with denied model 'mock\/test-model'/);
			assert.equal(mockPi.callCount(), callsBefore, "a blocked launch never starts the child");
			assert.equal(sent.length, 0);

			const nestedSettings = path.join(tempDir, "packages", "app", ".pi", "settings.json");
			fs.mkdirSync(path.dirname(nestedSettings), { recursive: true });
			fs.writeFileSync(nestedSettings, JSON.stringify({ subagents: { watchdog: { rules: { action: "block", roleModels: { echo: { deny: ["mock/*"] } } } } } }, null, 2), "utf-8");
			writeRules("warn");
			const nestedBlocked = await executor.execute("rules-workflow-cwd", { async: false, cwd: "packages/app", workflowScript: `return runs.run("one", { agent: "echo", task: "Do work", model: "mock/test-model" });` }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(nestedBlocked.isError, true, "rules load from the resolved workflow cwd");
			assert.equal(mockPi.callCount(), callsBefore);

			mockPi.onCall({ output: "warned but ran" });
			const warned = await executor.execute("rules-warn", { async: false, agent: "echo", task: "Do work", model: "mock/test-model" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(warned.isError, undefined, warned.content[0]?.text);
			assert.equal(mockPi.callCount(), callsBefore + 1);
			assert.equal(sent.length, 1);
			assert.match((sent[0] as { summary?: string }).summary ?? "", /denied model 'mock\/test-model'/);
			assert.match((sent[0] as { evidence?: string }).evidence ?? "", /echo must not use mock models/);
		});
	});

	it("fails explicit acceptance on an unaddressed child watchdog blocker and passes once a turn follows it", async () => {
		await withIsolatedWatchdogSettings(tempDir, async () => {
			writeWatchdogSettings(tempDir);
			const agents = makeAgentConfigs(["echo"]);
			const acceptance = { level: "checked" as const, criteria: ["Ship it"] };
			const blockerCheck = (result: RunSyncResult) => result.acceptance?.runtimeChecks?.find((entry) => entry.id === "watchdog-blocker");

			mockPi.onCall({ jsonl: [events.watchdogWarning("concern", "Minor naming concern"), events.acceptanceReport(), events.watchdogWarning("blocker", "Claims tests passed without running them")] });
			const unaddressed = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run", acceptance });
			assert.deepEqual(unaddressed.watchdog?.warnings?.map((warning) => [warning.severity, warning.addressed]), [["concern", true], ["blocker", false]]);
			assert.equal(blockerCheck(unaddressed)?.status, "failed");
			assert.match(blockerCheck(unaddressed)?.message ?? "", /Unresolved watchdog blocker: Claims tests passed without running them/);
			assert.equal(unaddressed.acceptance?.status, "rejected");
			assert.equal(unaddressed.exitCode, 1);
			assert.match(unaddressed.error ?? "", /Unresolved watchdog blocker/);

			mockPi.onCall({ jsonl: [events.assistantMessage("first pass"), events.watchdogWarning("blocker", "Claims tests passed without running them"), events.acceptanceReport()] });
			const addressed = await runSync(tempDir, agents, "echo", "Task", { runId: "watchdog-child-run-2", acceptance });
			assert.equal(addressed.watchdog?.warnings?.[0]?.addressed, true);
			assert.equal(blockerCheck(addressed)?.status, "passed");
			assert.equal(addressed.exitCode, 0, addressed.error);
		});
	});

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("marks foreground runs that exceed timeoutMs as timed out", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should time out early, took ${elapsed}ms`);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "Subagent timed out after 150ms.");
		assert.match(result.finalOutput ?? "", /Subagent timed out after 150ms\./);
		assert.equal(result.progress.status, "failed");
	});

	it("treats an unchanged pre-existing file-only output as missing on dirty foreground timeout", async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		const reportPath = path.join(tempDir, "report.md");
		fs.writeFileSync(path.join(tempDir, "input.md"), "base\n", "utf-8");
		fs.writeFileSync(reportPath, "stale report\n", "utf-8");
		execFileSync("git", ["add", "input.md", "report.md"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });

		mockPi.onCall({
			writeFiles: [{ path: "input.md", content: "changed\n" }],
			steps: [{ delay: 10_000 }],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Slow task", {
			timeoutMs: 1000,
			outputPath: reportPath,
			outputMode: "file-only",
			acceptance: false,
		});

		assert.equal(result.timedOut, true);
		assert.deepEqual(result.timeoutRecovery?.changedFiles, ["input.md"]);
		assert.equal(result.timeoutRecovery?.reportStatus, "missing");
		assert.equal(result.timeoutRecovery?.recoveryNeeded, true);
		assert.match(result.finalOutput ?? "", /requested report: missing/i);
		assert.equal(fs.readFileSync(reportPath, "utf-8"), "stale report\n");
	});

	it("ignores legacy turn-budget options without prompt injection or termination", async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("first turn", "tool_use"),
				mockAssistantMessage("second turn", "tool_use"),
				mockAssistantMessage("completed normally", "stop"),
			],
		});
		const legacyOptions = {
			runId: "foreground-legacy-turn-budget",
			turnBudget: { maxTurns: 1, graceTurns: 0 },
			enforceHardTurnLimit: true,
		} as Parameters<typeof runSync>[4] & { turnBudget: { maxTurns: number; graceTurns: number }; enforceHardTurnLimit: boolean };

		const result = await runSync(tempDir, makeAgentConfigs(["worker"]), "worker", "Complete normally.", legacyOptions);

		assert.equal(result.exitCode, 0);
		assert.equal(result.turnBudgetExceeded, undefined);
		assert.equal(result.wrapUpRequested, undefined);
		assert.match(result.finalOutput ?? "", /completed normally/);
		assert.doesNotMatch(readCall().systemPrompts.map((record) => record.text ?? "").join("\n"), /turn budget|wrap up by this budget/i);
	});

	it("does not run acceptance verification after a foreground timeout", async () => {
		const markerPath = path.join(tempDir, "verify-ran.txt");
		const report = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
			}),
			"```",
		].join("\n");
		mockPi.onCall({ jsonl: [events.assistantMessage(report)], keepAliveAfterFinalMessageMs: 10000 });
		const agents = makeAgentConfigs(["slow"]);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			timeoutMs: 150,
			acceptance: {
				level: "verified",
				verify: [{
					id: "marker",
					command: "node -e \"require('node:fs').writeFileSync(process.env.VERIFY_MARKER, 'ran')\"",
					env: { VERIFY_MARKER: markerPath },
					timeoutMs: 10_000,
				}],
			},
		});

		assert.equal(result.timedOut, true);
		assert.equal(result.acceptance?.status, "rejected");
		assert.equal(result.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(result.acceptance?.verifyRuns?.length, 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("preserves manual interrupt semantics when a timeout is also configured", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		setTimeout(() => controller.abort(), 100);
		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			interruptSignal: controller.signal,
			timeoutMs: 500,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.timedOut, undefined);
		assert.equal(result.error, undefined);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});

	it("supports synchronous user detach and rejects duplicate and late detach calls", async () => {
		mockPi.onCall({ steps: [
			{ delay: 500, jsonl: [events.assistantMessage("completed after user detach")] },
		] });
		let detachActive: ((reason?: string) => boolean) | undefined;
		let detachAccepted = false;
		let duplicateAccepted = true;
		let recoveredResult: RunSyncResult | undefined;

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Keep working", {
			runId: "user-foreground-detach",
			acceptance: false,
			onDetachReady: (detach: (reason?: string) => boolean) => {
				detachActive = detach;
				detachAccepted = detach("user request");
				duplicateAccepted = detach("user request");
			},
			onDetachedExit: (postExit) => { recoveredResult = postExit as RunSyncResult; },
		});

		assert.equal(detachAccepted, true);
		assert.equal(duplicateAccepted, false);
		assert.equal(recoveredResult, undefined, "foreground result should return before the child completes");
		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.detachedReason, "user request");
		assert.equal(result.finalOutput, "Detached at user request before task completion.");
		assert.equal(result.processSignal, undefined);

		for (let attempt = 0; attempt < 100 && !recoveredResult; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(recoveredResult);
		assert.equal(recoveredResult.exitCode, 0);
		assert.equal(recoveredResult.processSignal, undefined);
		assert.equal(recoveredResult.finalOutput, "completed after user detach");
		assert.equal(detachActive?.("user request"), false, "detach must reject calls after child exit");
	});

	it("produces the same authoritative terminal result attached and detached", async () => {
		mockPi.onCall({ output: "authoritative answer" });
		mockPi.onCall({ steps: [{ delay: 75, jsonl: [events.assistantMessage("authoritative answer")] }] });
		const agents = makeAgentConfigs(["echo"]);
		const attached = await runSync(tempDir, agents, "echo", "Equivalent task", {
			runId: "attached-authoritative-result",
			acceptance: false,
		});
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, agents, "echo", "Equivalent task", {
			runId: "detached-authoritative-result",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.deepEqual(
			{
				exitCode: terminal.exitCode,
				finalOutput: terminal.finalOutput,
				usage: terminal.usage,
				progressStatus: terminal.progress.status,
				acceptanceStatus: terminal.acceptance?.status,
			},
			{
				exitCode: attached.exitCode,
				finalOutput: attached.finalOutput,
				usage: attached.usage,
				progressStatus: attached.progress.status,
				acceptanceStatus: attached.acceptance?.status,
			},
		);
		assert.equal(terminal.detached, undefined);
		assert.equal(terminal.detachedReason, "user request");
	});

	it("isolates every nested detach receipt field from terminal completion and later sanitization", async () => {
		const receiptReport = [
			"receipt snapshot",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "receipt evidence" }],
				changedFiles: ["src/receipt.ts"],
				testsAddedOrUpdated: ["test/receipt.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		const terminalReport = [
			"terminal answer",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "terminal isolation verified" }],
				changedFiles: ["src/receipt.ts"],
				testsAddedOrUpdated: ["test/receipt.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ steps: [
			{ jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: receiptReport }],
					model: "mock/test-model",
					stopReason: "toolUse",
					usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}] },
			{ delay: 300, jsonl: [events.assistantMessage(terminalReport)] },
		] });
		let detach: ((reason?: string) => boolean) | undefined;
		let detached = false;
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Keep the receipt isolated", {
			runId: "detached-deep-receipt-isolation",
			agentContract: { version: 1 },
			acceptance: {
				level: "checked",
				criteria: [{
					id: "criterion-1",
					must: "Keep detach receipt state isolated",
					evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
				}],
			},
			onDetachReady: (detachAttempt) => { detach = detachAttempt; },
			onUpdate: (update: { content?: Array<{ text?: string }> }) => {
				if (detached || !update.content?.[0]?.text?.includes("receipt snapshot")) return;
				detached = detach?.("user request") === true;
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		const receiptMessages = receipt.messages as Array<{
			role?: string;
			model?: string;
			content: Array<{ type?: string; text?: string; callerOwned?: boolean }>;
		}>;
		const callerOwnedReceiptText = `caller-owned mutation\n${receiptReport}`;
		(receipt.agentContract as unknown as { version: number }).version = 999;
		receiptMessages[0]!.model = "caller-owned/model";
		receiptMessages[0]!.content[0]!.text = callerOwnedReceiptText;
		receiptMessages[0]!.content[0]!.callerOwned = true;
		receiptMessages[0]!.content.push({ type: "text", text: "caller-only content" });
		receiptMessages.push({ role: "assistant", model: "caller-only/model", content: [{ type: "text", text: "caller-only message" }] });
		const mutableAcceptance = receipt.acceptance as unknown as {
			status: string;
			effectiveAcceptance: { level: string; criteria: Array<{ must: string }> };
			criteria: Array<{ must: string }>;
		};
		mutableAcceptance.status = "rejected";
		mutableAcceptance.effectiveAcceptance.level = "none";
		mutableAcceptance.effectiveAcceptance.criteria[0]!.must = "caller corrupted effective criterion";
		mutableAcceptance.criteria[0]!.must = "caller corrupted ledger criterion";
		receipt.progress.status = "failed";
		(receipt.progress as unknown as { recentOutput: string[] }).recentOutput.push("caller-only progress");
		receipt.usage.turns = 999;
		receipt.usage.input = 999;
		receipt.attemptedModels = ["caller-only/model"];
		receipt.modelAttempts = [{ success: false, exitCode: 99, error: "caller-only attempt" }];
		receipt.effects = { fileMutation: { status: "missing", expected: true, attempted: false, message: "caller-only effect" } };
		receipt.execution = { status: "failed", success: false, exitCode: 99 };
		receipt.review = { status: "blockers" };

		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.finalOutput, "terminal answer");
		assert.deepEqual(terminal.agentContract, { version: 1 });
		assert.equal(terminal.acceptance?.status, "checked");
		assert.equal(terminal.acceptance?.runtimeChecks.every((check) => check.status === "passed"), true);
		assert.equal(terminal.progress.status, "completed");
		assert.deepEqual(terminal.usage, { turns: 2, input: 107, output: 53, cacheRead: 0, cacheWrite: 0, cost: 0.002 });
		assert.deepEqual(terminal.attemptedModels, ["mock/test-model"]);
		assert.deepEqual(terminal.modelAttempts?.map((attempt) => ({ success: attempt.success, exitCode: attempt.exitCode })), [{ success: true, exitCode: 0 }]);
		assert.equal(terminal.execution?.status, "completed");
		assert.equal(terminal.execution?.success, true);
		assert.equal(terminal.review?.status, "not-requested");
		assert.deepEqual(terminal.effects, {});
		assert.doesNotMatch(JSON.stringify(terminal.messages), /acceptance-report/);
		assert.equal(receiptMessages[0]!.content[0]!.text, callerOwnedReceiptText, "terminal report sanitization must not mutate the caller receipt");
		assert.equal(receiptMessages[0]!.content[0]!.callerOwned, true);
		assert.equal(receiptMessages.length, 2);
	});

	it("keeps the full fallback loop and authoritative aggregation alive after detach", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on detached fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];
		let terminal: RunSyncResult | undefined;

		const receipt = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-fallback-loop",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 300 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.detached, undefined, "terminal status must not remain detached");
		assert.equal(terminal.detachedReason, "user request");
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.finalOutput, "Recovered on detached fallback");
		assert.deepEqual(terminal.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(terminal.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.equal(terminal.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("terminalizes a post-receipt completion pipeline throw exactly once with strict projections", async () => {
		mockPi.onCall({ steps: [{ delay: 75, jsonl: [events.assistantMessage("answer before callback failure")] }] });
		let terminal: RunSyncResult | undefined;
		let callbackCount = 0;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "detached-completion-pipeline-throw",
			acceptance: { level: "checked", criteria: ["result is checked"] },
			agentContract: { version: 1 },
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
			},
			onUpdate: (update: { details?: { progress?: Array<{ status?: string }> } }) => {
				if (update.details?.progress?.[0]?.status === "completed") throw new Error("terminal consumer update failed");
			},
			onDetachedExit: (result) => {
				callbackCount++;
				terminal = result as RunSyncResult;
			},
		});
		assert.equal(receipt.detached, true);
		(receipt.agentContract as unknown as { version: number }).version = 999;
		receipt.messages.push({ role: "assistant", content: [{ type: "text", text: "caller-only fallback message" }] });
		const mutableAcceptance = receipt.acceptance as unknown as {
			status: string;
			effectiveAcceptance: { level: string; criteria: Array<{ must: string }> };
		};
		mutableAcceptance.status = "accepted";
		mutableAcceptance.effectiveAcceptance.level = "none";
		mutableAcceptance.effectiveAcceptance.criteria[0]!.must = "caller-only fallback criterion";
		receipt.progress.status = "completed";
		receipt.usage.turns = 999;
		receipt.usage.input = 999;
		receipt.attemptedModels = ["caller-only/fallback"];
		receipt.modelAttempts = [{ success: true, exitCode: 0 }];
		receipt.effects = { fileMutation: { status: "observed", expected: false, attempted: true, message: "caller-only fallback effect" } };
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(callbackCount, 1);
		assert.equal(terminal.exitCode, 1);
		assert.equal(terminal.detached, undefined);
		assert.equal(terminal.detachedReason, "user request");
		assert.equal(terminal.progress?.status, "failed");
		assert.equal(terminal.acceptance?.status, "rejected");
		assert.equal(terminal.acceptance?.runtimeChecks?.[0]?.id, "completion-pipeline");
		assert.equal(terminal.execution?.status, "failed");
		assert.equal(terminal.execution?.success, false);
		assert.equal(terminal.review?.status, "not-requested");
		assert.deepEqual(terminal.agentContract, { version: 1 });
		assert.deepEqual(terminal.effects, {});
		assert.equal(terminal.usage.turns, 0);
		assert.equal(terminal.attemptedModels, undefined);
		assert.equal(terminal.modelAttempts, undefined);
		assert.doesNotMatch(JSON.stringify(terminal.messages), /caller-only fallback message/);
		assert.match(terminal.error ?? "", /Detached completion pipeline failed after receipt/);
	});

	it("contains a synchronous onDetachReady throw and completes attached", async () => {
		mockPi.onCall({ output: "completed while attached" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "throwing-detach-ready-consumer",
			acceptance: false,
			onDetachReady: () => {
				throw new Error("bad detach consumer");
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.detached, undefined);
		assert.equal(result.finalOutput, "completed while attached");
		assert.equal(result.progress.recentOutput.some((line) => /Foreground detach callback failed: bad detach consumer/.test(line)), true);
	});

	it("reports expected artifact post-processing I/O failures without rejecting", async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.toolStart("read", { path: "README.md" })] },
			{ delay: 50, jsonl: [events.assistantMessage("artifact answer")] },
		] });
		const artifactsDir = path.join(tempDir, "artifact-output-failure");
		let sabotaged = false;
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "artifact-output-result-field",
			acceptance: false,
			artifactsDir,
			artifactConfig: { enabled: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: { outputPath?: string } }> } }) => {
				const outputPath = update.details?.results?.[0]?.artifactPaths?.outputPath;
				if (sabotaged || !outputPath) return;
				sabotaged = true;
				fs.mkdirSync(outputPath);
			},
		});
		assert.equal(sabotaged, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.outputSaveError ?? "", /Artifact output post-processing failed/);
	});

	it("publishes detach despite best-effort receipt metadata persistence failure", async () => {
		mockPi.onCall({ steps: [{ delay: 100, jsonl: [events.assistantMessage("completed after metadata recovery")] }] });
		const artifactsDir = path.join(tempDir, "receipt-metadata-failure");
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "detach-receipt-metadata-failure",
			acceptance: false,
			artifactsDir,
			artifactConfig: { enabled: true },
			onDetachReady: (detach) => {
				fs.rmSync(artifactsDir, { recursive: true, force: true });
				fs.writeFileSync(artifactsDir, "block metadata", "utf-8");
				assert.equal(detach("user request"), true);
				fs.rmSync(artifactsDir, { force: true });
				fs.mkdirSync(artifactsDir, { recursive: true });
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		assert.ok(receipt.metadataSaveError, "receipt should record best-effort metadata persistence failure");
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(terminal?.exitCode, 0);
	});

	it("contains a throwing detached-exit callback", async () => {
		mockPi.onCall({ steps: [{ delay: 50, jsonl: [events.assistantMessage("done")] }] });
		let callbackCount = 0;
		const receipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "throwing-detached-exit-callback",
			acceptance: false,
			onDetachReady: (detach) => assert.equal(detach("user request"), true),
			onDetachedExit: () => {
				callbackCount++;
				throw new Error("consumer callback failed");
			},
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && callbackCount === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(callbackCount, 1);
	});

	it("skips acceptance evaluation when an explicitly interrupted detached result settles", async () => {
		mockPi.onCall({ steps: [{ delay: 10_000, jsonl: [events.assistantMessage("too late")] }] });
		const interrupt = new AbortController();
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Task", {
			runId: "detached-interrupted-acceptance",
			acceptance: { level: "checked", criteria: ["result is checked"] },
			interruptSignal: interrupt.signal,
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
				setTimeout(() => interrupt.abort(), 25);
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});
		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.interrupted, true);
		assert.equal(terminal.exitCode, 0);
		assert.equal(terminal.acceptance?.status, "pending");
		assert.equal(terminal.acceptance?.runtimeChecks[0]?.status, "not-applicable");
		assert.equal(terminal.error, undefined);
	});

	it("linearizes originating abort against detach and keeps explicit interrupt routable afterward", async () => {
		mockPi.onCall({ steps: [{ delay: 10_000, jsonl: [events.assistantMessage("too late")] }] });
		const origin = new AbortController();
		const interrupt = new AbortController();
		let terminal: RunSyncResult | undefined;
		const receipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Keep working", {
			runId: "detach-origin-abort-race",
			acceptance: false,
			signal: origin.signal,
			interruptSignal: interrupt.signal,
			onDetachReady: (detach) => {
				assert.equal(detach("user request"), true);
				origin.abort();
				setTimeout(() => interrupt.abort(), 50);
			},
			onDetachedExit: (result) => { terminal = result as RunSyncResult; },
		});

		assert.equal(receipt.detached, true);
		for (let attempt = 0; attempt < 100 && !terminal; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(terminal);
		assert.equal(terminal.interrupted, true, "explicit control interrupt must remain active after detach");
		assert.equal(terminal.detached, undefined);
	});

	it("lets an already-observed originating abort win over detach", async () => {
		mockPi.onCall({ delay: 10_000 });
		const origin = new AbortController();
		let detachAccepted = true;
		const result = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Abort first", {
			runId: "origin-abort-wins-detach",
			signal: origin.signal,
			onDetachReady: (detach) => {
				origin.abort();
				detachAccepted = detach("user request");
			},
		});
		assert.equal(detachAccepted, false);
		assert.equal(result.detached, undefined);
	});

	it("keeps the configured runtime timeout active after user detach", async () => {
		mockPi.onCall({ delay: 10_000 });
		let recoveredResult: RunSyncResult | undefined;
		const startedAt = Date.now();

		const result = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Do not run forever", {
			runId: "user-detach-timeout",
			timeoutMs: 150,
			acceptance: false,
			onDetachReady: (detach: (reason?: string) => boolean) => {
				assert.equal(detach("user request"), true);
			},
			onDetachedExit: (postExit) => { recoveredResult = postExit as RunSyncResult; },
		});

		assert.equal(result.detached, true);
		assert.ok(Date.now() - startedAt < 1_000, "detach should release the foreground waiter promptly");
		for (let attempt = 0; attempt < 300 && !recoveredResult; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(recoveredResult, "configured timeout should terminate and recover the detached child");
		assert.equal(recoveredResult.timedOut, true);
		assert.equal(recoveredResult.error, "Subagent timed out after 150ms.");
		assert.equal(recoveredResult.progress.status, "failed");
		assert.ok(Date.now() - startedAt < 5_000, "detached child should remain bounded by runtime enforcement");
	});

	for (const toolName of ["intercom", "contact_supervisor"]) {
		it(`detaches cleanly on ${toolName} handoff without aborting the child session`, async () => {
			const eventBus = createEventBus();
			let accepted = false;
			eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
				if (!payload || typeof payload !== "object") return;
				accepted = (payload as { accepted?: unknown }).accepted === true;
			});
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(toolName, toolName === "intercom" ? { action: "ask", to: "orchestrator" } : { reason: "need_decision", message: "Need a decision" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			// Emit the detach request the moment we observe the coordination tool start
			// in a progress update — this is the signal the parent has set
			// `intercomStarted=true`. Using a fixed delay here races the mock's
			// cold spawn and flakes under load.
			let detachEmitted = false;
			const runPromise = runSync(tempDir, agents, "echo", "Task", {
				runId: `${toolName}-detach`,
				allowIntercomDetach: true,
				intercomEvents: eventBus,
				onUpdate: (update) => {
					if (detachEmitted) return;
					const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
					const sawCoordinationTool = Array.isArray(progress) && progress.some((p) => p?.currentTool === toolName);
					if (!sawCoordinationTool) return;
					detachEmitted = true;
					eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
				},
			});

			const result = await runPromise;

			assert.equal(result.exitCode, -2);
			assert.equal(result.detached, true);
			assert.equal(result.detachedReason, "intercom coordination");
			assert.equal(result.finalOutput, "Detached for intercom coordination before task completion.");
			assert.equal(result.progress?.status, "detached");
			assert.equal(accepted, true);
		});
	}

	it("reports intercom detach race losses and repeated requests as not accepted", async () => {
		const abortBus = createEventBus();
		const abortResponses: boolean[] = [];
		abortBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => abortResponses.push((payload as { accepted: boolean }).accepted));
		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }, { delay: 10_000 }] });
		const origin = new AbortController();
		let requested = false;
		const abortedResult = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "intercom-abort-race-loss",
			allowIntercomDetach: true,
			intercomEvents: abortBus,
			signal: origin.signal,
			onUpdate: (update) => {
				if (requested || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				requested = true;
				origin.abort();
				abortBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "abort-race" });
			},
		});
		assert.equal(abortedResult.detached, undefined);
		assert.deepEqual(abortResponses, [false]);

		const repeatedBus = createEventBus();
		const repeatedResponses: boolean[] = [];
		repeatedBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => repeatedResponses.push((payload as { accepted: boolean }).accepted));
		mockPi.onCall({ steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }, { delay: 50, jsonl: [events.assistantMessage("done")] }] });
		let repeated = false;
		const repeatedReceipt = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "intercom-repeated-detach",
			allowIntercomDetach: true,
			intercomEvents: repeatedBus,
			onUpdate: (update) => {
				if (repeated || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				repeated = true;
				repeatedBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "first" });
				repeatedBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "second" });
			},
		});
		assert.equal(repeatedReceipt.detached, true);
		assert.deepEqual(repeatedResponses, [true, false]);
	});

	it("does not launch retries or fallbacks after intercom detach and keeps timeout enforcement", async () => {
		const fallbackBus = createEventBus();
		mockPi.onCall({
			steps: [{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need decision" })] }],
			stderr: "rate limit exceeded",
			exitCode: 1,
		});
		mockPi.onCall({ output: "must not launch" });
		let resolveFallbackTerminal!: (result: RunSyncResult) => void;
		const fallbackTerminal = new Promise<RunSyncResult>((resolve) => { resolveFallbackTerminal = resolve; });
		let fallbackRequested = false;
		const receipt = await runSync(tempDir, [makeAgent("echo", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] })], "echo", "Task", {
			runId: "intercom-no-fallback",
			acceptance: false,
			allowIntercomDetach: true,
			intercomEvents: fallbackBus,
			onUpdate: (update) => {
				if (fallbackRequested || !update.details?.progress?.some((item) => item.currentTool === "contact_supervisor")) return;
				fallbackRequested = true;
				fallbackBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "no-fallback" });
			},
			onDetachedExit: (result) => { resolveFallbackTerminal(result as RunSyncResult); },
		});
		assert.equal(receipt.detached, true);
		const fallbackResult = await fallbackTerminal;
		assert.equal(mockPi.callCount(), 1);
		assert.equal(fallbackResult.exitCode, 1);

		const timeoutBus = createEventBus();
		mockPi.reset();
		mockPi.onCall({ delay: 10_000 });
		let resolveTimeoutTerminal!: (result: RunSyncResult) => void;
		const timeoutTerminal = new Promise<RunSyncResult>((resolve) => { resolveTimeoutTerminal = resolve; });
		let timeoutRequested = false;
		const timeoutReceipt = await runSync(tempDir, makeAgentConfigs(["slow"]), "slow", "Task", {
			runId: "intercom-timeout-enforced",
			acceptance: false,
			timeoutMs: 125,
			allowIntercomDetach: true,
			intercomEvents: timeoutBus,
			onDetachReady: () => {
				if (timeoutRequested) return;
				timeoutRequested = true;
				timeoutBus.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: "timeout",
					runId: "intercom-timeout-enforced",
					agent: "slow",
					childIndex: 0,
				});
			},
			onDetachedExit: (result) => { resolveTimeoutTerminal(result as RunSyncResult); },
		});
		assert.equal(timeoutReceipt.detached, true);
		const timeoutResult = await timeoutTerminal;
		assert.equal(timeoutResult.timedOut, true);
		assert.equal(timeoutResult.exitCode, 1);
	});

	it("does not save a detached placeholder to an explicit file-only output", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-output.md");
		let detachEmitted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-detach" });
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(result.savedOutputPath, undefined);
		assert.equal(fs.existsSync(outputPath), false);
		assert.match(result.outputSaveError ?? "", /not finalized/);
	});

	it("finalizes explicit output before reporting detached child post-exit success", async () => {
		const eventBus = createEventBus();
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 100, jsonl: [events.assistantMessage("after reply")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const outputPath = path.join(tempDir, "detached-final-output.md");
		let detachEmitted = false;
		let recoveredResult: RunSyncResult | undefined;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "detached-file-only-post-exit-output",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			outputPath,
			outputMode: "file-only",
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "file-only-post-exit-detach" });
			},
			onDetachedExit: (postExit) => {
				recoveredResult = postExit as RunSyncResult;
			},
		});

		assert.equal(result.exitCode, -2);
		assert.equal(result.detached, true);
		assert.equal(fs.existsSync(outputPath), false);

		for (let attempt = 0; attempt < 100 && (!fs.existsSync(outputPath) || !recoveredResult); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}

		assert.equal(fs.readFileSync(outputPath, "utf-8"), "after reply");
		assert.ok(recoveredResult);
		assert.equal(recoveredResult.exitCode, 0);
		assert.equal(recoveredResult.progress?.status, "completed");
		assert.equal(recoveredResult.savedOutputPath, outputPath);
		assert.equal(recoveredResult.outputSaveError, undefined);
		assert.match(recoveredResult.finalOutput ?? "", /^Output saved to:/);
	});

	it("aborts a foreground coordination tool start instead of detaching without a delivered handoff", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 10000, jsonl: [events.assistantMessage("after abort")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controller = new AbortController();
		let aborted = false;

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "contact-supervisor-abort-without-handoff",
			allowIntercomDetach: true,
			signal: controller.signal,
			onUpdate: (update) => {
				if (aborted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				if (!Array.isArray(progress) || !progress.some((p) => p?.currentTool === "contact_supervisor")) return;
				aborted = true;
				controller.abort();
			},
		});

		assert.equal(aborted, true);
		assert.notEqual(result.exitCode, -2);
		assert.equal(result.detached, undefined);
		assert.notEqual(result.progress?.status, "detached");
	});

	for (const testCase of [
		{ name: "intercom ask", toolName: "intercom", args: { action: "ask", to: "orchestrator" } },
		{ name: "contact_supervisor need_decision", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need a decision" } },
		{ name: "contact_supervisor interview_request", toolName: "contact_supervisor", args: { reason: "interview_request", message: "Need input", interview: { questions: [] } } },
	]) {
		it(`does not detach foreground children on blocking ${testCase.name} before a delivered handoff`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ delay: 50, jsonl: [events.assistantMessage("received pong")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-blocking-detach`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "received pong");
			assert.equal(result.progress?.status, "completed");
		});
	}

	for (const testCase of [
		{ name: "intercom send", toolName: "intercom", args: { action: "send", to: "orchestrator", message: "FYI" } },
		{ name: "contact_supervisor progress_update", toolName: "contact_supervisor", args: { reason: "progress_update", message: "FYI" } },
	]) {
		it(`does not proactively detach foreground children on non-blocking ${testCase.name}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart(testCase.toolName, testCase.args)] },
					{ jsonl: [events.toolEnd(testCase.toolName)] },
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			const agents = makeAgentConfigs(["echo"]);

			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: `${testCase.toolName}-nonblocking`,
				allowIntercomDetach: true,
			});

			assert.equal(result.exitCode, 0);
			assert.equal(result.detached, undefined);
			assert.equal(result.finalOutput, "done");
			assert.equal(result.progress?.status, "completed");
		});
	}

	it("lets an active intercom child accept detach when another child is listening", async () => {
		const eventBus = createEventBus();
		let firstDetachResponse: boolean | undefined;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			if ((payload as { requestId?: unknown }).requestId !== "parallel-request") return;
			firstDetachResponse ??= (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({ delay: 500, output: "quiet child done" });
		const agents = makeAgentConfigs(["quiet", "intercom"]);

		const quietRun = runSync(tempDir, agents, "quiet", "Quiet task", {
			runId: "quiet-listener",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});
		for (let attempt = 0; attempt < 50 && mockPi.callCount() < 1; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(mockPi.callCount(), 1);
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
				{ delay: 500, jsonl: [events.assistantMessage("after intercom")] },
			],
		});

		let detachEmitted = false;
		const intercomRun = runSync(tempDir, agents, "intercom", "Intercom task", {
			runId: "active-intercom",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
			onUpdate: (update) => {
				if (detachEmitted) return;
				const progress = (update as { details?: { progress?: Array<{ currentTool?: string }> } }).details?.progress;
				const sawIntercom = Array.isArray(progress) && progress.some((p) => p?.currentTool === "intercom");
				if (!sawIntercom) return;
				detachEmitted = true;
				eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "parallel-request" });
			},
		});

		const [quietResult, intercomResult] = await Promise.all([quietRun, intercomRun]);

		assert.equal(quietResult.exitCode, 0);
		assert.equal(quietResult.detached, undefined);
		assert.equal(intercomResult.exitCode, -2);
		assert.equal(intercomResult.detached, true);
		assert.equal(firstDetachResponse, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
