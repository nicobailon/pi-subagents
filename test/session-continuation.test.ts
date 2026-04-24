/**
 * Tests for resume: true — persistent writer session across loop iterations.
 *
 * When `resume: true` is set together with `sessionDir`, the subprocess is
 * launched with `--session <latest-file>` so pi loads the existing conversation
 * history. On the first call (no prior session yet) it silently starts fresh.
 *
 * Reviewers always omit `resume` to remain isolated (fresh context per call).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./support/helpers.ts";
import { createMockPi, createTempDir, removeTempDir, tryImport } from "./support/helpers.ts";

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<{
			isError?: boolean;
			content: Array<{ text?: string }>;
			details?: {
				results?: Array<{ sessionFile?: string }>;
			};
		}>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./subagent-executor.ts");
const available = !!executorMod;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function makeSessionManagerStub(sessionFile?: string) {
	return {
		getSessionFile: () => sessionFile,
		getSessionId: () => "mock-session-id",
		getLeafId: () => "leaf-current",
		createBranchedSession: (leafId: string) => `/tmp/fork-${leafId}.jsonl`,
	};
}

function makeState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

/** Read the args from the Nth mock-pi call record (0-indexed). */
function readCallArgs(mockPiDir: string, callIndex: number): string[] {
	const calls = fs.readdirSync(mockPiDir)
		.filter((f) => f.startsWith("call-"))
		.sort();
	const file = calls[callIndex];
	if (!file) throw new Error(`No call record at index ${callIndex} (total: ${calls.length})`);
	const record = JSON.parse(fs.readFileSync(path.join(mockPiDir, file), "utf-8")) as { args: string[] };
	return record.args;
}

describe(
	"resume: true — persistent writer session",
	{ skip: !available ? "subagent executor not importable" : undefined },
	() => {
		let tempDir: string;
		let mockPi: MockPi;

		before(() => {
			mockPi = createMockPi();
			mockPi.install();
		});

		after(() => {
			mockPi.uninstall();
		});

		beforeEach(() => {
			tempDir = createTempDir("pi-subagent-session-cont-test-");
			mockPi.reset();
			mockPi.onCall({ output: "task complete" });
		});

		afterEach(() => {
			removeTempDir(tempDir);
		});

		function makeExecutor() {
			return createSubagentExecutor!({
				pi: { events: { emit: () => {}, on: () => () => {} }, getSessionName: () => undefined },
				state: makeState(tempDir),
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({
					agents: [
						{ name: "writer", description: "Implementation writer" },
						{ name: "reviewer", description: "Code reviewer" },
					],
				}),
			});
		}

		function makeCtx(sessionFile?: string) {
			return {
				cwd: tempDir,
				hasUI: false,
				ui: {},
				modelRegistry: { getAvailable: () => [] },
				sessionManager: makeSessionManagerStub(sessionFile),
			};
		}

		// ── Schema ──────────────────────────────────────────────────────────

		it("SubagentParams schema has resume field and no sessionFile field", async () => {
			const mod = await tryImport<{ SubagentParams?: { properties?: Record<string, unknown> } }>(
				"./schemas.ts",
			);
			const schema = mod?.SubagentParams;
			assert.ok(schema, "schemas.ts should be importable");
			assert.ok(schema.properties?.resume, "SubagentParams should have a resume property");
			assert.equal(schema.properties?.sessionFile, undefined, "SubagentParams should not have sessionFile");
		});

		// ── sessionFile is surfaced in result for observability ─────────────

		it("result.details.results[0].sessionFile is populated after a sessionDir call", async () => {
			const sessionDir = path.join(tempDir, "writer-slot");
			const runDir = path.join(sessionDir, "run-0");
			// Mock pi doesn't write real session files — pre-seed one to simulate what pi would create.
			fs.mkdirSync(runDir, { recursive: true });
			const seededSession = path.join(runDir, "session.jsonl");
			fs.writeFileSync(seededSession, '{"type":"session"}\n');

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement step 1", sessionDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined);
			const sessionFile = result.details?.results?.[0]?.sessionFile;
			assert.ok(sessionFile, "sessionFile should be populated in result for observability");
			assert.ok(sessionFile.endsWith(".jsonl"), "sessionFile should be a .jsonl path");
		});

		// ── First call: no prior session → fresh start ───────────────────────

		it("resume: true on first call (empty sessionDir) starts fresh — no error, no --session flag", async () => {
			const sessionDir = path.join(tempDir, "writer-slot");
			const executor = makeExecutor();

			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "iteration 1", sessionDir, resume: true },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined, "first resume call should succeed (fresh start)");
			assert.equal(mockPi.callCount(), 1, "subprocess should have been spawned once");

			const args = readCallArgs(mockPi.dir, 0);
			assert.ok(!args.includes("--session"), "first call should not pass --session (no prior session)");
			assert.ok(args.includes("--session-dir"), "first call should use --session-dir for fresh start");
		});

		// ── Subsequent call: prior session exists → resume ───────────────────

		it("resume: true with existing session passes --session <file> to subprocess", async () => {
			const sessionDir = path.join(tempDir, "writer-slot");
			// Simulate a prior session file in the run-0 sub-dir
			const runDir = path.join(sessionDir, "run-0");
			fs.mkdirSync(runDir, { recursive: true });
			const existingSession = path.join(runDir, "session-prior.jsonl");
			fs.writeFileSync(existingSession, '{"type":"session"}\n');

			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "iteration 2", sessionDir, resume: true },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, undefined);
			assert.equal(mockPi.callCount(), 1);

			const args = readCallArgs(mockPi.dir, 0);
			assert.ok(args.includes("--session"), "should pass --session when prior session exists");
			assert.ok(
				args.includes(existingSession),
				`should pass the existing session file path (got: ${args.join(" ")})`,
			);
			assert.ok(!args.includes("--session-dir"), "should not also pass --session-dir");
		});

		// ── Without resume, each call is independent ─────────────────────────

		it("without resume, each call with the same sessionDir uses --session-dir (not --session)", async () => {
			const executor = makeExecutor();
			const sessionDir = path.join(tempDir, "writer-slot");

			await executor.execute(
				"id1",
				{ agent: "writer", task: "iteration 1", sessionDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);
			mockPi.reset();
			mockPi.onCall({ output: "second call" });

			await executor.execute(
				"id2",
				{ agent: "writer", task: "iteration 2", sessionDir },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			// After reset, only the second call's record is in the queue.
			const args = readCallArgs(mockPi.dir, 0);
			assert.ok(args.includes("--session-dir"), "without resume, should use --session-dir");
			assert.ok(!args.includes("--session"), "without resume, should not use --session");
		});

		// ── Validation errors ─────────────────────────────────────────────────

		it("resume without sessionDir returns an error", async () => {
			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement", resume: true },
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, true, "resume without sessionDir should be an error");
			assert.match(result.content[0]?.text ?? "", /sessionDir/i);
			assert.equal(mockPi.callCount(), 0, "no subprocess should be spawned");
		});

		it("resume in PARALLEL mode returns an error", async () => {
			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{
					tasks: [
						{ agent: "reviewer", task: "review A" },
						{ agent: "reviewer", task: "review B" },
					],
					sessionDir: tempDir,
					resume: true,
				},
				new AbortController().signal,
				undefined,
				makeCtx(),
			);

			assert.equal(result.isError, true, "resume in parallel mode should be an error");
			assert.match(result.content[0]?.text ?? "", /SINGLE mode/i);
			assert.equal(mockPi.callCount(), 0, "no subprocess should be spawned");
		});

		it("resume + context: 'fork' returns an error", async () => {
			const executor = makeExecutor();
			const result = await executor.execute(
				"id",
				{ agent: "writer", task: "implement", sessionDir: tempDir, resume: true, context: "fork" },
				new AbortController().signal,
				undefined,
				makeCtx("/tmp/some-parent.jsonl"),
			);

			assert.equal(result.isError, true, "fork + resume should be an error");
			assert.match(result.content[0]?.text ?? "", /fork/i);
			assert.equal(mockPi.callCount(), 0);
		});
	},
);
