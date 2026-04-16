/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses createMockPi() from @marcfargas/pi-test-harness to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	events,
	tryImport,
} from "../support/helpers.ts";

interface ModelAttempt {
	success?: boolean;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	durationMs: number;
	toolCount: number;
}

interface ArtifactPaths {
	outputPath: string;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	artifactPaths?: ArtifactPaths;
	finalOutput?: string;
	detached?: boolean;
	detachedReason?: string;
	savedOutputPath?: string;
	outputSaveError?: string;
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface TypesModule {
	INTERCOM_DETACH_REQUEST_EVENT: string;
	INTERCOM_DETACH_RESPONSE_EVENT: string;
}

const execution = await tryImport<ExecutionModule>("./execution.ts");
const utils = await tryImport<UtilsModule>("./utils.ts");
const types = await tryImport<TypesModule>("./types.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const INTERCOM_DETACH_REQUEST_EVENT = types?.INTERCOM_DETACH_REQUEST_EVENT ?? "pi-intercom:detach-request";
const INTERCOM_DETACH_RESPONSE_EVENT = types?.INTERCOM_DETACH_RESPONSE_EVENT ?? "pi-intercom:detach-response";

function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	return {
		on(channel: string, handler: (payload: unknown) => void) {
			const channelListeners = listeners.get(channel) ?? new Set();
			channelListeners.add(handler);
			listeners.set(channel, channelListeners);
			return () => {
				channelListeners.delete(handler);
				if (channelListeners.size === 0) listeners.delete(channel);
			};
		},
		emit(channel: string, payload: unknown) {
			for (const handler of listeners.get(channel) ?? []) {
				handler(payload);
			}
		},
	};
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
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
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function readCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(-1);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
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

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
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

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127")],
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

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
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

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "depth-env",
			maxSubagentDepth: 1,
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_DEPTH: "1",
			PI_SUBAGENT_MAX_DEPTH: "1",
		});
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith("subagent-prompt-runtime.ts")));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
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

	it("detaches cleanly on intercom handoff without aborting the child process", async () => {
		const eventBus = createEventBus();
		let accepted = false;
		eventBus.on(INTERCOM_DETACH_RESPONSE_EVENT, (payload) => {
			if (!payload || typeof payload !== "object") return;
			accepted = (payload as { accepted?: unknown }).accepted === true;
		});
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("intercom", { action: "ask", to: "orchestrator" })] },
				{ delay: 1000, jsonl: [events.assistantMessage("received pong")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "intercom-detach",
			allowIntercomDetach: true,
			intercomEvents: eventBus,
		});

		setTimeout(() => {
			eventBus.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "test-request" });
		}, 100);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(result.detached, true);
		assert.equal(result.detachedReason, "intercom coordination");
		assert.equal(result.finalOutput, "Detached for intercom coordination.");
		assert.equal(result.progress?.status, "detached");
		assert.equal(accepted, true);
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});
});
