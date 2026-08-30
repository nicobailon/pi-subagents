import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { writeAsyncResultFile } from "../../src/runs/background/result-files.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";
import { WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV, WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import { recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import type { AsyncStatus, SubagentState } from "../../src/shared/types.ts";

function writeStatus(asyncRoot: string, runId: string, state: AsyncStatus["state"], extra: object = {}): void {
	const dir = path.join(asyncRoot, runId);
	fs.mkdirSync(dir, { recursive: true });
	// Use a recent timestamp so the stale-run reconciler doesn't mark a live
	// "running" fixture as failed for having a stale heartbeat.
	const nowMs = Date.now();
	fs.writeFileSync(
		path.join(dir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state,
			startedAt: nowMs,
			lastUpdate: nowMs,
			steps: [{ agent: "worker", status: state }],
			...extra,
		}),
		"utf-8",
	);
	updateActiveRunIndex(dir, state);
}

function writeRecoveryDescriptor(asyncRoot: string, runId: string, agent: string, sessionFile: string, cwd: string): void {
	fs.writeFileSync(path.join(asyncRoot, runId, "recovery-descriptor.json"), JSON.stringify({
		version: 1,
		sourceRunId: runId,
		agent,
		sessionFile,
		cwd,
		systemPromptMode: "append",
		outputMode: "inline",
		inheritGlobalContext: false,
		inheritProjectContext: false,
		inheritSkills: false,
		maxSubagentDepth: 0,
		share: false,
		runFanoutBudget: createRunFanoutBudget(runId, 64),
	}), "utf-8");
}

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

function baseDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps> = {}): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		// Never probe real PIDs in tests — treat every recorded pid as alive so
		// reconciliation doesn't flip a "running" fixture to failed.
		kill: () => true,
		pollIntervalMs: 250,
		...overrides,
	};
}

describe("bg_wait tool", () => {
	it("resolves waitTool config and environment overrides strictly", () => {
		assert.deepEqual(resolveWaitToolConfig(undefined, {}), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(false, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, {}), { enabled: false });
		assert.deepEqual(resolveWaitToolConfig({ defaultTimeoutMs: 120_000 }, {}), { enabled: true, defaultTimeoutMs: 120_000 });
		assert.deepEqual(resolveWaitToolConfig({ defaultTimeoutMs: 120_000 }, { [WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]: "3000" }), { enabled: true, defaultTimeoutMs: 3_000 });
		assert.deepEqual(resolveWaitToolConfig({ enabled: false }, { [WAIT_TOOL_ENABLED_ENV]: "true" }), { enabled: true });
		assert.deepEqual(resolveWaitToolConfig(true, { [WAIT_TOOL_ENABLED_ENV]: "off" }), { enabled: false });
		assert.throws(() => resolveWaitToolConfig("false" as never, {}), /config\.waitTool/);
		assert.throws(() => resolveWaitToolConfig({ enabled: "false" } as never, {}), /config\.waitTool\.enabled/);
		assert.throws(() => resolveWaitToolConfig({ defaultTimeoutMs: 0 }, {}), /config\.waitTool\.defaultTimeoutMs/);
		assert.throws(() => resolveWaitToolConfig({ defaultTimeoutMs: 1.5 }, {}), /config\.waitTool\.defaultTimeoutMs/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]: "0" }), /PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS/);
		assert.throws(() => resolveWaitToolConfig(undefined, { [WAIT_TOOL_ENABLED_ENV]: "maybe" }), /PI_SUBAGENT_WAIT_TOOL_ENABLED/);
	});

	it("returns immediately without polling when waitTool is disabled", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-disabled-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let slept = false;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				enabled: false,
				sleep: async () => {
					slept = true;
					throw new Error("disabled bg_wait should not sleep");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /disabled/i);
			assert.match(textOf(result), /without blocking/i);
			assert.equal(slept, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns immediately when there is nothing to wait for", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-empty-"));
		try {
			const state = makeState("sess-1");
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("with all:true, resolves once every active run reaches a terminal state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-resolve-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "queued", { sessionId: "sess-1", pid: 999998 });

			// Flip one run terminal on the first poll, the other on the second — so
			// all:true must keep waiting past the first completion.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
				if (polls === 2) writeStatus(asyncRoot, "run-b", "failed", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /done/i);
			assert.match(text, /1 complete/);
			assert.match(text, /1 failed/);
			assert.ok(polls >= 2, "all:true should wait for both completions");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("streams active async run status while waiting", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-progress-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-live", "running", {
				sessionId: "sess-1",
				pid: 999999,
				steps: [{
					agent: "worker",
					status: "running",
					currentTool: "edit",
					currentPath: "src/render.ts",
					turnCount: 2,
					toolCount: 4,
				}],
			});
			const updates: string[] = [];
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				onUpdate: (update) => updates.push(textOf(update)),
				sleep: async () => writeStatus(asyncRoot, "run-live", "complete", { sessionId: "sess-1" }),
			}));

			assert.equal(result.isError, undefined);
			assert.equal(updates.length, 1);
			assert.match(updates[0]!, /Waiting .* for 1 async run/);
			assert.match(updates[0]!.split("\n")[0]!, /worker: edit .*src\/render\.ts/);
			assert.match(updates[0]!, /run-live/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces failed terminal runs as errors only for internal auto-drain", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-drain-failure-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-failed", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				failOnFailedRuns: true,
				sleep: async () => writeStatus(asyncRoot, "run-failed", "failed", { sessionId: "sess-1" }),
			}));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /1 failed/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells blocking callers to revive resumable failed runs before replacing them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-revive-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-revive", "running", { sessionId: "sess-1", pid: 999999 });
			writeRecoveryDescriptor(asyncRoot, "run-revive", "worker", sessionFile, root);
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-revive", "failed", {
					sessionId: "sess-1",
					steps: [{ agent: "worker", status: "failed", sessionFile }],
				}),
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 failed/);
			assert.match(text, /Resume-first/);
			assert.match(text, /subagent\(\{ action: "resume", id: "run-revive", message:/);
			assert.match(text, /before reporting failure or launching a replacement/);
			assert.match(text, /only if revive fails or the user explicitly asks/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not advertise resume-first when the recovery descriptor is missing", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-no-recovery-descriptor-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-no-descriptor", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-no-descriptor", "failed", {
					sessionId: "sess-1",
					steps: [{ agent: "worker", status: "failed", sessionFile }],
				}),
			}));

			assert.equal(result.isError, undefined);
			assert.doesNotMatch(textOf(result), /Resume-first/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the single-child run session fallback with a matching recovery descriptor", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-run-session-fallback-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-session-fallback", "running", { sessionId: "sess-1", pid: 999999 });
			writeRecoveryDescriptor(asyncRoot, "run-session-fallback", "worker", sessionFile, root);
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-session-fallback", "failed", {
					sessionId: "sess-1",
					sessionFile,
					steps: [{ agent: "worker", status: "failed" }],
				}),
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /Resume-first/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("tells blocking callers to reply and wait for intercom-detached failed runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-intercom-detach-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "worker-session.jsonl");
			fs.writeFileSync(sessionFile, "{}\n", "utf-8");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-detached", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-detached", "failed", {
					sessionId: "sess-1",
					error: "Step failed: worker",
					steps: [{ agent: "worker", status: "failed", sessionFile, error: "Detached for intercom coordination before task completion." }],
				}),
			}));

			const text = textOf(result);
			assert.match(text, /Reply to the supervisor request first/);
			assert.match(text, /wait with bg_wait/);
			assert.match(text, /do not resume or launch a replacement/);
			assert.doesNotMatch(text, /Resume-first/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces terminal completion payloads from the result file in details.completions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-completions-file-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => {
					writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
					fs.writeFileSync(path.join(resultsDir, "run-a.json"), JSON.stringify({
						id: "run-a",
						runId: "run-a",
						sessionId: "sess-1",
						agent: "workflow",
						mode: "workflow",
						state: "complete",
						success: true,
						results: [{
							agent: "reviewer",
							runId: "a1b2c3d4",
							success: true,
							outputState: "present",
							output: "full output text stays out of details",
							usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, cost: 0.001, turns: 1 },
							artifactPaths: {
								outputPath: "/tmp/a1b2c3d4_reviewer_0_output.md",
								metadataPath: "/tmp/a1b2c3d4_reviewer_0_meta.json",
							},
						}],
					}), "utf-8");
				},
			}));

			assert.equal(result.isError, undefined);
			const completions = result.details.completions;
			assert.equal(completions?.length, 1);
			assert.equal(completions![0]!.runId, "run-a");
			assert.equal(completions![0]!.mode, "workflow");
			assert.equal(completions![0]!.success, true);
			assert.deepEqual(result.usage, { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, totalTokens: 180, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } });
			const child = completions![0]!.results?.[0];
			assert.equal(child?.agent, "reviewer");
			assert.equal(child?.runId, "a1b2c3d4");
			assert.equal(child?.artifactPaths?.metadataPath, "/tmp/a1b2c3d4_reviewer_0_meta.json");
			assert.equal("output" in (child ?? {}), false);
			// The result file is the watcher's to consume; the wait must not delete it.
			assert.equal(fs.existsSync(path.join(resultsDir, "run-a.json")), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces bounded recovery guidance for a failed completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-recovery-completion-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-recovery", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => {
					const recovery = {
						termination: "timed-out",
						changedFiles: ["input.md"],
						recoveryNeeded: true,
						reason: "timed-out-with-dirty-worktree",
						reportStatus: "missing",
						message: "raw recovery message must not cross the wait boundary",
						effects: { settlementDiagnostic: { finalTextPresent: true } },
					};
					writeStatus(asyncRoot, "run-recovery", "failed", {
						sessionId: "sess-1",
						steps: [{ agent: "worker", status: "failed", timedOut: true, timeoutRecovery: recovery }],
					});
					fs.writeFileSync(path.join(resultsDir, "run-recovery.json"), JSON.stringify({
						id: "run-recovery",
						runId: "run-recovery",
						mode: "single",
						state: "failed",
						success: false,
						results: [{ agent: "worker", success: false, error: "Subagent timed out.", output: "raw output must not be copied", timeoutRecovery: recovery }],
					}), "utf-8");
				},
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /Recovery needed: review the diff and artifacts before resuming or launching dependent stages\./);
			assert.match(text, /requested report: missing/);
			assert.match(text, /changed tracked files: input\.md/);
			assert.doesNotMatch(text, /raw recovery message|settlementDiagnostic|raw output/);
			const completion = result.details.completions?.[0];
			assert.equal(completion?.success, false);
			assert.deepEqual(completion?.results?.[0]?.timeoutRecovery, {
				termination: "timed-out",
				changedFiles: ["input.md"],
				recoveryNeeded: true,
				reason: "timed-out-with-dirty-worktree",
				reportStatus: "missing",
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces terminal completion payloads from an indexed pending result file", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-completions-pending-"));
		const originalError = console.error;
		try {
			console.error = () => {};
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const publicResultPath = path.join(resultsDir, "run-pending.json");
			fs.mkdirSync(publicResultPath, { recursive: true });
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-pending", "running", { sessionId: "sess-1", pid: 999999 });

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => {
					writeStatus(asyncRoot, "run-pending", "complete", { sessionId: "sess-1" });
					assert.deepEqual(writeAsyncResultFile(publicResultPath, {
						id: "run-pending",
						runId: "run-pending",
						sessionId: "sess-1",
						agent: "worker",
						mode: "single",
						state: "complete",
						success: true,
						results: [{ agent: "worker", success: true, outputState: "present" }],
					}), { state: "pending" });
				},
			}));

			assert.equal(result.isError, undefined);
			assert.equal(result.details.completions?.[0]?.runId, "run-pending");
			assert.equal(result.details.completions?.[0]?.success, true);
			assert.equal(result.details.completions?.[0]?.results?.[0]?.agent, "worker");
			assert.equal(fs.statSync(publicResultPath).isDirectory(), true);
		} finally {
			console.error = originalError;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports malformed terminal result files as actionable errors", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-completions-malformed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-bad", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => {
					writeStatus(asyncRoot, "run-bad", "complete", { sessionId: "sess-1" });
					fs.writeFileSync(path.join(resultsDir, "run-bad.json"), "{not json", "utf-8");
				},
			}));

			assert.equal(result.isError, true);
			assert.match(textOf(result), /Failed to read subagent result/);
			assert.match(textOf(result), /run-bad\.json/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("surfaces completions from the watcher record when the result file is already consumed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-completions-record-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999999 });
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				sleep: async () => {
					writeStatus(asyncRoot, "run-b", "complete", { sessionId: "sess-1" });
					// Simulates the watcher: payload recorded, file consumed and deleted.
					recordWaitCompletion(state, "run-b", {
						agent: "worker",
						mode: "single",
						state: "complete",
						success: true,
						results: [{ agent: "worker", success: true, outputState: "present" }],
					}, Date.now(), 60_000);
				},
			}));

			assert.equal(result.isError, undefined);
			const completions = result.details.completions;
			assert.equal(completions?.length, 1);
			assert.equal(completions![0]!.runId, "run-b");
			assert.equal(completions![0]!.results?.[0]?.agent, "worker");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when a run needs attention, not only on completion", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// Two runs, all:true so it would normally block until both finish.
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });

			// Neither completes; run-a flags needs_attention (blocked for a decision).
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) {
					writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });
				}
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /need attention/i, "should report the attention run");
			assert.match(text, /steer a top-level live async child, resume a paused\/completed\/failed child, or interrupt explicitly/);
			assert.match(text, /run-a/, "should name the attention run");
			assert.ok(polls <= 2, `should break on attention promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("can keep blocking through idle attention when stopOnAttention is false", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-tolerant-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) {
					writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });
				}
				if (polls === 2) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true, stopOnAttention: false }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /1 complete/);
			assert.equal(polls, 2, "tolerant wait should not return on idle attention");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still stops tolerant waits for supervisor attention", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-tolerant-supervisor-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				writeStatus(asyncRoot, "run-a", "running", {
					sessionId: "sess-1",
					pid: 999999,
					activityState: "needs_attention",
					currentTool: "contact_supervisor",
				});
			};

			const result = await waitForSubagents({ all: true, stopOnAttention: false }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /Reply to any pending supervisor request/);
			assert.match(textOf(result), /run-a/);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns an error for internal auto-drain on supervisor attention", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-drain-supervisor-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			const result = await waitForSubagents({ all: true, stopOnAttention: false }, undefined, baseDeps(root, state, {
				failOnAttention: true,
				sleep: async () => writeStatus(asyncRoot, "run-a", "running", {
					sessionId: "sess-1",
					pid: 999999,
					activityState: "needs_attention",
					currentTool: "contact_supervisor",
				}),
			}));

			assert.equal(result.isError, true);
			assert.match(textOf(result), /Reply to any pending supervisor request/);
			assert.match(textOf(result), /run-a/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports runs that already need attention before waiting starts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-initial-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-blocked", "running", { sessionId: "sess-1", pid: 999999, activityState: "needs_attention" });

			let polls = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				sleep: async () => { polls += 1; },
			}));

			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.doesNotMatch(text, /nothing to wait for/i);
			assert.match(text, /need attention/i);
			assert.match(text, /run-blocked/);
			assert.equal(polls, 0, "initial attention should return without polling");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports step-level attention even when the aggregate flag has not caught up", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-step-attn-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-step-blocked", "running", {
				sessionId: "sess-1",
				pid: 999999,
				steps: [{ agent: "worker", status: "running", activityState: "needs_attention" }],
			});

			let polls = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				sleep: async () => { polls += 1; },
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /need attention/i);
			assert.match(textOf(result), /run-step-blocked/);
			assert.equal(polls, 0, "step-level attention should return without polling");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("by default returns as soon as the FIRST run finishes, leaving the rest in flight", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-first-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-b", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "run-c", "running", { sessionId: "sess-1", pid: 999997 });

			// Only run-a finishes; b and c stay running forever.
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({}, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 of 3 run\(s\) finished/);
			assert.match(text, /1 complete/);
			assert.match(text, /2 run\(s\) still in flight/);
			// Must not have blocked on b and c: a bounded number of polls.
			assert.ok(polls <= 2, `first-completion should return promptly, polled ${polls}`);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("only waits for runs belonging to the current session", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			// A run from another session must be ignored.
			writeStatus(asyncRoot, "run-other", "running", { sessionId: "sess-2", pid: 999999 });
			const result = await waitForSubagents({}, undefined, baseDeps(root, state));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /nothing to wait for/i);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("summarizes only runs that were active when waiting began", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-summary-scope-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "old-complete", "complete", { sessionId: "sess-1" });
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			const sleep = async () => {
				writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /1 complete/);
			assert.doesNotMatch(text, /2 complete/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits for a remembered detached foreground run by id and ignores other sessions", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([
				["foreground-alpha", {
					runId: "foreground-alpha",
					mode: "single",
					cwd: root,
					sessionId: "sess-1",
					updatedAt: 1,
					children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
				}],
				["foreground-other", {
					runId: "foreground-other",
					mode: "single",
					cwd: root,
					sessionId: "sess-2",
					updatedAt: 1,
					children: [{ agent: "worker", index: 0, status: "detached", updatedAt: 1 }],
				}],
			]);
			let polls = 0;
			const result = await waitForSubagents({ id: "foreground-al" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					state.foregroundRuns!.get("foreground-alpha")!.children[0] = {
						agent: "reviewer",
						index: 0,
						status: "completed",
						finalOutput: "Recovered review",
						updatedAt: 2,
					};
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /remembered detached foreground run "foreground-alpha"/i);
			assert.match(textOf(result), /1 completed/);
			assert.equal(polls, 1);

			const otherSession = await waitForSubagents({ id: "foreground-other" }, undefined, baseDeps(root, state));
			assert.match(textOf(otherSession), /No active run matched/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes when a remembered detached foreground run needs attention", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-attn-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([["foreground-blocked", {
				runId: "foreground-blocked",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{ agent: "researcher", index: 0, status: "detached", updatedAt: 1 }],
			}]]);
			let polls = 0;
			const result = await waitForSubagents({ id: "foreground-blocked", timeoutMs: 30_000 }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					state.foregroundRuns!.get("foreground-blocked")!.children[0] = {
						agent: "researcher",
						index: 0,
						status: "detached",
						activityState: "needs_attention",
						currentTool: "contact_supervisor",
						updatedAt: 2,
					};
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /attention required/i);
			assert.match(textOf(result), /foreground-blocked/);
			assert.match(textOf(result), /researcher#0/);
			assert.match(textOf(result), /Reply to any pending supervisor request/);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps waiting after a resolved supervisor reply even if idle needs_attention remains", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-idle-attn-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([["foreground-working", {
				runId: "foreground-working",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{
					agent: "worker",
					index: 0,
					status: "detached",
					activityState: "needs_attention",
					updatedAt: 1,
				}],
			}]]);
			let polls = 0;
			const result = await waitForSubagents({ id: "foreground-working", timeoutMs: 30_000 }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					state.foregroundRuns!.get("foreground-working")!.children[0] = {
						agent: "worker",
						index: 0,
						status: "completed",
						updatedAt: 2,
					};
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes a remembered foreground wait on a repeated supervisor request event", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-supervisor-"));
		try {
			const state = makeState("sess-1");
			state.foregroundRuns = new Map([["foreground-repeated", {
				runId: "foreground-repeated",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{ agent: "worker", index: 0, status: "detached", updatedAt: 1 }],
			}]]);
			const handlers = new Map<string, Array<(data: unknown) => void>>();
			const events = {
				on(channel: string, handler: (data: unknown) => void) {
					const list = handlers.get(channel) ?? [];
					list.push(handler);
					handlers.set(channel, list);
					return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
				},
				emit(channel: string, data: unknown) {
					for (const handler of handlers.get(channel) ?? []) handler(data);
				},
			};
			const startedAt = Date.now();
			const waiting = waitForSubagents({ id: "foreground-repeated", timeoutMs: 30_000 }, undefined, baseDeps(root, state, {
				events,
				pollIntervalMs: 10_000,
			}));

			setTimeout(() => {
				const child = state.foregroundRuns!.get("foreground-repeated")!.children[0]!;
				child.activityState = "needs_attention";
				child.currentTool = "contact_supervisor";
				events.emit("pi-intercom:detach-request", { runId: "foreground-repeated", childIndex: 0 });
			}, 15);

			const result = await waiting;
			assert.match(textOf(result), /attention required/i);
			assert.ok(Date.now() - startedAt < 5_000, "supervisor request should wake wait before the poll interval");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("streams detached foreground transcript activity while waiting", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-foreground-progress-"));
		try {
			const transcriptPath = path.join(root, "foreground-transcript.jsonl");
			const ts = Date.now();
			fs.writeFileSync(transcriptPath, [
				JSON.stringify({ version: 1, recordType: "message", sourceEventType: "initial_prompt", role: "user", text: "large delegated task", ts }),
				JSON.stringify({ version: 1, recordType: "message", sourceEventType: "message_end", role: "assistant", text: "I found the relevant renderer path.", ts: ts + 1 }),
				JSON.stringify({ version: 1, recordType: "tool_start", toolName: "edit", argsPreview: "{ path: src/render.ts }", ts: ts + 2 }),
				"{\"recordType\":\"message\"", // Simulate a concurrent partial append.
			].join("\n"), "utf-8");

			const state = makeState("sess-1");
			state.foregroundRuns = new Map([["foreground-live", {
				runId: "foreground-live",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: ts,
				children: [{ agent: "worker", index: 0, status: "detached", transcriptPath, updatedAt: ts }],
			}]]);
			const updates: string[] = [];
			const result = await waitForSubagents({ id: "foreground-live" }, undefined, baseDeps(root, state, {
				onUpdate: (update) => updates.push(textOf(update)),
				sleep: async () => {
					state.foregroundRuns!.get("foreground-live")!.children[0] = {
						agent: "worker",
						index: 0,
						status: "completed",
						finalOutput: "Implemented the renderer fix.",
						transcriptPath,
						updatedAt: ts + 3,
					};
				},
			}));

			assert.equal(result.isError, undefined);
			assert.equal(updates.length, 1);
			assert.match(updates[0]!, /Waiting for detached foreground run "foreground-live"/);
			assert.match(updates[0]!, /worker · working after supervisor handoff/);
			assert.match(updates[0]!, /current: edit: \{ path: src\/render\.ts \}/);
			assert.match(updates[0]!, /assistant: I found the relevant renderer path\./);
			assert.doesNotMatch(updates[0]!, /large delegated task/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not claim completion when a detached foreground run disappears or the active session changes", async () => {
		for (const scenario of ["missing", "session-change"] as const) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-wait-foreground-${scenario}-`));
			try {
				const state = makeState("sess-1");
				state.foregroundRuns = new Map([["foreground-still-live", {
					runId: "foreground-still-live",
					mode: "single",
					cwd: root,
					sessionId: "sess-1",
					updatedAt: 1,
					children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
				}]]);
				const result = await waitForSubagents({ id: "foreground-still", timeoutMs: 5000 }, undefined, baseDeps(root, state, {
					sleep: async () => {
						if (scenario === "missing") state.foregroundRuns!.delete("foreground-still-live");
						else state.currentSessionId = "sess-2";
					},
				}));

				assert.equal(result.isError, true);
				assert.doesNotMatch(textOf(result), /; done\./);
				assert.match(textOf(result), scenario === "missing" ? /disappeared before a terminal child result/ : /active session changed/);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("rejects ambiguous prefixes across async and remembered foreground runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-cross-kind-"));
		try {
			const state = makeState("sess-1");
			writeStatus(path.join(root, "runs"), "shared-x-async", "running", { sessionId: "sess-1", pid: 999999 });
			state.foregroundRuns = new Map([["shared-x-foreground", {
				runId: "shared-x-foreground",
				mode: "single",
				cwd: root,
				sessionId: "sess-1",
				updatedAt: 1,
				children: [{ agent: "reviewer", index: 0, status: "detached", updatedAt: 1 }],
			}]]);

			const result = await waitForSubagents({ id: "shared-x" }, undefined, baseDeps(root, state));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /Ambiguous subagent run id prefix "shared-x"/);
			assert.match(textOf(result), /shared-x-async/);
			assert.match(textOf(result), /shared-x-foreground/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves current-session prefix matches when a foreign exact id collides", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-session-prefix-collision-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-alph", "running", { sessionId: "sess-2", pid: 999999 });
			writeStatus(asyncRoot, "run-alpha-current", "running", { sessionId: "sess-1", pid: 999998 });

			const result = await waitForSubagents({ id: "run-alph" }, undefined, baseDeps(root, state, {
				sleep: async () => writeStatus(asyncRoot, "run-alpha-current", "complete", { sessionId: "sess-1" }),
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "run-alph".*done/is);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked prefix entries during foreign exact-id fallback", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-session-prefix-symlink-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const outsideRoot = path.join(root, "outside");
			const outsideRun = path.join(outsideRoot, "run-alpha");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run", "running", { sessionId: "sess-2", pid: 999998 });
			writeStatus(outsideRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999999 });
			fs.symlinkSync(outsideRun, path.join(asyncRoot, "run-alpha"), "dir");
			const reconciledPids: number[] = [];
			let sleeps = 0;

			const result = await waitForSubagents({ id: "run" }, undefined, baseDeps(root, state, {
				kill: (pid) => {
					reconciledPids.push(pid);
					return true;
				},
				sleep: async () => {
					sleeps += 1;
					writeStatus(outsideRoot, "run-alpha", "complete", { sessionId: "sess-1" });
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /No active run matched "run"/);
			assert.deepEqual(reconciledPids, [], "foreign and outside runs must not be reconciled");
			assert.equal(sleeps, 0, "outside symlink target must not be returned as active");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects symlinked targeted run directories before reconciliation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-symlink-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const outsideRun = path.join(root, "outside-run");
			const state = makeState("sess-1");
			writeStatus(path.dirname(outsideRun), path.basename(outsideRun), "running", { sessionId: "sess-1", pid: 999999 });
			fs.mkdirSync(asyncRoot, { recursive: true });
			fs.symlinkSync(outsideRun, path.join(asyncRoot, "link"), "dir");
			let reconciled = false;

			const result = await waitForSubagents({ id: "link" }, undefined, baseDeps(root, state, {
				kill: () => {
					reconciled = true;
					throw new Error("symlink target should not be reconciled");
				},
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /No active run matched "link"/);
			assert.equal(reconciled, false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("can target a single run by id prefix", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-alpha", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "run-beta", "running", { sessionId: "sess-1", pid: 999998 });

			let polls = 0;
			const sleep = async () => {
				polls += 1;
				// Only alpha finishes; beta stays running but we're not waiting on it.
				if (polls === 1) writeStatus(asyncRoot, "run-alpha", "complete", { sessionId: "sess-1" });
			};

			const result = await waitForSubagents({ id: "run-alph" }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "run-alph".*done/is);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous id prefixes but lets exact ids win", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-ambiguous-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "prefix-aa-1", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "prefix-aa-2", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "run", "running", { sessionId: "sess-1", pid: 999997 });

			const ambiguous = await waitForSubagents({ id: "prefix-aa" }, undefined, baseDeps(root, state));
			assert.equal(ambiguous.isError, true);
			assert.match(textOf(ambiguous), /Ambiguous subagent run id prefix "prefix-aa"/);
			assert.match(textOf(ambiguous), /prefix-aa-2/);

			let polls = 0;
			const exact = await waitForSubagents({ id: "run" }, undefined, baseDeps(root, state, {
				sleep: async () => {
					polls += 1;
					writeStatus(asyncRoot, "run", "complete", { sessionId: "sess-1" });
				},
			}));

			assert.equal(exact.isError, undefined);
			assert.match(textOf(exact), /run "run".*done/is);
			assert.equal(polls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not reconcile unrelated runs when waiting for an exact id", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-exact-id-scan-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "target-run", "running", { sessionId: "sess-1", pid: 999999 });
			writeStatus(asyncRoot, "other-run-a", "running", { sessionId: "sess-1", pid: 999998 });
			writeStatus(asyncRoot, "other-run-b", "running", { sessionId: "sess-1", pid: 999997 });

			let probes = 0;
			const result = await waitForSubagents({ id: "target-run" }, undefined, baseDeps(root, state, {
				kill: () => {
					probes++;
					return true;
				},
				sleep: async () => writeStatus(asyncRoot, "target-run", "complete", { sessionId: "sess-1" }),
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /run "target-run".*done/is);
			assert.equal(probes, 1, "exact-id waits should reconcile only the selected run");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects dot-segment ids before probing outside the async root", async () => {
		for (const id of [".", ".."]) {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-dot-id-"));
			try {
				const asyncRoot = path.join(root, "runs");
				const state = makeState("sess-1");
				fs.writeFileSync(path.join(root, "status.json"), JSON.stringify({
					runId: id,
					mode: "single",
					state: "running",
					startedAt: Date.now(),
					lastUpdate: Date.now(),
					sessionId: "sess-1",
					steps: [{ agent: "outside", status: "running" }],
				}), "utf-8");

				const result = await waitForSubagents({ id }, undefined, baseDeps(root, state));

				assert.equal(result.isError, undefined);
				assert.ok(textOf(result).includes(`No active run matched "${id}"`));
				assert.equal(fs.existsSync(path.join(asyncRoot, "status.json")), false);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("times out while runs are still active and reports them", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-stuck", "running", { sessionId: "sess-1", pid: 999999 });

			// Virtual clock that jumps past the timeout on the first sleep.
			let clock = 0;
			const now = () => clock;
			const sleep = async (ms: number) => {
				clock += ms + 10_000;
			};

			const result = await waitForSubagents({ timeoutMs: 5_000 }, undefined, baseDeps(root, state, { now, sleep, defaultTimeoutMs: 1_000 }));
			assert.equal(result.isError, undefined);
			const text = textOf(result);
			assert.match(text, /window elapsed after 5\.0s/i, "explicit timeoutMs must override the configured default");
			assert.match(text, /run-stuck \(running\)/);
			assert.deepEqual(result.details.wait, {
				reason: "window_elapsed",
				timedOut: true,
				activeRunIds: ["run-stuck"],
				activeProviderItems: [],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the configured wait window when timeoutMs is omitted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-config-timeout-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-configured", "running", { sessionId: "sess-1", pid: 999999 });
			let clock = 0;
			const result = await waitForSubagents({}, undefined, baseDeps(root, state, {
				now: () => clock,
				sleep: async (ms) => { clock += ms + 10_000; },
				defaultTimeoutMs: 2_000,
			}));

			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /window elapsed after 2\.0s/i);
			assert.equal(result.details.wait?.reason, "window_elapsed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports still-active provider identities when the wait window elapses", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-provider-timeout-"));
		try {
			const state = makeState("sess-1");
			let clock = 0;
			const result = await waitForSubagents({ timeoutMs: 1_000 }, undefined, baseDeps(root, state, {
				now: () => clock,
				sleep: async (ms) => { clock += ms + 10_000; },
				backgroundWork: {
					snapshot: () => ({
						providers: ["herdr"],
						items: [{ provider: "herdr", id: "pane-1", sessionId: "sess-1" }],
					}),
					wakeChannels: () => [],
				},
			}));

			assert.equal(result.isError, undefined);
			assert.deepEqual(result.details.wait?.activeProviderItems, [{ provider: "herdr", id: "pane-1" }]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves early when the turn is aborted", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-abort-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-x", "running", { sessionId: "sess-1", pid: 999999 });

			const controller = new AbortController();
			const sleep = async () => {
				controller.abort();
			};

			const result = await waitForSubagents({}, controller.signal, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, true);
			assert.match(textOf(result), /aborted/i);
			assert.match(textOf(result), /run-x \(running\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("wakes immediately on an event bus emission instead of waiting the poll interval", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-event-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });

			// Fake bus. Emitting on a wake channel should end wait's sleep early.
			const handlers = new Map<string, Array<(d: unknown) => void>>();
			const events = {
				on(channel: string, handler: (d: unknown) => void) {
					const list = handlers.get(channel) ?? [];
					list.push(handler);
					handlers.set(channel, list);
					return () => {
						const l = handlers.get(channel) ?? [];
						handlers.set(channel, l.filter((h) => h !== handler));
					};
				},
				emit(channel: string, data: unknown) {
					for (const h of handlers.get(channel) ?? []) h(data);
				},
			};

			let sleepCalls = 0;
			let sleepArmed!: () => void;
			const armed = new Promise<void>((resolve) => { sleepArmed = resolve; });
			const sleep = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
				sleepCalls += 1;
				signal?.addEventListener("abort", resolve, { once: true });
				sleepArmed();
			});

			const p = waitForSubagents({ all: true }, undefined, baseDeps(root, state, {
				events,
				pollIntervalMs: 10_000,
				sleep,
			}));

			await armed;
			writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			events.emit("subagent:async-complete", { id: "run-a" });

			const result = await Promise.race([
				p,
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("event wake did not resolve bg_wait")), 1_000)),
			]);
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(sleepCalls >= 1, "poll-interval sleep still armed as fallback");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still resolves via poll when no event bus is provided (fallback)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-nobus-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const state = makeState("sess-1");
			writeStatus(asyncRoot, "run-a", "running", { sessionId: "sess-1", pid: 999999 });
			let polls = 0;
			const sleep = async () => {
				polls += 1;
				if (polls === 1) writeStatus(asyncRoot, "run-a", "complete", { sessionId: "sess-1" });
			};
			// No `events` in deps → pure poll path.
			const result = await waitForSubagents({ all: true }, undefined, baseDeps(root, state, { sleep }));
			assert.equal(result.isError, undefined);
			assert.match(textOf(result), /done/i);
			assert.ok(polls >= 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
