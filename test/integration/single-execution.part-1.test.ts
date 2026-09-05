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
	tempDir, agentDir, mockPi, available, runSync, getFinalOutput, utils,
	createSubagentExecutor, escapeRegExp, pathContainsSegments, waitForFileContent,
	mockAssistantMessage, readCall, readCallArgs, readAllCallArgs, makeExecutor,
	installSingleExecutionHooks,
} from "../support/single-execution-fixture.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	createEventBus,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
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
import { registerWorkflowResource } from "../../src/api/workflow-resources.ts";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("derives a child session name and passes it to the child runtime config", async () => {
		mockPi.onCall({ output: "hello" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello to the world", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.sessionName, "echo: Say hello to the world");
		assert.equal(result.progressSummary?.sessionName, "echo: Say hello to the world");
		assert.equal(readCall().runtime?.sessionName, "echo: Say hello to the world");
	});

	it("rejects invalid foreground cwd before spawning Pi", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const requestedCwd = "missing-local-cwd";
		const effectiveCwd = path.resolve(tempDir, requestedCwd);

		const missing = await executor.executePublic(
			"invalid-foreground-cwd",
			{ agent: "echo", task: "Do not spawn", async: false, cwd: requestedCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.content[0]?.text ?? "", new RegExp(`cwd does not exist: ${effectiveCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(missing.content[0]?.text ?? "", /resolved from "missing-local-cwd"/);

		const fileCwd = path.join(tempDir, "not-a-directory");
		fs.writeFileSync(fileCwd, "file");
		const notDirectory = await executor.executePublic(
			"invalid-foreground-file-cwd",
			{ agent: "echo", task: "Do not spawn", async: false, cwd: fileCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(notDirectory.isError, true);
		assert.match(notDirectory.content[0]?.text ?? "", /cwd is not a directory/);
		assert.match(notDirectory.content[0]?.text ?? "", new RegExp(fileCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects invalid async cwd before spawning the native runner", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const requestedCwd = "missing-async-cwd";
		const effectiveCwd = path.resolve(tempDir, requestedCwd);

		const result = await executor.executePublic(
			"invalid-async-cwd",
			{ agent: "echo", task: "Do not spawn", async: true, cwd: requestedCwd },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`cwd does not exist: ${effectiveCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(result.content[0]?.text ?? "", /resolved from "missing-async-cwd"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("runs public structured single-child requests directly", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Structured child completed" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.executePublic(
			"structured-single",
			{ agent: "echo", task: "Run through workflow", async: false, context: "fresh" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.equal(result.details.mode, "single");
		assert.equal(mockPi.callCount(), 1);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Console:/);
	});

	it("keeps public structured children alive when tool results backfill without execution_end", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo PROBE_OK" } }] },
				{ delay: 25, jsonl: [
					{ type: "tool_result_end", message: { role: "toolResult", toolCallId: "bash-1", toolName: "bash", isError: false, content: [{ type: "text", text: "PROBE_OK" }] } },
					events.assistantMessage("PROBE_OK"),
				] },
			],
			keepAliveAfterFinalMessageMs: 400,
		});
		const executor = makeExecutor([makeAgent("bash-worker")]);

		const result = await executor.executePublic(
			"structured-single-tool-backfill",
			{ agent: "bash-worker", task: "Run exactly one tool: bash with command echo PROBE_OK.", async: false, toolTimeoutMs: 100, timeoutMs: 5_000 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /PROBE_OK/);
		assert.equal(result.details.results[0]?.timedOut, undefined);
	});

	it("keeps public structured single-child calls foreground when async is disabled by default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Structured child used the foreground default" });
		const executor = makeExecutor([makeAgent("echo")], {}, false);

		const result = await executor.executePublic(
			"structured-single-foreground-default",
			{ agent: "echo", task: "Run through workflow" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.match(result.content[0]?.text ?? "", /Structured child used the foreground default/);
		assert.equal(result.details.asyncId, undefined);
	});

	it("does not override structured single output unless configured by the agent", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		for (const params of [
			{ agent: "echo", task: "Use the task output path", async: false },
			{ agent: "echo", task: "Disable file output", output: false, async: false },
		] as const) {
			mockPi.onCall({ output: "Structured child completed" });
			const result = await makeExecutor([makeAgent("echo")]).executePublic(
				"structured-single-output",
				params,
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
			assert.doesNotMatch(readCallArgs().join("\n"), /This path is authoritative for this run/);
		}

		mockPi.onCall({ output: "Agent report" });
		const configuredPath = path.join(tempDir, "agent-report.md");
		const configured = await makeExecutor([makeAgent("echo", { output: configuredPath })]).executePublic(
			"structured-single-agent-output",
			{ agent: "echo", task: "Use agent output", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(configured.isError, undefined, configured.content[0]?.text ?? "workflow failed");
		const configuredTask = readCallArgs().join("\n");
		assert.match(configuredTask, new RegExp(escapeRegExp(configuredPath)));
		assert.match(configuredTask, /This path is authoritative for this run/);
		assert.equal(fs.readFileSync(configuredPath, "utf-8"), "Agent report");
	});

	it("preserves agent output defaults for structured prompt-template delegation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredPath = path.join(tempDir, "delegated-agent-report.md");
		mockPi.onCall({
			stdoutRaw: [
				{ type: "tool_execution_start", toolName: "structured_output", args: { value: { ok: true } } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
				{ type: "tool_execution_end", toolName: "structured_output" },
			].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
			structuredOutputCapture: { ok: true },
		});
		const executor = makeExecutor([makeAgent("echo", { output: configuredPath, outputMode: "file-only" })]);
		const request: SubagentDelegationRequest = {
			requestId: "delegated-output-default",
			ownerRunId: "owner-1",
			nodeId: "node-1",
			agent: "echo",
			task: "Return structured data",
			context: "fresh",
			cwd: tempDir,
			model: "mock/model",
			result: { kind: "structured", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } },
		};

		const result = await executor.executeDelegated(
			request.requestId,
			toSubagentDelegationExecutionParams(request),
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "delegated execution failed");
		const child = result.details?.results?.[0];
		assert.equal(child?.savedOutputPath, configuredPath);
		assert.equal(child?.outputMode, "file-only");
		assert.deepEqual(child?.structuredOutput, { ok: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(configuredPath, "utf-8")), { ok: true });
	});

	it("does not inject a workflow child output without an aggregate or explicit output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Workflow child completed" });
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"workflow-omitted-output",
			{ async: false, workflowScript: `return runs.run("main", { agent: "echo", task: "Use the task output path" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.doesNotMatch(readCallArgs().join("\n"), /This path is authoritative for this run/);
	});

	it("keeps escaped read-only delegate tasks from triggering the completion guard", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "The exact user-facing response" });
		const task = [
			"This is a read-only skill compliance scenario, not an implementation assignment.",
			"Read the supplied skill and write the exact user-facing response.",
			"Do not edit files.",
			"Use a scenario that discusses selection for an implementation task or closeout of an implementation assignment.",
		].join("\\n");
		const result = await makeExecutor([makeAgent("delegate", {
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
			inheritProjectContext: true,
			systemPromptMode: "append",
		})]).execute(
			"workflow-read-only-delegate",
			{
				async: false,
				acceptance: false,
				preflight: { version: 1, coverage: "complete", lanes: [{ key: "main", mode: "review" }] },
				workflowScript: `return runs.all([{ key: "main", agent: "delegate", task: ${JSON.stringify(task)} }]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const child = (result.details as { results?: Array<{ exitCode?: number; error?: string; output?: string }> } | undefined)?.results?.[0];
		assert.equal(child?.exitCode, 0);
		assert.equal(child?.error, undefined);
		assert.match(result.content[0]?.text ?? "", /The exact user-facing response/);
	});

	it("consumes one exact host-only workflow child permit before spawn", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo"), makeAgent("other"), makeAgent("external", { runner: { type: "external-cli", command: "external" } })]);
		const ctx = makeMinimalCtx(tempDir);
		const script = `return runs.run("main", { agent: "echo", task: "Exact task", acceptance: false });`;
		mockPi.onCall({ output: "projection probe" });
		const probe = await executor.execute("probe", { async: false, workflowScript: script }, new AbortController().signal, undefined, ctx);
		const launchContractDigest = (probe.details as { results?: Array<{ launchContractDigest?: string }> }).results?.[0]?.launchContractDigest;
		assert.ok(launchContractDigest);

		const permitFor = (workflowRunId: string, overrides: Partial<Parameters<typeof createWorkflowChildPermit>[0]> = {}) => createWorkflowChildPermit({
			issuerPackage: "permit-secret-package",
			workflowRunId,
			childKey: "main",
			agent: "echo",
			launchContractDigest,
			context: "fresh",
			...overrides,
		});
		const run = (id: string, workflowScript: string, permit: ReturnType<typeof permitFor>, async = false) => executor.executeDelegated(
			id,
			{ async, workflowScript, delegatedWorkflowPermit: permit },
			new AbortController().signal,
			undefined,
			ctx,
		);

		mockPi.onCall({ output: "permitted child" });
		const longRunId = `permitted-${"x".repeat(300)}`;
		const boundedLongRunId = encodeIndexSegment(longRunId);
		const permit = permitFor(boundedLongRunId);
		const allowed = await run(longRunId, script, permit);
		assert.equal(allowed.isError, undefined, allowed.content[0]?.text ?? "long permitted workflow failed");
		assert.equal(allowed.details.runId, boundedLongRunId);
		assert.equal(workflowChildPermitConsumed(permit), true);
		assert.equal(mockPi.callCount(), 2);
		assert.doesNotMatch(JSON.stringify(allowed), /permit-secret-package|__workflowChildPermit/);

		const reused = await run(longRunId, script, permit);
		assert.equal(reused.isError, true);
		assert.match(reused.content[0]?.text ?? "", /already consumed/);
		assert.equal(mockPi.callCount(), 2);

		mockPi.onCall({ stderr: "child failed", exitCode: 1 });
		const failedPermit = permitFor("spawn-failure");
		const spawnFailure = await run("spawn-failure", script, failedPermit);
		assert.equal(spawnFailure.isError, true);
		assert.equal(workflowChildPermitConsumed(failedPermit), true);
		assert.equal(mockPi.callCount(), 3, "a consumed permit must not start a retry");

		const denied = [
			await run("wrong-key", `return runs.run("other", { agent: "echo", task: "Exact task", acceptance: false });`, permitFor("wrong-key")),
			await run("wrong-agent", `return runs.run("main", { agent: "other", task: "Exact task", acceptance: false });`, permitFor("wrong-agent")),
			await run("wrong-task", `return runs.run("main", { agent: "echo", task: "Changed task", acceptance: false });`, permitFor("wrong-task")),
			await run("runs-all", `return runs.all([{ key: "main", agent: "echo", task: "Exact task", acceptance: false }]);`, permitFor("runs-all")),
			await run("resume", `return runs.run("main", { resume: "retained-run", task: "Continue" });`, permitFor("resume")),
			await run("external", `return runs.run("main", { agent: "external", task: "Exact task", async: false });`, permitFor("external")),
			await run("async-root", script, permitFor("async-root"), true),
		];
		const denialText = denied.map((result) => result.content[0]?.text ?? "").join("\n");
		assert.match(denialText, /child key mismatch.*agent mismatch.*final launch projection.*runs\.all.*retained resume.*native Pi children.*foreground workflow roots/s);
		const wrongThenRightPermit = permitFor("wrong-then-right");
		const wrongThenRight = await run("wrong-then-right", `
			try { await runs.run("other", { agent: "echo", task: "Exact task", acceptance: false }); } catch {}
			return runs.run("main", { agent: "echo", task: "Exact task", acceptance: false });
		`, wrongThenRightPermit);
		assert.equal(wrongThenRight.isError, true);
		assert.match(wrongThenRight.content[0]?.text ?? "", /already consumed/);
		assert.equal(workflowChildPermitConsumed(wrongThenRightPermit), true);
		assert.equal(mockPi.callCount(), 3, "wrong-then-right must not spawn");
		const fallback = await makeExecutor([makeAgent("echo", { model: "mock/primary", fallbackModels: ["mock/backup"] })]).executeDelegated(
			"fallback",
			{ async: false, workflowScript: script, delegatedWorkflowPermit: permitFor("fallback") },
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.match(fallback.content[0]?.text ?? "", /does not support model fallback/);
		assert.equal(mockPi.callCount(), 3);
	});

	it("resolves workflow child profile context from its agent default", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Workflow child completed" });
		const result = await makeExecutor([makeAgent("echo", { defaultContext: "fresh" })], { defaultSubagentContext: "fork" }).execute(
			"workflow-profile-context",
			{ async: false, workflowScript: `return runs.run("main", { agent: "echo", task: "Use profile context", context: "profile" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(result.details?.results?.[0]?.context, "fresh");
	});

	it("reports a user-requested foreground detach without supervisor guidance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ steps: [{ delay: 500, jsonl: [events.assistantMessage("completed after user detach")] }] });
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
		};
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
			allowMutatingManagementActions: true,
		});

		const pending = executor.execute(
			"user-detach-guidance",
			{ agent: "echo", task: "Keep working", async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		let control = state.lastForegroundControlId ? state.foregroundControls.get(state.lastForegroundControlId) : undefined;
		for (let attempt = 0; attempt < 100 && !control?.detach; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			control = state.lastForegroundControlId ? state.foregroundControls.get(state.lastForegroundControlId) : undefined;
		}
		assert.ok(control?.detach, "foreground detach control should become available");
		assert.equal(control.detach(), true);

		const result = await pending;
		const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		assert.equal(result.details.results[0]?.detachedReason, "user request");
		assert.match(text, /Detached at user request/);
		assert.match(text, /bg_wait\(\{ id: "[^"]+", nonBlocking: true \}\)/);
		assert.doesNotMatch(text, /intercom coordination|supervisor request|Wait with bg_wait/);
		assert.doesNotMatch(text, /bg_wait\(\{ id: "[^"]+" \}\)/);

		let terminalChild = state.foregroundRuns?.get(control.runId)?.children[0];
		for (let attempt = 0; attempt < 250 && terminalChild?.status !== "completed"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			terminalChild = state.foregroundRuns?.get(control.runId)?.children[0];
		}
		assert.equal(terminalChild?.status, "completed", "detached child should reach its terminal callback before teardown");
		assert.equal(terminalChild.finalOutput, "completed after user detach");
	});

	it("rejects action='single' with execution fields", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic("single-alias", { action: "single", agent: "echo", task: "work" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /action='single' is not supported/);
	});

	it("rejects internal fan-out fields from public workflows", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		for (const params of [
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "work" })`, runFanoutBudget: { version: 1 } },
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "work" })`, runFanoutAdmitted: true },
		] as const) {
			const result = await executor.executePublic("private-fanout", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /does not accept internal run fan-out fields/);
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("runs isolation none outside Git and keeps worktree isolation strict", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		assert.equal(fs.existsSync(path.join(tempDir, ".git")), false);
		mockPi.onCall({ output: "shared cwd" });
		const executor = makeExecutor([makeAgent("echo")]);
		const script = `return runs.run("main", { agent: "echo", task: "work" })`;

		const shared = await executor.executePublic(
			"isolation-none",
			{ async: false, isolation: "none", workflowScript: script },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(shared.isError, undefined, shared.content[0]?.text ?? "shared workflow failed");

		const isolated = await executor.executePublic(
			"isolation-worktree",
			{ async: false, isolation: "worktree", workflowScript: script },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(isolated.isError, true);
		assert.match(isolated.content[0]?.text ?? "", /worktree isolation requires a git repository/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("allows schedule.create to load its workflowScript target from a path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		let forwarded;
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, async (params) => {
			forwarded = params;
			return { content: [{ type: "text", text: "created" }], details: { mode: "management", results: [] } };
		});
		fs.writeFileSync(path.join(tempDir, "scheduled.js"), "return runs.run('main', { agent: 'echo' })");

		const result = await executor.executePublic(
			"schedule-create",
			{ action: "schedule.create", id: "nightly", every: "1h", workflowScriptPath: "scheduled.js" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.content[0]?.text, "created");
		assert.equal(forwarded?.workflowScript, "return runs.run('main', { agent: 'echo' })");
	});

	it("validates workflow scripts without launching children or creating artifacts", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const before = fs.readdirSync(tempDir).sort();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("validate must not discover or launch agents");
		});

		const result = await executor.executePublic(
			"offline-validation",
			{ action: "validate", workflowScript: `return runs.run("bad key", { agent: "echo" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), {
			ok: false,
			errors: [{ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", line: 1, column: 17 }],
		});
		const invalidPreflight = await executor.executePublic(
			"invalid-preflight",
			{ workflowScript: `return runs.run("child", { agent: "echo" });`, preflight: { version: 1, lanes: [{ key: "bad key" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(invalidPreflight.isError, true);
		assert.match(invalidPreflight.content[0]?.text ?? "", /preflight\.lanes\[0\]\.key/);
		const offlinePreflight = await executor.executePublic(
			"offline-preflight",
			{ action: "validate", workflowScript: "return 1;", preflight: { version: 1, lanes: [{ key: "bad key" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(offlinePreflight.isError, true);
		const offlinePreflightValidation = JSON.parse(offlinePreflight.content[0]?.text ?? "null") as { ok?: boolean; errors?: unknown[] };
		assert.equal(offlinePreflightValidation.ok, false);
		assert.match(JSON.stringify(offlinePreflightValidation.errors ?? []), /preflight\.lanes\[0\]\.key/);
		assert.equal(mockPi.callCount(), 0);
		assert.deepEqual(fs.readdirSync(tempDir).sort(), before);
	});

	it("runs a workflow host command without launching a child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-command.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("host command passed\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"host-command",
			{
				async: false,
				output: "reports/host-command.log",
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/host-command.log", role: "ci", provider: "local" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "host command workflow failed");
		assert.equal(mockPi.callCount(), 0);
		const savedOutput = fs.readFileSync(path.join(tempDir, "reports", "host-command.log"), "utf8");
		assert.match(savedOutput, /host command passed/);
		assert.doesNotMatch(savedOutput, /Workflow completed/);
		assert.deepEqual(result.details.workflow?.receipt?.hostSteps?.map(({ monitorKind, state, reportPath, exitCode }) => ({ monitorKind, state, reportPath, exitCode })), [{ monitorKind: "command", state: "done", reportPath: "reports/host-command.log", exitCode: 0 }]);

		const failedScriptPath = path.join(tempDir, "host-command-failed.cjs");
		fs.writeFileSync(failedScriptPath, `process.stderr.write("host command failed\\n"); process.exit(4);`);
		const failed = await executor.execute(
			"host-command-failed",
			{
				async: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(failedScriptPath)}`)}, timeoutMs: 5000, output: "reports/host-command-failed.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(failed.isError, true);
		assert.deepEqual(failed.details.workflow?.receipt?.hostSteps?.map(({ state, reasonCode, exitCode }) => ({ state, reasonCode, exitCode })), [{ state: "error", reasonCode: "command_failed", exitCode: 4 }]);
	});

	it("resolves a named workflow resource internally and exposes its provenance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Named review completed" });
		const result = await makeExecutor([makeAgent("reviewer")]).executePublic(
			"named-review-resource",
			{ workflow: "review", args: { task: "Review the change" }, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "named workflow failed");
		assert.match(result.content[0]?.text ?? "", /Named review completed/);
		assert.equal(result.details.workflow?.resource?.kind, "workflow");
		assert.equal(result.details.workflow?.resource?.name, "review");
		assert.equal(result.details.workflow?.resource?.invocation, "named");
		assert.equal(result.details.workflow?.receipt?.resource?.id, result.details.workflow?.resource?.id);
		assert.equal(mockPi.callCount(), 1);
	});

	it("executes a registered mixed foreground workflow without widening session or child authority", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		// A persistent session's file path is not its SDK session ID.
		ctx.sessionManager.getSessionFile = () => path.join(tempDir, "parent.jsonl");
		const marker = path.join(tempDir, "registered-marker");
		fs.writeFileSync(path.join(tempDir, "registered-check.cjs"), `require("node:fs").writeFileSync("registered-marker", "ran"); console.log("finite check passed");`);
		const command = `${JSON.stringify(process.execPath)} registered-check.cjs`;
		const host = `return await runs.host("check", ${JSON.stringify({ kind: "command", command, timeoutMs: 5000, output: "registered-check.log" })});`;
		const script = `const child = await runs.run("review", { agent: "reviewer", task: "Review the change", capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], sources: ["resource"] } }); if (!child.ok) throw new Error("Required review failed"); ${host}`;
		const registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: {
			name: "test.mixed", version: 1, resolve: () => ({ script, hostCommands: [{ key: "check", command }] }),
		} });
		const executor = makeExecutor([makeAgent("reviewer")]);
		try {
			const other = makeMinimalCtx(tempDir);
			other.sessionManager.getSessionId = () => "other-session";
			const wrongSession = await executor.executePublic("wrong-session", { workflow: "test.mixed", args: { sessionId: ctx.sessionManager.getSessionId() }, async: false }, new AbortController().signal, undefined, other);
			assert.equal(wrongSession.isError, true);
			assert.match(wrongSession.content[0]?.text ?? "", /Unknown workflow/);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(mockPi.callCount(), 0);

			const ceiling = registerSubagentCapabilityCeiling({ sessionId: ctx.sessionManager.getSessionFile()!, source: "test", ceiling: { allowedAgents: ["echo"] } });
			try {
				const denied = await executor.executePublic("ceiling-denied", { workflow: "test.mixed", async: false, capabilityCeiling: { version: 1, allowedAgents: ["reviewer"], sources: ["caller"] } }, new AbortController().signal, undefined, ctx);
				assert.equal(denied.isError, true);
				assert.match(denied.content[0]?.text ?? "", /Capability ceiling from caller, test does not allow agent 'reviewer'/);
				assert.equal(fs.existsSync(marker), false);
				assert.equal(mockPi.callCount(), 0);
			} finally { ceiling.dispose(); }

			mockPi.onCall({ output: "Registered review completed" });
			const result = await executor.executePublic("registered-mixed", { workflow: "test.mixed", async: false }, new AbortController().signal, undefined, ctx);
			assert.equal(result.isError, undefined, result.content[0]?.text);
			assert.equal(mockPi.callCount(), 1);
			assert.equal(fs.readFileSync(marker, "utf8"), "ran");
			assert.match(fs.readFileSync(path.join(tempDir, "registered-check.log"), "utf8"), /finite check passed/);
			assert.equal(result.details.workflow?.receipt?.resource?.name, "test.mixed");
			assert.equal(result.details.workflow?.receipt?.state, "complete");
			assert.equal(result.details.workflow?.receipt?.entries.review.agent, "reviewer");
			assert.ok(result.details.workflow?.receipt?.entries.review.latestRunId);
			assert.deepEqual(result.details.workflow?.receipt?.hostSteps?.map(({ id, state, exitCode }) => ({ id, state, exitCode })), [{ id: "check", state: "done", exitCode: 0 }]);
		} finally { registration.dispose(); }
	});

	it("denies untrusted and out-of-grant registered commands before spawning", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const marker = path.join(tempDir, "denied-marker");
		fs.writeFileSync(path.join(tempDir, "denied-check.cjs"), `require("node:fs").writeFileSync("denied-marker", "ran");`);
		const command = `${JSON.stringify(process.execPath)} denied-check.cjs`;
		const script = `return await runs.host("check", ${JSON.stringify({ kind: "command", command, timeoutMs: 5000 })});`;
		const ctx = makeMinimalCtx(tempDir);
		const executor = makeExecutor([]);
		const registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: {
			name: "test.denied", version: 1, resolve: () => ({ script, hostCommands: [{ key: "different-key", command }, { key: "check", command: `${command} unused` }] }),
		} });
		fs.writeFileSync(path.join(tempDir, "raw-workflow.js"), script);
		try {
			for (const params of [
				{ workflowScript: script },
				{ workflowScriptPath: "raw-workflow.js" },
				{ workflow: "test.denied", workflowResourcePermit: {} },
				{ workflow: "test.denied" },
			]) {
				const result = await executor.executePublic("denied-command", { ...params, async: false }, new AbortController().signal, undefined, ctx);
				assert.equal(result.isError, true);
				assert.match(result.content[0]?.text ?? "", /runs\.host is unavailable|provenance or permit|not allowed/);
				assert.equal(fs.existsSync(marker), false);
				assert.equal(mockPi.callCount(), 0);
			}
		} finally { registration.dispose(); }
	});

	it("denies host calls from raw public workflow scripts without resource authority", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const result = await makeExecutor([makeAgent("echo")]).executePublic(
			"raw-host-denied",
			{ workflowScript: `return await runs.host("ci", { kind: "command", command: "npm test", timeoutMs: 1000 });`, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /runs\.host is unavailable/);
		assert.equal(result.details.workflow?.resource, undefined);
		assert.equal(result.details.workflow?.receipt?.resource, undefined);
		assert.equal(mockPi.callCount(), 0);
	});

	it("denies host calls when scheduled raw workflows replay", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "scheduled-host-marker.txt");
		const script = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");`;
		const result = await makeExecutor([makeAgent("echo")]).executeScheduled(
			"scheduled-raw-host-denied",
			{
				workflowScript: `return await runs.host("ci", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`)}, timeoutMs: 1000 });`,
				async: false,
				scheduleOrigin: { id: "nightly" },
			},
			new AbortController().signal,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /runs\.host is unavailable/);
		assert.equal(fs.existsSync(markerPath), false);
		assert.equal(result.details.workflow?.resource, undefined);
		assert.equal(mockPi.callCount(), 0);
	});

	it("admits only the host command granted by a named workflow resource", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const result = await makeExecutor([makeAgent("echo")]).executePublic(
			"named-ci-resource",
			{ workflow: "run-ci", args: { command: "npm run typecheck", timeoutMs: 120_000 }, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(path.resolve(".")),
		);
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "named CI workflow failed");
		assert.equal(result.details.workflow?.resource?.name, "run-ci");
		assert.equal(result.details.workflow?.receipt?.resource?.name, "run-ci");
		assert.deepEqual(result.details.workflow?.receipt?.hostSteps?.map(({ id, state, exitCode }) => ({ id, state, exitCode })), [{ id: "ci", state: "done", exitCode: 0 }]);
		assert.equal(mockPi.callCount(), 0);
	});

	it("explains the cwd workaround instead of launching a host step", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.executePublic(
			"host-command-cwd",
			{
				async: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: "npm test", timeoutMs: 5000, cwd: "/tmp" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not accept per-step cwd.*workflow cwd.*outer subagent request.*cd \/path\/to\/worktree/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects a child output claimed by an earlier host command", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-output-owner.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("host owns output\\n");`);
		const sharedOutput = path.join(tempDir, "reports", "shared.log");
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"host-output-collision",
			{
				async: false,
				workflowScript: `await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/shared.log" }); return runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(sharedOutput)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(result.content[0]?.text ?? "", /output path is already claimed|resolve output to the same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects host and child output aliases through symlinks", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "host-output-alias-owner.cjs");
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		fs.symlinkSync(reportsDir, path.join(tempDir, "linked-reports"), "dir");
		fs.writeFileSync(scriptPath, `process.stdout.write("host owns output alias\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"host-output-alias-collision",
			{
				async: false,
				workflowScript: `await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "linked-reports/shared.log" }); return runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(path.join(reportsDir, "shared.log"))} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(result.content[0]?.text ?? "", /output path is already claimed|resolve output to the same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects host output aliases created after claim registration", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		const firstScriptPath = path.join(tempDir, "host-output-first.cjs");
		const aliasScriptPath = path.join(tempDir, "host-output-alias.cjs");
		fs.writeFileSync(firstScriptPath, `process.stdout.write("first evidence\\n");`);
		fs.writeFileSync(aliasScriptPath, `const fs = require("node:fs"); fs.rmSync(${JSON.stringify(path.join(tempDir, "late-link"))}, { recursive: true, force: true }); fs.symlinkSync(${JSON.stringify(reportsDir)}, ${JSON.stringify(path.join(tempDir, "late-link"))}, "dir"); process.stdout.write("second evidence\\n");`);
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"host-output-late-alias-collision",
			{
				async: false,
				workflowScript: `await runs.host("first", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(firstScriptPath)}`)}, timeoutMs: 5000, output: "reports/shared.log" }); return await runs.host("second", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(aliasScriptPath)}`)}, timeoutMs: 5000, output: "late-link/shared.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /output path changed after it was claimed/);
		assert.match(fs.readFileSync(path.join(reportsDir, "shared.log"), "utf-8"), /first evidence/);
	});

	it("rejects child output aliases created after claim registration", { skip: !createSubagentExecutor || process.platform === "win32" ? "symlink output aliases are not portable on Windows CI" : undefined }, async () => {
		const reportsDir = path.join(tempDir, "reports");
		fs.mkdirSync(reportsDir);
		const sharedOutput = path.join(reportsDir, "shared.log");
		fs.writeFileSync(sharedOutput, "prior output\n", "utf-8");
		const lateLink = path.join(tempDir, "late-link");
		const claimedOutput = path.join(lateLink, "shared.log");
		const releasePath = path.join(tempDir, "release-child-output");
		mockPi.onCall({ waitForPath: releasePath, output: "child fallback output" });

		const pending = makeExecutor([makeAgent("echo")]).executePublic(
			"child-output-late-alias-collision",
			{
				async: false,
				workflowScript: `return await runs.run("child", { agent: "echo", task: "unused", output: ${JSON.stringify(claimedOutput)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		for (let attempt = 0; attempt < 100 && mockPi.callCount() === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
		if (mockPi.callCount() !== 1) {
			fs.writeFileSync(releasePath, "go", "utf-8");
			await pending.catch(() => undefined);
		}
		assert.equal(mockPi.callCount(), 1);
		fs.symlinkSync(reportsDir, lateLink, "dir");
		fs.writeFileSync(releasePath, "go", "utf-8");

		const result = await pending;
		const child = (result.details as { results?: Array<{ exitCode?: number; outputSaveError?: string; savedOutputPath?: string }> } | undefined)?.results?.[0];
		assert.equal(child?.exitCode, 1);
		assert.match(child?.outputSaveError ?? "", /Output path changed after it was claimed/);
		assert.equal(child?.savedOutputPath, undefined);
		assert.equal(fs.readFileSync(sharedOutput, "utf-8"), "prior output\n");
	});

	it("persists async host command status and receipt evidence", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const scriptPath = path.join(tempDir, "async-host-command.cjs");
		fs.writeFileSync(scriptPath, `process.stdout.write("async host passed\\n");`);
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			"async-host-command",
			{
				async: true,
				mission: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`)}, timeoutMs: 5000, output: "reports/async-host.log", role: "ci", provider: "local" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(result.details.asyncDir);
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { state?: string; workflowGraph?: { nodes?: Array<{ hostStep?: { monitorKind?: string; state?: string; role?: string; reportPath?: string; exitCode?: number | null; updatedAt?: number; deadlineAt?: number } }> } } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.deepEqual(status.workflowGraph?.nodes?.[0]?.hostStep, {
			version: 1, kind: "host-step", monitorKind: "command", id: "tests", label: "tests", role: "ci", provider: "local", state: "done", verdict: "pass", detail: "async host passed", reportPath: "reports/async-host.log", exitCode: 0,
			updatedAt: status.workflowGraph?.nodes?.[0]?.hostStep?.updatedAt,
			deadlineAt: status.workflowGraph?.nodes?.[0]?.hostStep?.deadlineAt,
		});
		const receipt = JSON.parse(fs.readFileSync(path.join(result.details.asyncDir!, "workflow-receipt.json"), "utf8")) as { hostSteps?: Array<{ monitorKind?: string; state?: string; reportPath?: string }> };
		assert.deepEqual(receipt.hostSteps?.map(({ monitorKind, state, reportPath }) => ({ monitorKind, state, reportPath })), [{ monitorKind: "command", state: "done", reportPath: "reports/async-host.log" }]);
		assert.match(fs.readFileSync(path.join(tempDir, "reports", "async-host.log"), "utf8"), /async host passed/);
		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		if (result.details.asyncId) fs.rmSync(path.join(DIRS.results, `${result.details.asyncId}.json`), { force: true });

		const failedScript = path.join(tempDir, "async-host-command-failed.cjs");
		fs.writeFileSync(failedScript, `process.stderr.write("async host failed\\n"); process.exit(3);`);
		const failed = await executor.execute(
			"async-host-command-failed",
			{
				async: true,
				mission: false,
				workflowScript: `return await runs.host("tests", { kind: "command", command: ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(failedScript)}`)}, timeoutMs: 5000, output: "reports/async-host-failed.log" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(failed.details.asyncDir);
		const failedStatusPath = path.join(failed.details.asyncDir!, "status.json");
		let failedStatus: { state?: string; workflowGraph?: { nodes?: Array<{ hostStep?: { state?: string; reasonCode?: string; exitCode?: number | null } }> } } = {};
		for (let attempt = 0; attempt < 100; attempt += 1) {
			failedStatus = JSON.parse(fs.readFileSync(failedStatusPath, "utf8"));
			if (failedStatus.state === "complete" || failedStatus.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(failedStatus.state, "failed");
		assert.deepEqual(failedStatus.workflowGraph?.nodes?.map((node) => node.hostStep && { state: node.hostStep.state, reasonCode: node.hostStep.reasonCode, exitCode: node.hostStep.exitCode }), [{ state: "error", reasonCode: "command_failed", exitCode: 3 }]);
		const failedReceipt = JSON.parse(fs.readFileSync(path.join(failed.details.asyncDir!, "workflow-receipt.json"), "utf8")) as { state?: string; hostSteps?: Array<{ state?: string; reasonCode?: string; exitCode?: number | null }> };
		assert.equal(failedReceipt.state, "failed");
		assert.deepEqual(failedReceipt.hostSteps?.map(({ state, reasonCode, exitCode }) => ({ state, reasonCode, exitCode })), [{ state: "error", reasonCode: "command_failed", exitCode: 3 }]);
		assert.match(fs.readFileSync(path.join(tempDir, "reports", "async-host-failed.log"), "utf8"), /async host failed/);
		fs.rmSync(failed.details.asyncDir!, { recursive: true, force: true });
		if (failed.details.asyncId) fs.rmSync(path.join(DIRS.results, `${failed.details.asyncId}.json`), { force: true });
	});

	it("loads workflowScriptPath from the request cwd for validation without launching", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const requestCwd = path.join(tempDir, "request-cwd");
		fs.mkdirSync(requestCwd);
		fs.writeFileSync(path.join(requestCwd, "workflow.js"), `return runs.run("bad key", { agent: "echo" });`);
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("validate must not discover or launch agents");
		});

		const result = await executor.executePublic(
			"file-validation",
			{ action: "validate", cwd: "request-cwd", workflowScriptPath: "workflow.js" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), {
			ok: false,
			errors: [{ message: "runs.run key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.", line: 1, column: 17 }],
		});
		assert.equal(mockPi.callCount(), 0);
	});

	it("reports missing and empty workflowScriptPath files before validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "empty.js"), " \n");
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), () => {
			throw new Error("file input errors must not discover or launch agents");
		});

		const missing = await executor.executePublic("missing-file", { action: "validate", workflowScriptPath: "missing.js" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(missing.isError, true);
		assert.match(missing.content[0]?.text ?? "", /Failed to read workflowScriptPath.*missing\.js/);
		assert.doesNotMatch(missing.content[0]?.text ?? "", /validation failed|valid JavaScript/);

		const empty = await executor.executePublic("empty-file", { action: "validate", workflowScriptPath: "empty.js" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(empty.isError, true);
		assert.match(empty.content[0]?.text ?? "", /workflowScriptPath file .*empty\.js.* is empty/);
		assert.doesNotMatch(empty.content[0]?.text ?? "", /validation failed|valid JavaScript/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("executes a workflow loaded from workflowScriptPath", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "workflow.js"), `return runs.run("main", { agent: "echo", task: "from file" });`);
		mockPi.onCall({ output: "loaded workflow" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.executePublic(
			"file-execution",
			{ async: false, workflowScriptPath: path.join(tempDir, "workflow.js"), preflight: { version: 1, coverage: "complete", lanes: [{ key: "main", mode: "mutation" }] } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "file workflow failed");
		assert.deepEqual(result.details.preflight, { version: 1, coverage: "complete", lanes: [{ key: "main", mode: "mutation" }] });
		assert.equal(mockPi.callCount(), 1);
	});

	it("starts workflow scripts asynchronously with a portable internal run id", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "async child done" });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo", { aliases: ["helper"], defaultAsync: true })], { missions: { globalIndex: false } }, false, undefined, true, asyncJobs);
		const workflowCwd = path.join(tempDir, "workflow-cwd");
		fs.mkdirSync(workflowCwd);
		const toolCallId = "call_demo|fc_demo";
		const context = makeMinimalCtx(tempDir);
		context.sessionManager.getSessionFile = () => path.join(tempDir, "parent-session.jsonl");

		const result = await executor.execute(
			toolCallId,
			{
				cwd: workflowCwd,
				workflowScript: `emit("starting"); await runs.run("work", { agent: "helper", label: "Run async child", phase: "Execution", task: "Async work" }); return { answer: 42 };`,
				preflight: { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] },
				mission: { summary: "Review the active backlog", labels: ["github-backlog", "review"] },
			},
			new AbortController().signal,
			undefined,
			context,
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.mode, "workflow");
		assert.equal(result.details.toolCallId, toolCallId);
		assert.ok(result.details.asyncId);
		const workflowRunId = result.details.asyncId;
		assert.equal(result.details.runId, workflowRunId);
		assert.deepEqual(result.details.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		assert.notEqual(workflowRunId, toolCallId);
		assert.match(workflowRunId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(path.basename(result.details.asyncDir!), workflowRunId);
		assert.equal(asyncJobs.has(workflowRunId), true);
		assert.equal(asyncJobs.get(workflowRunId)?.cwd, workflowCwd);
		assert.equal(asyncJobs.get(workflowRunId)?.sessionRoot, path.join(tempDir, ".pi/subagents", "sessions"));
		assert.deepEqual(asyncJobs.get(workflowRunId)?.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		assert.equal(asyncJobs.has(toolCallId), false);
		assert.equal(fs.existsSync(path.join(DIRS.async, toolCallId)), false);
		assert.match(result.content[0]?.text ?? "", /Preflight: v1 · complete · 1 lane/);
		assert.match(result.content[0]?.text ?? "", /Async workflow/);
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { runId?: string; toolCallId?: string; cwd?: string; sessionRoot?: string; state?: string; preflight?: unknown; steps?: Array<{ agent?: string; sessionName?: string; label?: string; phase?: string; workflowKey?: string; parentWorkflowRunId?: string; async?: boolean }>; workflow?: { value?: unknown; emits?: unknown[]; trace?: Array<{ key?: string; agent?: string; label?: string; phase?: string; state?: string }> } } = {};
		for (let attempt = 0; attempt < 300; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.equal(status.runId, workflowRunId);
		assert.equal(status.toolCallId, toolCallId);
		assert.equal(status.cwd, workflowCwd);
		assert.equal(status.sessionRoot, path.join(tempDir, ".pi/subagents", "sessions"));
		assert.deepEqual(status.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		const statusResult = await executor.execute(
			"status-preflight",
			{ action: "status", id: workflowRunId },
			new AbortController().signal,
			undefined,
			context,
		);
		assert.match(statusResult.content[0]?.text ?? "", /Plan: 1 lane · work/);
		assert.doesNotMatch(statusResult.content[0]?.text ?? "", /key \| mode \| decision \| claims \| expected output \| independence/);
		assert.deepEqual(statusResult.details.preflight, { version: 1, coverage: "complete", lanes: [{ key: "work", mode: "mutation", claims: ["src/work.ts"], expectedOutput: "child report" }] });
		assert.equal(status.steps?.length, 1);
		assert.deepEqual(status.steps?.map(({ agent, sessionName, label, phase, workflowKey }) => ({ agent, sessionName, label, phase, workflowKey })), [
			{ agent: "echo", sessionName: "echo: Async work", label: "Run async child", phase: "Execution", workflowKey: "work" },
		]);
		assert.ok(status.steps?.every((step) => step.parentWorkflowRunId === workflowRunId));
		assert.equal(status.steps?.[0]?.async, true);
		assert.deepEqual(status.workflow?.value, { answer: 42 });
		assert.deepEqual(status.workflow?.emits, ["starting"]);
		assert.equal(mockPi.callCount(), 1);
		assert.ok(status.workflow?.trace?.some((entry) => entry.key === "work" && entry.agent === "echo" && entry.label === "Run async child" && entry.phase === "Execution" && entry.state === "completed"));
		const traceEvents = fs.readFileSync(path.join(result.details.asyncDir!, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; trace?: Array<{ key?: string; state?: string }> })
			.filter((event) => event.type === "subagent.workflow.trace");
		assert.equal(traceEvents.length, 2);
		assert.deepEqual(traceEvents[0]?.trace?.map(({ key, state }) => ({ key, state })), [{ key: "work", state: "started" }]);
		assert.deepEqual(traceEvents[1]?.trace?.map(({ key, state }) => ({ key, state })), [
			{ key: "work", state: "started" },
			{ key: "work", state: "completed" },
		]);
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { id?: string; runId?: string; toolCallId?: string; agent?: string; cwd?: string; summary?: string; workflow?: { value?: unknown; receipt?: unknown }; workflowReceipt?: { path?: string; receipt?: { workflowRunId?: string; entries?: Record<string, { key?: string; agent?: string; latestRunId?: string; resumability?: { state?: string; reason?: string }; continuation?: { runIds?: string[] } }> } }; results?: Array<{ agent?: string; sessionName?: string; workflowKey?: string; runId?: string; output?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } }> };
		assert.equal(persistedResult.id, workflowRunId);
		assert.equal(persistedResult.runId, workflowRunId);
		assert.equal(persistedResult.toolCallId, toolCallId);
		assert.equal(persistedResult.agent, "workflow");
		assert.equal(persistedResult.cwd, workflowCwd);
		assert.deepEqual(persistedResult.results?.map(({ agent, sessionName, workflowKey }) => ({ agent, sessionName, workflowKey })), [
			{ agent: "echo", sessionName: "echo: Async work", workflowKey: "work" },
		]);
		assert.deepEqual(persistedResult.results?.[0]?.usage, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 });
		assert.equal(readCall().runtime?.steerInbox, undefined, "in-process workflow children are steered through their session, not a file inbox");
		assert.equal(fs.existsSync(path.join(result.details.asyncDir!, "control", "workflow-foreground")), false);
		assert.match(persistedResult.summary ?? "", /Return: \{\n  "answer": 42\n\}/);
		assert.deepEqual(persistedResult.workflow?.value, { answer: 42 });
		assert.equal(persistedResult.workflow?.receipt, undefined, "status/result workflow projection must stay receipt-free");
		assert.equal(persistedResult.workflowReceipt?.path, path.join(result.details.asyncDir!, "workflow-receipt.json"));
		assert.equal(persistedResult.workflowReceipt?.receipt?.workflowRunId, workflowRunId);
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.key, "work");
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.agent, "echo");
		assert.equal(persistedResult.workflowReceipt?.receipt?.entries?.work?.latestRunId, persistedResult.results?.[0]?.runId);
		const childAsyncDir = path.join(DIRS.async, persistedResult.results?.[0]?.runId ?? "missing");
		assert.equal(fs.existsSync(childAsyncDir), true);
		assert.deepEqual(persistedResult.workflowReceipt?.receipt?.entries?.work?.continuation?.runIds, [persistedResult.results?.[0]?.runId]);
		assert.deepEqual(persistedResult.workflowReceipt?.receipt?.entries?.work?.resumability, { state: "resumable" });
		assert.deepEqual(JSON.parse(fs.readFileSync(persistedResult.workflowReceipt!.path!, "utf-8")), persistedResult.workflowReceipt?.receipt);
		assert.equal(fs.existsSync(path.join(DIRS.results, `${toolCallId}.json`)), false);
		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
		fs.rmSync(childAsyncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	});

	it("flushes async workflow assembly after cleanup once children are terminal", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "child output" });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const workflowControllers = new Map<string, AbortController>();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs, workflowControllers);
		const started = await executor.execute(
			`workflow-reload-assembly-${Date.now()}`,
			{
				async: true,
				mission: false,
				workflowScript: `const child = await runs.run("work", { agent: "echo", task: "Finish child" }); let checksum = 0; for (let index = 0; index < 100000000; index += 1) checksum = (checksum + index) % 97; return { phase: "assembled", output: child.output, checksum };`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined, started.content[0]?.text ?? "workflow launch failed");
		const workflowRunId = started.details.asyncId;
		assert.ok(workflowRunId);
		const asyncDir = started.details.asyncDir;
		assert.ok(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		let childCompleted = false;
		for (let attempt = 0; attempt < 500; attempt += 1) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { workflow?: { trace?: Array<{ key?: string; state?: string }> } };
			childCompleted = status.workflow?.trace?.some((entry) => entry.key === "work" && entry.state === "completed") ?? false;
			if (childCompleted) break;
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		assert.equal(childCompleted, true, "expected the child to settle before simulating session cleanup");
		const controller = workflowControllers.get(workflowRunId);
		assert.ok(controller, "expected a live workflow controller before simulated cleanup");
		controller.abort(new Error("Workflow stopped because the extension session was replaced or reloaded."));
		workflowControllers.clear();
		asyncJobs.clear();

		let finalStatus: { state?: string; workflow?: { value?: unknown } } = {};
		for (let attempt = 0; attempt < 500; attempt += 1) {
			finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as typeof finalStatus;
			if (finalStatus.state === "complete" || finalStatus.state === "failed" || finalStatus.state === "stopped") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(finalStatus.state, "complete");
		assert.deepEqual(finalStatus.workflow?.value, { phase: "assembled", output: "child output", checksum: 39 });
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string; workflow?: { value?: unknown } };
		assert.equal(result.state, "complete");
		assert.deepEqual(result.workflow?.value, finalStatus.workflow?.value);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("delivers a terminal Darwin workflow failure after demand disappears", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const state: SubagentState = {
			baseCwd: tempDir,
			currentSessionId: "session-1700",
			completionOwnerId: "owner-1700",
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			completionSeen: new Map(),
			resultFileCoalescer: { schedule: () => false, clear: () => {} },
		};
		let pollCreated = false;
		const delivered: Array<{ id?: string; state?: string }> = [];
		const piEvents = createEventBus();
		const watcher = createResultWatcher({ events: piEvents }, state, DIRS.results, 60_000, {
			platform: "darwin",
			deliverIntercomResults: false,
			coalesceDelayMs: 0,
			hasDeliveryDemand: () => [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running"),
			notifier: { deliver: async (result) => { delivered.push({ id: result.id, state: result.state }); return true; } },
			timers: {
				setTimeout,
				clearTimeout,
				setInterval: ((handler: () => void, delay?: number) => {
					assert.equal(delay, 3000);
					pollCreated = true;
					return { unref() {} } as NodeJS.Timeout;
				}) as typeof setInterval,
				clearInterval: (() => {}) as typeof clearInterval,
			},
		});
		let asyncDir: string | undefined;
		let resultPath: string | undefined;
		try {
			const executor = createSubagentExecutor!({
				pi: { events: piEvents, getSessionName: () => undefined },
				state,
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => path.join(tempDir, ".pi/subagents", "sessions"),
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo")] }),
				refreshResultDelivery: watcher.refreshResultDelivery,
			});
			const launchPromise = executor.execute(
				"darwin-immediate-workflow-failure",
				{ async: true, workflowScript: "{" },
				new AbortController().signal,
				undefined,
				{ ...makeMinimalCtx(tempDir), sessionManager: { getSessionId: () => "session-1700", getSessionFile: () => null } },
			);
			watcher.startResultWatcher();
			assert.equal(pollCreated, true, "expected Darwin demand polling to be armed");
			const launch = await launchPromise;
			assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "workflow launch failed");
			const workflowRunId = launch.details.asyncId;
			assert.ok(workflowRunId);
			asyncDir = launch.details.asyncDir;
			resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
			for (let attempt = 0; attempt < 100 && (state.asyncJobs.get(workflowRunId)?.status !== "failed" || delivered.length === 0); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(state.asyncJobs.get(workflowRunId)?.status, "failed");
			assert.equal([...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running"), false);
			assert.deepEqual(delivered, [{ id: workflowRunId, state: "failed" }], "terminal completion must not require a manual result refresh");
		} finally {
			watcher.stopResultWatcher();
			if (asyncDir) fs.rmSync(asyncDir, { recursive: true, force: true });
			if (resultPath) fs.rmSync(resultPath, { force: true });
		}
	});

	it("keeps script workflow phase during async auto-resume", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
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
		const releasePath = path.join(tempDir, "release-auto-resume-child");
		mockPi.onCall({ waitForPath: releasePath, output: "Recovered after workflow auto-resume" });
		const executor = makeExecutor([makeAgent("echo", { aliases: ["helper"] })]);
		const result = await executor.execute(
			"workflow-auto-resume-phase-status",
			{ workflowScript: `await runs.run("work", { agent: "helper", label: "Review current diff", phase: "Review", task: "Review the current diff" }); return { ok: true };` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const statusPath = path.join(result.details.asyncDir!, "status.json");
		let status: { state?: string; steps?: Array<{ workflowKey?: string; phase?: string }> } = {};
		for (let attempt = 0; attempt < 100 && mockPi.callCount() < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "running" && status.steps?.some((step) => step.workflowKey === "work" && step.phase !== undefined)) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "running");
		assert.equal(status.steps?.find((step) => step.workflowKey === "work")?.phase, "Review");

		fs.writeFileSync(releasePath, "go", "utf-8");
		for (let attempt = 0; attempt < 100; attempt++) {
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			if (status.state === "complete" || status.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(status.state, "complete");
		assert.equal(status.steps?.find((step) => step.workflowKey === "work")?.phase, "Review");
		assert.equal(mockPi.callCount(), 2);

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(path.join(DIRS.results, `${result.details.asyncId}.json`), { force: true });
	});

	it("runs an external CLI workflow child with subagents.defaultModel configured", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("external result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const ctx = { ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } };
		const started = await executor.execute(
			`external-workflow-${Date.now()}`,
			{ workflowScript: `return await runs.run("external", { agent: "external", task: "Run external", async: true });` },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		const workflowResultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		let workflowResult: { state?: string; results?: Array<{ output?: string; runId?: string }> } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(workflowResultPath)) workflowResult = JSON.parse(fs.readFileSync(workflowResultPath, "utf-8"));
			if (workflowResult.state === "complete" || workflowResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(workflowResult.state, "complete");
		assert.match(workflowResult.results?.[0]?.output ?? "", /Async: external/);
		assert.equal(await waitForFileContent(markerPath, "started"), "started");
		assert.equal(mockPi.callCount(), 0);

		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(workflowResultPath, { force: true });
	});

	it("awaits omitted external CLI workflow children through their async result", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-awaited-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("awaited external result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-awaited-workflow",
			{ workflowScript: `return await runs.run("external", { agent: "external", task: "Run external" });`, async: false },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } },
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(result.details.mode, "workflow");
		assert.match(result.content[0]?.text ?? "", /awaited external result/);
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "started");
		assert.equal(mockPi.callCount(), 0);
	});

	it("starts omitted external CLI single-child calls in async mode", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-single-omitted-async-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("single async result")`] },
				model: "mock/default-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-single-omitted-async",
			{ agent: "external", task: "Run external" },
			new AbortController().signal,
			undefined,
			{ ...makeMinimalCtx(tempDir), model: { provider: "mock", id: "parent-model" } },
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "launch failed");
		assert.ok(result.details.asyncId);
		assert.match(result.content[0]?.text ?? "", /Async: external/);
		assert.equal(await waitForFileContent(markerPath, "started"), "started");
		assert.equal(mockPi.callCount(), 0);

		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("lets explicit fast false opt out external CLI agents from inherited fast mode", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fast-false-started");
		const executor = makeExecutor([
			makeAgent("external", {
				fast: true,
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started"); process.stdout.write("external fast false result")`] },
			}),
		]);

		const rejected = await executor.execute(
			"external-fast-inherited",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support fast mode/);
		assert.equal(fs.existsSync(markerPath), false);

		const result = await executor.execute(
			"external-fast-false",
			{ agent: "external", task: "Run external", async: true, fast: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "launch failed");
		assert.ok(result.details.asyncId);
		assert.equal(await waitForFileContent(markerPath, "started"), "started");
		assert.equal(mockPi.callCount(), 0);

		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("runs external CLI agents with fallback models without registry validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fallback-started");
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`] },
				fallbackModels: ["mock/fallback"],
			}),
		]);
		const result = await executor.execute(
			"external-fallback-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, undefined);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		assert.equal(await waitForFileContent(markerPath, "started"), "started");
		assert.equal(mockPi.callCount(), 0);

		assert.ok(result.details.asyncId);
		const resultPath = path.join(DIRS.results, `${result.details.asyncId}.json`);
		let runResult: { state?: string } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) runResult = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (runResult.state === "complete" || runResult.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(runResult.state, "complete");

		fs.rmSync(result.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("rejects external CLI fork context before fallback model validation", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerPath = path.join(tempDir, "external-fork-started");
		const parentSessionFile = path.join(mockPi.dir, "external-fork-parent.jsonl");
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: tempDir })}\n`, "utf-8");
		const ctx = makeMinimalCtx(tempDir);
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "parent-leaf",
			openSession: () => ({
				createBranchedSession: () => parentSessionFile,
			}),
		});
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`] },
				defaultContext: "fork",
				fallbackModels: ["mock/fallback"],
			}),
		]);
		const result = await executor.execute(
			"external-fork-fallback",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			{
				...ctx,
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: fork context/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		assert.equal(mockPi.callCount(), 0);
		assert.equal(fs.existsSync(markerPath), false);
	});

	it("rejects explicit model overrides for external CLI agents", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
			}),
		]);
		const result = await executor.execute(
			"external-explicit-model",
			{ agent: "external", task: "Run external", async: true, model: "mock/override" },
			new AbortController().signal,
			undefined,
			{
				...makeMinimalCtx(tempDir),
				modelRegistry: { getAvailable: () => [{ provider: "other", id: "known" }] },
			},
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Unknown subagent model/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects external CLI agent models that differ from inherited subagents.defaultModel", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
				model: "mock/override-model",
				modelSource: { type: "subagents.defaultModel", scope: "user", path: "/settings.json", model: "mock/default-model" },
			}),
		]);
		const result = await executor.execute(
			"external-agent-override-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects external CLI agent models that equal inherited subagents.defaultModel without provenance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([
			makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('unreachable')"] },
				model: "mock/default-model",
			}),
		]);
		const result = await executor.execute(
			"external-agent-same-value-override-model",
			{ agent: "external", task: "Run external", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /does not support: model override/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("projects live child activity into async workflow status", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "src/example.ts" })] },
				{ delay: 2_500, jsonl: [events.toolEnd("read"), events.toolResult("read", "contents")] },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {
			control: {
				enabled: true,
				needsAttentionAfterMs: 100,
				activeNoticeAfterMs: 100,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event"],
			},
		}, false, undefined, true, asyncJobs);

		const result = await executor.execute(
			"workflow-live-activity",
			{ workflowScript: `return runs.run("main", { agent: "echo", task: "Inspect the file" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const { asyncId: workflowRunId, asyncDir } = result.details;
		assert.ok(workflowRunId);
		assert.ok(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		const activeMarkerPath = path.join(DIRS.async, ACTIVE_RUN_INDEX_DIR, workflowRunId);
		assert.equal(fs.existsSync(activeMarkerPath), true);
		let liveStatus: AsyncStatus | undefined;
		const activityDeadline = Date.now() + 5_000;
		while (Date.now() < activityDeadline && !fs.existsSync(resultPath)) {
			const candidate = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (candidate.activityState === "needs_attention" && candidate.steps?.[0]?.currentTool === "read") {
				liveStatus = candidate;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(liveStatus, "expected workflow status to expose live child activity");
		assert.equal(liveStatus.activityState, "needs_attention");
		assert.equal(typeof liveStatus.lastActivityAt, "number");
		assert.equal(liveStatus.currentTool, "read");
		assert.match(liveStatus.currentPath ?? "", /src[/\\]example\.ts$/);
		assert.equal(liveStatus.toolCount, 1);
		assert.equal(liveStatus.steps?.[0]?.status, "running");
		assert.equal(liveStatus.steps?.[0]?.agent, "echo");
		assert.match(liveStatus.steps?.[0]?.sessionFile ?? "", /session\.jsonl$/);
		assert.equal(fs.existsSync(liveStatus.steps?.[0]?.sessionFile ?? ""), true);
		assert.equal(liveStatus.steps?.[0]?.activityState, "needs_attention");
		assert.equal(typeof liveStatus.steps?.[0]?.lastActivityAt, "number");
		assert.equal(liveStatus.steps?.[0]?.toolCount, 1);
		assert.equal(asyncJobs.get(workflowRunId)?.activityState, "needs_attention");
		assert.equal(asyncJobs.get(workflowRunId)?.steps?.[0]?.currentTool, "read");

		const completionDeadline = Date.now() + 5_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > completionDeadline) assert.fail("Timed out waiting for async workflow completion");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.existsSync(activeMarkerPath), false);
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("notifies the parent when an async workflow child needs attention", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "src/example.ts" }), events.toolEnd("read"), events.toolResult("read", "contents"), mockAssistantMessage("Started", "tool_use")] },
				{ delay: 2_500, jsonl: [events.assistantMessage("Done")] },
			],
		});
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const piEvents = createEventBus();
		const controlPayloads: Array<{ event?: ControlEvent; source?: string }> = [];
		piEvents.on(SUBAGENT_CONTROL_EVENT, (payload) => {
			controlPayloads.push(payload as { event?: ControlEvent; source?: string });
		});
		const executor = makeExecutor([makeAgent("echo")], {
			control: {
				enabled: true,
				needsAttentionAfterMs: 100,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterTokens: 999_999,
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
		}, false, undefined, true, asyncJobs, undefined, undefined, piEvents);

		const result = await executor.execute(
			"workflow-child-attention-notice",
			{ workflowScript: `return runs.run("stalled-review", { agent: "echo", task: "Inspect the file" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const { asyncId: workflowRunId, asyncDir } = result.details;
		assert.ok(workflowRunId);
		assert.ok(asyncDir);
		const statusPath = path.join(asyncDir, "status.json");
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let liveStatus: AsyncStatus | undefined;
		const activityDeadline = Date.now() + 5_000;
		while (Date.now() < activityDeadline && !fs.existsSync(resultPath)) {
			if (fs.existsSync(statusPath)) {
				const candidate = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
				if (candidate.activityState === "needs_attention" && !candidate.steps?.[0]?.currentTool) {
					liveStatus = candidate;
					break;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(liveStatus, "expected workflow status to expose idle child attention");
		assert.equal(liveStatus.activityState, "needs_attention");
		assert.equal(liveStatus.steps?.[0]?.activityState, "needs_attention");
		assert.equal(liveStatus.steps?.[0]?.workflowKey, "stalled-review");

		const attentionPayload = controlPayloads.find((payload) => payload.event?.type === "needs_attention");
		assert.ok(attentionPayload, "expected a live parent control event");
		assert.equal(attentionPayload.source, "async");
		assert.equal(attentionPayload.event?.workflowKey, "stalled-review");
		assert.equal(attentionPayload.event?.reason, "idle");
		const sent: Array<{ options?: { triggerTurn?: boolean } }> = [];
		handleSubagentControlNotice({
			pi: { sendMessage(_message, options) { sent.push({ options: options as { triggerTurn?: boolean } }); } },
			state: { asyncJobs } as SubagentState,
			visibleControlNotices: new Set(),
			details: { event: attentionPayload.event!, source: "async" },
		});
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]?.options, { triggerTurn: true });

		assert.equal(fs.existsSync(eventsPath), true);
		const controlRecords = fs.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as { type?: string; event?: ControlEvent; runId?: string })
			.filter((record) => record.type === "subagent.control");
		const persisted = controlRecords.find((record) => record.event?.type === "needs_attention");
		assert.ok(persisted, "expected a persisted workflow control event");
		assert.equal(persisted.runId, workflowRunId);
		assert.equal(persisted.event?.workflowKey, "stalled-review");
		assert.equal(controlRecords.filter((record) => record.event?.type === "needs_attention").length, 1);

		const completionDeadline = Date.now() + 5_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > completionDeadline) assert.fail("Timed out waiting for async workflow completion");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		fs.rmSync(asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("rejects an invalid async workflow usage budget before creating run state", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);
		const runId = `scripted-workflow-invalid-budget-${Date.now()}`;

		const result = await executor.execute(
			runId,
			{ workflowScript: `return "unreachable";`, usageBudget: { tokens: { hard: 0 } } },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /usageBudget\.tokens\.hard must be a positive number/);
		assert.equal(result.details.asyncId, undefined);
		assert.equal(asyncJobs.has(runId), false);
		assert.equal(fs.existsSync(path.join(DIRS.async, runId)), false);
		assert.equal(fs.existsSync(path.join(DIRS.results, `${runId}.json`)), false);
	});

	it("rejects async child launches from budgeted async workflows", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const runId = `scripted-workflow-budget-async-child-${Date.now()}`;
		const started = await executor.execute(
			runId,
			{
				workflowScript: `await runs.run("background", { agent: "echo", task: "Async child", async: true }); return "unreachable";`,
				usageBudget: { tokens: { hard: 100 } },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.notEqual(started.details.asyncId, runId);
		const resultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		let persisted: { state?: string; summary?: string; results?: Array<{ success?: boolean; output?: string }> } = {};
		for (let attempt = 0; attempt < 100; attempt++) {
			if (fs.existsSync(resultPath)) persisted = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			if (persisted.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(persisted.state, "failed");
		assert.match(persisted.summary ?? "", /workflow usageBudget does not support async runs\.run launches/);
		assert.equal(persisted.results?.length, 1);
		assert.equal(persisted.results?.[0]?.success, false);
		assert.match(persisted.results?.[0]?.output ?? "", /workflow usageBudget does not support async runs\.run launches/);
		assert.equal(mockPi.callCount(), 0);
		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("honors an omitted agent async default while awaiting the workflow child result", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "default async child done" });
		const executor = makeExecutor([makeAgent("echo", { defaultAsync: true })], {}, false);
		const result = await executor.execute(
			`scripted-workflow-agent-async-default-${Date.now()}`,
			{ workflowScript: `return await runs.run("background", { agent: "echo", task: "Async child" });`, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const child = result.details.workflow?.value as { ok?: boolean; output?: string; runId?: string } | undefined;
		assert.equal(child?.ok, true);
		assert.equal(child?.output, "default async child done");
		assert.ok(child?.runId);
		assert.equal(result.details.results[0]?.finalOutput, "default async child done");
		assert.equal(fs.existsSync(path.join(DIRS.async, child.runId)), true);
		fs.rmSync(path.join(DIRS.async, child.runId), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(path.join(DIRS.results, `${child.runId}.json`), { force: true });
	});

	it("keeps ordinary async workflow child results in the watcher-owned path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "async child done" });
		const executor = makeExecutor([makeAgent("echo")]);
		const result = await executor.execute(
			`scripted-workflow-async-child-${Date.now()}`,
			{ workflowScript: `return await runs.run("background", { agent: "echo", task: "Async child", async: true });`, async: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childRunId = (result.details.workflow?.value as { runId?: string } | undefined)?.runId;
		assert.ok(childRunId);
		const childDir = path.join(DIRS.async, childRunId);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		for (let attempt = 0; attempt < 200 && !fs.existsSync(childResultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(fs.existsSync(childResultPath), true);
		assert.equal(fs.existsSync(path.join(childDir, "workflow-result.json")), false);
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(childResultPath, { force: true });
	});

	it("applies an agent deadline to a workflow-launched async child", { skip: !createSubagentExecutor ? "executor not importable" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const executor = makeExecutor([makeAgent("slow", { defaultTimeoutMs: 150 })]);
		const result = await executor.execute(
			`scripted-workflow-async-child-timeout-${Date.now()}`,
			{
				workflowScript: `return await runs.run("background", { agent: "slow", task: "Wait", async: true });`,
				async: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childRunId = (result.details.workflow?.value as { runId?: string } | undefined)?.runId;
		assert.ok(childRunId, JSON.stringify(result.details.workflow?.value ?? result.content));
		const childDir = path.join(DIRS.async, childRunId);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		let persisted: { timeoutMs?: number; state?: string; results?: Array<{ timedOut?: boolean; error?: string }> } = {};
		for (let attempt = 0; attempt < 200; attempt++) {
			if (fs.existsSync(childResultPath)) persisted = JSON.parse(fs.readFileSync(childResultPath, "utf-8"));
			if (persisted.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(persisted.timeoutMs, 150);
		assert.equal(persisted.state, "failed");
		assert.deepEqual(persisted.results?.map((entry) => entry.timedOut), [true]);
		assert.deepEqual(persisted.results?.map((entry) => entry.error), ["Subagent timed out after 150ms."]);
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(childResultPath, { force: true });
	});

	it("persists workflow parent metadata in an async worktree child status and result", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "async child done", writeFiles: [{ path: "feature.txt", content: "feature\n" }] });
		const executor = makeExecutor([makeAgent("echo")]);
		const toolCallId = `scripted-workflow-parent-${Date.now()}`;
		const started = await executor.execute(
			toolCallId,
			{ workflowScript: `const child = await runs.run("background", { agent: "echo", task: "Async child", async: true, worktree: true, lane: { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] } }); return child.runId;` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(started.details.asyncId);
		const workflowRunId = started.details.asyncId;
		const workflowResultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let childRunId: string | undefined;
		for (let attempt = 0; attempt < 150; attempt++) {
			if (fs.existsSync(workflowResultPath)) {
				const workflowResult = JSON.parse(fs.readFileSync(workflowResultPath, "utf-8")) as { workflow?: { value?: unknown } };
				if (typeof workflowResult.workflow?.value === "string") { childRunId = workflowResult.workflow.value; break; }
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.ok(childRunId);
		const workflowStatus = JSON.parse(fs.readFileSync(path.join(started.details.asyncDir!, "status.json"), "utf-8")) as AsyncStatus;
		const workflowStepSessionFile = workflowStatus.steps?.[0]?.sessionFile ?? "";
		assert.equal(workflowStatus.steps?.[0]?.agent, "echo");
		assert.deepEqual(workflowStatus.steps?.[0]?.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.match(workflowStepSessionFile, /session\.jsonl$/);
		const childDir = path.join(DIRS.async, childRunId);
		const childStatusPath = path.join(childDir, "status.json");
		let childStatus: { state?: string; mode?: string; parentWorkflowRunId?: string; workflowKey?: string; lane?: { key: string; mode?: string; sourceRef?: string; claims?: string[] }; steps?: Array<{ lane?: { key: string }; worktreePath?: string; branch?: string }>; parallelHandoff?: { path?: string; changedPatches?: number } } = {};
		for (let attempt = 0; attempt < 200; attempt++) {
			if (fs.existsSync(childStatusPath)) childStatus = JSON.parse(fs.readFileSync(childStatusPath, "utf-8"));
			if (["complete", "failed", "stopped"].includes(childStatus.state ?? "")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(childStatus.mode, "single");
		assert.equal(childStatus.parentWorkflowRunId, workflowRunId);
		assert.equal(childStatus.workflowKey, "background");
		assert.deepEqual(childStatus.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.deepEqual(childStatus.steps?.[0]?.lane, childStatus.lane);
		assert.equal(typeof childStatus.steps?.[0]?.worktreePath, "string");
		assert.equal(typeof childStatus.steps?.[0]?.branch, "string");
		assert.equal(typeof childStatus.parallelHandoff?.path, "string");
		assert.equal(childStatus.parallelHandoff?.changedPatches, 1);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
		const handoff = JSON.parse(fs.readFileSync(childStatus.parallelHandoff!.path!, "utf-8")) as { groups?: Array<{ children?: Array<{ workflowKey?: string; runId?: string; lane?: { key: string }; patch?: { changed?: boolean; filesChanged?: number } }>; cleanup?: { state?: string; tasks?: Array<{ path?: string; preserved?: boolean; worktreeRemoved?: boolean; reason?: string }> } }> };
		assert.equal(handoff.groups?.[0]?.children?.[0]?.workflowKey, "background");
		assert.equal(handoff.groups?.[0]?.children?.[0]?.runId, childRunId);
		assert.equal(handoff.groups?.[0]?.children?.[0]?.lane?.key, "background");
		assert.equal(handoff.groups?.[0]?.children?.[0]?.patch?.changed, true);
		assert.equal(handoff.groups?.[0]?.children?.[0]?.patch?.filesChanged, 1);
		assert.equal(handoff.groups?.[0]?.cleanup?.state, "partial");
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.preserved, true);
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.worktreeRemoved, false);
		assert.equal(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.reason, "retained child resume requires managed worktree cwd");
		assert.equal(fs.existsSync(handoff.groups?.[0]?.cleanup?.tasks?.[0]?.path ?? ""), true);
		const childResultPath = path.join(DIRS.results, `${childRunId}.json`);
		for (let attempt = 0; attempt < 200 && !fs.existsSync(childResultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const childResult = JSON.parse(fs.readFileSync(childResultPath, "utf-8")) as { parentWorkflowRunId?: string; workflowKey?: string };
		assert.equal(childResult.parentWorkflowRunId, workflowRunId);
		assert.equal(childResult.workflowKey, "background");
		const workflowReceipt = JSON.parse(fs.readFileSync(path.join(started.details.asyncDir!, "workflow-receipt.json"), "utf-8")) as { entries?: Record<string, { lane?: { key: string; mode?: string } }> };
		assert.deepEqual(workflowReceipt.entries?.background?.lane, { version: 1, key: "background", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature.txt"] });
		assert.equal(fs.existsSync(workflowStepSessionFile), true);
		const retainedCwd = handoff.groups?.[0]?.cleanup?.tasks?.[0]?.path;
		assert.ok(retainedCwd);
		const resumeTarget = resolveAsyncResumeTarget({ id: childRunId }, { asyncDirRoot: DIRS.async, resultsDir: DIRS.results });
		assert.equal(resumeTarget.recoveryDescriptor?.sourceRunId, childRunId);
		assert.equal(path.resolve(resumeTarget.cwd ?? ""), path.resolve(retainedCwd));
		discardPreservedWorktrees(childStatus.parallelHandoff!.path!, { kind: "confirmed" });
		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(workflowResultPath, { force: true });
		fs.rmSync(childDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(path.join(DIRS.results, `${childRunId}.json`), { force: true });
	});

	it("stops a live async workflow through its controller", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const controller = new AbortController();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), new Map([["workflow-stop", controller]]));
		const result = await executor.execute(
			"stop-call",
			{ action: "stop", id: "workflow-stop" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(result.isError, undefined);
		assert.equal(controller.signal.aborted, true);
		assert.equal(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason), "Workflow stopped.");
		assert.match(result.content[0]?.text ?? "", /Stop requested for async workflow workflow-stop/);
	});

	it("persists parent-stopped workflow children as stopped instead of failed", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const workflowControllers = new Map<string, AbortController>();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, new Map(), workflowControllers);
		const started = await executor.execute(
			`workflow-stop-child-${Date.now()}`,
			{ workflowScript: `return await runs.run("review", { agent: "echo", task: "Wait" });` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.ok(started.details.asyncId);
		const workflowRunId = started.details.asyncId;
		const statusPath = path.join(started.details.asyncDir!, "status.json");
		for (let attempt = 0; attempt < 100; attempt++) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (status.steps?.some((step) => step.workflowKey === "review" && step.status === "running")) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		for (let attempt = 0; attempt < 100 && mockPi.sessions[0]?.task === undefined; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(mockPi.sessions.length, 1);

		const stopped = await executor.execute(
			"stop-workflow-child",
			{ action: "stop", id: workflowRunId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(stopped.isError, undefined);

		let status: AsyncStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		for (let attempt = 0; attempt < 100 && status.state !== "stopped"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
		}
		assert.equal(status.state, "stopped");
		assert.equal(status.error, "Workflow stopped.");
		assert.equal(status.steps?.[0]?.status, "stopped");
		assert.equal(status.steps?.[0]?.stopped, true);
		assert.equal(status.steps?.[0]?.error, "Workflow stopped.");
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "review" && entry.state === "stopped"), true);
		assert.equal(status.workflow?.trace.some((entry) => entry.key === "review" && entry.state === "failed"), false);

		let childSettled = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			if (mockPi.sessions[0]?.aborted && mockPi.sessions[0]?.disposed) {
				childSettled = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(childSettled, true, "child session must be aborted and disposed after the workflow stop");
		await new Promise((resolve) => setTimeout(resolve, 50));
		status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		assert.equal(status.steps?.[0]?.status, "stopped");
		assert.equal(status.steps?.[0]?.stopped, true);
		assert.equal(status.steps?.[0]?.error, "Workflow stopped.");

		fs.rmSync(started.details.asyncDir!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(path.join(DIRS.results, `${workflowRunId}.json`), { force: true });
	});

	it("stops one live async workflow child without stopping the parent or sibling", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Slow child", delay: 5_000, output: "slow late" });
		mockPi.onCall({ matchArgIncludes: "Fast child", delay: 250, output: "fast done" });
		const asyncJobs: SubagentState["asyncJobs"] = new Map();
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);
		const started = await executor.execute(
			`workflow-child-stop-${Date.now()}`,
			{
				workflowScript: `
					const results = await runs.all([
						{ key: "slow", agent: "echo", task: "Slow child" },
						{ key: "fast", agent: "echo", task: "Fast child" }
					]);
					return results.map((result) => result.key + ":" + (result.stopped ? "stopped" : result.ok ? "ok" : "failed")).join(",");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncDir);
		const workflowRunId = started.details.asyncId!;
		const statusPath = path.join(started.details.asyncDir, "status.json");
		const resultPath = path.join(DIRS.results, `${workflowRunId}.json`);
		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && !status.steps?.some((step) => step.workflowKey === "slow" && step.status === "running"); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		const listed = listAsyncRuns(DIRS.async, { sessionId: "session-123", runId: workflowRunId, exactRunId: true })
			.find((run) => run.id === workflowRunId);
		assert.equal(listed?.steps?.find((step) => step.workflowKey === "slow")?.childId, "slow");

		const stop = await executor.execute(
			"stop-workflow-child-only",
			{ action: "stop", id: workflowRunId, childId: "slow" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.equal(stop.isError, undefined, stop.content[0]?.text ?? "");
		assert.match(stop.content[0]?.text ?? "", /Stop requested for child slow/);

		for (let attempt = 0; attempt < 150 && status.state !== "complete"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		assert.equal(status.state, "complete", status.error);
		assert.equal(status.stopped, undefined);
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.status, "stopped");
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.stopped, true);
		assert.equal(status.steps?.find((step) => step.workflowKey === "slow")?.error, "Workflow child 'slow' stopped.");
		assert.equal(status.steps?.find((step) => step.workflowKey === "fast")?.status, "completed");
		assert.equal(status.steps?.find((step) => step.workflowKey === "fast")?.stopped, undefined);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string; stopped?: boolean; results?: Array<{ workflowKey?: string; success?: boolean; stopped?: boolean }> };
		assert.equal(payload.state, "complete");
		assert.equal(payload.stopped, undefined);
		assert.equal(payload.results?.find((entry) => entry.workflowKey === "slow")?.stopped, true);
		assert.equal(payload.results?.find((entry) => entry.workflowKey === "fast")?.success, true);
		const childStatusEvents = fs.readFileSync(path.join(started.details.asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; childId?: string; status?: string; reason?: string });
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "slow" && event.status === "stopping"));
		const stoppedChildStatus = childStatusEvents.findLast((event) => event.type === "subagent.child-status" && event.childId === "slow" && event.status === "stopped");
		assert.equal(stoppedChildStatus?.reason, "subagent-action");
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		fs.rmSync(resultPath, { force: true });
	});

	it("reports completed async workflows as not running when stopped after completion", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const runId = `workflow-stop-complete-${Date.now()}`;
		const asyncDir = path.join(DIRS.async, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId,
			sessionId: "session-123",
			mode: "workflow",
			state: "complete",
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			cwd: tempDir,
			pid: process.pid,
		}), "utf-8");
		const asyncJobs: SubagentState["asyncJobs"] = new Map([[runId, {
			asyncId: runId,
			asyncDir,
			cwd: tempDir,
			status: "complete",
			mode: "workflow",
			agents: [],
			steps: [],
			startedAt: Date.now(),
			updatedAt: Date.now(),
		}]]);
		const executor = makeExecutor([makeAgent("echo")], {}, false, undefined, true, asyncJobs);

		const result = await executor.execute(
			"stop-completed-workflow",
			{ action: "stop", id: runId },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /No running or queued async run was found/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /reload recovery/);
		fs.rmSync(asyncDir, { recursive: true, force: true });
	});

	it("keeps a git worktree clean while routing workflow children through one automatic mission", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(projectDir);
		execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: projectDir });
		fs.writeFileSync(path.join(projectDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: projectDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: projectDir, stdio: "ignore" });
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndex: false } });
			const result = await executor.execute(
				"scripted-workflow",
				{
					async: false,
					workflowScript: `
						const stateType = typeof state;
						const scan = await runs.run("scan", { agent: "echo", task: "Scan auth" });
						const review = await runs.run("review", { agent: "echo", task: "Review: " + scan.output });
						return { output: review.output, stateType };
					`,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /reviewed auth/);
			assert.equal(result.details.mode, "workflow");
			assert.equal(result.details.results.length, 2);
			assert.deepEqual(result.details.results.map((entry) => entry.workflowKey), ["scan", "review"]);
			assert.equal(result.details.workflow?.value && (result.details.workflow.value as { stateType?: unknown }).stateType, "object");
			assert.ok(result.details.missionId);
			const missionFiles = fs.readdirSync(path.join(agentDir, "missions", "projects"), { recursive: true })
				.filter((entry) => typeof entry === "string" && entry.endsWith(".json"));
			assert.equal(missionFiles.length, 1);
			const mission = JSON.parse(fs.readFileSync(path.join(agentDir, "missions", "projects", missionFiles[0]!), "utf-8")) as { objective?: string };
			assert.equal(mission.objective, utils.PROMPT_REDACTED);
			assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state === "completed").map((entry) => entry.key), ["scan", "review"]);
			assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf-8" }), "");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("keeps workflow children mission-detached when automatic mission persistence fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "scanned auth" });
		mockPi.onCall({ output: "reviewed auth" });
		const blockedIndex = path.join(tempDir, "blocked-mission-index");
		fs.writeFileSync(blockedIndex, "not a directory", "utf-8");
		const executor = makeExecutor([makeAgent("echo")], { missions: { directory: ".pi/subagents/missions", globalIndexDir: blockedIndex } });

		const result = await executor.execute(
			"scripted-workflow-mission-warning",
			{
				async: false,
				workflowScript: `
					const scan = await runs.run("scan", { agent: "echo", task: "Scan auth" });
					const review = await runs.run("review", { agent: "echo", task: "Review: " + scan.output });
					return review.output;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details.missionId, undefined);
		assert.match(result.details.missionWarning ?? "", /Mission tracking unavailable/);
		assert.equal(result.details.results.length, 2);
		const missionDir = path.join(tempDir, ".pi/subagents", "missions");
		const missionFiles = fs.existsSync(missionDir) ? fs.readdirSync(missionDir).filter((entry) => entry.endsWith(".json")) : [];
		assert.equal(missionFiles.length, 1);
	});

	it("shares durable workflow state across a mission and omits it for mission:false", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const projectDir = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(projectDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const executor = makeExecutor([makeAgent("echo")], { missions: { globalIndex: false } });
			const first = await executor.execute(
				"mission-state-first",
				{
					async: false,
					mission: { title: "Stateful workflow" },
					workflowScript: `await state.set("review.stage", { count: 1 }); return await state.get("review.stage");`,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);
			assert.equal(first.isError, undefined, first.content[0]?.text ?? "first workflow failed");
			assert.ok(first.details.missionId);
			assert.deepEqual(first.details.workflow?.value, { count: 1 });
			const location = resolveMissionStoreLocation({ projectRoot: projectDir, agentDir });
			const statePath = missionStatePath(location, first.details.missionId);
			assert.equal(fs.existsSync(statePath), true);
			assert.equal(path.relative(projectDir, statePath).startsWith(".."), true);

			const second = await executor.execute(
				"mission-state-second",
				{ async: false, missionId: first.details.missionId, workflowScript: `return await state.get("review.stage");` },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);
			assert.equal(second.isError, undefined, second.content[0]?.text ?? "second workflow failed");
			assert.deepEqual(second.details.workflow?.value, { count: 1 });

			const ephemeral = await executor.execute(
				"mission-state-off",
				{ async: false, mission: false, workflowScript: `return typeof state;` },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(projectDir),
			);
			assert.equal(ephemeral.isError, undefined, ephemeral.content[0]?.text ?? "ephemeral workflow failed");
			assert.equal(ephemeral.details.workflow?.value, "undefined");
			assert.equal(ephemeral.details.missionId, undefined);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("runs a direct single child in a managed worktree", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "isolated feature", writeFiles: [{ path: "feature.txt", content: "feature\n" }] });
		const executor = makeExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"direct-worktree",
			{ async: false, agent: "worker", task: "Implement feature", worktree: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "managed worktree child failed");
		assert.equal(mockPi.callCount(), 1);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
		const handoffPath = (result.content[0]?.text ?? "").match(/([^\s]+\/handoffs\/[^\s]+\.json)/)?.[1];
		assert.ok(handoffPath, result.content[0]?.text);
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				cleanup: { state: string; tasks: Array<{ worktreeRemoved: boolean }> };
			}>;
		};
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);

	});

	it("aligns a forked workflow child session with its managed worktree cwd", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });

		const parentSessionFile = path.join(mockPi.dir, "parent-session.jsonl");
		const childSessionFile = path.join(mockPi.dir, "forked-child-session.jsonl");
		fs.writeFileSync(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: tempDir })}\n`, "utf-8");
		const ctx = makeMinimalCtx(tempDir);
		Object.assign(ctx.sessionManager, {
			getSessionFile: () => parentSessionFile,
			getLeafId: () => "parent-leaf",
			openSession: () => ({
				createBranchedSession: () => {
					fs.writeFileSync(childSessionFile, `${JSON.stringify({ type: "session", version: 3, id: "child", cwd: tempDir })}\n`, "utf-8");
					return childSessionFile;
				},
			}),
		});
		mockPi.onCall({ output: "isolated fork child" });
		const executor = makeExecutor([makeAgent("worker", { defaultContext: "fork" })]);

		const result = await executor.execute(
			"forked-worktree-workflow",
			{ async: false, workflowScript: `return runs.run("isolated", { agent: "worker", task: "Work in isolation", worktree: true });` },
			new AbortController().signal,
			undefined,
			ctx,
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const workflowValue = result.details.workflow?.value as { artifactPaths?: string[] } | undefined;
		const handoffPath = workflowValue?.artifactPaths?.find((candidate) => candidate.endsWith(".json") && candidate.includes("handoffs"));
		assert.ok(handoffPath, JSON.stringify(workflowValue));
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{ cleanup: { tasks: Array<{ path: string }> } }>;
		};
		const managedWorktreeCwd = handoff.groups[0]?.cleanup.tasks[0]?.path;
		assert.ok(managedWorktreeCwd);
		const callCwd = readCall().cwd;
		assert.ok(callCwd);
		assert.notEqual(path.resolve(callCwd), path.resolve(tempDir));
		assert.equal(path.basename(callCwd), path.basename(managedWorktreeCwd));
		const sessionHeader = JSON.parse(fs.readFileSync(childSessionFile, "utf-8").split("\n", 1)[0]!) as { cwd?: string };
		assert.ok(sessionHeader.cwd);
		assert.equal(path.basename(sessionHeader.cwd), path.basename(callCwd));
	});

	it("rejects workflowScript implementation children under a read-only capability ceiling before spawn", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "completed without edits" });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"workflow-readonly-implementation-contract",
			{
				async: false,
				workflowScript: `return await runs.run("impl", { agent: "worker", task: "Implement the requested source fix" });`,
				capabilityCeiling: { version: 1, allowedTools: ["read", "grep", "find", "ls", "contact_supervisor"], denyExtensions: true, sources: ["test"] },
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /completed without making edits/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("stringifies workflow child results without object placeholders", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Monitor" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-stringified-child-results",
			{
				async: false,
				workflowScript: `
					const [review, monitor] = await runs.all([
						{ key: "review", agent: "echo", task: "Review" },
						{ key: "monitor", agent: "echo", task: "Monitor" }
					]);
					return "## Lane 1\\n" + review + "\\n\\n---\\n\\n## Lane 2\\n" + monitor;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined, text || "workflow failed");
		assert.doesNotMatch(text, /\[object Object\]/);
		assert.match(text, /## Lane 1\nfirst report/);
		assert.match(text, /## Lane 2\nsecond report/);
		assert.equal(result.details.workflow?.value, "## Lane 1\nfirst report\n\n---\n\n## Lane 2\nsecond report");
	});

	it("stringifies awaited workflow child results without object placeholders", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "single report", matchArgIncludes: "Review" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-stringified-single-child-result",
			{
				async: false,
				workflowScript: `
					const review = await runs.run("review", { agent: "echo", task: "Review" });
					return "## Lane\\n" + review;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined, text || "workflow failed");
		assert.doesNotMatch(text, /\[object Object\]/);
		assert.match(text, /## Lane\nsingle report/);
		assert.equal(result.details.workflow?.value, "## Lane\nsingle report");
	});

	it("derives workflow child output paths from the workflow output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Monitor" });
		const executor = makeExecutor([makeAgent("echo")]);
		const workflowOutput = path.join(tempDir, "workflow-report.md");

		const result = await executor.execute(
			"scripted-workflow-child-output-defaults",
			{
				async: false,
				output: workflowOutput,
				workflowScript: `
					const children = await runs.all([
						{ key: "review", agent: "echo", task: "Review" },
						{ key: "monitor", agent: "echo", task: "Monitor" }
					]);
					return children.map(({ key, artifactPaths }) => ({ key, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), /Workflow completed\./);
		const value = result.details.workflow?.value as Array<{ key: string; artifactPaths: string[] }>;
		const childOutputs = value.map((child) => child.artifactPaths.find((candidate) => candidate.endsWith(".md")) ?? "").sort();
		assert.deepEqual(childOutputs, [
			path.join(tempDir, "workflow-report.monitor.md"),
			path.join(tempDir, "workflow-report.review.md"),
		]);
		assert.equal(fs.readFileSync(path.join(tempDir, "workflow-report.review.md"), "utf-8"), "first report");
		assert.equal(fs.readFileSync(path.join(tempDir, "workflow-report.monitor.md"), "utf-8"), "second report");
	});

	it("keys concurrent workflow children under distinct run-id session roots for an explicit sessionDir", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child" });
		mockPi.onCall({ output: "second child" });
		const sessionDir = path.join(tempDir, "fanout-sessions");
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"workflow-session-dir-fanout",
			{
				async: false,
				sessionDir,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First" },
						{ key: "second", agent: "echo", task: "Second" }
					]);
					return children.map(({ key }) => key);
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const sessionArgs = readAllCallArgs(true)
			.map((args) => {
				const index = args.indexOf("--session");
				return index >= 0 ? args[index + 1] : undefined;
			})
			.filter((value): value is string => value !== undefined);
		assert.equal(sessionArgs.length, 2, `expected two --session child args, got ${JSON.stringify(sessionArgs)}`);
		const [firstSession, secondSession] = sessionArgs;
		assert.notEqual(firstSession, secondSession);
		for (const sessionFile of sessionArgs) {
			const relative = path.relative(sessionDir, sessionFile);
			const segments = relative.split(path.sep);
			assert.match(segments[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			assert.deepEqual(segments.slice(1), ["run-0", "session.jsonl"]);
		}
		const runIdDirs = fs.readdirSync(sessionDir).sort();
		assert.equal(runIdDirs.length, 2);
		for (const runIdDir of runIdDirs) {
			assert.deepEqual(fs.readdirSync(path.join(sessionDir, runIdDir)), ["run-0"]);
		}
	});

	it("maps a task-requested report path to the workflow-saved child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report" });
		const requestedReport = path.join(tempDir, "requested-review.md");
		const workflowOutput = path.join(tempDir, "workflow-report.md");
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"scripted-workflow-requested-output-mapping",
			{
				async: false,
				output: workflowOutput,
				workflowScript: `return await runs.run("review", { agent: "echo", task: ${JSON.stringify(`Review the change.\n\nWrite your findings to exactly this path: ${requestedReport}`)} });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const savedReport = path.join(tempDir, "workflow-report.review.md");
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(requestedReport), false);
		assert.equal(fs.readFileSync(savedReport, "utf-8"), "review report");
		assert.deepEqual((result.details.workflow?.value as { outputPathMapping?: unknown }).outputPathMapping, {
			requestedPath: requestedReport,
			savedPath: savedReport,
		});
		assert.match(result.content[0]?.text ?? "", new RegExp(`Output path mappings: 'review': requested ${escapeRegExp(requestedReport)} -> saved ${escapeRegExp(savedReport)}`));
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), /Output path mappings:/);
	});

	it("preserves output path mappings when an async workflow fails after a completed child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review first" });
		mockPi.onCall({ exitCode: 1, stderr: "later child failure", matchArgIncludes: "Fail later" });
		const requestedReport = path.join(tempDir, "requested-review.md");
		const workflowOutput = path.join(tempDir, "failed-workflow.md");
		const started = await makeExecutor([makeAgent("echo")]).execute(
			"async-workflow-failed-output-mapping",
			{
				async: true,
				output: workflowOutput,
				workflowScript: `
					await runs.run("review", { agent: "echo", task: ${JSON.stringify(`Review first.\n\nWrite your findings to exactly this path: ${requestedReport}`)} });
					await runs.run("fails", { agent: "echo", task: "Fail later" });
					throw new Error("later workflow failure");
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(started.isError, undefined);
		assert.ok(started.details.asyncId);
		assert.ok(started.details.asyncDir);
		const resultPath = path.join(DIRS.results, `${started.details.asyncId}.json`);
		for (let attempt = 0; attempt < 150 && !fs.existsSync(resultPath); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const persisted = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { state?: string; summary?: string; results?: Array<{ workflowKey?: string; outputReference?: string; output?: string }> };
		const savedReport = path.join(tempDir, "failed-workflow.review.md");
		const expectedMapping = `Output path mappings: 'review': requested ${requestedReport} -> saved ${savedReport}`;
		assert.equal(persisted.state, "failed");
		assert.equal(persisted.results?.[0]?.workflowKey, "review");
		assert.equal(persisted.results?.[0]?.outputReference, savedReport);
		assert.equal(persisted.results?.[0]?.output, "review report");
		assert.match(persisted.summary ?? "", new RegExp(escapeRegExp(expectedMapping)));
		assert.match(fs.readFileSync(workflowOutput, "utf-8"), new RegExp(escapeRegExp(expectedMapping)));
		assert.equal(fs.readFileSync(savedReport, "utf-8"), "review report");

		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

	it("uses child-cwd agent output defaults for omitted workflow child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "app report" });
		const appDir = path.join(tempDir, "packages", "app");
		fs.mkdirSync(appDir, { recursive: true });
		const rootAgents = [makeAgent("echo", { output: "root-report.md" })];
		const appAgents = [makeAgent("echo", { output: "app-report.md" })];
		const executor = makeExecutor(rootAgents, {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), (cwd) => path.resolve(cwd) === path.resolve(appDir) ? appAgents : rootAgents);

		const result = await executor.execute(
			"scripted-workflow-child-cwd-omitted-output-default",
			{
				async: false,
				workflowScript: `return await runs.run("app", { agent: "echo", task: "Review app", cwd: "packages/app" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(appDir, "app-report.md")), false);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-child-cwd-omitted-output-default"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "app-report.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "app report");
		assert.equal(fs.existsSync(path.join(tempDir, "root-report.md")), false);
	});

	it("uses child-cwd agent output defaults for workflow output true", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "app report" });
		const appDir = path.join(tempDir, "packages", "app");
		fs.mkdirSync(appDir, { recursive: true });
		const rootAgents = [makeAgent("echo", { output: "root-report.md" })];
		const appAgents = [makeAgent("echo", { output: "app-report.md" })];
		const executor = makeExecutor(rootAgents, {}, false, undefined, true, new Map(), undefined, undefined, createEventBus(), (cwd) => path.resolve(cwd) === path.resolve(appDir) ? appAgents : rootAgents);

		const result = await executor.execute(
			"scripted-workflow-child-cwd-output-default",
			{
				async: false,
				workflowScript: `return await runs.run("app", { agent: "echo", task: "Review app", cwd: "packages/app", output: true });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(appDir, "app-report.md")), false);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-child-cwd-output-default"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "app-report.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "app report");
		assert.equal(fs.existsSync(path.join(tempDir, "root-report.md")), false);
	});

	it("reports workflow aggregate output write failures without throwing", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const outputDir = path.join(tempDir, "aggregate-dir");
		fs.mkdirSync(outputDir);
		const result = await makeExecutor([makeAgent("echo")]).execute(
			"scripted-workflow-aggregate-output-write-error",
			{
				async: false,
				output: outputDir,
				workflowScript: `return "ok";`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /Workflow completed\./);
		assert.match(result.content[0]?.text ?? "", /Output file error:/);
		assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegExp(outputDir)));
	});

	it("routes workflow relative outputs to the run output artifact directory", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "child report" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-relative-output-base",
			{
				async: false,
				output: "workflow-summary.md",
				workflowScript: `return await runs.run("review", { agent: "echo", task: "Review", output: "plans/review.md" });`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(fs.existsSync(path.join(tempDir, "workflow-summary.md")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "plans", "review.md")), false);
		const workflowOutputPath = path.join(TEMP_ARTIFACTS_DIR, "outputs", "scripted-workflow-relative-output-base", "workflow-summary.md");
		assert.match(fs.readFileSync(workflowOutputPath, "utf-8"), /Workflow completed\./);
		assert.ok(result.details.results[0]?.savedOutputPath && pathContainsSegments(result.details.results[0].savedOutputPath, "artifacts", "outputs", "scripted-workflow-relative-output-base", "plans"));
		assert.equal(path.basename(result.details.results[0]?.savedOutputPath ?? ""), "review.md");
		assert.equal(fs.readFileSync(result.details.results[0]?.savedOutputPath ?? "", "utf-8"), "child report");
	});

	it("rejects workflow child output collisions before launch", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")]);
		const sharedOutput = path.join(tempDir, "shared.md");

		const duplicate = await executor.execute(
			"scripted-workflow-duplicate-child-output",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: ${JSON.stringify(sharedOutput)} },
					{ key: "monitor", agent: "echo", task: "Monitor", output: ${JSON.stringify(sharedOutput)} }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(duplicate.isError, undefined, duplicate.content[0]?.text ?? "workflow failed");
		const duplicateChildren = duplicate.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(duplicateChildren.map(({ ok }) => ok), [false, false]);
		for (const child of duplicateChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(escapeRegExp(sharedOutput)));
		}
		assert.equal(mockPi.callCount(), 0);

		const relativeDuplicateOutput = "relative-shared.md";
		const relativeDuplicate = await executor.execute(
			"scripted-workflow-relative-duplicate-child-output",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: ${JSON.stringify(relativeDuplicateOutput)} },
					{ key: "monitor", agent: "echo", task: "Monitor", output: ${JSON.stringify(relativeDuplicateOutput)} }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(relativeDuplicate.isError, undefined, relativeDuplicate.content[0]?.text ?? "workflow failed");
		const relativeDuplicateChildren = relativeDuplicate.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(relativeDuplicateChildren.map(({ ok }) => ok), [false, false]);
		for (const child of relativeDuplicateChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(`${escapeRegExp(TEMP_ARTIFACTS_DIR)}.*outputs.*${escapeRegExp(relativeDuplicateOutput)}`));
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("isolates colliding inherited agent-default outputs for parallel workflow children", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review" });
		mockPi.onCall({ output: "monitor report", matchArgIncludes: "Monitor" });
		const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
			"scripted-workflow-parallel-inherited-output-collision",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review" },
					{ key: "monitor", agent: "echo", task: "Monitor" }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
		const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "").sort();
		assert.equal(outputPaths.length, 2);
		assert.notEqual(outputPaths[0], outputPaths[1]);
		assert.ok(pathContainsSegments(outputPaths[0]!, "artifacts", "outputs"));
		assert.ok(pathContainsSegments(outputPaths[1]!, "artifacts", "outputs"));
		assert.match(path.basename(outputPaths[0]!), /^(monitor|review)\.md$/);
		assert.match(path.basename(outputPaths[1]!), /^(monitor|review)\.md$/);
		assert.deepEqual(outputPaths.map((outputPath) => fs.readFileSync(outputPath, "utf-8")).sort(), ["monitor report", "review report"]);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
	});

	it("isolates inherited outputs that collide with a resumed child output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const retainedRunId = `retained-output-${Date.now()}`;
		const retainedAsyncDir = path.join(DIRS.async, retainedRunId);
		const retainedSessionFile = path.join(tempDir, "retained-session.jsonl");
		const retainedOutputPath = path.join(tempDir, "context.md");
		const runFanoutBudget = createRunFanoutBudget(retainedRunId, 10);
		fs.mkdirSync(retainedAsyncDir, { recursive: true });
		fs.writeFileSync(retainedSessionFile, "{}\n", "utf-8");
		fs.writeFileSync(path.join(retainedAsyncDir, "status.json"), JSON.stringify({
			runId: retainedRunId,
			sessionId: "session-123",
			state: "failed",
			cwd: tempDir,
			sessionFile: retainedSessionFile,
			steps: [
				{ agent: "echo", status: "failed", sessionFile: retainedSessionFile },
				{ agent: "echo", status: "failed", sessionFile: retainedSessionFile },
			],
		}), "utf-8");
		fs.writeFileSync(path.join(retainedAsyncDir, "recovery-descriptor.json"), JSON.stringify({
			version: 1,
			runFanoutBudget,
			sourceRunId: retainedRunId,
			agent: "echo",
			cwd: tempDir,
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: true,
			outputPath: retainedOutputPath,
			outputMode: "inline",
			maxSubagentDepth: 1,
			share: false,
		}), "utf-8");
		mockPi.onCall({ output: "resumed report", matchArgIncludes: "Resume" });
		mockPi.onCall({ output: "review report", matchArgIncludes: "Review" });

		try {
			const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
				"scripted-workflow-resumed-inherited-output-collision",
				{
					async: false,
					workflowScript: `return await runs.all([
						{ key: "resume", resume: ${JSON.stringify(retainedRunId)}, index: 1, task: "Resume" },
						{ key: "review", agent: "echo", task: "Review" }
					]);`,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
			const children = result.details.workflow?.value as Array<{ ok: boolean }>;
			assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
			assert.equal(fs.readFileSync(retainedOutputPath, "utf-8"), "resumed report");
			const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "");
			const inheritedOutputPaths = outputPaths.filter((outputPath) => outputPath && outputPath !== retainedOutputPath).sort();
			assert.deepEqual(inheritedOutputPaths.map((outputPath) => path.basename(outputPath)), ["context.md"]);
			assert.ok(inheritedOutputPaths.every((outputPath) => pathContainsSegments(outputPath, "artifacts", "outputs")));
		} finally {
			fs.rmSync(retainedAsyncDir, { recursive: true, force: true });
			fs.rmSync(runFanoutBudget.directory, { recursive: true, force: true });
		}
	});

	it("reroutes a later inherited agent-default output collision", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report", matchArgIncludes: "First" });
		mockPi.onCall({ output: "second report", matchArgIncludes: "Second" });
		const result = await makeExecutor([makeAgent("echo", { output: "context.md" })]).execute(
			"scripted-workflow-sequential-inherited-output-collision",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("first", { agent: "echo", task: "First" });
					const second = await runs.run("second", { agent: "echo", task: "Second" });
					return [first, second];
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, true]);
		assert.equal(fs.existsSync(path.join(tempDir, "context.md")), false);
		const outputPaths = result.details.results.map(({ savedOutputPath }) => savedOutputPath ?? "");
		assert.ok(pathContainsSegments(outputPaths[0]!, "artifacts", "outputs"));
		assert.equal(path.basename(outputPaths[0]!), "context.md");
		assert.equal(fs.readFileSync(outputPaths[0]!, "utf-8"), "first report");
		assert.ok(pathContainsSegments(outputPaths[1]!, "artifacts", "outputs"));
		assert.equal(path.basename(outputPaths[1]!), "second.md");
		assert.equal(fs.readFileSync(outputPaths[1]!, "utf-8"), "second report");
	});

	it("preserves a rejected file-only child report when its path matches workflow output", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const usefulReport = "# Review findings\n\nThe implementation loses the final report.";
		const sharedOutput = path.join(tempDir, "review.md");
		mockPi.onCall({ stdoutRaw: `${JSON.stringify(events.assistantMessage(usefulReport))}\n` });
		const executor = makeExecutor([makeAgent("reviewer", { tools: ["read"], completionGuard: false })]);

		const result = await executor.execute(
			"scripted-workflow-file-only-acceptance-collision",
			{
				async: false,
				output: sharedOutput,
				workflowScript: `
					const child = await runs.run("review", {
						agent: "reviewer",
						task: "Write a structured review report.",
						output: ${JSON.stringify(sharedOutput)},
						outputMode: "file-only",
						acceptance: { level: "checked", criteria: ["Return the structured review report"] }
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(escapeRegExp(sharedOutput)));
		assert.equal(result.details.results[0]?.acceptance?.status, "rejected");
		assert.match(result.details.results[0]?.acceptance?.runtimeChecks[0]?.message ?? "", /Structured acceptance report not found/);
		assert.equal(result.details.results[0]?.savedOutputPath, sharedOutput);
		assert.deepEqual(fs.readFileSync(sharedOutput), Buffer.from(usefulReport));
	});

	it("continues to a read-only review after malformed file-only acceptance metadata", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const sharedOutput = path.join(tempDir, "implementation-report.md");
		const malformed = `ACCEPTANCE_REPORT: ${JSON.stringify({ criteriaSatisfied: true, commandsRun: ["npm test"] })}`;
		mockPi.onCall({
			output: "Implementation report persisted.",
			matchArgIncludes: "Write implementation report",
			jsonl: [...events.completedWrite(sharedOutput, malformed), events.assistantMessage("Implementation report persisted.")],
			writeFiles: [{ path: sharedOutput, content: malformed }],
		});
		mockPi.onCall({ output: "Read-only review completed.", matchArgIncludes: "Review the persisted implementation report without editing it" });
		const executor = makeExecutor([
			makeAgent("worker", { tools: ["read", "write"], completionGuard: false }),
			makeAgent("reviewer", { tools: ["read"], completionGuard: false }),
		]);

		const result = await executor.execute(
			"scripted-workflow-malformed-acceptance-recovery",
			{
				async: false,
				workflowScript: `
					const writer = await runs.run("writer", {
						agent: "worker",
						task: "Write implementation report",
						output: ${JSON.stringify(sharedOutput)},
						outputMode: "file-only",
						acceptance: { level: "checked", criteria: ["Return the implementation report"] }
					});
					const review = await runs.run("review", {
						agent: "reviewer",
						task: "Review the persisted implementation report without editing it",
						acceptance: false
					});
					return { writerOk: writer.ok, writerRecovery: writer.recovery, reviewOk: review.ok };
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const value = result.details.workflow?.value as { writerOk?: boolean; writerRecovery?: { status?: string; reason?: string; reportPath?: string; reportHash?: string }; reviewOk?: boolean };
		assert.equal(value.writerOk, false);
		assert.equal(value.writerRecovery?.status, "available-for-review");
		assert.equal(value.writerRecovery?.reason, "acceptance-metadata-rejected");
		assert.equal(value.writerRecovery?.reportPath, sharedOutput);
		assert.match(value.writerRecovery?.reportHash ?? "", /^[0-9a-f]{64}$/);
		assert.equal(value.reviewOk, true);
		assert.equal(result.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(result.details.results[0]?.outputReference?.path, sharedOutput);
		assert.equal(result.details.results[0]?.savedOutputPath, sharedOutput);
		assert.equal(result.details.workflowChildren?.children.find((child) => child.childId === "writer")?.state, "rejected");
		assert.deepEqual(fs.readFileSync(sharedOutput, "utf-8"), malformed);
	});

	it("identifies validation failures before any workflow child launches", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("worker")]);
		const workflowId = "scripted-workflow-invalid-nested-async";
		const result = await executor.execute(
			workflowId,
			{
				async: false,
				workflowScript: `const lane = async () => runs.run("writer", { agent: "worker", task: "write" }); return lane();`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", new RegExp(`Workflow '${workflowId}' validation failed before child launch; no children launched`));
		assert.match(result.content[0]?.text ?? "", /Parallel plus sequential rewrite/);
		assert.deepEqual(result.details.results, []);
	});

	it("replaces stale workflow output when a child claims its path but writes no report", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const sharedOutput = path.join(tempDir, "failed-review.md");
		fs.writeFileSync(sharedOutput, "stale workflow output", "utf-8");
		mockPi.onCall({ exitCode: 1, stderr: "review child failed before writing output" });
		const executor = makeExecutor([makeAgent("reviewer", { completionGuard: false })]);

		const result = await executor.execute(
			"scripted-workflow-missing-child-output-collision",
			{
				async: false,
				output: sharedOutput,
				workflowScript: `
					const child = await runs.run("review", {
						agent: "reviewer",
						task: "Write a review report.",
						output: ${JSON.stringify(sharedOutput)},
						outputMode: "file-only"
					});
					if (!child.ok) throw new Error(child.error);
					return child;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /review child failed before writing output/);
		const workflowOutput = fs.readFileSync(sharedOutput, "utf-8");
		assert.match(workflowOutput, /Workflow failed:.*review child failed before writing output/s);
		assert.doesNotMatch(workflowOutput, /stale workflow output/);
	});

	it("rejects sequential workflow child output collisions before launch", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first report" });
		const executor = makeExecutor([makeAgent("echo")]);
		const sharedOutput = path.join(tempDir, "sequential-shared.md");

		const result = await executor.execute(
			"scripted-workflow-sequential-output-collision",
			{
				async: false,
				workflowScript: `
					const first = await runs.run("review", { agent: "echo", task: "Review", output: ${JSON.stringify(sharedOutput)} });
					const second = await runs.run("monitor", { agent: "echo", task: "Monitor", output: ${JSON.stringify(sharedOutput)} })
						.catch((error) => ({ ok: false, error: error.message }));
					return [first, second];
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		const children = result.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(children.map(({ ok }) => ok), [true, false]);
		assert.match(children[1]?.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
		assert.match(children[1]?.error ?? "", new RegExp(escapeRegExp(sharedOutput)));
		assert.equal(mockPi.callCount(), 1);
	});

	it("checks workflow child output collisions against configured output base", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const configuredBase = path.join(tempDir, "configured-outputs");
		const workflowOutput = "shared.md";

		const resolvedSharedOutput = path.join(configuredBase, workflowOutput);
		const agentDefaultResult = await makeExecutor([makeAgent("echo", { output: workflowOutput })], { singleRunOutputBaseDir: configuredBase }).execute(
			"scripted-workflow-configured-agent-default-output-collision",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "review", agent: "echo", task: "Review", output: true },
					{ key: "monitor", agent: "echo", task: "Monitor", output: true }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(agentDefaultResult.isError, undefined, agentDefaultResult.content[0]?.text ?? "workflow failed");
		const agentDefaultChildren = agentDefaultResult.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(agentDefaultChildren.map(({ ok }) => ok), [false, false]);
		for (const child of agentDefaultChildren) {
			assert.match(child.error ?? "", /Workflow children 'review' and 'monitor' resolve output to the same path/);
			assert.match(child.error ?? "", new RegExp(escapeRegExp(resolvedSharedOutput)));
		}
		assert.equal(mockPi.callCount(), 0);
	});

	it("lets runs.all siblings settle when one child fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ exitCode: 1, stderr: "first child failed" });
		mockPi.onCall({ output: "second child completed" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-settlement",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					return children.map(({ key, ok, error }) => error === undefined ? { key, ok } : { key, ok, error });
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		const value = result.details.workflow?.value as Array<{ key: string; ok: boolean; error?: string }>;
		assert.deepEqual(value.map(({ key }) => key), ["first", "second"]);
		assert.deepEqual(value.map(({ ok }) => ok).sort(), [false, true]);
		const failed = value.find(({ ok }) => !ok);
		const succeeded = value.find(({ ok }) => ok);
		assert.match(failed?.error ?? "", /first child failed/);
		assert.equal(failed?.error?.match(/first child failed/g)?.length, 1);
		assert.equal(succeeded?.error, undefined);
		assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state !== "started").map(({ state }) => state).sort(), ["completed", "failed"]);
	});

	it("reports keyed runs.all result access after siblings settle", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child completed", matchArgIncludes: "First task" });
		mockPi.onCall({ output: "second child completed", matchArgIncludes: "Second task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-keyed-result-access",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					return children.first.output;
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 2);
		assert.match(result.content[0]?.text ?? "", /runs\.all resolves to an ordered array, not a key map/);
		assert.match(result.content[0]?.text ?? "", /Use results\[0\], array destructuring, or results\.map/);
		assert.deepEqual(result.details.workflow?.trace.filter((entry) => entry.state === "completed").map(({ key }) => key).sort(), ["first", "second"]);
	});

	it("keeps array access working when runs.all child keys collide with array properties", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "length child completed", matchArgIncludes: "Length task" });
		mockPi.onCall({ output: "map child completed", matchArgIncludes: "Map task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-colliding-key-access",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "length", agent: "echo", task: "Length task" },
						{ key: "map", agent: "echo", task: "Map task" }
					]);
					const [, second] = children;
					return {
						length: children.length,
						first: children[0].output,
						second: second.output,
						outputs: children.map((child) => child.output),
						children
					};
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		const value = result.details.workflow?.value as { length?: number; first?: string; second?: string; outputs?: string[]; children?: Array<{ key?: string; ok?: boolean; output?: string }> } | undefined;
		assert.equal(value?.length, 2);
		assert.equal(value?.first, "length child completed");
		assert.equal(value?.second, "map child completed");
		assert.deepEqual(value?.outputs, ["length child completed", "map child completed"]);
		assert.deepEqual(value?.children?.map(({ key, ok, output }) => ({ key, ok, output })), [
			{ key: "length", ok: true, output: "length child completed" },
			{ key: "map", ok: true, output: "map child completed" },
		]);
	});

	it("emits runs.all results as plain arrays", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child completed", matchArgIncludes: "First task" });
		mockPi.onCall({ output: "second child completed", matchArgIncludes: "Second task" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-runs-all-emitted-array",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "first", agent: "echo", task: "First task" },
						{ key: "second", agent: "echo", task: "Second task" }
					]);
					emit(children);
					return children.map((child) => child.output);
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual((result.details.workflow?.emits[0] as Array<{ key: string; output: string }>).map(({ key, output }) => ({ key, output })), [
			{ key: "first", output: "first child completed" },
			{ key: "second", output: "second child completed" },
		]);
		assert.deepEqual(result.details.workflow?.value, ["first child completed", "second child completed"]);
	});

	it("rejects an over-limit runs.all batch before launching any workflow child", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerRun: 1 });

		const result = await executor.execute(
			"scripted-workflow-fanout-limit",
			{
				async: false,
				workflowScript: `return await runs.all([
					{ key: "first", agent: "echo", task: "First task" },
					{ key: "second", agent: "echo", task: "Second task" }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 0);
		const children = result.details.workflow?.value as Array<{ ok: boolean; error?: string }>;
		assert.deepEqual(children.map(({ ok }) => ok), [false, false]);
		for (const child of children) assert.match(child.error ?? "", /workflow\[second\].*0\/1 used; 2 requested, 1 remaining/);
	});

	it("lets an explicit workflow spawn override exceed config", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "first child completed" });
		mockPi.onCall({ output: "second child completed" });
		const result = await makeExecutor([makeAgent("echo")], { maxSubagentSpawnsPerRun: 1 }).execute(
			"scripted-workflow-fanout-override",
			{
				async: false,
				maxSubagentSpawnsPerRun: 2,
				workflowScript: `return await runs.all([
					{ key: "first", agent: "echo", task: "First task" },
					{ key: "second", agent: "echo", task: "Second task" }
				]);`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
	});

	it("runs a direct child gate as host-verified acceptance", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const markerFile = "direct-gate.txt";
		const markerPath = path.join(tempDir, markerFile);
		mockPi.onCall({ output: [
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
		].join("\n") });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"direct-gate",
			{ async: false, agent: "echo", task: "Validate the result without edits", gate: `${process.execPath} -e "require('node:fs').writeFileSync('${markerFile}','verified')"` },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "direct gate failed");
		assert.equal(fs.readFileSync(markerPath, "utf-8"), "verified");
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns[0]?.id, "gate");
	});

	it("lets runs.all siblings settle when one verified gate fails", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const acceptedReport = [
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
		mockPi.onCall({ output: acceptedReport });
		mockPi.onCall({ output: acceptedReport });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"scripted-workflow-gates",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "fails-gate", agent: "echo", task: "First task", gate: ${JSON.stringify(`${process.execPath} -e "process.exit(7)"`)} },
						{ key: "passes-gate", agent: "echo", task: "Second task", gate: ${JSON.stringify(`${process.execPath} -e "process.exit(0)"`)} }
					]);
					return children.map(({ key, ok }) => ({ key, ok }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.workflow?.value, [
			{ key: "fails-gate", ok: false },
			{ key: "passes-gate", ok: true },
		]);
		const [failed, passed] = result.details.results;
		assert.equal(failed?.acceptance?.status, "rejected");
		assert.equal(failed?.acceptance?.verifyRuns[0]?.status, "failed");
		assert.equal(passed?.acceptance?.status, "verified");
		assert.equal(passed?.acceptance?.verifyRuns[0]?.status, "passed");
	});

	it("gives parallel workflow children separate managed worktrees and durable handoffs", { skip: !createSubagentExecutor || process.platform === "win32" ? "executor unavailable or worktree paths differ on Windows" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({ output: "feature a", writeFiles: [{ path: "feature-a.txt", content: "a\n" }] });
		mockPi.onCall({ output: "feature b", writeFiles: [{ path: "feature-b.txt", content: "b\n" }] });
		const executor = makeExecutor([makeAgent("worker")]);

		const result = await executor.execute(
			"scripted-workflow-worktrees",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "feature-a", agent: "worker", task: "Implement A", worktree: true, lane: { version: 1, key: "feature-a", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-a.txt"] } },
						{ key: "feature-b", agent: "worker", task: "Implement B", worktree: true, lane: { version: 1, key: "feature-b", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-b.txt"] } }
					]);
					return children.map(({ key, artifactPaths }) => ({ key, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

			assert.equal(result.isError, undefined);
			assert.equal(mockPi.callCount(), 2, result.content[0]?.text ?? "workflow produced no output");
			assert.deepEqual(result.details.workflow?.receipt?.entries["feature-a"]?.lane, { version: 1, key: "feature-a", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-a.txt"] });
			assert.deepEqual(result.details.workflow?.receipt?.entries["feature-b"]?.lane, { version: 1, key: "feature-b", mode: "mutation", sourceRef: "owner/repo#1621", claims: ["feature-b.txt"] });
		assert.equal(fs.existsSync(path.join(tempDir, "feature-a.txt")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "feature-b.txt")), false);
		const output = result.content[0]?.text ?? "";
		const handoffPaths = [...output.matchAll(/"([^"\n]*\/handoffs\/[^"\n]+\.json)"/g)].map((match) => match[1]!);
		assert.equal(handoffPaths.length, 2, output);
		const worktreePaths = new Set<string>();
		for (const handoffPath of handoffPaths) {
			const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
				groups: Array<{
				children: Array<{ workflowKey: string; runId: string; lane: { key: string; mode: string; sourceRef: string; claims: string[] }; patch: { changed: boolean; path: string } }>;
					cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
				}>;
			};
			assert.equal(handoff.groups.length, 1);
			assert.equal(handoff.groups[0]?.children.length, 1);
			assert.equal(handoff.groups[0]?.children[0]?.workflowKey, handoff.groups[0]?.children[0]?.lane.key);
			assert.equal(handoff.groups[0]?.children[0]?.runId?.length > 0, true);
			assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
			assert.equal(fs.existsSync(handoff.groups[0]!.children[0]!.patch.path), true);
			assert.equal(handoff.groups[0]?.cleanup.state, "complete");
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
			assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
			worktreePaths.add(handoff.groups[0]!.cleanup.tasks[0]!.path);
		}
		assert.equal(worktreePaths.size, 2);
		for (const worktreePath of worktreePaths) assert.equal(fs.existsSync(worktreePath), false);
		assert.match(result.content[0]?.text ?? "", /handoffs/);
	});

	it("finalizes a workflow worktree when its child detaches for supervisor coordination", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({
			writeFiles: [{ path: "feature.txt", content: "feature\n" }],
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		const piEvents = createEventBus();
		const executor = makeExecutor(
			[makeAgent("worker", { systemPrompt: "Intercom orchestration channel:" })],
			{},
			false,
			undefined,
			true,
			new Map(),
			undefined,
			undefined,
			piEvents,
		);
		let detachAccepted = false;
		piEvents.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if ((payload as { requestId?: unknown }).requestId === "workflow-worktree-detach") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "workflow-worktree-detach" });
		}, 10);
		detachTimer.unref();

		const result = await executor.execute(
			"scripted-workflow-detached-worktree",
			{
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "detaches", agent: "worker", task: "Ask then continue", worktree: true }
					]);
					return children.map(({ key, ok, artifactPaths }) => ({ key, ok, artifactPaths }));
				`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);
		assert.equal(result.isError, undefined, result.content[0]?.text ?? "workflow failed");
		assert.match(result.content[0]?.text ?? "", /run detaches: detached/);
		const workflowValue = result.details.workflow?.value as Array<{ ok: boolean; artifactPaths: string[] }>;
		assert.equal(workflowValue[0]?.ok, false);
		const handoffPath = workflowValue[0]?.artifactPaths.find((candidate) => candidate.endsWith(".json"));
		assert.ok(handoffPath, result.content[0]?.text ?? "missing pending handoff");
		let handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				children: Array<{ status: string; patch: { changed: boolean; filesChanged: number } }>;
				cleanup: { state: string; tasks: Array<{ path: string; branch: string; preserved: boolean; worktreeRemoved: boolean; branchRemoved: boolean }> };
			}>;
		};
		const cleanup = handoff.groups[0]?.cleanup;
		assert.equal(cleanup?.state, "partial");
		assert.equal(cleanup?.tasks[0]?.preserved, true);
		assert.equal(cleanup?.tasks[0]?.worktreeRemoved, false);
		assert.equal(cleanup?.tasks[0]?.branchRemoved, false);
		const worktreePath = cleanup?.tasks[0]?.path;
		const branch = cleanup?.tasks[0]?.branch;
		assert.ok(worktreePath);
		assert.ok(branch);
		assert.equal(fs.existsSync(worktreePath), true, "live detached worktree must remain present");

		for (let attempt = 0; attempt < 150 && handoff.groups[0]?.cleanup.state !== "complete"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as typeof handoff;
		}
		assert.equal(handoff.groups[0]?.children[0]?.status, "completed");
		assert.equal(handoff.groups[0]?.children[0]?.patch.changed, true);
		assert.equal(handoff.groups[0]?.children[0]?.patch.filesChanged, 1);
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.preserved, undefined);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
		assert.equal(fs.existsSync(worktreePath), false);
		assert.equal(fs.existsSync(path.join(tempDir, "feature.txt")), false);
	});

	it("continues an async sequential workflow after supervisor coordination settles", { skip: !createSubagentExecutor ? "executor unavailable" : undefined }, async () => {
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		fs.writeFileSync(path.join(tempDir, "base.txt"), "base\n", "utf-8");
		execFileSync("git", ["add", "base.txt"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" });
		mockPi.onCall({
			matchArgIncludes: "Ask then continue",
			steps: [
				{ jsonl: [events.toolStart("contact_supervisor", { reason: "need_decision", message: "Need a decision" })] },
				{ delay: 500, jsonl: [events.assistantMessage("done after coordination")] },
			],
		});
		mockPi.onCall({ matchArgIncludes: "Use coordinated output: done after coordination", output: "tail completed" });
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
			if ((payload as { requestId?: unknown }).requestId === "async-workflow-detach") {
				detachAccepted ||= (payload as { accepted?: unknown }).accepted === true;
			}
		});
		const detachTimer = setInterval(() => {
			if (!detachAccepted) piEvents.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "async-workflow-detach" });
		}, 10);
		detachTimer.unref();

		const started = await executor.execute(
			"async-scripted-workflow-detached-worktree",
			{
				workflowScript: `
					const child = await runs.run("detaches", { agent: "worker", task: "Ask then continue", worktree: true });
					const tail = await runs.run("tail", { agent: "worker", task: "Use coordinated output: " + child.output });
					return tail.output;
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
		const activeMarkerPath = path.join(DIRS.async, ACTIVE_RUN_INDEX_DIR, workflowRunId);

		let status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		for (let attempt = 0; attempt < 150 && status.steps?.[0]?.activityState !== "needs_attention"; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
		}
		clearInterval(detachTimer);

		assert.equal(detachAccepted, true);

		let reconciled: AsyncStatus | undefined;
		for (let attempt = 0; attempt < 150; attempt++) {
			reconciled = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatus;
			if (reconciled.state === "complete" || reconciled.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(reconciled?.state, "complete", reconciled?.error);
		assert.equal(reconciled?.activityState, undefined);
		assert.equal(reconciled?.steps?.[0]?.status, "completed");
		assert.equal(reconciled?.steps?.[0]?.activityState, undefined);
		assert.equal(reconciled?.steps?.[1]?.workflowKey, "tail");
		assert.equal(reconciled?.steps?.[1]?.status, "completed");
		assert.equal(asyncJobs.get(workflowRunId)?.status, "complete");
		assert.equal(mockPi.callCount(), 2);

		const persistedResult = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
			state?: string;
			success?: boolean;
			activityState?: string;
			error?: string;
			results?: Array<{ workflowKey?: string; success?: boolean; output?: string; detached?: boolean; artifactPaths?: { outputPath?: string } }>;
		};
		assert.equal(persistedResult.state, "complete");
		assert.equal(persistedResult.success, true);
		assert.equal(persistedResult.activityState, undefined);
		assert.equal(persistedResult.error, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.detached, undefined);
		assert.equal(persistedResult.results?.find((entry) => entry.workflowKey === "tail")?.output, "tail completed");
		const handoffPath = persistedResult.results?.find((entry) => entry.workflowKey === "detaches")?.artifactPaths?.outputPath;
		assert.ok(handoffPath, "missing finalized worktree handoff path");
		const handoff = JSON.parse(fs.readFileSync(handoffPath, "utf-8")) as {
			groups: Array<{
				children: Array<{ status: string; patch: { changed: boolean; filesChanged: number } }>;
				cleanup: { state: string; tasks: Array<{ path: string; worktreeRemoved: boolean; branchRemoved: boolean }> };
			}>;
		};
		assert.equal(handoff.groups[0]?.children[0]?.status, "completed");
		assert.equal(handoff.groups[0]?.children[0]?.patch.changed, false);
		assert.equal(handoff.groups[0]?.children[0]?.patch.filesChanged, 0);
		assert.equal(handoff.groups[0]?.cleanup.state, "complete");
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.worktreeRemoved, true);
		assert.equal(handoff.groups[0]?.cleanup.tasks[0]?.branchRemoved, true);
		assert.equal(fs.existsSync(handoff.groups[0]?.cleanup.tasks[0]?.path ?? ""), false);
		assert.equal(fs.existsSync(activeMarkerPath), false);
		fs.rmSync(started.details.asyncDir, { recursive: true, force: true });
		fs.rmSync(resultPath, { force: true });
	});

});
