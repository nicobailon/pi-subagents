/**
 * Foreground children run as in-process pi sessions. These tests drive
 * `runSync` against the scripted child session factory and check the seams
 * the in-process launch owns: hook config, steering, interrupt, timeout,
 * structured output capture, disposal, and detach.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createMockPi, createTempDir, events, makeAgent, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { childSessionFactory, createDefaultChildSessionFactory, disposeChildSessions, type ChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import type { ForegroundChildSessionControls, SingleResult } from "../../src/shared/types.ts";

async function waitFor(read: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!read()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for test condition.");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("in-process foreground child", () => {
	let tempDir: string;
	let mockPi: MockPi;
	const savedEnv = { ...process.env };

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
		process.env.PI_SUBAGENT_CHILD_AGENT = savedEnv.PI_SUBAGENT_CHILD_AGENT ?? "";
		delete process.env.PI_SUBAGENT_CHILD_AGENT;
	});

	after(() => removeTempDir(tempDir));

	it("passes the child hooks a typed config built without the environment", async () => {
		process.env.PI_SUBAGENT_CHILD_AGENT = "leaked-parent-value";
		try {
			mockPi.onCall({ output: "done" });
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "hooks-config", index: 3, waitToolEnabled: false });
			assert.equal(result.exitCode, 0);
			const [session] = mockPi.sessions;
			assert.ok(session, "child session was created");
			assert.equal(session.launch.runtime.agent, "echo");
			assert.equal(session.launch.runtime.runId, "hooks-config");
			assert.equal(session.launch.runtime.childIndex, 3);
			assert.equal(session.launch.runtime.fanoutChild, false);
			assert.equal(session.launch.runtime.waitTool.enabled, false);
			assert.equal(session.launch.runtime.steerInbox, undefined, "in-process children have no steer inbox");
			assert.equal(session.launch.runtime.depth, 1);
			assert.equal(session.task?.startsWith("Task: Task"), true);
			assert.equal(session.launch.systemPrompt?.startsWith('<active_agent name="echo"/>'), true);
			assert.deepEqual(session.launch.storage, { kind: "memory" });
		} finally {
			delete process.env.PI_SUBAGENT_CHILD_AGENT;
		}
	});

	it("adds the fanout hook and nested route only for fanout-authorized children", async () => {
		const route = createNestedRoute("hooks-fanout");
		try {
			mockPi.onCall({ output: "done" });
			const result = await runSync(tempDir, [makeAgent("delegator", { tools: ["read", "subagent"] })], "delegator", "Task", {
				runId: "hooks-fanout",
				nestedRoute: route,
			});
			assert.equal(result.exitCode, 0);
			const [session] = mockPi.sessions;
			assert.equal(session?.launch.runtime.fanoutChild, true);
			assert.deepEqual(session?.launch.runtime.nestedRoute, route);
			assert.deepEqual(session?.launch.runtime.nestedParent, { parentRunId: "hooks-fanout", parentChildIndex: 0, depth: 1, path: [{ runId: "hooks-fanout", stepIndex: 0, agent: "delegator" }] });
			assert.deepEqual(session?.launch.tools, ["read", "subagent"]);
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("routes steer and follow-up to the child session", async () => {
		const release = path.join(tempDir, "release");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered" }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }] }] });
		let controls: ForegroundChildSessionControls | undefined;
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "steer-session",
			onChildSession: (next) => { controls = next; },
		});
		await waitFor(() => controls !== undefined);
		await controls!.steer("Focus on tests.");
		await controls!.followUp("Then update docs.");
		fs.writeFileSync(release, "go");
		const result = await run;
		assert.equal(result.exitCode, 0);
		assert.deepEqual(mockPi.sessions[0]?.steers, [
			{ text: "Focus on tests.", mode: "steer" },
			{ text: "Then update docs.", mode: "followUp" },
		]);
	});

	for (const type of ["turn_start", "agent_start", "auto_retry_start"]) {
		it(`foreground keeps resumed work alive after ${type}`, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.assistantMessage("before continuation"), { type }] },
					// Queued steering/follow-up work is allowed to outlive the old final-stop grace.
					{ delay: 1400, jsonl: [events.assistantMessage("after continuation")] },
				],
			});
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: `resumed-${type}` });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.finalOutput, "after continuation");
			assert.equal(mockPi.sessions[0]?.aborted, false);
		});
	}

	it("aborts the child session on interrupt and disposes it", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const interrupt = new AbortController();
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "interrupt-session", interruptSignal: interrupt.signal });
		await waitFor(() => mockPi.sessions.length === 1);
		await waitFor(() => mockPi.sessions[0]?.task !== undefined);
		interrupt.abort();
		const result = await run;
		assert.equal(result.interrupted, true);
		assert.equal(result.exitCode, 0);
		assert.equal(mockPi.sessions[0]?.aborted, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("aborts the child session on timeout and disposes it", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "timeout-session", timeoutMs: 60 });
		assert.equal(result.timedOut, true);
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /timed out after 60ms/);
		assert.equal(mockPi.sessions[0]?.aborted, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("disposes the child session after a normal completion", async () => {
		mockPi.onCall({ output: "finished" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "dispose-session" });
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "finished");
		assert.equal(mockPi.sessions[0]?.settled, true);
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("reports the run only after the child session's shutdown work finished", async () => {
		mockPi.onCall({ output: "done" });
		let shutdownDone = false;
		const inner = childSessionFactory();
		const wrapped: ChildSessionFactory = {
			...inner,
			create: async (launch) => {
				const session = await inner.create(launch);
				const dispose = session.dispose.bind(session);
				session.dispose = () => dispose().then(() => new Promise<void>((resolve) => setTimeout(() => { shutdownDone = true; resolve(); }, 30)));
				return session;
			},
		};
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "dispose-order", childSessionFactory: wrapped });
		assert.equal(result.exitCode, 0);
		assert.equal(shutdownDone, true);
	});

	it("captures structured output in memory", async () => {
		const structured = createStructuredOutputRuntime({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, tempDir);
		mockPi.onCall({ structuredOutput: { ok: true } });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "structured-memory", structuredOutput: structured });
		assert.equal(result.exitCode, 0, result.error);
		assert.deepEqual(result.structuredOutput, { ok: true });
		assert.equal(mockPi.sessions[0]?.launch.runtime.structuredOutput?.schema.type, "object");
		assert.deepEqual(JSON.parse(fs.readFileSync(structured.outputPath, "utf-8")), { ok: true });
	});

	it("fails when the child never calls structured_output", async () => {
		const structured = createStructuredOutputRuntime({ type: "object" }, tempDir);
		mockPi.onCall({ output: "prose only" });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "structured-missing", structuredOutput: structured });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /Missing structured_output call/);
		assert.equal(result.structuredOutputFailed, true);
	});

	it("keeps a detached child running in-process and delivers its terminal result", async () => {
		const release = path.join(tempDir, "release-detach");
		mockPi.onCall({ steps: [{ waitForPath: release, jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after detach" }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }] }] });
		let detach: ((reason?: string) => boolean) | undefined;
		let terminal: SingleResult | undefined;
		const receipt = await new Promise<SingleResult>((resolve, reject) => {
			runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
				runId: "detach-session",
				onDetachReady: (next) => { detach = next; },
				onDetachReceipt: () => true,
				onDetachedExit: (result) => { terminal = result; },
			}).then(resolve, reject);
			void waitFor(() => detach !== undefined && mockPi.sessions[0]?.task !== undefined).then(() => {
				assert.equal(detach!("user request"), true);
			}, reject);
		});
		assert.equal(receipt.detached, true);
		assert.equal(receipt.detachedReason, "user request");
		assert.equal(mockPi.sessions[0]?.aborted, false, "detach must not abort the session");
		await disposeChildSessions();
		assert.equal(mockPi.sessions[0]?.aborted, false, "parent session shutdown must not abort a detached child");
		fs.writeFileSync(release, "go");
		await waitFor(() => terminal !== undefined);
		assert.equal(terminal?.exitCode, 0);
		assert.equal(terminal?.finalOutput, "after detach");
		assert.equal(terminal?.detachedReason, "user request");
		assert.equal(mockPi.sessions[0]?.disposed, true);
	});

	it("reports a parent session shutdown as the reason an attached child stopped", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const run = runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", { runId: "shutdown-attached" });
		await waitFor(() => mockPi.sessions[0]?.task !== undefined);
		await disposeChildSessions();
		const result = await run;
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Subagent stopped because the parent session shut down.");
	});
});

/** A pi module stub whose loader reads `process.env` after an await, the way a real extension load does. */
function stubPi(session: Record<string, unknown> = {}, onReload?: () => void): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() { await new Promise((resolve) => setTimeout(resolve, 10)); onReload?.(); } },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", ...session } }),
	} as unknown as PiCodingAgentModule;
}
const stubLaunch: ChildSessionLaunch = { cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] };

describe("default child session factory", () => {
	it("serializes process env through extension loading and session start across concurrent launches", async () => {
		const seen: string[] = [];
		const bound: string[] = [];
		const bindExtensions = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); bound.push(process.env.PI_SUBAGENT_TEST_ENV ?? ""); };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi({ bindExtensions }, () => { seen.push(process.env.PI_SUBAGENT_TEST_ENV ?? ""); }) });
		await Promise.all([
			factory.create({ ...stubLaunch, processEnv: { PI_SUBAGENT_TEST_ENV: "a" } }),
			factory.create({ ...stubLaunch, processEnv: { PI_SUBAGENT_TEST_ENV: "b" } }),
		]);
		delete process.env.PI_SUBAGENT_TEST_ENV;
		assert.deepEqual(seen, ["a", "b"]);
		assert.deepEqual(bound, ["a", "b"]);
	});

	it("marks each child's loader as reloaded so pi resets its extension cache", async () => {
		const flags: boolean[] = [];
		const pi = stubPi();
		pi.DefaultResourceLoader = class { loaded = false; async reload() { flags.push(this.loaded); } } as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		await factory.create(stubLaunch);
		await factory.create(stubLaunch);
		assert.deepEqual(flags, [true, true]);
	});

	it("resolves models from providers queued during child extension loading", async () => {
		const registeredProviders: string[] = [];
		const registeredNativeProviders: string[] = [];
		let refreshed = false;
		let pendingRuntime: { pendingProviderRegistrations: unknown[]; pendingNativeProviderRegistrations: unknown[] } | undefined;
		const pi = stubPi();
		pi.ModelRuntime = { create: async () => ({ registerProvider: (name: string) => { registeredProviders.push(name); }, registerNativeProvider: (provider: { id: string }) => { registeredNativeProviders.push(provider.id); }, refresh: async () => { refreshed = true; } }) } as unknown as PiCodingAgentModule["ModelRuntime"];
		pi.DefaultResourceLoader = class {
			runtime = {
				pendingProviderRegistrations: [{ name: "router", config: { models: [{ id: "mimo-v2.5" }] }, extensionPath: "/extensions/router.ts" }],
				pendingNativeProviderRegistrations: [{ provider: { id: "native-router", models: [{ id: "native-model" }] }, extensionPath: "/extensions/native-router.ts" }],
			};
			async reload() { pendingRuntime = this.runtime; }
			getExtensions() { return { extensions: [], errors: [], runtime: this.runtime }; }
		} as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		pi.resolveCliModel = (({ cliModel }) => {
			assert.equal(cliModel, "router/mimo-v2.5");
			assert.deepEqual(registeredProviders, ["router"]);
			assert.deepEqual(registeredNativeProviders, ["native-router"]);
			assert.equal(refreshed, true);
			return { model: { provider: "router", id: "mimo-v2.5" } };
		}) as unknown as PiCodingAgentModule["resolveCliModel"];
		pi.createAgentSession = (async ({ model }) => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", model } })) as unknown as PiCodingAgentModule["createAgentSession"];

		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create({ ...stubLaunch, model: "router/mimo-v2.5" });

		assert.equal(child.modelId, "router/mimo-v2.5");
		assert.deepEqual(pendingRuntime?.pendingProviderRegistrations, []);
		assert.deepEqual(pendingRuntime?.pendingNativeProviderRegistrations, []);
	});

	it("resolves queued providers when the loader has no native provider queue", async () => {
		const registeredProviders: string[] = [];
		let refreshed = false;
		let pendingRuntime: { pendingProviderRegistrations?: unknown[] } | undefined;
		const pi = stubPi();
		pi.ModelRuntime = { create: async () => ({ registerProvider: (name: string) => { registeredProviders.push(name); }, registerNativeProvider: () => {}, refresh: async () => { refreshed = true; } }) } as unknown as PiCodingAgentModule["ModelRuntime"];
		pi.DefaultResourceLoader = class {
			runtime = {
				pendingProviderRegistrations: [{ name: "router", config: { models: [{ id: "mimo-v2.5" }] }, extensionPath: "/extensions/router.ts" }],
			};
			async reload() { pendingRuntime = this.runtime; }
			getExtensions() { return { extensions: [], errors: [], runtime: this.runtime }; }
		} as unknown as PiCodingAgentModule["DefaultResourceLoader"];
		pi.resolveCliModel = (({ cliModel }) => {
			assert.equal(cliModel, "router/mimo-v2.5");
			assert.deepEqual(registeredProviders, ["router"]);
			assert.equal(refreshed, true);
			return { model: { provider: "router", id: "mimo-v2.5" } };
		}) as unknown as PiCodingAgentModule["resolveCliModel"];
		pi.createAgentSession = (async ({ model }) => ({ session: { bindExtensions: async () => {}, dispose() {}, extensionRunner: { hasHandlers: () => false }, subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, steer: async () => {}, followUp: async () => {}, messages: [], sessionId: "s", model } })) as unknown as PiCodingAgentModule["createAgentSession"];

		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create({ ...stubLaunch, model: "router/mimo-v2.5" });

		assert.equal(child.modelId, "router/mimo-v2.5");
		assert.deepEqual(pendingRuntime?.pendingProviderRegistrations, []);
	});

	it("reports a missing extension cache reset when the child loads extension files", async () => {
		const errors: string[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi() });
		await factory.create({ ...stubLaunch, onExtensionError: (error) => errors.push(error.extensionPath) });
		await factory.create({ ...stubLaunch, extensionPaths: ["/tmp/ext.ts"], onExtensionError: (error) => errors.push(error.extensionPath) });
		assert.deepEqual(errors, ["<loader>"]);
	});

	it("initializes the theme from settings before each child session", async () => {
		const themed: Array<string | undefined> = [];
		const pi = stubPi();
		pi.initTheme = ((themeName?: string) => { themed.push(themeName); }) as PiCodingAgentModule["initTheme"];
		pi.SettingsManager = { create: () => ({ getTheme: () => "solarized-dark" }) } as unknown as PiCodingAgentModule["SettingsManager"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		await factory.create(stubLaunch);
		await factory.create(stubLaunch);
		assert.deepEqual(themed, ["solarized-dark", "solarized-dark"]);
	});

	it("skips theme initialization when the pi module has no initTheme export", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi() });
		await factory.create(stubLaunch);
		// Reaching here without throwing is the assertion: `settingsManager.getTheme()`
		// must not be evaluated when `initTheme` is unavailable.
	});

	it("disposes the session when bindExtensions rejects", async () => {
		let disposed = 0;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => stubPi({ bindExtensions: async () => { throw new Error("bind failed"); }, dispose: () => { disposed += 1; } }) });
		await assert.rejects(factory.create(stubLaunch), /bind failed/);
		assert.equal(disposed, 1);
	});

	it("leaves detached children running on dispose and keeps the shared runtime", async () => {
		let aborted = 0;
		let runtimes = 0;
		const pi = stubPi({ abort: async () => { aborted += 1; } });
		pi.ModelRuntime = { create: async () => { runtimes += 1; return {}; } } as unknown as PiCodingAgentModule["ModelRuntime"];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const child = await factory.create(stubLaunch);
		child.detached = true;
		await factory.dispose();
		assert.equal(aborted, 0);
		assert.equal(child.shutDown, undefined);
		await factory.create(stubLaunch);
		assert.equal(runtimes, 1, "runtime is kept while a detached child runs");
	});

	it("bounds the wait for a stuck session_shutdown handler", { timeout: 2_000 }, async () => {
		const factory = createDefaultChildSessionFactory({ shutdownTimeoutMs: 50, loadPiCodingAgent: async () => stubPi({ extensionRunner: { hasHandlers: () => true, emit: () => new Promise(() => {}) } }) });
		(await factory.create(stubLaunch)).dispose();
		await factory.dispose();
	});
});
