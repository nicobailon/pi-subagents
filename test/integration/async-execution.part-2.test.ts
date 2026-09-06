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
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, resolveMockPiCallArgs } from "../support/helpers.ts";
import { deliverInterruptRequest, deliverStopRequest, deliverTimeoutRequest, requestAsyncSteer } from "../../src/runs/background/control-channel.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../src/shared/types.ts";
import type { AsyncResultPayload, AsyncStatusPayload, MockPiCallRecord } from "../support/async-execution-fixture.ts";
import {
	installAsyncExecutionHooks, waitForMockPiRuntime, mockAssistantMessage,
	available, isAsyncAvailable, executeAsyncSingle, executeAsyncChain, readStatus,
	pruneStatusCacheForAsyncRoot, ASYNC_DIR, RESULTS_DIR, createSubagentExecutor,
	createRepo, waitForAsyncResultFile, waitForAsyncEvent, waitForAsyncState,
	waitForMockPiCall, readMockPiArgs, readMockPiArgsMatching, tempDir, mockPi,
	makeAsyncExecutor, readAsyncPayload,
} from "../support/async-execution-fixture.ts";

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("keeps named output references literal in async single tasks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const task = "Reply with OK. You may reference {outputs.name} if it helps.";
		mockPi.onCall({ output: "OK" });
		const id = `async-single-literal-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task,
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, undefined);
		const call = await waitForMockPiCall(mockPi, 0);
		assert.match(call.args.at(-1) ?? "", /\{outputs\.name\}/);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "OK");
	});

	it("spawns the async runner with node when process.execPath is not node", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, process.platform === "win32" ? "pi.exe" : "pi");
		try {
			mockPi.onCall({ output: "non-node exec async done" });
			const id = `async-non-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say non-node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "non-node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("falls back to PATH node when node-like process.execPath is stale", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "deleted-node-install", "bin", process.platform === "win32" ? "node.exe" : "node");
		try {
			mockPi.onCall({ output: "stale node exec async done" });
			const id = `async-stale-node-exec-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Say stale node exec async done. Do not edit files.",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, undefined);
			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, "stale node exec async done");
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("interrupts every active async parallel child", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		mockPi.onCall({ delay: 5_000, output: "three done" });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait" },
					{ agent: "two", task: "Wait" },
					{ agent: "three", task: "Wait" },
				],
				concurrency: 3,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two"), makeAgent("three")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 2, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(asyncDir, "status.json");
		const statusBeforeInterrupt = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload & { pid?: number };
		deliverInterruptRequest({ asyncDir, pid: statusBeforeInterrupt.pid, source: "test" });

		const resultPath = await waitForAsyncResultFile(id, 30_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.state, "paused");
		assert.equal(payload.success, false);
		assert.deepEqual(status.steps?.map((step) => step.status), ["paused", "paused", "paused"]);
		assert.equal(mockPi.callCount(), 3);
	});

	for (const diagnostic of ["hidden", "empty", "structured", "file", "mutation"] as const) {
		for (const interrupted of [true, false]) {
			it(`${interrupted ? "defers" : "enforces"} ${diagnostic} completion diagnostics ${interrupted ? "while paused" : "on completion"}`, { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "cross-process interrupt delivery unreliable on Windows CI" : undefined }, async () => {
				const id = `async-completion-${diagnostic}-${interrupted}-${Date.now().toString(36)}`;
				const outputPath = path.join(tempDir, `${id}.md`);
				const jsonl = diagnostic === "hidden"
					? [events.assistantMessage("Inspecting the task."), events.toolResult("bash", "Blocked by policy. Command exited with code 1", true), events.toolResult("read", "file contents")]
					: diagnostic === "empty" || diagnostic === "file"
						? []
						: [events.assistantMessage("I will inspect the files before proceeding.")];
				mockPi.onCall({ steps: [
					{ jsonl },
					...(interrupted ? [
						{ jsonl: [events.toolStart("read", { path: "pause-ready" })] },
						{ waitForPath: path.join(tempDir, `${id}-release`) },
					] : []),
				] });
				const launch = executeAsyncChain(id, {
					chain: [{
						agent: "worker",
						task: diagnostic === "mutation" ? "Implement the fix in src/example.ts." : "Inspect the task and return a report. Do not edit files.",
						acceptance: false,
						...(diagnostic === "structured" ? { outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } : {}),
						...(diagnostic === "file" ? { output: outputPath, outputMode: "file-only" as const } : {}),
					}],
					agents: [makeAgent("worker", { tools: ["read", "write"], completionGuard: diagnostic === "mutation" })],
					ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-completion-diagnostics" },
					artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: true, includeMetadata: true, cleanupDays: 7 },
					artifactsDir: path.join(tempDir, "artifacts", id),
					shareEnabled: false,
					maxSubagentDepth: 2,
				});
				assert.ok(!launch.isError, JSON.stringify(launch));
				const asyncDir = path.join(ASYNC_DIR, id);
				if (interrupted) {
					const running = await waitForAsyncState(id, (status) => status.steps?.[0]?.currentTool === "read");
					if (diagnostic === "file") assert.equal(fs.existsSync(outputPath), false);
					deliverInterruptRequest({ asyncDir, pid: running.pid, source: "test" });
				}
				const payload = await readAsyncPayload(id);
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
				assert.equal(payload.success, false);
				if (interrupted) {
					assert.equal(payload.results[0]?.success, false);
					assert.equal(payload.state, "paused");
					assert.equal(payload.error, undefined);
					assert.equal(payload.results[0]?.error, undefined);
					assert.equal(status.state, "paused");
					assert.equal(status.error, undefined);
					assert.equal(status.steps?.[0]?.status, "paused");
					assert.equal(status.steps?.[0]?.exitCode, 0);
					assert.equal(status.steps?.[0]?.error, undefined);
					assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "paused");
					assert.equal(payload.workflowGraph?.nodes?.[0]?.error, undefined);
				} else {
					const expected = {
						hidden: /bash failed/,
						empty: /empty|no.*output/i,
						structured: /structured_output/,
						file: /Required file-only output was not produced/,
						mutation: /without making edits/,
					};
					assert.match(payload.results[0]?.error ?? "", expected[diagnostic]);
					assert.equal(status.steps?.[0]?.status, "failed");
				}
				if (diagnostic === "hidden") {
					const transcript = payload.results[0]?.artifactPaths?.transcriptPath;
					assert.ok(transcript);
					assert.match(fs.readFileSync(transcript, "utf-8"), /Blocked by policy/);
				}
				assert.equal(mockPi.callCount(), 1);
			});
		}
	}

	it("delivers inbox steer requests to the background child session", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const release = path.join(tempDir, "steer-release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [events.assistantMessage("steered result")] }] });
		const id = `async-inbox-steer-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Wait for guidance",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-inbox-steer" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		await waitForMockPiCall(mockPi, 0, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		requestAsyncSteer(asyncDir, { message: "Focus on the tests.", id: "steer-1", ts: Date.now() });
		requestAsyncSteer(asyncDir, { message: "Then update the docs.", id: "steer-2", ts: Date.now() + 1, mode: "follow_up" });
		type SteeringTargets = { steering?: { recent: Array<{ id: string; targets: Array<{ index: number; state: string }> }> } };
		const status = await waitForAsyncState(id, (candidate) => {
			const recent = (candidate as SteeringTargets).steering?.recent ?? [];
			return recent.some((request) => request.id === "steer-1" && request.targets[0]?.state === "delivered")
				&& recent.some((request) => request.id === "steer-2" && request.targets[0]?.state === "queued");
		}) as AsyncStatusPayload & SteeringTargets;
		assert.equal(status.state, "running");
		const steers = fs.readFileSync(path.join(mockPi.dir, "steers.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { text: string; mode: string });
		assert.deepEqual(steers.map((steer) => steer.mode), ["steer", "followUp"]);
		assert.match(steers[0]?.text ?? "", /Mid-run steering from the parent orchestrator:\n\nFocus on the tests\./);
		assert.match(steers[1]?.text ?? "", /Queued follow-up from the parent orchestrator:\n\nThen update the docs\./);
		fs.writeFileSync(release, "go");
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "steered result");
		const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
		assert.match(eventsText, /"type":"subagent\.steer\.delivered"[^\n]*"requestId":"steer-1"/);
		assert.match(eventsText, /"type":"subagent\.steer\.queued"[^\n]*"requestId":"steer-2"/);
	});

	it("journals terminal child status events for running async child stops", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "cross-process stop delivery unreliable on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one late" });
		mockPi.onCall({ delay: 250, output: "two done" });
		const id = `async-child-stop-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "one", task: "Wait" },
					{ agent: "two", task: "Finish" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [makeAgent("one"), makeAgent("two")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		await waitForMockPiCall(mockPi, 1, 10_000);
		const asyncDir = path.join(ASYNC_DIR, id);
		const statusBeforeStop = await waitForAsyncState(id, (candidate) => candidate.steps?.[0]?.status === "running" && typeof candidate.pid === "number");
		deliverStopRequest({ asyncDir, pid: statusBeforeStop.pid, source: "test", targetIndex: 0, childId: "step:0" });

		await waitForAsyncResultFile(id, 30_000);
		const status = await waitForAsyncState(id, (candidate) => candidate.state !== "running");
		assert.equal(status.steps?.[0]?.status, "stopped");
		const childStatusEvents = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; childId?: string; status?: string });
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "step:0" && event.status === "stopping"));
		assert.ok(childStatusEvents.some((event) => event.type === "subagent.child-status" && event.childId === "step:0" && event.status === "stopped"));
	});

	it("marks async parallel runs that exceed timeoutMs as timed out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one done" });
		mockPi.onCall({ delay: 5_000, output: "two done" });
		// This fixture owns real parallel deadline enforcement; dirty recovery is
		// covered below with mutation ordered before an explicit timeout request.
		const repo = createRepo("pi-subagents-parallel-timeout-");
		try {
			const id = `async-timeout-parallel-${Date.now().toString(36)}`;
			executeAsyncChain(id, {
				chain: [{
					parallel: [
						{ agent: "one", task: "Wait" },
						{ agent: "two", task: "Wait" },
					],
					concurrency: 2,
				}],
				resultMode: "parallel",
				agents: [makeAgent("one"), makeAgent("two")],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 1_500,
			});

			const resultPath = await waitForAsyncResultFile(id, 8_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed", 30_000);
			assert.equal(payload.state, "failed");
			assert.equal(payload.success, false);
			assert.equal(payload.exitCode, 1);
			assert.equal(payload.timeoutMs, 1_500);
			assert.equal(payload.timedOut, true);
			assert.match(payload.summary ?? "", /Subagent timed out after 1500ms\./);
			assert.equal(status.state, "failed");
			assert.equal(status.timeoutMs, 1_500);
			assert.equal(status.timedOut, true);
			assert.match(status.error ?? "", /Subagent timed out after 1500ms\./);
			assert.deepEqual(status.steps?.map((step) => step.status), ["failed", "failed"]);
			assert.deepEqual(status.steps?.map((step) => step.timedOut), [true, true]);
			assert.deepEqual(status.steps?.map((step) => step.error), ["Subagent timed out after 1500ms.", "Subagent timed out after 1500ms."]);
			assert.deepEqual(status.steps?.map((step) => step.timeoutRecovery?.changedFiles), [[], []]);
			assert.deepEqual(payload.results.map((result) => result.timedOut), [true, true]);
			assert.deepEqual(payload.results.map((result) => result.timeoutRecovery?.changedFiles), [[], []]);
			assert.ok(payload.results.every((result) => /Recovery summary:/.test(result.output ?? "")));
			assert.equal(mockPi.callCount(), 2);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("enforces an agent-level timeout on an async serial child without a composite deadline", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "too late" });
		const id = `async-child-timeout-chain-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "slow", task: "Wait" }],
			agents: [makeAgent("slow", { defaultTimeoutMs: 150 })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, undefined, "composite parent must remain unbounded by default");
		assert.equal(payload.state, "failed");
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, "Subagent timed out after 150ms.");
	});

	it("classifies a timed-out dirty child with a missing requested report as recovery-needed", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		const repo = createRepo("pi-subagents-timeout-recovery-");
		const changedPath = path.join(repo, "input.md");
		const partialChange = "partial child change\n";
		mockPi.onCall({
			writeFiles: [{ path: changedPath, content: partialChange }],
			steps: [{ waitForPath: path.join(tempDir, "unreleased-dirty-child") }],
		});
		try {
			const id = `async-timeout-recovery-${Date.now().toString(36)}`;
			const outputPath = path.join(repo, "missing-report.md");
			executeAsyncChain(id, {
				chain: [{ agent: "slow", task: "Write the requested report" }],
				agents: [makeAgent("slow", { output: outputPath, outputMode: "file-only" })],
				ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: true,
					includeInput: false,
					includeOutput: true,
					includeJsonl: true,
					includeMetadata: true,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
			});

			// The child writes after its mutation baseline, then stays blocked.
			// Observe that write before requesting timeout so recovery cannot
			// collect evidence before the mutation, regardless of startup speed.
			await waitForAsyncState(id, (candidate) =>
				candidate.steps?.[0]?.status === "running"
				&& fs.readFileSync(changedPath, "utf-8") === partialChange);
			deliverTimeoutRequest({ asyncDir: path.join(ASYNC_DIR, id), source: "test" });
			const payload = await readAsyncPayload(id);
			const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
			const result = payload.results[0];
			const recovery = result?.timeoutRecovery;
			const statusRecovery = status.steps?.[0]?.timeoutRecovery;
			assert.equal(payload.success, false);
			assert.equal(payload.state, "failed");
			assert.equal(payload.timedOut, true);
			assert.equal(result?.timedOut, true);
			assert.equal(result?.success, false);
			assert.equal(fs.existsSync(outputPath), false);
			assert.deepEqual(result?.timeoutRecovery?.changedFiles, ["input.md"]);
			assert.equal(recovery?.recoveryNeeded, true);
			assert.equal(recovery?.reason, "timed-out-with-dirty-worktree");
			assert.equal(recovery?.reportStatus, "missing");
			assert.match(result?.timeoutRecovery?.message ?? "", /changed tracked files: input\.md/);
			assert.match(recovery?.message ?? "", /requested report: missing/i);
			assert.match(result?.output ?? "", /review (?:the )?diff and artifacts before resuming.*dependent stages/i);
			assert.match(result?.output ?? "", /Recovery summary:/);
			assert.match(result?.output ?? "", /Warning: Inspect partial changes before retrying/);
			assert.equal(status.state, "failed");
			assert.equal(status.timedOut, true);
			assert.equal(status.steps?.[0]?.status, "failed");
			assert.equal(status.steps?.[0]?.timedOut, true);
			assert.deepEqual(statusRecovery?.changedFiles, ["input.md"]);
			assert.equal(statusRecovery?.recoveryNeeded, true);
			assert.equal(statusRecovery?.reportStatus, "missing");
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("kills a wedged tool at the per-tool timeout with a tool-specific error before the run-level timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		// Wedge: tool_execution_start fires, then the mock holds (long delay) so
		// tool_execution_end never arrives — output would keep flowing in a real
		// wedge, which is exactly why a run-level stall detector can't see it.
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 30_000 }, // hold far past the per-tool budget; no tool_execution_end
			],
		});
		const id = `async-tool-timeout-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000, // run-level budget is longer; the per-tool timer must fire first
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "failed");
			assert.equal(payload.results[0]?.timedOut, true);
			assert.match(payload.results[0]?.error ?? "", /Tool 'bash' exceeded its timeout of 1000ms\./);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("background keeps a terminal answer authoritative over an earlier tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 50, jsonl: [events.assistantMessage("Done")] },
			],
			keepAliveAfterFinalMessageMs: 1_500,
		});
		const id = `async-terminal-tool-timeout-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "600";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Do work" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 5_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.timedOut, undefined);
			assert.equal(payload.results[0]?.output, "Done");
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("keeps an earlier wedged tool armed when another tool starts and ends", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: {} }] },
				{ delay: 50, jsonl: [
					{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
					{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" },
				] },
				{ delay: 30_000 },
			],
		});
		const id = `async-tool-timeout-overlap-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "failed");
			assert.equal(payload.results[0]?.timedOut, true);
			assert.match(payload.results[0]?.error ?? "", /Tool 'bash' exceeded its timeout of 1000ms\./);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("lets the shorter run-level deadline win over a per-tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("bash")] },
				{ delay: 30_000 },
			],
		});
		const id = `async-tool-timeout-run-budget-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Wait" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 300,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.results[0]?.timedOut, true);
			assert.equal(payload.results[0]?.error, "Subagent timed out after 300ms.");
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("does not kill a tool that completes before the per-tool timeout", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash"),
				events.toolEnd("bash"),
				events.assistantMessage("done"),
				{ type: "agent_end", willRetry: false },
				{ type: "agent_settled" },
			],
		});
		const id = `async-tool-complete-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Done" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "complete");
			assert.notEqual(payload.results[0]?.timedOut, true);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("does not apply the per-tool timeout to supervisor tools (contact_supervisor/intercom)", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		// contact_supervisor holds ~1.5s — longer than the 1s per-tool budget — but
		// is allowlisted, so the per-tool timer must not fire.
		mockPi.onCall({
			steps: [
				{
					delay: 1500,
					jsonl: [
						events.toolStart("contact_supervisor"),
						events.toolEnd("contact_supervisor"),
						events.assistantMessage("done"),
						{ type: "agent_end", willRetry: false },
						{ type: "agent_settled" },
					],
				},
			],
		});
		const id = `async-tool-allowlist-${Date.now().toString(36)}`;
		process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS = "1000";
		try {
			executeAsyncChain(id, {
				chain: [{ agent: "one", task: "Ask" }],
				agents: [makeAgent("one")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				maxSubagentDepth: 2,
				timeoutMs: 8_000,
			});

			const payload = await readAsyncPayload(id);
			assert.equal(payload.state, "complete");
			assert.notEqual(payload.results[0]?.timedOut, true);
		} finally {
			delete process.env.PI_SUBAGENT_TOOL_TIMEOUT_MS;
		}
	});

	it("enforces child timeouts on async parallel tasks without a composite deadline", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ delay: 5_000, output: "one too late" });
		mockPi.onCall({ delay: 5_000, output: "two too late" });
		const id = `async-child-timeout-parallel-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "slow-one", task: "Wait" },
					{ agent: "slow-two", task: "Wait" },
				],
				concurrency: 2,
			}],
			resultMode: "parallel",
			agents: [
				makeAgent("slow-one", { defaultTimeoutMs: 150 }),
				makeAgent("slow-two", { defaultTimeoutMs: 200 }),
			],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		assert.equal(payload.timeoutMs, undefined, "composite parent must remain unbounded by default");
		assert.equal(payload.state, "failed");
		assert.deepEqual(payload.results.map((result) => result.timedOut), [true, true]);
		assert.deepEqual(payload.results.map((result) => result.error), ["Subagent timed out after 150ms.", "Subagent timed out after 200ms."]);
	});

	it("hard-kills async children that ignore timeout SIGTERM", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 60_000, ignoreSigterm: true, output: "too late" });
		const id = `async-timeout-hard-kill-${Date.now().toString(36)}`;
		const timeoutMs = process.platform === "win32" ? 5_000 : 1_500;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "stubborn",
			task: "Ignore soft termination",
			agentConfig: makeAgent("stubborn", { model: "primary-model", fallbackModels: ["fallback-model"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
		});

		await waitForMockPiCall(mockPi, 0, 10_000);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.error, `Subagent timed out after ${timeoutMs}ms.`);
		assert.equal(status.timedOut, true);
		assert.equal(status.steps?.[0]?.timedOut, true);
		assert.ok(elapsedMs < timeoutMs + 4_000, `timeout result should settle after hard kill, elapsed ${elapsedMs}ms`);
		assert.equal(mockPi.callCount(), 1);
	});

	it("cancels async acceptance verification when the run times out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "implementation complete" });
		const id = `async-timeout-acceptance-${Date.now().toString(36)}`;
		const timeoutMs = 1_000;
		const startedAt = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement with verified acceptance",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: true,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: true,
				cleanupDays: 7,
			},
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs,
			acceptance: {
				level: "verified",
				verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 30000)"`, timeoutMs: 60_000 }],
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results[0]?.timedOut, true);
		assert.equal(payload.results[0]?.acceptance?.status, "rejected");
		assert.equal(payload.results[0]?.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.equal(status.steps?.[0]?.timedOut, true);
		const metadataPath = payload.results[0]?.artifactPaths?.metadataPath;
		assert.ok(metadataPath);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { acceptance?: { status?: string; runtimeChecks?: Array<{ id?: string }> } };
		assert.equal(metadata.acceptance?.status, "rejected");
		assert.equal(metadata.acceptance?.runtimeChecks?.[0]?.id, "timeout");
		assert.ok(elapsedMs < timeoutMs + 4_000, `timeout should cancel acceptance verification well before the verify command completes, elapsed ${elapsedMs}ms`);
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const emitted: Array<{ channel: string; data: unknown }> = [];
		const commonParams = {
			ctx: {
				pi: { events: { emit(channel: string, data: unknown) { emitted.push({ channel, data }); } } },
				cwd: tempDir,
				currentSessionId: "session-1",
			},
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		const startedEvent = (id: string): { task?: string; goal?: string } => {
			const event = emitted.find((entry) => entry.channel === SUBAGENT_ASYNC_STARTED_EVENT && (entry.data as { id?: string }).id === id);
			assert.ok(event, `missing async-started event for ${id}`);
			return event.data as { task?: string; goal?: string };
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const wrappedTask = `Fork preamble: ${"execution ".repeat(20)}`;
		const rawGoal = `Caller-facing goal: ${"raw ".repeat(40)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: wrappedTask,
			goal: rawGoal,
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /Use bg_wait only/i);
		assert.match(singleResult.content[0]?.text ?? "", /non-interactive run: Pi auto-drains current-session subagent work at agent_end/);
		assert.equal(startedEvent(singleId).task, "[prompt redacted]");
		assert.equal(startedEvent(singleId).goal, "[prompt redacted]");
		await waitForAsyncResultFile(singleId, 30_000);

		mockPi.onCall({ output: "interactive done" });
		const interactiveId = `async-handoff-interactive-${Date.now().toString(36)}`;
		const interactiveResult = executeAsyncSingle(interactiveId, {
			agent: "worker",
			task: "Interactive handoff",
			agentConfig: makeAgent("worker"),
			...commonParams,
			ctx: { ...commonParams.ctx, interactive: true },
		});
		assert.match(interactiveResult.content[0]?.text ?? "", /interactive session/);
		assert.match(interactiveResult.content[0]?.text ?? "", /return control to the user/);
		assert.match(interactiveResult.content[0]?.text ?? "", /does not need a wait call/);
		assert.match(interactiveResult.content[0]?.text ?? "", /native completion notification/);
		assert.doesNotMatch(interactiveResult.content[0]?.text ?? "", /bg_wait\(\{ id:/);
		assert.doesNotMatch(interactiveResult.content[0]?.text ?? "", /auto-drain/);
		await waitForAsyncResultFile(interactiveId, 30_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /Use bg_wait only/i);
		assert.equal(startedEvent(parallelId).goal, "[prompt redacted]");
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainGoal = `Coordinate the complete workflow ${"goal ".repeat(30)}`;
		const chainChildTask = `Do chained work ${"child ".repeat(15)}`;
		const chainResult = executeAsyncChain(chainId, {
			task: chainGoal,
			chain: [{ agent: "worker", task: chainChildTask }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		const chainEvent = startedEvent(chainId);
		assert.equal(chainEvent.task, "[prompt redacted]");
		assert.equal(chainEvent.goal, "[prompt redacted]");
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("fails background chains when requested extension tools are unavailable", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Model incorrectly claimed success", missingTools: ["fixture_search"] });
		const id = `async-missing-extension-tool-${Date.now().toString(36)}`;

		executeAsyncChain(id, {
			chain: [{ agent: "extension-worker", task: "Use fixture search" }],
			agents: [makeAgent("extension-worker", { tools: ["read", "fixture_search"] })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.results[0]?.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.match(payload.results[0]?.error ?? "", /subagentOnlyExtensions/);
	});

	it("records blocked mutation effects when background implementation tools are missing", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I cannot edit because fixture_search is missing", missingTools: ["fixture_search"] });
		const id = `async-missing-implementation-tool-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the requested source fix",
			agentConfig: makeAgent("worker", { tools: ["read", "fixture_search"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			acceptance: false,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "failed");

		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.match(payload.results[0]?.error ?? "", /requested unavailable child tools: fixture_search/);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /completed without making edits/);
		assert.equal(payload.results[0]?.effects?.fileMutation?.status, "blocked");
		assert.equal(payload.results[0]?.effects?.fileMutation?.expected, true);
		assert.equal(payload.results[0]?.effects?.fileMutation?.attempted, false);
		assert.match(payload.results[0]?.effects?.fileMutation?.message ?? "", /requested unavailable child tools: fixture_search/);
		assert.equal(statusPayload.steps?.[0]?.effects?.fileMutation?.status, "blocked");
	});

	it("applies agent acceptance roles to inferred async acceptance", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "exploration complete" });
		const executor = makeAsyncExecutor([makeAgent("worker", { acceptanceRole: "read-only" })]);

		const result = await executor.execute(
			"async-agent-acceptance-role",
			{ agent: "worker", task: "Explore the authentication flow", async: true, clarify: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const payload = await readAsyncPayload(asyncId);
		assert.equal(payload.results[0]?.acceptance?.effectiveAcceptance.level, "none");
	});



	it("infers async chain acceptance after expanding top-level task templates", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "patched" });
		mockPi.onCall({ output: "reviewed" });

		const patchId = `async-role-task-template-patch-${Date.now().toString(36)}`;
		executeAsyncChain(patchId, {
			task: "Patch src/auth.ts",
			chain: [{ agent: "explorer", task: "{task}" }],
			agents: [makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-patch" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const patchPayload = await readAsyncPayload(patchId);
		assert.equal(patchPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "checked");

		const reviewId = `async-role-task-template-review-${Date.now().toString(36)}`;
		executeAsyncChain(reviewId, {
			task: "Review only; do not edit files",
			chain: [{ agent: "implementer", task: "{task}" }],
			agents: [makeAgent("implementer", { acceptanceRole: "writer" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-role-task-review" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const reviewPayload = await readAsyncPayload(reviewId);
		assert.equal(reviewPayload.results[0]?.acceptance?.effectiveAcceptance?.level, "none");
	});









	it("async chain static parallel namespaces inherited default outputs", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Write first", output: "chain first report" });
		mockPi.onCall({ matchArgIncludes: "Write second", output: "chain second report" });
		const id = `async-chain-parallel-output-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "worker", task: "Write first" }, { agent: "worker", task: "Write second" }] }],
			agents: [makeAgent("worker", { output: "context.md" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-chain-output" },
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true);
		const outputDir = path.join(tempDir, ".pi/subagents", "artifacts", "outputs", id);
		const authoritativePaths = [
			path.join(outputDir, "parallel-0", "0-worker", "context.md"),
			path.join(outputDir, "parallel-0", "1-worker", "context.md"),
		];
		assert.equal(fs.readFileSync(authoritativePaths[0]!, "utf-8"), "chain first report");
		assert.equal(fs.readFileSync(authoritativePaths[1]!, "utf-8"), "chain second report");
		const artifactPaths = payload.results.map((result) => result.artifactPaths?.outputPath);
		assert.ok(artifactPaths[0] && artifactPaths[1]);
		assert.notEqual(artifactPaths[0], artifactPaths[1]);
		assert.equal(fs.readFileSync(artifactPaths[0], "utf-8"), "chain first report");
		assert.equal(fs.readFileSync(artifactPaths[1], "utf-8"), "chain second report");
		const calls = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const taskArgs = calls.map((name) => {
			const call = JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as MockPiCallRecord;
			return resolveMockPiCallArgs(call).at(-1) ?? "";
		});
		assert.ok(taskArgs.find((task) => task.includes("Write first"))?.includes(path.join("parallel-0", "0-worker", "context.md")));
		assert.ok(taskArgs.find((task) => task.includes("Write second"))?.includes(path.join("parallel-0", "1-worker", "context.md")));
	});

	it("async single preserves checked evidence while independent review is pending", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { level: "checked", criteria: ["Patch bug"], review: { agent: "reviewer", required: true } },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(result.success, true);
		assert.equal(result.results[0]?.acceptance?.status, "review-required");
		assert.equal(result.results[0]?.acceptance?.evidenceStatus, "checked");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "review-required");
		assert.equal(status.steps?.[0]?.acceptance?.status, "review-required");
	});



	it("async chains reject malformed named output references before spawning", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async chains can start parallel, funnel into one step, then fan back out", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Scout API", output: "Scout A async findings" });
		mockPi.onCall({ matchArgIncludes: "Scout UI", output: "Scout B async findings" });
		mockPi.onCall({ matchArgIncludes: "Synthesize:", output: "Async funnel synthesis" });
		mockPi.onCall({ matchArgIncludes: "Review funnel A:", output: "Async reviewer A done" });
		mockPi.onCall({ matchArgIncludes: "Review funnel B:", output: "Async reviewer B done" });
		const id = `async-parallel-funnel-fanout-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					parallel: [
						{ agent: "scout-a", task: "Scout API" },
						{ agent: "scout-b", task: "Scout UI" },
					],
					concurrency: 2,
				},
				{ agent: "synthesizer", task: "Synthesize:\n{previous}" },
				{
					parallel: [
						{ agent: "review-a", task: "Review funnel A:\n{previous}" },
						{ agent: "review-b", task: "Review funnel B:\n{previous}" },
					],
					concurrency: 2,
				},
			],
			agents: [makeAgent("scout-a"), makeAgent("scout-b"), makeAgent("synthesizer"), makeAgent("review-a"), makeAgent("review-b")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-parallel-funnel-fanout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError, `should launch: ${JSON.stringify(result.content)}`);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "complete");
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results.map((entry) => entry.output), [
			"Scout A async findings",
			"Scout B async findings",
			"Async funnel synthesis",
			"Async reviewer A done",
			"Async reviewer B done",
		]);
		assert.deepEqual(status.steps?.map((step) => step.status), ["complete", "complete", "complete", "complete", "complete"]);
		assert.deepEqual(status.parallelGroups, [
			{ start: 0, count: 2, stepIndex: 0 },
			{ start: 3, count: 2, stepIndex: 2 },
		]);
		const funnelTask = readMockPiArgsMatching(mockPi, "Synthesize:").at(-1) ?? "";
		assert.match(funnelTask, /=== Parallel Task 1 \(scout-a\) ===/);
		assert.match(funnelTask, /Scout A async findings/);
		assert.match(funnelTask, /=== Parallel Task 2 \(scout-b\) ===/);
		assert.match(funnelTask, /Scout B async findings/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel A:").at(-1) ?? "", /Review funnel A:\nAsync funnel synthesis/);
		assert.match(readMockPiArgsMatching(mockPi, "Review funnel B:").at(-1) ?? "", /Review funnel B:\nAsync funnel synthesis/);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "step");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.kind, "parallel-group");
		assert.equal(payload.workflowGraph?.nodes?.[2]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ matchArgIncludes: "Review src/a.ts", output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ matchArgIncludes: "Review src/b.ts", output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { output: "context.md" }), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			artifactsDir: path.join(tempDir, ".pi/subagents", "artifacts"),
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		assert.deepEqual(status.steps?.slice(1, 3).map((step) => step.sessionName), ["reviewer: Review src/a.ts", "reviewer: Review src/b.ts"]);
		assert.deepEqual(payload.results.slice(1, 3).map((result) => result.sessionName), ["reviewer: Review src/a.ts", "reviewer: Review src/b.ts"]);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const outputDir = path.join(tempDir, ".pi/subagents", "artifacts", "outputs", id);
		const dynamicOutputPaths = [
			path.join(outputDir, "dynamic-1", "0-reviewer", "context.md"),
			path.join(outputDir, "dynamic-1", "1-reviewer", "context.md"),
		];
		assert.equal(fs.readFileSync(dynamicOutputPaths[0]!, "utf-8"), "review-a");
		assert.equal(fs.readFileSync(dynamicOutputPaths[1]!, "utf-8"), "review-b");
		const reviewerArtifacts = payload.results.slice(1, 3).map((result) => result.artifactPaths?.outputPath);
		assert.ok(reviewerArtifacts[0] && reviewerArtifacts[1]);
		assert.notEqual(reviewerArtifacts[0], reviewerArtifacts[1]);
		assert.equal(fs.readFileSync(reviewerArtifacts[0], "utf-8"), "review-a");
		assert.equal(fs.readFileSync(reviewerArtifacts[1], "utf-8"), "review-b");
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", new RegExp(dynamicOutputPaths[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", new RegExp(dynamicOutputPaths[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("async dynamic fanout blocks queued children when hard reported usage is exhausted", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ matchArgIncludes: "Review src/a.ts", output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-usage-budget-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			usageBudget: { tokens: { hard: 200 } },
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-budget" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(mockPi.callCount(), 2);
		assert.equal(payload.success, false);
		assert.equal(payload.usageBudget?.exhausted, true);
		assert.equal(status.steps?.[1]?.status, "complete");
		assert.equal(status.steps?.[2]?.status, "failed");
		assert.match(status.steps?.[2]?.error ?? "", /Usage budget exhausted/);
		assert.equal(payload.results.find((result) => result.agent === "reviewer" && result.skipped)?.skipped, true);
	});

	it("rejects a shared explicit output before dynamic fanout children start", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ matchArgIncludes: "Produce targets", output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-explicit-output-${Date.now().toString(36)}`;
		const launch = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {target.path}", output: "shared.md" },
					collect: { as: "reviews" },
					concurrency: 2,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-explicit-output" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(launch.isError, undefined);
		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		const error = payload.results.find((result) => result.error)?.error ?? "";
		assert.match(error, /materialized 2 items that resolve output to the same path/);
		assert.match(error, /shared\.md/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("async dynamic fanout applies fork session files and thinking overrides to materialized children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		const id = `async-dynamic-fork-thinking-${Date.now().toString(36)}`;
		const sessionA = path.join(tempDir, "dynamic-a.jsonl");
		const sessionB = path.join(tempDir, "dynamic-b.jsonl");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
					},
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer", { model: "anthropic/claude-sonnet-4-5:high", thinking: "high" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionFilesByFlatIndex: [undefined, sessionA, sessionB],
			thinkingOverridesByFlatIndex: [undefined, "off", "off"],
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		const firstDynamicArgs = readMockPiArgs(mockPi, 1);
		const secondDynamicArgs = readMockPiArgs(mockPi, 2);
		assert.equal(payload.success, true);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--session") + 1], sessionA);
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--session") + 1], sessionB);
		assert.equal(firstDynamicArgs[firstDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.equal(secondDynamicArgs[secondDynamicArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5:off");
		assert.deepEqual(status.steps?.slice(1).map((step) => step.sessionFile), [sessionA, sessionB]);
		assert.deepEqual(status.steps?.slice(1).map((step) => step.thinking), ["off", "off"]);
	});

	it("applies read-only acceptance roles to async dynamic children and their aggregate group", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const readOnlyReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "inspection complete" }],
				changedFiles: [],
				testsAddedOrUpdated: [],
				commandsRun: [],
				validationOutput: [],
				reviewFindings: ["No blocking findings"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: readOnlyReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-acceptance-role-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Explore {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["none", "none"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(dynamicNode?.acceptanceStatus, "not-required");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["not-required", "not-required"]);
	});

	it("infers async dynamic acceptance after materializing item templates", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const writerReport = [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patch complete" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["tests passed"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: writerReport, structuredOutput: { ok: "b" } });
		const id = `async-dynamic-role-item-template-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
					parallel: { agent: "explorer", task: "Patch {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
			],
			agents: [makeAgent("producer"), makeAgent("explorer", { acceptanceRole: "read-only" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-role-item" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = await readAsyncPayload(id);
		const explorerResults = payload.results.filter((child) => child.agent === "explorer");
		assert.deepEqual(explorerResults.map((child) => child.acceptance?.effectiveAcceptance?.level), ["checked", "checked"]);
		const dynamicNode = payload.workflowGraph?.nodes?.[1];
		assert.equal(payload.success, true);
		assert.equal(dynamicNode?.acceptanceStatus, "rejected");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["rejected", "rejected"]);
	});

	it("cancels dynamic fanout aggregate acceptance when the run times out", { skip: !isAsyncAvailable() ? "jiti not available" : process.platform === "win32" ? "timeout signal delivery intermittent on Windows CI" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-acceptance-timeout-${Date.now().toString(36)}`;
		const startedAt = Date.now();
		executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
					collect: { as: "reviews" },
					acceptance: {
						level: "verified",
						verify: [{ id: "slow", command: `${process.execPath} -e "setTimeout(()=>process.exit(0), 5000)"`, timeoutMs: 10_000 }],
					},
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-acceptance-timeout" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			timeoutMs: 1_000,
		});

		const resultPath = await waitForAsyncResultFile(id, 5_000);
		const elapsedMs = Date.now() - startedAt;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed");
		const dynamicNode = payload.workflowGraph?.nodes?.[1] as { status?: string; error?: string; acceptanceStatus?: string } | undefined;
		assert.equal(payload.state, "failed");
		assert.equal(payload.timedOut, true);
		assert.equal(payload.results.at(-1)?.timedOut, true);
		assert.equal(payload.results.at(-1)?.acceptance, undefined);
		assert.equal(dynamicNode?.status, "failed");
		assert.match(dynamicNode?.error ?? "", /Subagent timed out after 1000ms\./);
		assert.notEqual(dynamicNode?.acceptanceStatus, "verified");
		assert.equal(status.timedOut, true);
		assert.ok(elapsedMs < 3_000, `timeout should cancel dynamic aggregate acceptance promptly, elapsed ${elapsedMs}ms`);
	});

	it("async dynamic fanout recomputes later child intercom targets by final flat index", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "consumed" });
		const id = `async-dynamic-targets-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-targets" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			controlIntercomTarget: "subagent-orchestrator-test",
			childIntercomTarget: (agent: string, index: number) => `subagent-${agent}-${id}-${index + 1}`,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const expectedConsumerTarget = `subagent-consumer-${id}-4`;
		assert.equal(payload.success, true);
		assert.equal(payload.results[3]?.intercomTarget, expectedConsumerTarget);
		assert.equal((await waitForMockPiRuntime(mockPi, 3)).intercomSessionName, expectedConsumerTarget);
	});

	it("async dynamic pre-spawn failures persist failed graph status and error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-prespawn-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = await waitForAsyncState(id, (candidate) => candidate.state === "failed") as AsyncStatusPayload & { workflowGraph?: AsyncResultPayload["workflowGraph"]; error?: string };
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /exceeding maxItems 1/);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.workflowGraph?.nodes?.[1]?.status, "failed");
	});

	it("async dynamic collect schema failures persist failed graph status and details", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-collect-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: "object" } },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-collect-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(payload.results.at(-1)?.structuredOutput), "failed collect result should preserve ordered collection details");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /Collected output validation failed/);
	});



	it("readStatus caches ordered sweeps above 50 files and invalidates same-mtime replacements", () => {
		const root = createTempDir();
		try {
			const fixedTimestamp = new Date(1_700_000_000_000);
			const dirs = Array.from({ length: 51 }, (_, index) => {
				const dir = path.join(root, `run-${index}`);
				const statusPath = path.join(dir, "status.json");
				fs.mkdirSync(dir);
				fs.writeFileSync(statusPath, JSON.stringify({
					runId: `cache-test-${index}`,
					state: "running",
					mode: "single",
					startedAt: fixedTimestamp.getTime(),
				}));
				fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
				return dir;
			});

			const cached = dirs.map((dir) => readStatus(dir));
			cached.forEach((status) => assert.ok(status));
			dirs.forEach((dir, index) => assert.strictEqual(readStatus(dir), cached[index]));

			const replacedDir = dirs[25]!;
			const cachedStatus = cached[25];
			assert.ok(cachedStatus);
			const statusPath = path.join(replacedDir, "status.json");
			writeAtomicJson(statusPath, { ...cachedStatus, state: "stopped" });
			fs.utimesSync(statusPath, fixedTimestamp, fixedTimestamp);
			assert.equal(fs.statSync(statusPath).mtimeMs, fixedTimestamp.getTime());
			const replaced = readStatus(replacedDir);
			assert.ok(replaced);
			assert.equal(replaced.state, "stopped");
			assert.notStrictEqual(replaced, cachedStatus);

			fs.rmSync(statusPath);
			assert.equal(readStatus(replacedDir), null);

			const removedDir = dirs[50]!;
			assert.ok(readStatus(removedDir));
			fs.rmSync(removedDir, { recursive: true, force: true });
			assert.equal(pruneStatusCacheForAsyncRoot(root, dirs.slice(0, 50).map((dir) => path.basename(dir))), 1);
		} finally {
			removeTempDir(root);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 300, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			acceptance: { level: "none", reason: "descriptor persistence coverage" },
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const descriptorPath = path.join(asyncDir, "recovery-descriptor.json");
		const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf-8"));
		assert.equal(descriptor.sourceRunId, id);
		assert.equal(descriptor.agent, "worker");
		assert.equal(descriptor.model, "openai/gpt-5-mini:high");
		assert.deepEqual(descriptor.fallbackModels, ["anthropic/claude-sonnet-4:low"]);
		assert.equal(descriptor.cwd, tempDir);
		assert.equal(descriptor.sessionDir, path.join(sessionRoot, `async-${id}`));
		assert.deepEqual(descriptor.acceptance, { level: "none", reason: "descriptor persistence coverage" });
		assert.equal(descriptor.initialTurnBudget, undefined);
		assert.equal(Object.hasOwn(descriptor.acceptance, "explicit"), false);
		assert.equal(Object.hasOwn(descriptor.acceptance, "inferredReason"), false);
		assert.equal(Object.hasOwn(descriptor, "task"), false);
		if (process.platform !== "win32") assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		assert.deepEqual(payload.results[0].totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(payload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const statusPayload = await waitForAsyncState(id, (candidate) => candidate.state === "complete"
			&& candidate.lifecycleArtifactVersion !== undefined
			&& candidate.totalTokens?.total !== undefined
			&& candidate.totalCost !== undefined
			&& candidate.steps[0]?.model !== undefined
			&& candidate.steps[0]?.thinking !== undefined
			&& candidate.steps[0]?.tokens?.total !== undefined
			&& candidate.steps[0]?.totalCost !== undefined);
		assert.equal(statusPayload.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.equal(statusPayload.totalTokens!.window, 100);
		assert.equal(statusPayload.totalTokens!.windowPeak, 310);
		assert.equal(statusPayload.steps[0]?.tokens!.window, 100);
		assert.equal(statusPayload.steps[0]?.tokens!.windowPeak, 310);
		assert.deepEqual(statusPayload.steps[0]?.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.deepEqual(statusPayload.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(events.find((event) => event.type === "subagent.run.started")?.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		const completed = await waitForAsyncEvent(id, "subagent.run.completed");
		assert.equal(completed.lifecycleArtifactVersion, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION);
		assert.deepEqual(completed.totalCost, { inputTokens: 110, outputTokens: 55, costUsd: 0.011 });
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs accept captured response aliases for the resolved fallback without rewriting its route", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [], stderr: "429 rate limit exceeded", exitCode: 1 });
		mockPi.onCall({ jsonl: [events.assistantMessage("Declared async echo accepted", "claude-opus-5")] });
		const id = `async-response-alias-fallback-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Say hello",
			acceptance: false,
			agentConfig: makeAgent("worker", { model: "mock/primary", fallbackModels: ["ias-claude-opus-5:high"] }),
			ctx: {
				pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1",
				modelResponseAliases: { "databricks-bedrock/ias-claude-opus-5": ["claude-opus-5"] },
			},
			availableModels: [
				{ provider: "mock", id: "primary", fullId: "mock/primary" },
				{ provider: "databricks-bedrock", id: "ias-claude-opus-5", fullId: "databricks-bedrock/ias-claude-opus-5" },
			],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true, payload.results[0]?.error);
		assert.equal(payload.results[0]?.model, "databricks-bedrock/ias-claude-opus-5:high");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["mock/primary", "databricks-bedrock/ias-claude-opus-5:high"]);
		assert.equal(payload.results[0]?.modelAttempts?.[1]?.success, true);
		const args = readMockPiArgs(mockPi, 1);
		assert.equal(args[args.indexOf("--model") + 1], "databricks-bedrock/ias-claude-opus-5:high");
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail when a configured provider-qualified model starts on a different child model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ jsonl: [events.assistantMessage("wrong async provider", "openai-codex/gpt-5.6-sol")] });
		const id = `async-model-verification-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "opencode-go/ox-alpha-free:max" }),
			ctx: {
				pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1",
				modelResponseAliases: { "opencode-go/ox-alpha-free": ["declared-echo"] },
			},
			availableModels: [
				{ provider: "opencode-go", id: "ox-alpha-free", fullId: "opencode-go/ox-alpha-free" },
				{ provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.model, "opencode-go/ox-alpha-free:max");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["opencode-go/ox-alpha-free:max"]);
		assert.equal(payload.results[0]?.modelAttempts?.[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /model_verification_failed/);
		assert.match(payload.results[0]?.error ?? "", /Expected 'opencode-go\/ox-alpha-free:max'/);
		assert.match(payload.results[0]?.error ?? "", /observed 'openai-codex\/gpt-5\.6-sol'/);
		assert.match(payload.results[0]?.modelAttempts?.[0]?.error ?? "", /model_verification_failed/);
		const args = readMockPiArgs(mockPi, 0);
		assert.equal(args[args.indexOf("--model") + 1], "opencode-go/ox-alpha-free:max");
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs retry the fallback model when the provider stream ends without finish_reason", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "stream broke mid-response" }],
					model: "openai/gpt-5-mini",
					errorMessage: "Stream ended without finish_reason",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after stream failure" });
		const id = `async-fallback-stream-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.match(payload.results[0].output ?? "", /Recovered after stream failure/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs retry the fallback model after a provider connection error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					model: "openai/gpt-5-mini",
					errorMessage: "Connection error.",
					usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered after connection error" });
		const id = `async-fallback-connection-error-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.match(payload.results[0].modelAttempts[0].error ?? "", /Connection error/u);
		assert.match(payload.results[0].output ?? "", /Recovered after connection error/u);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs do not retry the fallback model for a trailing tool failure", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				mockAssistantMessage("checking connectivity", "tool_use"),
				events.toolResult("bash", "curl: (28) Connection timed out after 5000 ms\nCommand exited with code 1", true),
			],
			exitCode: 0,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const id = `async-fallback-toolfail-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.results[0].modelAttempts.length, 1);
		assert.match(payload.results[0].error ?? "", /^bash failed \(exit 1\)/);
		assert.match(payload.results[0].error ?? "", /timed out/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs do not retry raw connection stderr after child activity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "completed side effect" }],
					model: "openai/gpt-5-mini",
					stopReason: "stop",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			stderr: "APIConnectionError: Connection closed.",
			exitCode: 1,
		});
		mockPi.onCall({ output: "fallback must not run" });
		const id = `async-fallback-raw-stderr-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.results[0].modelAttempts.length, 1);
		assert.match(payload.results[0].error ?? "", /Connection closed/u);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background runs resume the retained session once after a compaction-induced abort following completed tool work", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sessionFile = path.join(tempDir, "async-abort-recovery-session.jsonl");
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
		mockPi.onCall({ output: "Recovered asynchronously from retained session" });
		const id = `async-fallback-provider-after-tool-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			sessionFile,
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, true);
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high"]);
		assert.deepEqual(payload.results[0].modelAttempts.map((attempt: { success: boolean }) => attempt.success), [false, true]);
		assert.equal(mockPi.callCount(), 2);
		const firstArgs = readMockPiArgs(mockPi, 0);
		const resumedArgs = readMockPiArgs(mockPi, 1);
		assert.equal(firstArgs[firstArgs.indexOf("--session") + 1], sessionFile);
		assert.equal(resumedArgs[resumedArgs.indexOf("--session") + 1], sessionFile);
		assert.match(resumedArgs.at(-1) ?? "", /Continue from the current files and transcript/);
		assert.equal(fs.readFileSync(path.join(tempDir, "side-effect.txt"), "utf-8"), "done");
	});

	it("background compaction abort without a retained session does not fall back", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("I inspected the source."),
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
			keepAliveAfterFinalMessageMs: 5_000,
			exitCode: 0,
		});
		mockPi.onCall({ output: "Fallback must not run" });
		const id = `async-compaction-abort-no-session-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /Compaction-induced child abort could not be resumed safely: retained session unavailable\./);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /Fallback must not run/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background does not use compaction recovery for a generic empty assistant abort after a compaction retry", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const sessionFile = path.join(tempDir, "async-generic-empty-after-compaction-retry-session.jsonl");
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
		const id = `async-no-compaction-recovery-after-retry-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			sessionFile,
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8"));
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /Subagent produced no output after terminal assistant stopReason "aborted"\./u);
		assert.equal(payload.results[0]?.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

});
