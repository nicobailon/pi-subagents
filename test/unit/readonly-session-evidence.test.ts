import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDefaultChildSessionFactory, setChildSessionFactory, type ChildSession, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { getReadonlySessionEvidence, requestReadonlySessionEvidence, validateReadonlySessionCheckpoint, type SettledReadonlyEvidence } from "../../src/runs/shared/readonly-session-evidence.ts";
import { createChildHooks, isReadonlyChildHookProfile } from "../../src/runs/shared/child-hooks.ts";
import { buildInProcessChildLaunch, createReportedChildSessionInput } from "../../src/runs/shared/child-launch.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { flushPersist, getExcludedCount, getExclusionsFilePath } from "../../src/runs/shared/model-exclusions.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { runSingleStepInner, runSubagent } from "../../src/runs/background/subagent-runner.ts";
import { READONLY_CONTINUATION_PROMPT } from "../../src/runs/shared/readonly-model-continuation.ts";
import { createChildTranscriptWriter } from "../../src/shared/child-transcript.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";
import { discoverAgents, type AgentConfig } from "../../src/agents/agents.ts";
import { registerBackgroundWorkProvider } from "../../src/api/background-work.ts";
import { DIRS } from "../../src/shared/types.ts";
import { releaseActiveRunIndex, updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { resolveChildWatchdogConfig } from "../../src/watchdog/child-status.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";

function launch(cwd: string): ChildSessionLaunch & { storage: Extract<ChildSessionLaunch["storage"], { kind: "file" }> } {
	return { cwd, storage: { kind: "file", sessionFile: join(cwd, "session.jsonl") }, model: "baseten/model-a", tools: ["read"], extensionPaths: [],
		ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true,
		runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } } };
}

it("has no duck-typed receipt or caller-issued checkpoint", () => {
	const fake = { continuationEvidence: { status: 429 } } as unknown as ChildSession;
	assert.equal(getReadonlySessionEvidence(fake), undefined);
	assert.equal(validateReadonlySessionCheckpoint({ sessionFile: "not-read" } as SettledReadonlyEvidence), false);
});

it("ordinary startup fallback retains its fresh per-attempt timeout without a caller deadline", async () => {
	const realNow = Date.now;
	const start = realNow();
	let creates = 0;
	let listener: ((event: any) => void) | undefined;
	const agent: AgentConfig = { name: "reader", description: "Read", systemPrompt: "Read", source: "project", filePath: "reader.md", model: "mock/timeout-a", fallbackModels: ["mock/timeout-b"] };
	try {
		const result = await runSync(process.cwd(), [agent], "reader", "Summarize", {
			runId: "ordinary-startup-deadline", timeoutMs: 1000,
			childSessionFactory: {
				async create() {
					if (++creates === 1) { Date.now = () => start + 2000; throw new Error("503 service unavailable"); }
					return {
						subscribe(callback) { listener = callback; return () => {}; },
						async prompt() { listener?.({ type: "message_end", message: { role: "assistant", provider: "mock", model: "timeout-b", stopReason: "stop", content: [{ type: "text", text: "done" }] } }); },
						async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
						messages: [], sessionFile: undefined, sessionId: "fake", modelId: "mock/timeout-b",
					};
				},
				async dispose() {},
			},
		});
		assert.equal(creates, 2);
		assert.equal(result.exitCode, 0, result.error);
		assert.notEqual(result.timedOut, true);
	} finally { Date.now = realNow; }
});

it("rejects runtime and wait accessors without invoking getters during admission or revalidation", () => {
	for (const target of ["runtime", "wait object", "wait enabled"] as const) {
		for (const afterCapture of [false, true]) {
			const l = launch("/not-opened");
			if (afterCapture) l.hooks = createChildHooks(l.runtime);
			let calls = 0;
			const object = target === "wait enabled" ? l.runtime.waitTool : l.runtime;
			const key = target === "runtime" ? "sessionName" : target === "wait object" ? "waitTool" : "enabled";
			Object.defineProperty(object, key, { enumerable: true, get() { calls++; throw new Error("getter must not run"); } });
			if (!afterCapture) l.hooks = createChildHooks(l.runtime);
			assert.equal(isReadonlyChildHookProfile(l.hooks, l.runtime), false);
			assert.equal(calls, 0);
		}
	}
});

it("rejects hidden and symbol data keys in runtime and wait profiles", () => {
	for (const nested of [false, true]) {
		for (const key of ["hiddenOption", nested ? "enabled" : "sessionName", Symbol("unknown")]) {
			const l = launch("/not-opened");
			const value = key === "enabled" ? false : key === "sessionName" ? "hidden" : true;
			Object.defineProperty(nested ? l.runtime.waitTool : l.runtime, key, { value, enumerable: typeof key === "symbol" });
			l.hooks = createChildHooks(l.runtime);
			assert.equal(isReadonlyChildHookProfile(l.hooks, l.runtime), false);
		}
	}
});

const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
async function countAsyncIO(run: (counts: { scans: number; reads: number; stats: number }) => Promise<void>) {
	const counts = { scans: 0, reads: 0, stats: 0 };
	const readdir = fs.readdirSync, read = fs.readFileSync, stat = fs.statSync;
	const status = (p: unknown) => String(p).startsWith(`${DIRS.async}/`) && String(p).endsWith("/status.json");
	fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => { if (String(args[0]) === join(DIRS.async, ".active-runs")) counts.scans++; return readdir(...args); }) as typeof fs.readdirSync;
	fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => { if (status(args[0])) counts.reads++; return read(...args); }) as typeof fs.readFileSync;
	fs.statSync = ((...args: Parameters<typeof fs.statSync>) => { if (status(args[0])) counts.stats++; return stat(...args); }) as typeof fs.statSync;
	syncBuiltinESMExports();
	try { await run(counts); }
	finally { fs.readdirSync = readdir; fs.readFileSync = read; fs.statSync = stat; syncBuiltinESMExports(); }
}

describe("native 0.85.1 factory evidence (synthetic transport, real configured ModelRuntime)", { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated SDK install root" }, () => {
	let pi: PiCodingAgentModule;
	async function sdk() {
		if (!pi) {
			// ESM conditions matter: the SDK has import-only package exports.
			const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
			assert.match(entry, /\/dist\/index\.js$/);
			pi = await import(entry);
			assert.equal(pi.VERSION, "0.85.1");
		}
		return pi;
	}
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	function sse(tool = false, tokens = 0): Response {
		const delta = tool ? { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] } : { content: "complete" };
		const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens * 2 } };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
	function http(status: number): Response {
		return new Response(JSON.stringify({ error: { message: "synthetic rate limit", type: "rate_limit_error" } }), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
	}
	type NativeSession = Awaited<ReturnType<PiCodingAgentModule["createAgentSession"]>>["session"];
	type Captured = { session: NativeSession; original: NativeSession["agent"]["streamFunction"]; runtime: NonNullable<Parameters<PiCodingAgentModule["createAgentSession"]>[0]>["modelRuntime"] };
	async function fixture(run: (f: { pi: PiCodingAgentModule; cwd: string; agentDir: string; l: ReturnType<typeof launch>; factory: ReturnType<typeof createDefaultChildSessionFactory>; captured: Captured[]; acknowledge: (id: string) => void; requests: { body: Record<string, unknown> }[]; setResponses: (responses: (() => Response | Promise<Response>)[]) => void }) => Promise<void>, settings: Record<string, unknown> = {}, fresh = false) {
		const realPi = await sdk();
		const cwd = mkdtempSync(join(tmpdir(), "readonly-factory-"));
		const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		const previousFetch = globalThis.fetch;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, ...settings }));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { baseten: { baseUrl: "https://synthetic.invalid/configured/v1", apiKey: "fixture-key", headers: { "X-Fixture": "preserved" }, models: ["model-a", "model-b", "model-c"].map((id) => ({ id, name: id, api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
		writeFileSync(join(cwd, "marker.txt"), "DISTINCTIVE_REAL_BUILTIN_READ_RESULT");
		const l = launch(cwd);
		l.hooks = createChildHooks(l.runtime);
		if (!fresh) {
			const manager = realPi.SessionManager.open(l.storage.sessionFile, undefined, cwd);
			manager.appendMessage({ role: "user", content: "Earlier context", timestamp: 1 });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], api: "openai-completions", provider: "baseten", model: "model-a", stopReason: "stop", timestamp: 2, usage: { ...usage, input: 101, output: 103, totalTokens: 204, cost: { ...usage.cost, total: 2 } } });
		}
		const requests: { body: Record<string, unknown> }[] = [];
		let responses: (() => Response | Promise<Response>)[] = [];
		// Test process only: every HTTP operation is intercepted; never contact a provider.
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			assert.equal(url, "https://synthetic.invalid/configured/v1/chat/completions");
			assert.equal(init?.method, "POST");
			assert.ok(init?.signal);
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), "Bearer fixture-key");
			assert.equal(headers.get("x-fixture"), "preserved");
			requests.push({ body: JSON.parse(String(init.body)) });
			const next = responses.shift(); assert.ok(next, "unexpected request (including auxiliary HTTP)");
			return next();
		};
		const captured: Captured[] = [];
		let eventBus: ReturnType<PiCodingAgentModule["createEventBus"]>;
		// Observe public SDK objects without stubbing the runtime, session, adapter, or stream closure.
		const observedPi: PiCodingAgentModule = { ...realPi, DefaultResourceLoader: class extends realPi.DefaultResourceLoader {
			constructor(options: ConstructorParameters<PiCodingAgentModule["DefaultResourceLoader"]>[0]) {
				eventBus = realPi.createEventBus();
				super({ ...options, eventBus });
			}
		}, createAgentSession: async (options) => {
			const result = await realPi.createAgentSession(options);
			captured.push({ session: result.session, original: result.session.agent.streamFunction, runtime: options?.modelRuntime });
			return result;
		} };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => observedPi, shutdownTimeoutMs: 20 });
		try { await run({ pi: realPi, cwd, agentDir, l, factory, captured, acknowledge: (id) => eventBus.emit("subagent:acknowledge-extension", { id }), requests, setResponses: (value) => { responses = value; } }); }
		finally {
			await factory.dispose(); globalThis.fetch = previousFetch;
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	function resolvedLaunch(l: ReturnType<typeof launch>, model = "baseten/model-a") {
		return buildInProcessChildLaunch({
			cwd: l.cwd, host: "parent", sessionEnabled: true, sessionFile: l.storage.sessionFile,
			model, tools: ["read"], requireReadTool: true, allowNestedSubagents: false, waitToolEnabled: false,
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			parentSessionId: "resolved-parent", runId: "resolved-run", childAgentName: "reader", childIndex: 0,
			sessionName: "resolved reader", forkCacheKey: "resolved-cache", systemPrompt: "Retain the completed read.",
		});
	}

	for (const scenario of ["success", "retained", "cross-provider-skip", "no-sibling", "second429", "sibling-startup", "sibling-abort", "unverified-sibling", "wrong-model", "changed-file", "missing-file", "cancel-at-create", "deadline-at-create", "usage-budget", "tool-budget", "wait-profile", "directory", "text429", "stop-at-settlement", "steer-at-settlement", "smaller-model"] as const) {
		it(`actual foreground owned continuation loop: ${scenario}`, async (test) => fixture(async ({ pi, l, factory, requests, setResponses, captured, cwd, agentDir }) => {
			const file = l.storage.sessionFile;
			if (scenario === "retained") {
				const manager = pi.SessionManager.open(file, undefined, cwd);
				manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier billed answer" }], api: "openai-completions", provider: "baseten", model: "model-a", stopReason: "stop", timestamp: 3, usage: { ...usage, input: 100, output: 100, totalTokens: 200 } });
			}
			const exclusionCount = getExcludedCount();
			flushPersist();
			const exclusionFile = getExclusionsFilePath();
			const exclusionBefore = existsSync(exclusionFile) ? readFileSync(exclusionFile, "utf8") : undefined;
			if (scenario === "smaller-model") {
				const config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
				config.providers.baseten.models[1].contextWindow = 100;
				writeFileSync(join(agentDir, "models.json"), JSON.stringify(config));
			}
			const agent: AgentConfig = {
				name: "reader", description: "Read only", systemPrompt: "Retain completed reads.", systemPromptMode: "append",
				inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
				tools: ["read"], allowNestedSubagents: false, source: "project", filePath: join(cwd, "reader.md"),
				model: "baseten/model-a", fallbackModels: scenario === "no-sibling" ? ["openai/gpt-4o"] : scenario === "cross-provider-skip" ? ["openai/gpt-4o", "baseten/model-b", "baseten/model-c"] : ["baseten/model-b", "baseten/model-c"],
			};
			const controller = new AbortController();
			const children: ChildSession[] = [];
			let creates = 0;
			const createMs: number[] = [];
			const disposeMs: number[] = [];
			const realNow = Date.now;
			const start = Date.now();
			setResponses([() => sse(true, 7), () => {
				if (scenario === "text429") throw new Error("429 synthetic rate limit");
				return http(429);
			}, () => scenario === "second429" ? http(429) : sse(false, 11)]);
			const result = await runSync(cwd, [agent], "reader", "ORIGINAL_TASK read marker.txt once", {
				cwd, runId: "owned-foreground", sessionDir: cwd, sessionFile: scenario === "directory" ? undefined : file,
				waitToolEnabled: scenario === "wait-profile", signal: controller.signal,
				...(scenario === "deadline-at-create" ? { timeoutMs: 10000 } : {}),
				...(scenario === "usage-budget" ? { usageBudget: { tokens: { hard: 100000 } } } : {}),
				...(scenario === "tool-budget" ? { toolBudget: { hard: 10, block: ["read"] } } : {}),
				childSessionFactory: { ...factory, async create(input) {
					const createStart = performance.now();
					creates++;
					if (creates === 2) {
						assert.ok(getReadonlySessionEvidence(children[0]), "proof exists before sibling creation");
						if (scenario === "sibling-startup") throw new Error("503 service unavailable");
						if (scenario === "wrong-model") input.model = "baseten/model-c";
						if (scenario === "changed-file") writeFileSync(file, readFileSync(file, "utf8") + "{}\n");
						if (scenario === "missing-file") rmSync(file);
						if (scenario === "cancel-at-create") controller.abort();
					}
					const child = await factory.create(input);
					createMs.push(performance.now() - createStart);
					const realDispose = child.dispose.bind(child);
					child.dispose = async () => { const start = performance.now(); await realDispose(); disposeMs.push(performance.now() - start); };
					children.push(child);
					if (creates === 2) {
						assert.equal(child.sessionId, children[0].sessionId);
						assert.equal(child.sessionFile, children[0].sessionFile);
						if (scenario === "sibling-abort") child.prompt = async () => { throw new Error("aborted"); };
						if (scenario === "unverified-sibling") return { ...child };
						if (scenario === "deadline-at-create") {
							Date.now = () => start + 20000;
						}
					}
					if (creates === 1 && (scenario === "stop-at-settlement" || scenario === "steer-at-settlement")) {
						const dispose = child.dispose.bind(child);
						child.dispose = async () => {
							await dispose();
							if (scenario === "stop-at-settlement") controller.abort();
							else await child.steer("intervening steering").catch(() => {});
						};
					}
					return child;
				} },
			}).finally(() => { Date.now = realNow; });
			const denied = ["no-sibling", "usage-budget", "tool-budget", "wait-profile", "directory", "text429", "stop-at-settlement", "steer-at-settlement", "smaller-model"].includes(scenario);
			assert.equal(creates, denied ? 1 : 2, result.error);
			assert.equal(result.modelAttempts?.length, denied ? 1 : 2);
			assert.equal(requests.length, ["success", "retained", "cross-provider-skip", "second429"].includes(scenario) ? 3 : 2, "no dispatch after a handoff veto and no third model dispatch");
			if (scenario === "success" || scenario === "retained" || scenario === "cross-provider-skip") {
				assert.equal(result.exitCode, 0, result.error);
				assert.deepEqual(result.attemptedModels, ["baseten/model-a", "baseten/model-b"]);
				assert.equal(requests[2].body.model, "model-b");
				const payload = JSON.stringify(requests[2].body.messages);
				for (const text of ["DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1", "Do not restart or repeat completed work"]) assert.ok(payload.includes(text), text);
				if (scenario === "retained") for (const text of ["Earlier context", "Earlier answer"]) assert.ok(payload.includes(text), text);
				assert.equal(payload.match(/ORIGINAL_TASK/g)?.length, 1);
				const diskMessages = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.type === "message");
				assert.equal(JSON.stringify(diskMessages).match(/ORIGINAL_TASK/g)?.length, 1, "task only in retained messages; session-name metadata may also retain it");
				assert.match(readFileSync(file, "utf8"), /"stopReason":"error"/);
				assert.equal(result.usage.input, 18);
				assert.equal(result.usage.output, 18);
				assert.equal(result.progressSummary?.toolCount, 1);
				assert.equal(captured.length, 2);
				test.diagnostic(JSON.stringify({ scenario, historyBytes: Buffer.byteLength(readFileSync(file, "utf8")), createMs, shutdownAndValidationMs: disposeMs, logicalMs: Date.now() - start }));
			} else assert.notEqual(result.exitCode, 0, "negative cannot report success");
			flushPersist();
			assert.equal(getExcludedCount(), exclusionCount);
			assert.equal(existsSync(exclusionFile) ? readFileSync(exclusionFile, "utf8") : undefined, exclusionBefore, "midrun recovery never changes exclusions");
		}, {}, scenario !== "retained"));
	}

	for (const budgetOwner of ["none", "single", "workflow"] as const) {
		it(`actual executor propagates ${budgetOwner} configured usage budget`, async () => fixture(async ({ factory, cwd, setResponses }) => {
			const agent: AgentConfig = { name: "reader", description: "Read", systemPrompt: "Read marker.txt", systemPromptMode: "append", tools: ["read"], extensions: [], allowNestedSubagents: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, source: "project", filePath: join(cwd, "reader.md"), model: "baseten/model-a", fallbackModels: ["baseten/model-b"] };
			const children: ChildSession[] = [];
			const inputs: ChildSessionLaunch[] = [];
			setChildSessionFactory({ ...factory, async create(input) { inputs.push(input); const child = await factory.create(input); children.push(child); return child; } });
			const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, pendingForegroundControlNotices: new Map(), cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } };
			try {
				const executor = createSubagentExecutor({
					pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
					state: state as any, config: { maxSubagentDepth: 2, control: {}, intercomBridge: { mode: "off" } } as any,
					asyncByDefault: false, waitToolEnabled: false, tempArtifactsDir: join(cwd, "artifacts"), getSubagentSessionRoot: () => join(cwd, "sessions"), expandTilde: (value) => value,
					discoverAgents: () => ({ agents: [agent] }),
				});
				setResponses([() => sse(true), () => http(429), () => sse()]);
				const single = { agent: "reader", task: "Read marker.txt once", async: false, output: false };
				const request = budgetOwner === "workflow" ? { workflowScript: `return await runs.run('reader', ${JSON.stringify(single)});`, async: false, mission: false, usageBudget: { tokens: { hard: 100000 } } } : { ...single, ...(budgetOwner === "single" ? { usageBudget: { tokens: { hard: 100000 } } } : {}) };
				const result = await executor.execute("budget-owner", request, undefined, undefined, { cwd, hasUI: false, sessionManager: { getSessionId() { return "parent"; }, getSessionFile() { return null; } }, modelRegistry: { getAvailable() { return ["model-a", "model-b"].map((id) => ({ provider: "baseten", id })); } }, model: { provider: "baseten", id: "model-a" } } as any);
				assert.ok(children[0] && getReadonlySessionEvidence(children[0]), JSON.stringify(inputs));
				assert.equal(children.length, budgetOwner === "none" ? 2 : 1, JSON.stringify(result));
			} finally {
				setChildSessionFactory(undefined);
				for (const timer of state.cleanupTimers.values()) clearTimeout(timer);
			}
		}, {}, true));
	}

	it("certifies explicitly test-opted-in actual foreground and sibling with no admission/dispatch/settlement native scans", async () => countAsyncIO(async (io) => fixture(async ({ l, factory, captured, requests, setResponses, cwd }) => {
		const file = l.storage.sessionFile;
		assert.equal(existsSync(file), false, "fixture never preinitializes the assigned file");
		const agent: AgentConfig = {
			name: "reader", description: "Read only", systemPrompt: "Retain the completed read.", systemPromptMode: "append",
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			tools: ["read"], allowNestedSubagents: false, source: "project", filePath: join(cwd, "reader.md"),
		};
		const children: ChildSession[] = [];
		let expected: SettledReadonlyEvidence | undefined;
		const inputs: ChildSessionLaunch[] = [];
		const hostFactory = { ...factory, async create(input: ChildSessionLaunch) {
			const beforeCreate = { ...io };
			inputs.push(input);
			assert.equal(typeof input.onExtensionError, "function", "mandatory real host reporting retained");
			assert.equal(input.runtime.watchdogStatus, undefined, "only absent-watchdog sink is omitted");
			assert.equal(input.runtime.childWatchdog, undefined);
			assert.deepEqual(input.runtime.waitTool, { enabled: false });
			assert.deepEqual(input.runtime.requiredTools, ["read"], "actual no-skills requireReadTool=false output is not modified");
			assert.equal(typeof input.runtime.toolDiagnostic, "function");
			assert.equal(typeof input.runtime.runtimeAcknowledgements, "function");
			// This older two-call seam fixture additionally tests explicit guarded handoff.
			requestReadonlySessionEvidence(input, expected);
			const child = await factory.create(input);
			assert.deepEqual(io, beforeCreate, "no native index or status read at opted-in create");
			children.push(child);
			assert.notEqual(captured.at(-1)!.session.agent.streamFunction, captured.at(-1)!.original);
			if (!expected) {
				assert.equal(existsSync(file), false, "SDK defers fresh-file persistence until assistant response");
				assert.equal(child.messages.length, 0);
				assert.equal(child.sessionId, captured[0].session.sessionManager.getHeader()!.id);
			} else {
				assert.equal(child.sessionId, expected.sessionId);
				assert.equal(JSON.stringify(child.messages), expected.contextJson);
			}
			input.onExtensionError!({ extensionPath: "<fixture>", event: "test", error: new Error("mandatory report retained") });
			return child;
		} };
		const options = { cwd, sessionFile: file, sessionDir: cwd, artifactsDir: join(cwd, "artifacts"), parentSessionId: "foreground-parent", runId: "foreground-read", waitToolEnabled: false, childSessionFactory: hostFactory };
		assert.deepEqual(io, { scans: 0, reads: 0, stats: 0 });
		setResponses([() => { assert.deepEqual(io, { scans: 0, reads: 0, stats: 0 }); return sse(true); },
			() => { assert.deepEqual(io, { scans: 0, reads: 0, stats: 0 }); return http(429); }]);
		const result = await runSync(cwd, [{ ...agent, model: "baseten/model-a" }], "reader", "Fresh original task: read marker.txt once", options);
		assert.deepEqual(io, { scans: 1, reads: 0, stats: 0 }, "only the first ordinary source drain query, none at settlement");
		assert.equal(children.length, 1, result.error);
		expected = getReadonlySessionEvidence(children[0]); assert.ok(expected, result.error);
		assert.equal(expected.sessionFile, file);
		assert.equal(expected.sessionId, JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id);
		assert.match(readFileSync(result.transcriptPath!, "utf8"), /mandatory report retained/);
		setResponses([() => { assert.deepEqual(io, { scans: 1, reads: 0, stats: 0 }); return sse(); }]);
		await runSync(cwd, [{ ...agent, model: "baseten/model-b" }], "reader", "Continue from retained results", options);
		assert.deepEqual(io, { scans: 2, reads: 0, stats: 0 }, "one unchanged drain per actual attempt, no guarded dispatch or settlement scan");
		assert.equal(children.length, 2);
		assert.equal(requests.length, 3);
		assert.equal(requests[2].body.model, "model-b");
		const payload = JSON.stringify(requests[2].body.messages);
		for (const text of ["DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1", "You are a child subagent", "Retain the completed read."]) assert.ok(payload.includes(text), text);
		assert.equal(payload.match(/Fresh original task: read marker.txt once/g)?.length, 1);
		assert.match(readFileSync(file, "utf8"), /"stopReason":"error"/);
		assert.deepEqual(inputs.map((input) => input.storage), [{ kind: "file", sessionFile: file }, { kind: "file", sessionFile: file }]);
	}, {}, true)));

	function runnerLaunch(l: ReturnType<typeof launch>, model = "baseten/model-a", overrides: Partial<RunnerSubagentStep> = {}, context = {}) {
		const step: RunnerSubagentStep = {
			agent: "reader", task: "Runner original task: read marker.txt once", context: "fresh",
			sessionFile: l.storage.sessionFile, parentSessionId: "runner-parent",
			tools: ["read"], extensions: [], allowNestedSubagents: false, waitToolEnabled: false,
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			systemPrompt: "Retain the completed read.", ...overrides,
		};
		return buildRunnerChildLaunch(step, { cwd: l.cwd, id: "runner-read", flatIndex: 0, ...context }, {
			model, sessionEnabled: true, sessionName: "runner reader", watchdogStatus: () => assert.fail("absent watchdog has no consumer"),
		});
	}

	function ownedRunnerStep(cwd: string, file: string): RunnerSubagentStep {
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agents", "loop-reader.md"), "---\nname: loop-reader\ndescription: Read-only loop\ntools: read\nextensions:\nallowNestedSubagents: false\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nRetain the completed read.\n");
		const agent = discoverAgents(cwd, "project").agents.find((agent) => agent.name === "loop-reader")!;
		assert.deepEqual(agent.extensions, []);
		return { agent: agent.name, task: "Owned original task: read marker.txt once", context: "fresh", sessionFile: file,
			modelCandidates: ["baseten/model-a", "other-provider/untried", "baseten/model-b", "baseten/model-c"],
			tools: agent.tools, extensions: agent.extensions, allowNestedSubagents: agent.allowNestedSubagents,
			inheritProjectContext: agent.inheritProjectContext, inheritGlobalContext: agent.inheritGlobalContext, inheritSkills: agent.inheritSkills,
			systemPrompt: agent.systemPrompt, waitToolEnabled: false };
	}

	function enlargeRunnerSibling(agentDir: string) {
		const file = join(agentDir, "models.json");
		const config = JSON.parse(readFileSync(file, "utf8"));
		config.providers.baseten.models[1].contextWindow = 256000;
		config.providers.baseten.models.push({ ...config.providers.baseten.models[1], id: "model-c", name: "model-c" });
		config.providers["other-provider"] = { ...config.providers.baseten, models: [{ ...config.providers.baseten.models[0], id: "untried", name: "untried" }] };
		writeFileSync(file, JSON.stringify(config));
	}

	for (const kind of ["success", "fresh success", "second429", "sibling startup", "sibling abort", "model mismatch", "stop after settlement", "deadline after settlement", "stop during create", "changed file", "missing file", "steer", "late shutdown", "fake factory", "ambient", "tool budget", "unknown token budget", "equal window", "retained image", "retained context too large", "no sibling", "false429"] as const) {
		it(`owned native runner loop: ${kind}`, async () => fixture(async ({ pi, cwd, agentDir, l, factory, captured, requests, setResponses }) => {
			const success = kind === "success" || kind === "fresh success";
			flushPersist();
			const exclusionsPath = getExclusionsFilePath();
			const exclusionsBefore = existsSync(exclusionsPath) ? readFileSync(exclusionsPath, "utf8") : undefined;
			if (kind !== "equal window") enlargeRunnerSibling(agentDir);
			const file = l.storage.sessionFile;
			const step = ownedRunnerStep(cwd, file);
			if (kind === "retained image" || kind === "retained context too large") {
				pi.SessionManager.open(file, undefined, cwd).appendMessage({ role: "user", timestamp: 3,
					content: kind === "retained image" ? [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }] : "retained text ".repeat(12_000) });
			}
			if (kind === "ambient") step.extensions = undefined;
			if (kind === "tool budget") step.toolBudget = { hard: 100, block: "*" };
			if (kind === "no sibling") step.modelCandidates = ["baseten/model-a"];
			const stop = new AbortController();
			const deadline = Date.now() + 60_000;
			const children: ChildSession[] = [];
			const inputs: ChildSessionLaunch[] = [];
			let ledgerTokens = 0;
			const context = { cwd, id: "owned-loop", flatIndex: 0, flatStepCount: 1, previousOutput: "", placeholder: "{previous}",
				outputFile: join(cwd, "output.log"), artifactsDir: join(cwd, "artifacts"), sessionEnabled: true, deadlineAt: deadline,
				stopSignal: stop.signal,
				usageBudget: kind === "unknown token budget" ? { tokens: { hard: 1000 } } : undefined,
				usageBudgetExhausted: kind === "unknown token budget" ? undefined : () => ledgerTokens >= 1000,
				onChildEvent: (event: import("../../src/runs/background/run-child-session.ts").ChildEvent) => {
					if (event.type === "message_end" && event.message?.role === "assistant") ledgerTokens += (event.message.usage?.input ?? 0) + (event.message.usage?.output ?? 0);
				},
				childSessions: { ...factory, async create(input: ChildSessionLaunch) {
					inputs.push(input);
					if (inputs.length === 2 && kind === "sibling startup") throw new Error("synthetic startup failure");
					const child = await factory.create(input); children.push(child);
					if (kind === "fake factory") return { ...child };
					if (inputs.length === 2 && kind === "stop during create") stop.abort();
					if (inputs.length === 2 && kind === "sibling abort") await child.abort();
					if (inputs.length === 2 && kind === "model mismatch") Object.defineProperty(child, "modelId", { value: "baseten/wrong-model" });
					if (kind === "late shutdown") {
						const runner = captured.at(-1)!.session.extensionRunner;
						const emit = runner.emit.bind(runner);
						runner.emit = (event) => event.type === "session_shutdown" ? new Promise(() => {}) : emit(event);
					}
					if (inputs.length === 1) {
						const dispose = child.dispose;
						child.dispose = async () => {
							await dispose();
							if (kind === "stop after settlement") stop.abort();
							if (kind === "deadline after settlement") context.deadlineAt = Date.now() - 1;
							if (kind === "changed file") appendFileSync(file, "changed\n");
							if (kind === "missing file") rmSync(file);
							if (kind === "steer") await child.steer("intervening input");
						};
					}
					return child;
				} },
			};
			setResponses([() => sse(true, 7), () => { if (kind === "false429") throw new Error("429: synthetic rate limit"); return http(429); },
				() => kind === "second429" ? http(429) : sse(false, 11)]);
			const result = await runSingleStepInner(step, context);
			flushPersist();
			assert.equal(existsSync(exclusionsPath) ? readFileSync(exclusionsPath, "utf8") : undefined, exclusionsBefore, "continuation never changes startup exclusions");
			assert.equal(result.sessionFile, file);
			assert.ok(inputs.length <= 2, "shared token forbids third creation");
			assert.ok(requests.length <= 3, "shared token forbids third model dispatch");
			assert.equal(requests.filter((request) => request.body.model === "untried" || request.body.model === "model-c").length, 0);
			assert.equal(result.usage?.input, success ? 18 : 7, JSON.stringify(result));
			assert.equal(result.usage?.output, success ? 18 : 7);
			assert.equal(result.usage?.cost, 0, "the retained historical $2 charge is not a new event delta");
			assert.equal(ledgerTokens, success ? 36 : 14, "only new event deltas reach the ledger");
			if (success) {
				assert.equal(result.exitCode, 0, result.error);
				assert.deepEqual(result.attemptedModels, ["baseten/model-a", "baseten/model-b"]);
				assert.equal(result.modelAttempts?.length, 2);
				assert.equal(children[0].sessionId, children[1].sessionId);
				assert.deepEqual(inputs.map((input) => input.storage), [{ kind: "file", sessionFile: file }, { kind: "file", sessionFile: file }]);
				const payload = JSON.stringify(requests[2].body.messages);
				for (const text of ["DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1", READONLY_CONTINUATION_PROMPT]) assert.ok(payload.includes(text), text);
				if (kind !== "fresh success") for (const text of ["Earlier context", "Earlier answer"]) assert.ok(payload.includes(text), text);
				assert.equal(payload.match(/Owned original task: read marker.txt once/g)?.length, 1);
				assert.match(readFileSync(file, "utf8"), /"stopReason":"error"/);
				assert.match(result.output, /\[readonly-continuation\]/);
				assert.ok(result.transcriptPath && existsSync(result.transcriptPath));
				assert.equal(captured[1].session.model?.id, "model-b");
			} else {
				assert.notEqual(result.exitCode, 0, kind);
				if (!["second429", "sibling startup", "sibling abort", "model mismatch", "stop during create", "changed file", "missing file"].includes(kind)) assert.equal(inputs.length, 1, kind);
			}
		}, {}, kind === "fresh success"));
	}

	it("owned run deadline without step timeout vetoes creation before timer delivery", async () => fixture(async ({ cwd, agentDir, l, factory, requests, setResponses }) => {
		enlargeRunnerSibling(agentDir);
		const file = l.storage.sessionFile;
		const step = ownedRunnerStep(cwd, file);
		assert.equal(step.timeoutMs, undefined);
		const asyncDir = join(cwd, "deadline-async");
		const deadlineAt = Date.now() + 2000;
		let creations = 0;
		let settledBeforeExpiry = false;
		let settledEvidence: SettledReadonlyEvidence | undefined;
		const observedFactory = { ...factory, async create(input: ChildSessionLaunch) {
			creations++;
			const child = await factory.create(input);
			if (creations === 1) {
				const dispose = child.dispose;
				child.dispose = async () => {
					await dispose();
					settledEvidence = getReadonlySessionEvidence(child);
					settledBeforeExpiry = Date.now() < deadlineAt;
					// Deliberately keep this turn synchronous: the real parent timer becomes due,
					// but cannot deliver before the settlement microtask reaches the host guard.
					while (Date.now() <= deadlineAt) { /* bounded by the original two-second deadline */ }
				};
			}
			return child;
		} };
		setResponses([() => sse(true, 7), () => http(429), () => sse(false, 11)]);
		await runSubagent({ id: "owned-deadline", cwd, asyncDir, resultPath: join(asyncDir, "result.json"),
			placeholder: "{previous}", sessionId: "parent-session", steps: [step], deadlineAt,
			controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled: false },
		}, observedFactory);
		assert.ok(settledEvidence, "real settled proof exists; deadline alone must deny continuation");
		assert.ok(settledBeforeExpiry, "source shutdown settled before the original deadline");
		assert.ok(Date.now() > deadlineAt);
		assert.equal(creations, 1, "no sibling creation after original expiry, even before timer delivery");
		assert.equal(requests.length, 2);
		const status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
		assert.equal(status.deadlineAt, deadlineAt);
		assert.notEqual(status.timedOut, true, "the asynchronous parent timeout did not supply the veto");
		assert.equal(status.steps[0].modelAttempts.length, 1);
		assert.equal(status.totalTokens.input, 7);
		assert.equal(status.totalTokens.output, 7);
		assert.match(readFileSync(file, "utf8"), /"stopReason":"error"/);
	}));

	for (const kind of ["unconfigured", "available tokens", "exhausted tokens", "concurrent exhausted tokens", "concurrent unknown tokens", "cost unknown"] as const) {
		it(`owned run ledger and final publication: ${kind}`, async () => fixture(async ({ cwd, agentDir, l, factory, requests, setResponses }) => {
			enlargeRunnerSibling(agentDir);
			const step = ownedRunnerStep(cwd, l.storage.sessionFile);
			const concurrent = kind.startsWith("concurrent");
			const unknown = kind === "concurrent unknown tokens";
			const asyncDir = join(cwd, "owned-async");
			const resultPath = join(asyncDir, "result.json");
			let release: (() => void) | undefined;
			const bothStarted = new Promise<void>((resolve) => { release = resolve; });
			let unknownObserved: (() => void) | undefined;
			const missingUsage = new Promise<void>((resolve) => { unknownObserved = resolve; });
			let created = 0;
			const observedFactory = { ...factory, async create(input: ChildSessionLaunch) {
				const child = await factory.create(input);
				if (++created === 2 && unknown) {
					const subscribe = child.subscribe;
					child.subscribe = (listener) => subscribe((event) => {
						const message = event.message as { role?: string; usage?: Record<string, unknown> } | undefined;
						if (event.type === "message_end" && message?.role === "assistant") {
							listener({ ...event, message: { ...message, usage: { ...message.usage, input: undefined, inputTokens: undefined, output: 0 } } });
							unknownObserved!();
						} else listener(event);
					});
				}
				return child;
			} };
			let initialRequests = 0;
			setResponses(Array.from({ length: 8 }, () => async () => {
				const request = requests.at(-1)!.body;
				if (request.model === "model-b") return sse(false, 11);
				const hasRead = (request.messages as { role: string }[]).some((message) => message.role === "tool");
				if (hasRead) { if (unknown) await missingUsage; return http(429); }
				if (concurrent) { if (++initialRequests === 2) release!(); await bothStarted; }
				return sse(true, 7);
			}));
			await runSubagent({ id: "owned-ledger", cwd, asyncDir, resultPath, placeholder: "{previous}", sessionId: "parent-session",
				steps: concurrent ? [{ parallel: [step, { ...step, sessionFile: join(cwd, "parallel-session.jsonl") }], concurrency: 2 }] : [step],
				controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled: false }, artifactsDir: join(cwd, "artifacts"),
				usageBudget: kind === "unconfigured" ? undefined : kind === "cost unknown" ? { costUsd: { hard: 100 } }
					: { tokens: { hard: kind === "available tokens" || unknown ? 1000 : concurrent ? 20 : 10 } },
			}, observedFactory);
			const status = JSON.parse(readFileSync(join(asyncDir, "status.json"), "utf8"));
			const result = JSON.parse(readFileSync(resultPath, "utf8"));
			const success = kind === "unconfigured" || kind === "available tokens";
			assert.equal(status.state, success ? "complete" : "failed", JSON.stringify(result));
			assert.equal(requests.length, success ? 3 : concurrent ? 4 : 2);
			assert.equal(status.totalTokens.input, success ? 18 : concurrent && !unknown ? 14 : 7);
			assert.equal(status.totalTokens.output, success ? 18 : concurrent && !unknown ? 14 : 7);
			assert.equal(status.steps[0].modelAttempts.length, success ? 2 : 1);
			assert.equal(status.steps[0].toolCount, 1, "restored history is not a new tool event");
			assert.ok(status.steps[0].durationMs >= 0);
			assert.ok(existsSync(join(asyncDir, "events.jsonl")));
			if (kind.includes("tokens")) {
				assert.equal(status.usageBudget.tokens.used, success ? 36 : concurrent && !unknown ? 28 : 14);
				assert.equal(status.usageBudget.exhausted, !success && !unknown);
			}
		}));
	}

	for (const optedIn of [false, true]) it(`actual native runner construction and mandatory captures, evidence opt-in=${optedIn}`, async () => countAsyncIO(async (io) => fixture(async ({ l, factory, captured, acknowledge, requests, setResponses, cwd }) => {
		const file = l.storage.sessionFile;
		assert.equal(existsSync(file), false);
		const children: ChildSession[] = [];
		let expected: SettledReadonlyEvidence | undefined;
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agents", "runner-reader.md"), "---\nname: runner-reader\ndescription: Explicit read-only runner\ntools: read\nextensions:\nallowNestedSubagents: false\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\nRetain the completed read.\n");
		const agent = discoverAgents(cwd, "project").agents.find((agent) => agent.name === "runner-reader");
		assert.ok(agent);
		assert.deepEqual(agent.extensions, [], "ordinary agent discovery preserves the explicit empty extension configuration");
		// async-execution transfers these agent fields unchanged into RunnerSubagentStep.
		const configured = { tools: agent.tools, extensions: agent.extensions, allowNestedSubagents: agent.allowNestedSubagents,
			inheritProjectContext: agent.inheritProjectContext, inheritGlobalContext: agent.inheritGlobalContext, inheritSkills: agent.inheritSkills,
			systemPrompt: agent.systemPrompt };
		let currentLaunch = runnerLaunch(l, "baseten/model-a", configured);
		const transcriptPath = join(cwd, "runner-transcript.jsonl");
		const transcriptWriter = createChildTranscriptWriter({ transcriptPath, source: "async", runId: "runner-read", agent: "reader", cwd });
		const hostFactory = { ...factory, async create(input: ChildSessionLaunch) {
			const before = { ...io };
			assert.deepEqual(input.hooks.map((hook) => hook.name), ["pi-subagents:prompt-runtime", "pi-subagents:completion-intent"]);
			assert.equal(input.ambientExtensions, false, "configured extensions:[] disables ambient through ordinary tool-plan resolution");
			assert.equal(input.processEnv?.MCP_DIRECT_TOOLS, "__none__", "runner environment is retained");
			assert.equal(input.runtime.watchdogStatus, undefined);
			assert.deepEqual(input.runtime.requiredTools, ["read"]);
			assert.equal(typeof input.runtime.toolDiagnostic, "function");
			assert.equal(typeof input.runtime.runtimeAcknowledgements, "function");
			assert.equal(typeof input.onExtensionError, "function");
			assert.equal(currentLaunch.capture.completionIntentContext?.(), undefined);
			if (optedIn) requestReadonlySessionEvidence(input, expected);
			const child = await factory.create(input);
			children.push(child);
			assert.deepEqual(io, before, "no create-time native scans/reads");
			if (optedIn) assert.notEqual(captured.at(-1)!.session.agent.streamFunction, captured.at(-1)!.original);
			else assert.equal(captured.at(-1)!.session.agent.streamFunction, captured.at(-1)!.original);
			const intent = currentLaunch.capture.completionIntentContext?.();
			assert.equal(intent?.model, captured.at(-1)!.session.model);
			assert.ok(intent?.modelRegistry);
			assert.deepEqual(intent.modelRegistry.find("baseten", intent.model!.id), intent.model);
			assert.deepEqual(Object.keys(intent!), ["model", "modelRegistry"]);
			acknowledge("runner-reviewed");
			const diagnostic = { required: ["read"], available: [], missing: ["read"] };
			input.runtime.toolDiagnostic!(diagnostic);
			assert.equal(currentLaunch.capture.toolDiagnostic(), diagnostic);
			input.onExtensionError!({ extensionPath: "<fixture>", event: "test", error: new Error("runner mandatory report retained") });
			if (expected) {
				assert.equal(child.sessionId, expected.sessionId);
				assert.equal(JSON.stringify(child.messages), expected.contextJson);
			} else {
				assert.equal(existsSync(file), false, "SDK owns deferred fresh-file initialization");
				assert.equal(child.sessionId, captured[0].session.sessionManager.getHeader()!.id);
			}
			return child;
		} };
		const run = (prompt: string) => runChildSession({ factory: hostFactory, launch: currentLaunch, prompt, transcriptWriter, appendChildEvent: () => {}, writeOutputLine: () => {} });
		setResponses([() => { assert.deepEqual(io, { scans: 0, reads: 0, stats: 0 }); return sse(true); },
			() => { assert.deepEqual(io, { scans: 0, reads: 0, stats: 0 }); return http(429); }]);
		const result = await run("Runner original task: read marker.txt once");
		assert.equal(children.length, 1, result.error);
		assert.equal(requests.length, 2, result.error);
		assert.deepEqual(io, { scans: 1, reads: 0, stats: 0 }, "one ordinary drain only");
		assert.equal(currentLaunch.capture.toolDiagnostic(), undefined, "actual agent_start clears diagnostic after checking real tools");
		assert.deepEqual(currentLaunch.capture.runtimeAcknowledgedExtensions()?.ids, ["runner-reviewed"]);
		assert.match(readFileSync(transcriptPath, "utf8"), /runner mandatory report retained/);
		expected = getReadonlySessionEvidence(children[0]);
		if (!optedIn) { assert.equal(expected, undefined); return; }
		assert.ok(expected);
		assert.equal(expected.sessionFile, file);
		assert.equal(expected.sessionId, JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id);
		currentLaunch = runnerLaunch(l, "baseten/model-b", configured);
		setResponses([() => { assert.deepEqual(io, { scans: 1, reads: 0, stats: 0 }); return sse(); }]);
		await run("Continue from retained results");
		assert.deepEqual(io, { scans: 2, reads: 0, stats: 0 });
		assert.equal(requests.length, 3);
		assert.equal(requests[2].body.model, "model-b");
		const payload = JSON.stringify(requests[2].body.messages);
		for (const text of ["DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1", "Retain the completed read."]) assert.ok(payload.includes(text), text);
		assert.equal(payload.match(/Runner original task: read marker.txt once/g)?.length, 1);
		assert.match(readFileSync(file, "utf8"), /"stopReason":"error"/);
	}, {}, true)));

	for (const kind of ["completion replacement", "completion removal", "reporter replacement", "routing", "inheritance", "wait timeout", "default ambient"] as const) {
		it(`keeps runner profile fail-closed: ${kind}`, async () => fixture(async ({ l, factory, captured }) => {
			const built = runnerLaunch(l, "baseten/model-a", kind === "wait timeout" ? { waitToolDefaultTimeoutMs: 10 } : kind === "default ambient" ? { extensions: undefined } : {},
				kind === "routing" ? { childIntercomTarget: "configured-child", orchestratorIntercomTarget: "configured-parent" }
					: kind === "inheritance" ? { inheritedChildRuntime: { depth: 1, thinkingCeiling: "low" } } : {});
			if (kind === "completion replacement") built.session.hooks[1] = { name: "pi-subagents:completion-intent", factory: (api) => api.on("session_start", () => {}) };
			if (kind === "completion removal") built.session.hooks.pop();
			const input = createReportedChildSessionInput(built);
			if (kind === "reporter replacement") input.onExtensionError = () => {};
			requestReadonlySessionEvidence(input);
			const child = await factory.create(input);
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose();
			assert.equal(getReadonlySessionEvidence(child), undefined);
		}));
	}

	it("retains the configured runner watchdog and exact sink rather than certifying it", async () => fixture(async ({ l }) => {
		const childWatchdog = resolveChildWatchdogConfig({ config: { ...DEFAULT_WATCHDOG_CONFIG, enabled: true, children: { ...DEFAULT_WATCHDOG_CONFIG.children, enabled: true } } });
		assert.ok(childWatchdog);
		const sink = () => {};
		const built = buildRunnerChildLaunch({ agent: "reader", task: "read", sessionFile: l.storage.sessionFile,
			tools: ["read"], extensions: [], allowNestedSubagents: false, waitToolEnabled: false,
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false },
			{ cwd: l.cwd, id: "runner-watchdog", flatIndex: 0 }, { sessionEnabled: true, childWatchdog, watchdogStatus: sink });
		assert.equal(built.config.childWatchdog, childWatchdog);
		assert.equal(built.config.watchdogStatus, sink);
		assert.equal(isReadonlyChildHookProfile(built.session.hooks, built.config), false);
	}));

	it("vetoes replaced mandatory runner completion capture before guarded dispatch", async () => fixture(async ({ l, factory, requests, setResponses }) => {
		const sourceInput = createReportedChildSessionInput(runnerLaunch(l));
		requestReadonlySessionEvidence(sourceInput);
		const child = await factory.create(sourceInput);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const siblingInput = createReportedChildSessionInput(runnerLaunch(l, "baseten/model-b"));
		requestReadonlySessionEvidence(siblingInput, receipt);
		const sibling = await factory.create(siblingInput);
		siblingInput.hooks[1] = { name: "pi-subagents:completion-intent", factory: () => {} };
		await assert.rejects(() => sibling.prompt("Continue"));
		await sibling.dispose();
		assert.equal(requests.length, 2);
	}));

	for (const kind of ["empty preexisting", "corrupt preexisting", "appeared during open", "memory", "directory", "default"] as const) {
		it(`does not certify fresh storage: ${kind}`, async () => fixture(async ({ l, factory, captured, setResponses }) => {
			const file = l.storage.sessionFile;
			if (kind === "empty preexisting") writeFileSync(file, "");
			if (kind === "corrupt preexisting") writeFileSync(file, "corrupt\n");
			const built = resolvedLaunch(l);
			if (kind === "memory") built.session.storage = { kind: "memory" };
			if (kind === "directory") built.session.storage = { kind: "dir", sessionDir: l.cwd };
			if (kind === "default") built.session.storage = { kind: "default" };
			const input = createReportedChildSessionInput(built);
			requestReadonlySessionEvidence(input);
			const opening = factory.create(input);
			if (kind === "appeared during open") writeFileSync(file, "");
			if (kind === "corrupt preexisting") {
				await assert.rejects(opening, /not a valid/);
				assert.equal(readFileSync(file, "utf8"), "corrupt\n");
				return;
			}
			const child = await opening;
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Read marker.txt"); await child.dispose();
			assert.equal(getReadonlySessionEvidence(child), undefined);
		}, {}, true));
	}

	for (const timing of ["before create", "during open", "before prompt"] as const) {
		it(`never recreates missing guarded fresh-source storage ${timing}`, async () => fixture(async ({ l, factory, captured, requests, setResponses }) => {
			const input = createReportedChildSessionInput(resolvedLaunch(l));
			requestReadonlySessionEvidence(input);
			const child = await factory.create(input);
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Read marker.txt"); await child.dispose();
			const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
			const next = createReportedChildSessionInput(resolvedLaunch(l, "baseten/model-b"));
			requestReadonlySessionEvidence(next, receipt);
			if (timing === "before create") rmSync(receipt.sessionFile);
			const opening = factory.create(next);
			if (timing === "during open") rmSync(receipt.sessionFile);
			if (timing !== "before prompt") {
				await assert.rejects(opening, /checkpoint changed/);
				assert.equal(captured.length, 1);
			} else {
				const sibling = await opening;
				rmSync(receipt.sessionFile);
				await assert.rejects(sibling.prompt("Continue"), /changed before prompt/);
				await sibling.dispose();
			}
			assert.equal(requests.length, 2);
			assert.equal(existsSync(receipt.sessionFile), false);
		}, {}, true));
	}

	for (const kind of ["replaced reporter", "deleted reporter", "copied reporter", "accessor reporter", "unknown watchdog sink"] as const) {
		it(`leaves uncertified actual caller additions uninstrumented: ${kind}`, async () => fixture(async ({ l, factory, captured }) => {
			const built = resolvedLaunch(l);
			let input = createReportedChildSessionInput(built);
			let reporterReads = 0;
			const reporter = input.onExtensionError;
			if (kind === "replaced reporter") input.onExtensionError = () => {};
			if (kind === "deleted reporter") delete input.onExtensionError;
			if (kind === "copied reporter") input = { ...input };
			if (kind === "accessor reporter") Object.defineProperty(input, "onExtensionError", { enumerable: true, get() { reporterReads++; return reporter; } });
			if (kind === "unknown watchdog sink") input.runtime.watchdogStatus = () => {};
			requestReadonlySessionEvidence(input);
			const opening = factory.create(input);
			assert.equal(reporterReads, 0, "admission must not invoke the getter; ordinary SDK setup may read it later");
			const child = await opening;
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		}));
	}

	it("vetoes replaced host reporting on a guarded sibling before dispatch", async () => fixture(async ({ l, factory, requests, setResponses }) => {
		const input = createReportedChildSessionInput(resolvedLaunch(l));
		requestReadonlySessionEvidence(input);
		const child = await factory.create(input);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const next = createReportedChildSessionInput(resolvedLaunch(l, "baseten/model-b"));
		requestReadonlySessionEvidence(next, receipt);
		const sibling = await factory.create(next);
		next.onExtensionError = () => {};
		await assert.rejects(sibling.prompt("Continue"), /changed before prompt/);
		await sibling.dispose(); assert.equal(requests.length, 2);
	}));

	it("certifies an actual launch-built read-only profile with owned diagnostics and acknowledgements intact", async () => fixture(async ({ l, factory, captured, acknowledge, requests, setResponses }) => {
		const built = resolvedLaunch(l);
		assert.deepEqual(built.config.requiredTools, ["read"]);
		assert.equal(typeof built.config.toolDiagnostic, "function");
		assert.equal(typeof built.config.runtimeAcknowledgements, "function");
		const seed = { required: ["read"], available: [], missing: ["read"] };
		built.config.toolDiagnostic!(seed);
		assert.equal(built.capture.toolDiagnostic(), seed);
		const previous = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";
		try {
			requestReadonlySessionEvidence(built.session);
			const child = await factory.create(built.session);
			assert.notEqual(captured[0].session.agent.streamFunction, captured[0].original, "resolved profile must be instrumented");
			assert.deepEqual(captured[0].session.getAllTools().map((tool) => tool.name), ["read"]);
			acknowledge("reviewed-fixture"); acknowledge("reviewed-fixture"); acknowledge("../invalid");
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Resolved original task: read marker.txt once"); await child.dispose();
			assert.equal(requests.length, 2);
			assert.equal(isReadonlyChildHookProfile(built.session.hooks, built.config), true);
			const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
			assert.equal(built.capture.toolDiagnostic(), undefined, "actual agent_start clears the seeded diagnostic");
			assert.deepEqual(built.capture.runtimeAcknowledgedExtensions()?.ids, ["reviewed-fixture"], "actual finalization captures and projects validated event ids");
			acknowledge("too-late");
			assert.deepEqual(built.capture.runtimeAcknowledgedExtensions()?.ids, ["reviewed-fixture"]);
			assert.equal(captured[0].session.sessionManager.getSessionName(), "resolved reader");
			const next = resolvedLaunch(l, "baseten/model-b");
			requestReadonlySessionEvidence(next.session, receipt);
			const sibling = await factory.create(next.session);
			assert.equal(sibling.sessionFile, receipt.sessionFile);
			assert.equal(sibling.sessionId, receipt.sessionId);
			assert.equal(JSON.stringify(sibling.messages), receipt.contextJson);
			setResponses([() => sse()]); await sibling.prompt("Continue from retained results"); await sibling.dispose();
			const payload = JSON.stringify(requests[2].body.messages);
			for (const text of ["Earlier context", "Earlier answer", "DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1", "You are a child subagent", "Retain the completed read."]) assert.ok(payload.includes(text), text);
			assert.equal(payload.match(/Resolved original task: read marker.txt once/g)?.length, 1);
			assert.equal(requests[2].body.model, "model-b");
			assert.equal(requests[2].body.prompt_cache_key, "resolved-cache");
			assert.match(readFileSync(receipt.sessionFile, "utf8"), /"stopReason":"error"/);
		} finally { if (previous === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previous; }
	}));

	it("keeps ordinary launch-built sessions dormant and finalizes acknowledgements on shutdown without a prompt", async () => fixture(async ({ l, factory, captured, acknowledge }) => {
		const built = resolvedLaunch(l);
		const child = await factory.create(built.session);
		assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
		acknowledge("shutdown-observation");
		assert.equal(built.capture.runtimeAcknowledgedExtensions(), undefined);
		await child.dispose();
		assert.deepEqual(built.capture.runtimeAcknowledgedExtensions()?.ids, ["shutdown-observation"]);
		assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("denies resolved-profile evidence when acknowledgement shutdown does not settle before timeout", async () => fixture(async ({ l, factory, captured, setResponses }) => {
		const built = resolvedLaunch(l);
		requestReadonlySessionEvidence(built.session); const child = await factory.create(built.session);
		setResponses([() => sse(true), () => http(429)]); await child.prompt("Read marker.txt");
		const runner = captured[0].session.extensionRunner;
		const original = runner.emit.bind(runner);
		let shutdown: Promise<void> | undefined;
		runner.emit = (event) => event.type === "session_shutdown"
			? (shutdown = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => original(event))) : original(event);
		await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		await shutdown; assert.equal(getReadonlySessionEvidence(child), undefined, "late settlement must not restore evidence");
	}));

	it("vetoes a replaced owned callback on guarded resolved-profile continuation before dispatch", async () => fixture(async ({ l, factory, requests, setResponses }) => {
		const built = resolvedLaunch(l);
		requestReadonlySessionEvidence(built.session); const child = await factory.create(built.session);
		setResponses([() => sse(true), () => http(429)]); await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const next = resolvedLaunch(l, "baseten/model-b");
		requestReadonlySessionEvidence(next.session, receipt); const sibling = await factory.create(next.session);
		next.config.runtimeAcknowledgements = () => { throw new Error("unknown callback"); };
		await assert.rejects(sibling.prompt("Continue"), /changed before prompt/);
		assert.equal(requests.length, 2); await sibling.dispose();
	}));

	for (const kind of ["diagnostic replacement", "ack replacement", "copied callbacks", "unknown setting", "required accessor", "required hidden", "required mutation", "writer", "extra hook"] as const) {
		it(`denies unsupported resolved launch: ${kind}`, async () => fixture(async ({ l, factory, captured }) => {
			const built = resolvedLaunch(l);
			if (kind === "diagnostic replacement") built.config.toolDiagnostic = () => {};
			if (kind === "ack replacement") built.config.runtimeAcknowledgements = () => {};
			if (kind === "copied callbacks") built.session.hooks = createChildHooks(built.config);
			if (kind === "unknown setting") Object.assign(built.config, { unknownSetting: true });
			if (kind === "required accessor") Object.defineProperty(built.config.requiredTools, "0", { enumerable: true, get() { throw new Error("admission invoked requiredTools getter"); } });
			if (kind === "required hidden") Object.defineProperty(built.config.requiredTools, "hidden", { value: true });
			if (kind === "required mutation") built.config.requiredTools!.push("ls");
			if (kind === "writer") built.session.tools!.push("write");
			if (kind === "extra hook") built.session.hooks.push({ name: "unknown", factory() {} });
			requestReadonlySessionEvidence(built.session); const child = await factory.create(built.session);
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		}));
	}

	it("certifies the actual prompt-runtime hook without dropping its naming, prompt, cache or drain effects", async () => fixture(async ({ l, factory, captured, requests, setResponses }) => {
		Object.assign(l.runtime, { sessionName: "certified child", inheritSkills: false, forkCacheKey: "certified-cache-key" });
		l.hooks = createChildHooks(l.runtime);
		l.hooks[0].name = "display-name-is-not-identity";
		const previous = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";
		try {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			assert.deepEqual(captured[0].session.getAllTools().map((tool) => tool.name), ["read"], "registered bg_wait must not be executable");
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Read marker.txt once for the original task"); await child.dispose();
			const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
			assert.equal(captured[0].session.sessionManager.getSessionName(), "certified child");
			assert.match(JSON.stringify(requests[1].body.messages), /You are a child subagent/);
			assert.equal(requests[1].body.prompt_cache_key, "certified-cache-key");
			const next = { ...l, model: "baseten/model-b" };
			requestReadonlySessionEvidence(next, receipt); const sibling = await factory.create(next);
			assert.equal(sibling.sessionId, receipt.sessionId);
			assert.equal(sibling.sessionFile, receipt.sessionFile);
			assert.equal(JSON.stringify(sibling.messages), receipt.contextJson);
			setResponses([() => sse()]); await sibling.prompt("Continue from retained results"); await sibling.dispose();
			const payload = JSON.stringify(requests[2].body.messages);
			for (const text of ["Earlier context", "Earlier answer", "DISTINCTIVE_REAL_BUILTIN_READ_RESULT", "read-1"]) assert.ok(payload.includes(text));
			assert.equal(payload.match(/Read marker.txt once for the original task/g)?.length, 1);
			assert.equal(requests[2].body.prompt_cache_key, "certified-cache-key");
		} finally { if (previous === undefined) delete process.env.PI_CACHE_RETENTION; else process.env.PI_CACHE_RETENTION = previous; }
	}));

	for (const kind of ["name spoof", "copied config", "mutated config", "callback", "inherited callback", "unknown option", "wait", "extra hook"] as const) {
		it(`denies uncertified hook profile: ${kind}`, async () => fixture(async ({ l, factory, captured }) => {
			if (kind === "callback") l.runtime.runtimeAcknowledgements = () => {};
			if (kind === "inherited callback") Object.setPrototypeOf(l.runtime, { runtimeAcknowledgements: () => {} });
			if (kind === "unknown option") Object.assign(l.runtime, { unknownOption: true });
			if (kind === "wait") l.runtime.waitTool.enabled = true;
			l.hooks = createChildHooks(l.runtime);
			if (kind === "name spoof") l.hooks = [{ name: "pi-subagents:prompt-runtime", factory() {} }];
			if (kind === "copied config") l.runtime = { ...l.runtime };
			if (kind === "mutated config") l.runtime.sessionName = "changed after capture";
			if (kind === "extra hook") l.hooks.push({ name: "extra", factory() {} });
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		}));
	}

	it("denies the non-enumerable diagnostic pair without disabling ordinary diagnostics", async () => fixture(async ({ l, factory, captured, setResponses }) => {
		let diagnostics = 0;
		Object.defineProperties(l.runtime, {
			requiredTools: { value: ["read"] },
			toolDiagnostic: { value: () => { diagnostics++; } },
		});
		l.hooks = createChildHooks(l.runtime);
		assert.equal(isReadonlyChildHookProfile(l.hooks, l.runtime), false);
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		assert.equal(diagnostics, 1, "ordinary hook behavior must remain intact");
		assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("denies registered background callbacks without invoking them for eligibility", async () => fixture(async ({ l, factory, captured }) => {
		l.hooks = createChildHooks(l.runtime);
		let calls = 0;
		const unregister = registerBackgroundWorkProvider({ name: "hook-test", reconcile() { calls++; }, listActiveWork() { calls++; return []; } });
		try {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
			assert.equal(calls, 0);
		} finally { unregister(); }
	}));

	for (const kind of ["dead-owned", "result-owned", "unrelated-dead", "unknown-owner", "completed-before-drain"] as const) {
		it(`actual SDK receipt uses same-pass pre-repair evidence: ${kind}`, async () => fixture(async ({ l, factory, setResponses }) => {
			const runId = `sdk-drain-${kind}`; const dir = join(DIRS.async, runId);
			const file = l.storage.sessionFile;
			mkdirSync(dir, { recursive: true });
			const status = { runId, mode: "single", state: "running", startedAt: Date.now(), steps: [{ agent: "reader", status: "running" }],
				sessionId: kind === "unrelated-dead" ? "/another/session" : kind === "unknown-owner" ? undefined : file,
				...(kind.includes("dead") ? { pid: 2147483647 } : {}),
			};
			writeFileSync(join(dir, "status.json"), JSON.stringify(status)); updateActiveRunIndex(dir, "running");
			if (kind === "result-owned") { mkdirSync(DIRS.results, { recursive: true }); writeFileSync(join(DIRS.results, `${runId}.json`), JSON.stringify({ success: true, results: [] })); }
			try {
				requestReadonlySessionEvidence(l); const child = await factory.create(l);
				setResponses([() => sse(true), () => {
					if (kind === "completed-before-drain") {
						writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status, state: "complete" })); updateActiveRunIndex(dir, "complete");
					}
					return http(429);
				}]);
				await child.prompt("Read marker.txt");
				assert.equal(getReadonlySessionEvidence(child), undefined, "only settled factory can issue receipt");
				await child.dispose();
				assert.equal(!!getReadonlySessionEvidence(child), kind === "unrelated-dead" || kind === "completed-before-drain");
				if (kind.includes("dead") || kind === "result-owned") assert.equal(JSON.parse(readFileSync(join(dir, "status.json"), "utf8")).state, kind === "result-owned" ? "complete" : "failed");
			} finally { releaseActiveRunIndex(dir); rmSync(dir, { recursive: true, force: true }); rmSync(join(DIRS.results, `${runId}.json`), { force: true }); }
		}));
	}

	it("does not scan preexisting native work at admission; missing drain cannot certify it", async () => fixture(async ({ l, factory, captured }) => {
		l.hooks = createChildHooks(l.runtime);
		const runId = "hook-existing-work";
		const dir = join(DIRS.async, runId); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, state: "queued", mode: "single", startedAt: Date.now(), sessionId: l.storage.sessionFile, steps: [{ agent: "worker", status: "pending" }] }));
		updateActiveRunIndex(dir, "queued");
		try {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			assert.notEqual(captured[0].session.agent.streamFunction, captured[0].original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		} finally { releaseActiveRunIndex(dir); rmSync(dir, { recursive: true, force: true }); }
	}));

	it("vetoes guarded continuation when background callbacks appear after creation", async () => fixture(async ({ l, factory, requests, setResponses }) => {
		l.hooks = createChildHooks(l.runtime);
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const next = { ...l, model: "baseten/model-b" };
		requestReadonlySessionEvidence(next, receipt); const sibling = await factory.create(next);
		let calls = 0;
		const unregister = registerBackgroundWorkProvider({ name: "guarded-drain", listActiveWork() { calls++; return []; } });
		try {
			setResponses([() => sse()]);
			await assert.rejects(sibling.prompt("Continue"), /before prompt/);
			assert.equal(requests.length, 2); assert.equal(calls, 0);
			await sibling.dispose();
		} finally { unregister(); }
	}));

	it("cannot issue a receipt without the actual installed drain even after real read/429 and shutdown", async () => fixture(async ({ l, factory, setResponses }) => {
		l.hooks = [];
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("invalidates the source proof immediately before the unchanged agent-end drain", async () => fixture(async ({ l, factory, setResponses }) => {
		l.hooks = createChildHooks(l.runtime);
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		let unregister = () => {}; let calls = 0;
		setResponses([() => sse(true), () => {
			unregister = registerBackgroundWorkProvider({ name: "late-drain", listActiveWork() {
				calls++;
				assert.equal(isReadonlyChildHookProfile(l.hooks, l.runtime), false);
				return [];
			} });
			return http(429);
		}]);
		try {
			await child.prompt("Read marker.txt"); unregister();
			assert.ok(calls > 0, "the actual drain must not be disabled");
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
			assert.equal(isReadonlyChildHookProfile(l.hooks, l.runtime), false, "invalidation survives provider removal");
		} finally { unregister(); }
	}));

	it("retains complete same-file context, real builtin result and terminal numeric 429 only after disposal", async () => fixture(async ({ l, factory, requests, setResponses }) => {
		requestReadonlySessionEvidence(l);
		const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt once for the original task");
		assert.equal(getReadonlySessionEvidence(child), undefined);
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[1].body), /DISTINCTIVE_REAL_BUILTIN_READ_RESULT/);
		await child.dispose();
		const receipt = getReadonlySessionEvidence(child);
		assert.ok(receipt, JSON.stringify(child.messages));
		assert.equal(receipt.status, 429); assert.equal(receipt.provider, "baseten");
		assert.equal(receipt.completedToolResults, 1);
		assert.equal(receipt.sessionId, child.sessionId);
		assert.equal(receipt.sessionFile, child.sessionFile);
		assert.equal(validateReadonlySessionCheckpoint(receipt), true);
		const next = { ...l, model: "baseten/model-b" };
		requestReadonlySessionEvidence(next, receipt);
		const sibling = await factory.create(next);
		assert.equal(sibling.sessionId, receipt.sessionId);
		assert.equal(sibling.sessionFile, receipt.sessionFile);
		assert.equal(JSON.stringify(sibling.messages), receipt.contextJson);
		setResponses([() => sse()]);
		await sibling.prompt("Continue using retained results; do not restart");
		await sibling.dispose();
		const payload = JSON.stringify(requests.at(-1)?.body);
		assert.match(payload, /DISTINCTIVE_REAL_BUILTIN_READ_RESULT/);
		assert.equal(payload.match(/Read marker.txt once for the original task/g)?.length, 1);
		assert.equal(requests.at(-1)?.body.model, "model-b");
		assert.match(readFileSync(receipt.sessionFile, "utf8"), /"stopReason":"error"/);
		assert.equal(getReadonlySessionEvidence(sibling), undefined);
		assert.equal(validateReadonlySessionCheckpoint(receipt), false);
	}));

	for (const [name, tail] of [
		["successful retry", [() => http(429), () => sse()]],
		["401 after 429", [() => http(429), () => http(401)]],
		["transport rejection after 429", [() => http(429), () => { throw new Error("fetch transport rejection"); }]],
		["HTTP 200 with 429-looking stream error", [() => new Response('data: {"error":{"message":"429 rate limit"}}\n\n', { headers: { "content-type": "text/event-stream" } })]],
	] as const) {
		it(`rejects stale/false status: ${name}`, async () => fixture(async ({ l, factory, requests, setResponses }) => {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			setResponses([() => sse(true), ...tail]);
			await child.prompt("Read marker.txt"); await child.dispose();
			assert.equal(requests.length, 1 + tail.length);
			assert.equal(getReadonlySessionEvidence(child), undefined);
		}, { retry: { enabled: false, provider: { maxRetries: 1 } } }));
	}

	it("denies corrupt checkpoints before SDK open and leaves the file untouched", async () => fixture(async ({ l, factory, setResponses }) => {
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		appendFileSync(receipt.sessionFile, "{corrupt\n");
		const before = readFileSync(receipt.sessionFile, "utf8");
		requestReadonlySessionEvidence(l, receipt);
		await assert.rejects(factory.create(l), /checkpoint changed/);
		assert.equal(readFileSync(receipt.sessionFile, "utf8"), before);
	}));

	it("rejects truncation after create begins without SDK newline repair", async () => fixture(async ({ l, factory, captured, setResponses }) => {
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		const next = { ...l, model: "baseten/model-b" };
		requestReadonlySessionEvidence(next, receipt);
		const opening = factory.create(next);
		const truncated = readFileSync(receipt.sessionFile, "utf8").slice(0, -1);
		writeFileSync(receipt.sessionFile, truncated);
		await assert.rejects(opening, /checkpoint changed/);
		assert.equal(readFileSync(receipt.sessionFile, "utf8"), truncated);
		assert.equal(captured.length, 1, "must reject before constructing the sibling SDK session");
	}));

	for (const timing of ["before prompt", "before dispatch"] as const) {
		it(`vetoes guarded provider refresh ${timing} without HTTP dispatch`, async () => fixture(async ({ l, factory, captured, requests, setResponses }) => {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Read marker.txt"); await child.dispose();
			const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
			const next = { ...l, model: "baseten/model-b" };
			requestReadonlySessionEvidence(next, receipt);
			const sibling = await factory.create(next);
			const { session, runtime } = captured[1];
			const provider = runtime!.getProvider("baseten");
			const refresh = async () => {
				await runtime!.refresh({ allowNetwork: false });
				assert.notEqual(runtime!.getProvider("baseten"), provider);
			};
			if (timing === "before prompt") await refresh();
			else {
				const original = session.agent.transformContext;
				session.agent.transformContext = async (messages, signal) => {
					await refresh();
					return original ? original(messages, signal) : messages;
				};
			}
			setResponses([() => sse()]); // A dispatched request would succeed, not hide behind a fixture error.
			if (timing === "before prompt") await assert.rejects(sibling.prompt("Continue from retained results"), /before prompt/);
			else {
				await sibling.prompt("Continue from retained results");
				const terminal = sibling.messages.at(-1);
				assert.equal(terminal?.role, "assistant");
				assert.ok(terminal?.role === "assistant" && terminal.stopReason === "error");
				assert.match(terminal.errorMessage ?? "", /before dispatch/);
			}
			assert.equal(requests.length, 2, "guarded sibling must not send a third HTTP request");
			await sibling.dispose();
			assert.equal(getReadonlySessionEvidence(sibling), undefined);
		}));
	}

	it("preserves request-local fetch, configured auth/endpoint/headers, payload/response callbacks and abort", async () => fixture(async ({ l, factory, captured, requests }) => {
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		const { session, original } = captured[0];
		let fetchCalls = 0; let payloadCalls = 0; let responseCalls = 0;
		const controller = new AbortController();
		const options = { signal: controller.signal, maxRetries: 0,
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls++;
				assert.equal(String(input), "https://synthetic.invalid/configured/v1/chat/completions");
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
				assert.equal(new Headers(init?.headers).get("x-fixture"), "preserved");
				assert.equal(init?.signal?.aborted, false);
				assert.equal(JSON.parse(String(init?.body)).model, "model-a");
				assert.equal(JSON.parse(String(init?.body)).temperature, 0.123);
				return sse();
			},
			onPayload: (payload: unknown) => { payloadCalls++; return { ...(payload as Record<string, unknown>), temperature: 0.123 }; },
			onResponse: (response: { status: number }) => { responseCalls++; assert.equal(response.status, 200); },
		};
		const stream = await session.agent.streamFunction(session.model!, { messages: [] }, options);
		assert.equal((await stream.result()).stopReason, "stop");
		assert.equal(fetchCalls, 1); assert.equal(payloadCalls, 1); assert.equal(responseCalls, 1);
		assert.equal(requests.length, 0, "must use request-local fetch rather than ambient transport");
		controller.abort();
		const aborted = await session.agent.streamFunction(session.model!, { messages: [] }, options);
		const unwrappedAbort = await original.call(session.agent, session.model!, { messages: [] }, options);
		assert.equal((await aborted.result()).stopReason, (await unwrappedAbort.result()).stopReason);
		assert.equal((await aborted.result()).errorMessage, (await unwrappedAbort.result()).errorMessage);
		assert.equal(fetchCalls, 1, "auth-stage cancellation must not reach transport");
		await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("clears a prior 429 when a session-level retry fails before reaching fetch", async () => fixture(async ({ l, factory, captured, requests, setResponses }) => {
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		let payloads = 0;
		captured[0].session.agent.onPayload = () => { if (++payloads === 3) throw new Error("429-looking failure without HTTP"); };
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		assert.equal(payloads, 3); assert.equal(requests.length, 2);
		assert.equal(getReadonlySessionEvidence(child), undefined);
	}, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } } }));

	it("denies a config-selected Radius/pi-messages replacement without changing configured behavior", async () => fixture(async ({ agentDir, l, factory, captured }) => {
		const config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		config.providers.baseten.oauth = "radius";
		for (const model of config.providers.baseten.models) model.api = "pi-messages";
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(config));
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		assert.equal(captured[0].session.model?.api, "pi-messages");
		assert.equal(captured[0].session.agent.streamFunction, captured[0].original, "unsupported transport is not instrumented");
		await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("invalidates an ordinary configured-provider replacement after the failed invocation", async () => fixture(async ({ l, factory, captured, setResponses }) => {
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt");
		await captured[0].runtime!.refresh({ allowNetwork: false });
		await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("rejects a real SDK custom read override even when its name matches the allowlist", async () => fixture(async ({ pi, l }) => {
		let session: NativeSession | undefined;
		let original: NativeSession["agent"]["streamFunction"] | undefined;
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...pi, createAgentSession: async (options) => {
			const builtin = pi.createReadToolDefinition(l.cwd);
			const result = await pi.createAgentSession({ ...options, customTools: [{ ...builtin, execute: async () => ({ content: [{ type: "text", text: "custom override" }], details: {} }) }] });
			session = result.session; original = session.agent.streamFunction;
			return result;
		} }) });
		try {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			assert.notEqual(session!.getAllTools().find((tool) => tool.name === "read")?.sourceInfo?.source, "builtin");
			assert.equal(session!.agent.streamFunction, original);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
		} finally { await factory.dispose(); }
	}));

	it("rejects an unresolved old call before SDK provider-context synthesis", async () => fixture(async ({ pi, l, factory, captured }) => {
		const manager = pi.SessionManager.open(l.storage.sessionFile, undefined, l.cwd);
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "unresolved", name: "read", arguments: { path: "marker.txt" } }], api: "openai-completions", provider: "baseten", model: "model-a", stopReason: "toolUse", timestamp: 3, usage });
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
		assert.equal(child.messages.at(-1)?.role, "assistant");
		await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
	}));

	it("checks the settled active branch rather than flattening retired branches", async () => fixture(async ({ pi, l, factory, setResponses }) => {
		const manager = pi.SessionManager.open(l.storage.sessionFile, undefined, l.cwd);
		const leaf = manager.getLeafId()!;
		manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "retired-unresolved", name: "write", arguments: {} }], api: "openai-completions", provider: "baseten", model: "model-a", stopReason: "toolUse", timestamp: 3, usage });
		manager.branch(leaf); manager.appendThinkingLevelChange("off");
		requestReadonlySessionEvidence(l); const child = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await child.prompt("Read marker.txt"); await child.dispose();
		const receipt = getReadonlySessionEvidence(child); assert.ok(receipt);
		assert.doesNotMatch(receipt.contextJson, /retired-unresolved/);
		assert.match(readFileSync(receipt.sessionFile, "utf8"), /retired-unresolved/);
	}));

	for (const corruption of ["missing result", "corrupt JSONL", "truncated JSONL"] as const) {
		it(`denies retained history with ${corruption}`, async () => fixture(async ({ l, factory, setResponses }) => {
			requestReadonlySessionEvidence(l); const child = await factory.create(l);
			setResponses([() => sse(true), () => http(429)]);
			await child.prompt("Read marker.txt");
			const file = child.sessionFile!;
			const bytes = readFileSync(file, "utf8");
			const rows = bytes.trimEnd().split("\n").map((line) => JSON.parse(line));
			if (corruption === "missing result") rows.splice(rows.findIndex((row) => row.message?.role === "toolResult"), 1);
			const changed = corruption === "corrupt JSONL" ? `${bytes}{corrupt\n` : corruption === "truncated JSONL" ? bytes.slice(0, -8) : rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
			writeFileSync(file, changed);
			await child.dispose(); assert.equal(getReadonlySessionEvidence(child), undefined);
			assert.equal(readFileSync(file, "utf8"), changed);
		}));
	}

	it("keeps ordinary sessions dormant and rejects cancellation", async () => fixture(async ({ l, factory, captured, setResponses }) => {
		const ordinary = await factory.create(l);
		assert.equal(captured[0].session.agent.streamFunction, captured[0].original);
		setResponses([() => sse(true), () => http(429)]);
		await ordinary.prompt("Read marker.txt"); await ordinary.dispose();
		assert.equal(getReadonlySessionEvidence(ordinary), undefined);
		requestReadonlySessionEvidence(l); const cancelled = await factory.create(l);
		setResponses([() => sse(true), () => http(429)]);
		await cancelled.prompt("Read marker.txt"); await cancelled.abort(); await cancelled.dispose();
		assert.equal(getReadonlySessionEvidence(cancelled), undefined);
	}));
});
