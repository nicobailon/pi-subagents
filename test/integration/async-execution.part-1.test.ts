/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { events, makeAgent, makeMinimalCtx, resolveMockPiCallArgs } from "../support/helpers.ts";
import { registerSubagentCapabilityCeiling } from "../../src/api/capability-ceiling.ts";
import { registerWorkflowResource } from "../../src/api/workflow-resources.ts";
import type { WorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { ACTIVE_ASYNC_CAPACITY_DIR, acquireActiveAsyncCapacity, activeAsyncCapacitySessionKey, getActiveAsyncCapacitySnapshot } from "../../src/runs/background/active-async-capacity.ts";
import { recordModelFailure } from "../../src/runs/shared/model-exclusions.ts";
import type { AsyncExecutionResult, AsyncResultPayload, AsyncStatusPayload, MockPiCallRecord } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, mockAssistantMessage, available, isAsyncAvailable,
	executeAsyncSingle, executeAsyncChain, resolveTargetedAsyncRun, ASYNC_DIR,
	RESULTS_DIR, createSubagentExecutor, readIfExists, waitForAsyncResultFile,
	waitForAsyncState, waitForMockPiCall, readMockPiArgs, readMockPiRequiredTools,
	tempDir, mockPi, makeAsyncExecutor, readAsyncPayload, launchProtocolTest,
} from "../support/async-execution-fixture.ts";

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("executes a registered mixed background workflow with captured grants after disposal", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		const command = `${JSON.stringify(process.execPath)} registered-check.cjs`;
		fs.writeFileSync(path.join(tempDir, "registered-check.cjs"), `require("node:fs").writeFileSync("registered-marker", "ran"); console.log("background finite check passed");`);
		const definition = { name: "test.background", version: 1, resolve: () => ({
			script: `const child = await runs.run("review", { agent: "reviewer", task: "Review the change" }); if (!child.ok) throw new Error("Required review failed"); return await runs.host("check", ${JSON.stringify({ kind: "command", command, timeoutMs: 5000, output: "registered-check.log" })});`,
			hostCommands: [{ key: "check", command }],
		}) };
		const registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition });
		const executor = makeAsyncExecutor([makeAgent("reviewer", { completionGuard: false })]);
		mockPi.onCall({ output: "Background review completed" });
		try {
			const pending = executor.executePublic("registered-background", { workflow: definition.name, async: true }, new AbortController().signal, undefined, ctx);
			// executePublic has synchronously captured the expansion; no timing-based wait.
			registration.dispose();
			const missing = await executor.executePublic("disposed-background", { workflow: definition.name, async: true }, new AbortController().signal, undefined, ctx);
			assert.equal(missing.isError, true);
			assert.match(missing.content[0]?.text ?? "", /Unknown workflow/);
			const replacement = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: { ...definition, resolve: () => ({ script: "return 'replacement'" }) } });
			try {
				const launch = await pending;
				assert.equal(launch.isError, undefined, launch.content[0]?.text);
				const id = launch.details?.asyncId;
				assert.ok(id);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload & { workflowReceipt: { path: string; receipt: WorkflowReceipt } };
				assert.equal(payload.success, true, payload.error);
				assert.equal((await waitForAsyncState(id, (status) => status.state === "complete")).state, "complete");
				assert.equal(payload.results[0]?.output, "Background review completed");
				assert.equal(mockPi.callCount(), 1);
				assert.equal(fs.readFileSync(path.join(tempDir, "registered-marker"), "utf8"), "ran");
				assert.match(fs.readFileSync(path.join(tempDir, "registered-check.log"), "utf8"), /background finite check passed/);
				assert.equal(payload.workflowReceipt.receipt.resource?.name, definition.name);
				assert.equal(payload.workflowReceipt.receipt.state, "complete");
				assert.equal(payload.workflowReceipt.receipt.entries.review.agent, "reviewer");
				assert.ok(payload.workflowReceipt.receipt.entries.review.latestRunId);
				assert.deepEqual(payload.workflowReceipt.receipt.hostSteps?.map(({ id, state, exitCode }) => ({ id, state, exitCode })), [{ id: "check", state: "done", exitCode: 0 }]);
				assert.deepEqual(JSON.parse(fs.readFileSync(payload.workflowReceipt.path, "utf8")), payload.workflowReceipt.receipt);
			} finally { replacement.dispose(); }
		} finally { registration.dispose(); }
	});

	it("enforces the registered background command deadline and records terminal failure", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const ctx = makeMinimalCtx(tempDir);
		const command = `${JSON.stringify(process.execPath)} finite-slow-check.cjs`;
		fs.writeFileSync(path.join(tempDir, "finite-slow-check.cjs"), `console.log("finite slow check started"); setTimeout(() => console.log("unexpected completion"), 10000);`);
		const registration = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(), definition: {
			name: "test.deadline", version: 1, resolve: () => ({ script: `return await runs.host("check", ${JSON.stringify({ kind: "command", command, timeoutMs: 250, output: "deadline.log" })});`, hostCommands: [{ key: "check", command }] }),
		} });
		try {
			const launch = await makeAsyncExecutor([]).executePublic("registered-deadline", { workflow: "test.deadline", async: true }, new AbortController().signal, undefined, ctx);
			assert.equal(launch.isError, undefined, launch.content[0]?.text);
			const id = launch.details?.asyncId;
			assert.ok(id);
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload & { workflowReceipt: { receipt: WorkflowReceipt } };
			assert.equal(payload.success, false);
			assert.equal((await waitForAsyncState(id, (status) => status.state === "failed")).state, "failed");
			assert.equal(payload.workflowReceipt.receipt.resource?.name, "test.deadline");
			assert.equal(payload.workflowReceipt.receipt.state, "failed");
			assert.deepEqual(payload.workflowReceipt.receipt.hostSteps?.map(({ state, reasonCode }) => ({ state, reasonCode })), [{ state: "error", reasonCode: "timed_out" }]);
			assert.doesNotMatch(fs.readFileSync(path.join(tempDir, "deadline.log"), "utf8"), /unexpected completion/);
			assert.equal(mockPi.callCount(), 0);
		} finally { registration.dispose(); }
	});

	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("does not persist terminal async workflow status when the result index write fails", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const id = `async-workflow-result-index-failure-${Date.now().toString(36)}`;
		const resultIndexPath = path.join(RESULTS_DIR, "result-index");
		let asyncDir: string | undefined;
		let resultPath: string | undefined;
		let pendingPath: string | undefined;
		const originalError = console.error;
		try {
			console.error = () => {};
			fs.rmSync(resultIndexPath, { recursive: true, force: true });
			fs.mkdirSync(RESULTS_DIR, { recursive: true });
			fs.writeFileSync(resultIndexPath, "not a directory", "utf-8");
			const executor = makeAsyncExecutor([]);
			const context = makeMinimalCtx(tempDir);
			context.sessionManager.getSessionId = () => "session-workflow-index";

			const launch = await executor.execute(id, { workflowScript: "return 'done'", async: true }, new AbortController().signal, undefined, context);
			assert.equal(launch.isError, undefined);
			const asyncId = launch.details?.asyncId;
			assert.ok(asyncId, "expected async workflow id");
			asyncDir = path.join(ASYNC_DIR, asyncId);
			resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			pendingPath = path.join(RESULTS_DIR, "result-pending", encodeURIComponent("session-workflow-index"), `${encodeURIComponent(asyncId)}.json`);

			const eventsPath = path.join(asyncDir, "events.jsonl");
			const deadline = Date.now() + 5_000;
			let eventsText = "";
			while (Date.now() <= deadline) {
				eventsText = readIfExists(eventsPath) ?? "";
				if (eventsText.includes("subagent.workflow.result_write_failed")) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.match(eventsText, /subagent\.workflow\.result_write_failed/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(status.state, "running");
			assert.equal(fs.existsSync(resultPath), false);
			assert.equal(fs.existsSync(pendingPath), true);
		} finally {
			console.error = originalError;
			if (asyncDir) fs.rmSync(asyncDir, { recursive: true, force: true });
			if (resultPath) fs.rmSync(resultPath, { recursive: true, force: true });
			if (pendingPath) fs.rmSync(pendingPath, { force: true });
			fs.rmSync(resultIndexPath, { recursive: true, force: true });
		}
	});

	it("summarizes result-wait evidence without exposing artifact contents", async () => {
		const id = `async-wait-diagnostic-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(asyncDir, { recursive: true });
		try {
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "running", steps: [{ status: "pending" }], task: "secret-prompt" }));
			fs.writeFileSync(path.join(asyncDir, "runner.stdout.log"), "");
			fs.mkdirSync(path.join(asyncDir, "runner.stderr.log"));
			fs.writeFileSync(path.join(asyncDir, "runner-startup-proceed.json"), JSON.stringify({ token: "secret-token" }));
			fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "secret-event-output\n");
			const checkTimeout = async (stepState: string, callCount: number) => {
				await assert.rejects(waitForAsyncResultFile(id, -1), (error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, new RegExp(`"steps":\\["${stepState}"\\]`));
					assert.ok(error.message.includes(`mock queue: readable, prompt call records=${callCount}`));
					assert.match(error.message, /runner.stdout.log: empty/);
					assert.match(error.message, /runner.stderr.log: unreadable \(EISDIR\)/);
					assert.match(error.message, /process-terminal.json: absent/);
					assert.match(error.message, /runner-startup-proceed.json: readable, \d+ bytes \(contents withheld\)/);
					assert.match(error.message, /events.jsonl: readable/);
					assert.doesNotMatch(error.message, /secret-/);
					return true;
				});
			};
			await checkTimeout("pending", 0);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "running", steps: [{ status: "running" }] }));
			fs.writeFileSync(path.join(mockPi.dir, "call-diagnostic.json"), JSON.stringify({ task: "secret-mock-prompt" }));
			await checkTimeout("running", 1);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("persists terminal status with the result artifact", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "completed output" });
		const id = `async-terminal-status-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		await waitForAsyncResultFile(id);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(status.state, "complete");
		assert.equal(status.endedAt !== undefined, true);
	});

	it("preserves effective thinking in the completed async result artifact", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "completed with thinking" });
		const id = `async-result-thinking-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Report the configured reasoning level.",
			agentConfig: makeAgent("worker", { model: "mock/test-model", thinking: "high", completionGuard: false }),
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-result-thinking" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.thinking, "high");
		assert.equal(status.steps?.[0]?.thinking, "high");
	});

	it("persists the bounded usage projection in async results and metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "accounted output" });
		const id = `async-usage-artifact-${Date.now().toString(36)}`;
		const artifactsDir = path.join(tempDir, ".pi", "subagents", "artifacts");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Persist usage",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-usage-artifact" },
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			artifactsDir,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		const payload = await readAsyncPayload(id);
		const expectedUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 1 };
		assert.deepEqual(payload.results[0]?.usage, expectedUsage);
		const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
		assert.ok(metadataPath);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { usage?: unknown };
		assert.deepEqual(metadata.usage, expectedUsage);
	});

	it("makes a launched async run immediately visible to exact status lookup", { skip: !isAsyncAvailable() || !resolveTargetedAsyncRun ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 500, output: "visible async done" });
		const id = `async-initial-status-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Remain visible while starting",
			agentConfig: makeAgent("worker", { completionGuard: false, model: "mock/test-model" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-initial-status" },
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model", contextWindow: 128_000 }],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		assert.equal(resolveTargetedAsyncRun(ASYNC_DIR, id, "session-initial-status").kind, "exact");
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.sessionId, "session-initial-status");
		assert.equal(status.pid !== undefined, true);
		assert.equal(status.steps?.[0]?.contextLimit, 128_000);
		await waitForAsyncResultFile(id);
	});

	it("persists absent output provenance when async lifecycle text is synthetic", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [mockAssistantMessage("", "tool_use")], stderr: "mock child failure", exitCode: 1 });
		const id = `async-output-absent-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.outputState, "absent");
		assert.match(payload.results[0]?.error ?? "", /mock child failure/);
	});

	it("persists present output provenance when async failure follows partial output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "usable partial answer", stderr: "mock post-output failure", exitCode: 1 });
		const id = `async-output-present-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.outputState, "present");
		assert.equal(payload.results[0]?.output, "usable partial answer");
	});

	it("matches preflight launch digest in equivalent foreground and async execution", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agentName = `contract-worker-${Date.now().toString(36)}`;
		const task = "Compare the resolved launch inputs.";
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = path.join(tempDir, "agent-home");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const permissionExtDir = path.join(agentDir, "extensions", "pi-permission-system");
		fs.mkdirSync(path.join(permissionExtDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(permissionExtDir, "src", "index.ts"), "export default () => {};", "utf-8");
		fs.writeFileSync(path.join(permissionExtDir, "package.json"), JSON.stringify({ name: "test", pi: { extensions: ["./src/index.ts"] } }), "utf-8");
		const agentPath = path.join(tempDir, ".pi", "agents", `${agentName}.md`);
		fs.mkdirSync(path.dirname(agentPath), { recursive: true });
		fs.writeFileSync(agentPath, `---\nname: ${agentName}\ndescription: Contract comparison worker\npermissions:\n  write: ask\n---\n`, "utf-8");
		try {
			const discovered = discoverAgents(tempDir).agents.find((agent) => agent.name === agentName);
			assert.ok(discovered, "expected temporary agent definition to be discovered");
			const preflight = await resolveSubagentLaunchContract({ agent: agentName, cwd: tempDir, task, runId: "contract-preflight" });
			assert.equal(preflight.ok, true);
			assert.ok(preflight.contract.tools.extensionArgs.some((entry) => entry.endsWith(path.join("pi-permission-system", "src", "index.ts"))));

			mockPi.onCall({ output: "foreground contract comparison" });
			const foreground = await runSync(tempDir, [discovered], agentName, task, { runId: "contract-foreground", acceptance: false });
			assert.equal(foreground.exitCode, 0);
			assert.equal(foreground.launchContractDigest, preflight.contract.launchContractDigest);

			mockPi.onCall({ output: "async contract comparison" });
			const asyncId = `async-contract-equivalence-${Date.now().toString(36)}`;
			const launch = executeAsyncSingle(asyncId, {
				agent: agentName,
				task,
				agentConfig: discovered,
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
				acceptance: false,
			});
			const payload = await readAsyncPayload(asyncId);
			assert.equal(launch.details.launchContractDigest, preflight.contract.launchContractDigest);
			assert.equal(payload.launchContractDigest, preflight.contract.launchContractDigest);
			assert.equal(payload.results[0]?.launchContractDigest, preflight.contract.launchContractDigest);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("persists the actual launch digest in async status and result metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: "digest-bound async done",
			runtimeAcknowledgedExtensions: { version: 1, source: "child-runtime", ids: ["ext.async"], omitted: 0 },
		});
		const id = `async-launch-digest-${Date.now().toString(36)}`;
		const privateExtension = path.join(tempDir, "extensions", "private-extension.ts");
		const recoveryAgentConfig = makeAgent("worker", { completionGuard: false, extensions: [privateExtension], tools: ["read"], systemPrompt: "Base prompt" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Exercise launch digest reporting",
			agentConfig: { ...recoveryAgentConfig, tools: ["read", "intercom", "contact_supervisor"], systemPrompt: "Base prompt\n\nIntercom orchestration channel:" },
			recoveryAgentConfig,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			context: "fork",
			intercomBridge: { mode: "off" },
		});
		assert.match(launch.details.launchContractDigest ?? "", /^[a-f0-9]{64}$/);
		const recovery = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "recovery-descriptor.json"), "utf-8")) as { runFanoutBudget?: { rootRunId?: string; limit?: number }; context?: string; intercomBridge?: { mode?: string }; tools?: string[]; systemPrompt?: string };
		assert.deepEqual(recovery.runFanoutBudget && { rootRunId: recovery.runFanoutBudget.rootRunId, limit: recovery.runFanoutBudget.limit }, { rootRunId: id, limit: 64 });
		assert.equal(recovery.context, "fork");
		assert.deepEqual(recovery.intercomBridge, { mode: "off" });
		assert.deepEqual(recovery.tools, ["read"]);
		assert.equal(recovery.systemPrompt, "Base prompt");
		const payload = await readAsyncPayload(id);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete" && candidate.runtimeAcknowledgedExtensions !== undefined);
		assert.equal(payload.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(payload.results[0]?.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(status.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(status.steps?.[0]?.launchContractDigest, launch.details.launchContractDigest);
		assert.equal(launch.details.launchResolvedExtensions?.source, "launch-resolved");
		assert.equal(launch.details.launchResolvedExtensions?.disableAmbientExtensions, true);
		assert.deepEqual(payload.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(payload.results[0]?.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(status.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		assert.deepEqual(status.steps?.[0]?.launchResolvedExtensions, launch.details.launchResolvedExtensions);
		const runtimeAck = { version: 1, source: "child-runtime", ids: ["ext.async"], omitted: 0 };
		assert.deepEqual(payload.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(payload.results[0]?.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(status.runtimeAcknowledgedExtensions, runtimeAck);
		assert.deepEqual(status.steps?.[0]?.runtimeAcknowledgedExtensions, runtimeAck);
		assert.ok(!JSON.stringify(launch.details.launchResolvedExtensions).includes(tempDir), "projection should not expose raw extension paths");
		// Stale supervisor-bridge pair: the --tools allowlist passes both names
		// through, but PI_SUBAGENT_REQUIRED_TOOLS excludes them so the 0.50 child
		// runtime cannot fail the run over the removed native intercom (#1207).
		const recoveryCallArgs = readMockPiArgs(mockPi, 0);
		assert.equal(recoveryCallArgs[recoveryCallArgs.indexOf("--tools") + 1], "read,intercom,contact_supervisor");
		assert.deepEqual(readMockPiRequiredTools(mockPi, 0), ["read"]);
	});

	it("rejects an explicit unknown model before spawn even when a fallback exists", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(`async-explicit-unknown-model-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/fallback", fallbackModels: ["mock/fallback"], completionGuard: false }),
			modelOverride: "mock/does-not-exist",
			modelOrigin: "explicit",
			availableModels: [{ provider: "mock", id: "fallback", fullId: "mock/fallback" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /Unknown subagent model 'mock\/does-not-exist'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("retries configured fallbacks after a valid explicit primary fails", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "explicit fallback recovered" });
		const id = `async-explicit-model-fallback-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/configured", fallbackModels: ["anthropic/claude-sonnet-4"], completionGuard: false }),
			modelOverride: "openai/gpt-5-mini",
			modelOrigin: "explicit",
			availableModels: [
				{ provider: "mock", id: "configured", fullId: "mock/configured" },
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 2);
	});

	it("rejects an explicit cached-excluded model before spawn even when a fallback exists", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		recordModelFailure({ modelId: "blocked", provider: "mock", reason: "sk-secret-token-xyz" });
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(`async-explicit-cached-excluded-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/fallback", fallbackModels: ["mock/fallback"], completionGuard: false }),
			modelOverride: "mock/blocked",
			modelOrigin: "explicit",
			availableModels: [
				{ provider: "mock", id: "blocked", fullId: "mock/blocked" },
				{ provider: "mock", id: "fallback", fullId: "mock/fallback" },
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /is excluded and cannot be replaced by a fallback/);
		assert.equal((launch.content[0]?.text ?? "").includes("sk-secret-token-xyz"), false);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects fallback-only configurations with no launch candidates before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(`async-fallback-only-zero-candidates-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { fallbackModels: ["does-not-exist"], completionGuard: false }),
			availableModels: [{ provider: "mock", id: "fallback", fullId: "mock/fallback" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /Unknown subagent model 'does-not-exist'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects an explicit non-strict out-of-scope model before spawn even when a fallback exists", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(`async-explicit-scope-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/fallback", fallbackModels: ["mock/fallback"], completionGuard: false }),
			modelOverride: "mock/blocked",
			modelOrigin: "explicit",
			availableModels: [
				{ provider: "mock", id: "blocked", fullId: "mock/blocked" },
				{ provider: "mock", id: "fallback", fullId: "mock/fallback" },
			],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				modelScope: { enforce: true, allow: ["mock/fallback"] },
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /outside the configured subagent model scope/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("uses a configured fallback when the agent primary is unavailable", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-configured-fallback-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "fallback model ran" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "mock/missing-primary", fallbackModels: ["mock/fallback"], completionGuard: false }),
			modelOrigin: "configured",
			availableModels: [{ provider: "mock", id: "fallback", fullId: "mock/fallback" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.model, "mock/fallback");
		assert.equal(mockPi.callCount(), 1);
	});

	it("rejects async thinking above maxThinking before child startup", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const launch = executeAsyncSingle(`async-thinking-ceiling-${Date.now().toString(36)}`, {
			agent: "worker",
			task: "Use the strongest available reasoning.",
			agentConfig: makeAgent("worker", { model: "mock/test-model", maxThinking: "xhigh", completionGuard: false }),
			thinkingOverride: "max",
			availableModels: [{ provider: "mock", id: "test-model", fullId: "mock/test-model" }],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /max.*xhigh.*worker/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects implementation workers without mutation-capable tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("lets unrestricted implementation workers spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-unrestricted-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "implemented" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined);
		await waitForAsyncResultFile(id, 10_000);
		assert.equal(mockPi.callCount(), 1);
	});

	it("lets explicit fast false opt out async external single runs from inherited fast mode", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agentConfig = makeAgent("external", {
			fast: true,
			runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('external async fast false')"] },
		} as never);

		const rejected = executeAsyncSingle(`async-external-fast-inherited-${Date.now().toString(36)}`, {
			agent: "external",
			task: "Run external",
			agentConfig,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support: fast mode/);

		const id = `async-external-fast-false-${Date.now().toString(36)}`;
		const launch = executeAsyncSingle(id, {
			agent: "external",
			task: "Run external",
			agentConfig,
			fast: false,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external async fast false/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("establishes a lifecycle sidecar before an external CLI can run", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-external-lifecycle-${Date.now().toString(36)}`;
		const startedRunners: string[] = [];
		const launch = executeAsyncSingle(id, {
			agent: "external",
			task: "Run external",
			agentConfig: makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "setTimeout(() => process.stdout.write('external lifecycle'), 500)"] },
			} as never),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			activeAsyncCapacity: {
				owner: {},
				markStarted: (runnerProcessInstanceId: string) => { startedRunners.push(runnerProcessInstanceId); },
				markWorkflowStarted() {},
				rollback: () => false,
				rollbackBeforeRunnerProceed: () => false,
				reconcile: () => ({ used: 1, limit: 1 }),
			} as never,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const proof = JSON.parse(fs.readFileSync(path.join(launch.details.asyncDir ?? "", "process-terminal.json"), "utf-8")) as { state?: string; runId?: string; runnerProcessInstanceId?: string };
		assert.equal(proof.state, "pending");
		assert.equal(proof.runId, id);
		assert.deepEqual(startedRunners, [proof.runnerProcessInstanceId]);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external lifecycle/);
	});

	it("continues startup when proceed authorization is published but temp cleanup fails", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async (t) => {
		const id = `async-external-proceed-cleanup-${Date.now().toString(36)}`;
		const originalRmSync = fsDefault.rmSync;
		let proceedCleanupFailures = 0;
		let rollbackCount = 0;
		t.mock.method(fsDefault, "rmSync", ((target: fs.PathLike, options?: fs.RmOptions) => {
			const targetPath = String(target);
			if (targetPath.includes(".runner-startup-proceed.json.") && targetPath.endsWith(".tmp") && proceedCleanupFailures === 0) {
				proceedCleanupFailures += 1;
				throw new Error("simulated proceed cleanup failure");
			}
			return originalRmSync(target, options);
		}) as typeof fsDefault.rmSync);
		syncBuiltinESMExports();
		t.after(() => syncBuiltinESMExports());

		const launch = executeAsyncSingle(id, {
			agent: "external",
			task: "Run external",
			agentConfig: makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('external proceed cleanup')"] },
			} as never),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			activeAsyncCapacity: {
				owner: {},
				markStarted() {},
				markWorkflowStarted() {},
				rollback() { rollbackCount += 1; return false; },
				rollbackBeforeRunnerProceed() { rollbackCount += 1; return false; },
				reconcile: () => ({ used: 1, limit: 1 }),
			} as never,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		assert.equal(proceedCleanupFailures, 1);
		assert.equal(rollbackCount, 0);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external proceed cleanup/);
	});

	it("fails pre-proceed capacity bind without rebinding the killed runner", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async (t) => {
		const parentSessionId = `session-capacity-bind-${Date.now().toString(36)}`;
		const id = `async-capacity-bind-failure-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		let ownerWrites = 0;
		fs.rmSync(path.join(ACTIVE_ASYNC_CAPACITY_DIR, activeAsyncCapacitySessionKey(parentSessionId)), { recursive: true, force: true });
		const activeAsyncCapacity = acquireActiveAsyncCapacity({ sessionId: parentSessionId, limit: 1, runId: id, kind: "runner", asyncDir }, {
			writeOwner(filePath, owner) {
				ownerWrites += 1;
				if (ownerWrites === 1) throw new Error("simulated durable bind failure");
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, JSON.stringify(owner, null, 2));
			},
		});
		assert.ok(activeAsyncCapacity);
		const originalKill = process.kill;
		t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | 0) => {
			if (signal === 0) return true;
			return originalKill(pid, signal);
		}) as typeof process.kill);

		const launch = executeAsyncSingle(id, {
			agent: "external",
			task: "Run external",
			agentConfig: makeAgent("external", {
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
			} as never),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: parentSessionId },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			activeAsyncCapacity,
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /Failed to establish async runner capacity ownership/);
		assert.equal(ownerWrites, 1);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /Failed to establish async runner capacity ownership/);
		assert.equal(status.processTerminal?.state, "not-started");
		assert.deepEqual(getActiveAsyncCapacitySnapshot(parentSessionId, 1), { used: 0, limit: 1 });
	});

	it("lets explicit fast false opt out async external chains from inherited fast mode", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const agent = makeAgent("external", {
			fast: true,
			runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('external chain fast false')"] },
		} as never);

		const rejected = executeAsyncChain(`async-chain-external-fast-inherited-${Date.now().toString(36)}`, {
			chain: [{ agent: "external", task: "Run external" }],
			resultMode: "chain",
			agents: [agent],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			acceptance: false,
		});
		assert.equal(rejected.isError, true);
		assert.match(rejected.content[0]?.text ?? "", /does not support: fast mode/);

		const id = `async-chain-external-fast-false-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{ agent: "external", task: "Run external" }],
			resultMode: "chain",
			agents: [agent],
			fast: false,
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "launch failed");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.match(payload.results[0]?.output ?? "", /external chain fast false/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects implementation workers when a capability ceiling removes mutation tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-ceiling-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "write"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"] },
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects workflow implementation workers without mutation-capable tools before spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-workflow-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Implement the requested source fix" }],
			resultMode: "chain",
			agents: [makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects workflow read-only workers after previous-output templates resolve to implementation tasks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-workflow-resolved-readonly-worker-contract-${Date.now().toString(36)}`;
		mockPi.onCall({ output: "Implement the requested source fix" });
		mockPi.onCall({ output: "should not spawn" });
		const launch = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Return the next instruction" },
				{ agent: "worker", task: "{previous}" },
			],
			resultMode: "chain",
			agents: [
				makeAgent("producer", { completionGuard: false }),
				makeAgent("worker", { tools: ["read", "grep", "find", "ls", "contact_supervisor"] }),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		assert.equal(launch.isError, undefined);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[1]?.error ?? "", /no mutation-capable tools/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background parallel groups report usage budget state and block queued children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "first async result" });
		const id = `async-usage-budget-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "first", task: "First task" },
					{ agent: "second", task: "Second task" },
				],
				concurrency: 1,
			}],
			resultMode: "parallel",
			usageBudget: { tokens: { hard: 10 } },
			agents: [makeAgent("first"), makeAgent("second")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.details.usageBudget?.exhausted, false);
		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.error ?? payload.summary ?? "", /Usage budget exhausted/);
		assert.equal(payload.results.length, 2);
		assert.equal(payload.results[1]?.skipped, true);
		assert.match(payload.results[1]?.error ?? "", /Usage budget exhausted/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(payload.usageBudget?.exhausted, true);
		assert.equal(payload.usageBudget?.reason, "tokens");
		assert.equal(status.usageBudget?.exhausted, true);
		assert.equal(status.steps?.[0]?.status, "complete");
		assert.equal(status.steps?.[1]?.status, "failed");
	});

	it("routes async artifacts to the configured session directory", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "async session artifact" });
		const sessionFile = path.join(tempDir, "sessions", "parent-session", "session.jsonl");
		const ctx = makeMinimalCtx(tempDir);
		ctx.sessionManager.getSessionFile = () => sessionFile;
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })], { artifactDir: "session" });

		const launch = await executor.execute(
			"async-session-artifact-dir",
			{ agent: "worker", task: "Write async session artifacts", async: true, runId: "async-session-artifacts", acceptance: false },
			new AbortController().signal,
			undefined,
			ctx,
		) as AsyncExecutionResult;

		const expectedDir = path.join(path.dirname(sessionFile), "subagent-artifacts");
		assert.equal(launch.isError, undefined);
		assert.ok(launch.details.asyncId);
		const descriptor = JSON.parse(fs.readFileSync(path.join(launch.details.asyncDir!, "recovery-descriptor.json"), "utf-8"));
		assert.equal(descriptor.artifactsDir, expectedDir);
		assert.equal(descriptor.artifactConfig.dir, "session");

		const payload = await readAsyncPayload(launch.details.asyncId);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		assert.ok(outputPath?.startsWith(`${expectedDir}${path.sep}`));
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async session artifact");
		assert.equal(fs.existsSync(path.join(tempDir, ".pi/subagents", "artifacts")), false);
	});

	it("persists async capability ceiling audit to status, results, events, and metadata", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "restricted async done" });
		const sessionId = `session-capability-${Date.now().toString(36)}`;
		const handle = registerSubagentCapabilityCeiling({ sessionId, ceiling: { allowedTools: ["read"], denyExtensions: true }, source: "test" });
		let waitForOwnedRun: (() => Promise<void>) | undefined;
		try {
			const executor = makeAsyncExecutor([makeAgent("worker", { tools: ["read", "write"], completionGuard: false })]);
			const id = `async-capability-${Date.now().toString(36)}`;
			const ctx = makeMinimalCtx(tempDir);
			ctx.sessionManager.getSessionId = () => sessionId;
			const launch = await executor.execute(
				id,
				{ agent: "worker", task: "Run with a restricted capability ceiling", async: true, runId: id, acceptance: false, artifacts: true },
				new AbortController().signal,
				undefined,
				ctx,
			) as AsyncExecutionResult;
			const asyncId = launch.details.asyncId;
			const asyncDir = launch.details.asyncDir;
			if (asyncId && asyncDir) {
				let terminalWait: Promise<void> | undefined;
				waitForOwnedRun = () => terminalWait ??= (async () => {
					const eventsPath = path.join(asyncDir, "events.jsonl");
					const deadline = Date.now() + 10_000;
					while (true) {
						let journal = "";
						try {
							journal = fs.readFileSync(eventsPath, "utf-8");
						} catch (error) {
							if (!["ENOENT", "EINTR", "EAGAIN", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
						}
						// Only complete records for this run establish the final status/journal boundary.
						const terminal = journal.split("\n").slice(0, -1).some((line) => {
							try {
								const event = JSON.parse(line);
								return event?.type === "subagent.run.process_terminal" && event.runId === asyncId;
							} catch {
								return false;
							}
						});
						if (terminal) break;
						assert.ok(Date.now() <= deadline, `Timed out waiting for async event 'subagent.run.process_terminal': ${eventsPath}`);
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				})();
			}
			assert.equal(launch.isError, undefined);
			assert.ok(asyncId);
			assert.ok(asyncDir);
			assert.equal(asyncDir, path.join(ASYNC_DIR, asyncId));
			const resultPath = await waitForAsyncResultFile(asyncId, 10_000);
			await waitForOwnedRun!();
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.deepEqual(payload.capabilityCeiling, { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"] });
			assert.deepEqual(payload.results[0]?.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(status.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(status.steps?.[0]?.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(payload.capabilityAudit?.effectiveTools, ["read"]);
			assert.deepEqual(payload.capabilityAudit?.removedTools, ["write", "contact_supervisor"]);
			assert.equal(payload.capabilityAudit?.extensionsDenied, true);
			const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
			assert.ok(events.some((event) => event.type === "subagent.capability-ceiling.applied" && event.stepIndex === 0 && event.capabilityAudit?.removedTools?.includes("write")));
			const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
			assert.ok(metadataPath);
			const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { launchContractDigest?: string; capabilityCeiling?: unknown; capabilityAudit?: { removedTools?: string[] } };
			assert.equal(metadata.launchContractDigest, payload.results[0]?.launchContractDigest);
			assert.deepEqual(metadata.capabilityCeiling, payload.capabilityCeiling);
			assert.deepEqual(metadata.capabilityAudit?.removedTools, ["write", "contact_supervisor"]);
		} finally {
			try {
				// Result/read/assertion failures must not skip an established owned-run wait.
				await waitForOwnedRun?.();
			} finally {
				handle.dispose();
			}
		}
	});

	it("redacts async task text from durable artifacts, transcripts, and metadata", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async redaction complete" });
		const id = `async-prompt-redaction-${Date.now().toString(36)}`;
		const sentinel = "ASYNC_RAW_PROMPT_SENTINEL_1021";
		executeAsyncSingle(id, {
			agent: "worker",
			task: `Handle ${sentinel} without persisting it`,
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeTranscript: true, includeMetadata: true, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		await waitForMockPiCall(mockPi, 0);
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.endsWith(".json"));
		assert.ok(callFile);
		const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as MockPiCallRecord;
		assert.match(resolveMockPiCallArgs(call).join("\n"), new RegExp(sentinel));

		const payload = await readAsyncPayload(id);
		const artifactPaths = payload.results[0]?.artifactPaths;
		assert.ok(artifactPaths?.inputPath);
		assert.ok(artifactPaths.metadataPath);
		assert.ok(artifactPaths.transcriptPath);
		const inputText = fs.readFileSync(artifactPaths.inputPath, "utf-8");
		const transcriptText = fs.readFileSync(artifactPaths.transcriptPath, "utf-8");
		const metadataText = fs.readFileSync(artifactPaths.metadataPath, "utf-8");
		assert.doesNotMatch(inputText, new RegExp(sentinel));
		assert.doesNotMatch(transcriptText, new RegExp(sentinel));
		assert.doesNotMatch(metadataText, new RegExp(sentinel));
		assert.match(inputText, /\[prompt redacted\]/);
		assert.match(transcriptText, /\[prompt redacted\]/);
		assert.equal((JSON.parse(metadataText) as { task?: string }).task, "[prompt redacted]");
	});

	it("background writes a failure stub to output artifacts when no output was produced", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "", stderr: "model unavailable", exitCode: 1 });
		const id = `async-empty-failure-artifact-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Fail before output",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		assert.ok(outputPath, "should expose an output artifact path");
		const artifact = fs.readFileSync(outputPath, "utf-8");
		assert.match(artifact, /Subagent run failed before producing output\./);
		assert.match(artifact, /Error:\nmodel unavailable/);
		assert.match(artifact, /Transcript:/);
		assert.match(artifact, /Metadata:/);
	});

	it("recreates project-local artifact directories removed before async completion", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "completed after artifact cleanup" });
		const id = `async-artifact-dir-recovery-${Date.now().toString(36)}`;
		const artifactsDir = path.join(tempDir, ".pi/subagents", "artifacts");
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Complete after generated artifacts are cleaned",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeJsonl: false, includeMetadata: true, cleanupDays: 7 },
			artifactsDir,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});

		await waitForMockPiCall(mockPi, 0);
		assert.equal(fs.existsSync(artifactsDir), true);
		fs.rmSync(path.join(tempDir, ".pi/subagents"), { recursive: true, force: true });

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.outputSaveError, undefined);
		assert.equal(payload.results[0]?.metadataSaveError, undefined);
		const outputPath = payload.results[0]?.artifactPaths?.outputPath;
		const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
		assert.ok(outputPath && metadataPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "completed after artifact cleanup");
		assert.equal((JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { exitCode?: number }).exitCode, 0);
	});

	it("background preserves retry lifecycle from an oversized agent_end aggregate", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [
				events.assistantMessage("retrying oversized async response"),
				{ type: "agent_end", messages: ["x".repeat(64 * 1024)], willRetry: true },
			] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after oversized aggregate"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-oversized-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "settled after oversized aggregate");
		assert.ok(Date.now() - startedAt >= 1200, "projected agent_end must cancel the retry drain");
	});

	it("background cancels final drain while agent_end reports a retry and waits for agent_settled", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("retrying async response"), { type: "agent_end", willRetry: true }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled async response"), { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "settled async response");
		assert.ok(Date.now() - startedAt >= 1200, "background runner must not terminate during the retry delay");
	});

	it("background does not drain on settlement from a compaction attempt that will retry", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ steps: [
			{ jsonl: [{ type: "compaction_end", willRetry: true }, { type: "agent_settled" }] },
			{ delay: 1400, jsonl: [events.assistantMessage("settled after compaction retry"), { type: "agent_start" }, { type: "agent_end", willRetry: false }, { type: "agent_settled" }] },
		] });
		const id = `async-lifecycle-compaction-retry-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "settled after compaction retry");
		assert.ok(Date.now() - startedAt >= 1200, "background runner must not terminate during compaction retry");
	});

	it("background treats agent_settled as a clean terminal watermark", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [mockAssistantMessage("settled async without a terminal assistant stop", "tool_use"), { type: "agent_settled" }], keepAliveAfterFinalMessageMs: 15_000 });
		const id = `async-lifecycle-settled-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "settled async without a terminal assistant stop");
		assert.ok(Date.now() - startedAt < 10_000, "agent_settled should trigger bounded child cleanup");
	});

	it("does not report successful compaction settlement as a failure", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{ type: "compaction_start" }, mockAssistantMessage("settled after compaction"), { type: "agent_settled" }],
			keepAliveAfterFinalMessageMs: 15_000,
		});
		const id = `async-lifecycle-compaction-success-${Date.now().toString(36)}`;
		launchProtocolTest(id);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "settled after compaction");
		assert.equal(payload.results[0]?.effects?.settlementDiagnostic, undefined);
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(status.steps?.[0]?.effects?.settlementDiagnostic, undefined);
	});

});
