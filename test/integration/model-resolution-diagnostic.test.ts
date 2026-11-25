/**
 * A child whose model comes from an extension-registered provider fails to
 * start when that extension is not loaded into it, and Pi core reports only
 * that the model is unknown. These tests drive the real failure paths for both
 * hosts: a foreground child must be told that it inherits the parent's
 * registered providers and how to load the extension itself, and a child that
 * did load the ambient extensions must keep the plain core error.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDefaultChildSessionFactory, type ParentProviderRegistry, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const MODEL = "pengepul/commandcode/deepseek/deepseek-v4.1-flash";
const MODEL_NOT_FOUND = `Model "${MODEL}" not found. Use --list-models to see available models.`;

/** A pi module stub whose model resolver rejects the provider-extension model. */
function unresolvedModelPi(): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}), create: () => ({}) },
		resolveCliModel: (({ cliModel }: { cliModel: string }) => ({
			error: `Model "${cliModel}" not found. Use --list-models to see available models.`,
		})) as unknown as PiCodingAgentModule["resolveCliModel"],
		createAgentSession: (async () => { throw new Error("The child must not reach session creation."); }) as unknown as PiCodingAgentModule["createAgentSession"],
	} as unknown as PiCodingAgentModule;
}

const PROVIDER_ERROR = "prompt-capture: no capture for this 120-char system prompt";
const bridgeParent: ParentProviderRegistry = {
	getRegisteredProviderIds: () => ["bridge"],
	getRegisteredProviderConfig: () => ({ models: [] }) as never,
	getRegisteredNativeProvider: () => undefined,
};
const errorReply = { role: "assistant", content: [], stopReason: "error", errorMessage: PROVIDER_ERROR, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };

/** A pi module stub whose `bridge/model` session replays `replies` as the first prompt's assistant messages; an Error reply rejects the prompt. `childClaimsBridge` makes a child extension register `bridge` while loading or on `session_start`. */
function bridgePi(replies: unknown[], childClaimsBridge?: "load" | "session_start"): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => {
			const registered = new Set<string>();
			return { registerProvider(name: string) { registered.add(name); }, registerNativeProvider(provider: { id: string }) { registered.add(provider.id); }, getRegisteredProviderIds: () => [...registered], refresh: async () => {} };
		} },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {}
			getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: childClaimsBridge === "load" ? [{ name: "bridge", config: {}, extensionPath: "/bridge.ts" }] : [] } }; }
		},
		SessionManager: { inMemory: () => ({}), create: () => ({}) },
		resolveCliModel: () => ({ model: { provider: "bridge", id: "model" } }),
		createAgentSession: async ({ modelRuntime }: { modelRuntime: { registerProvider(name: string, config: unknown): void } }) => {
			const listeners: Array<(event: unknown) => void> = [];
			const messages: unknown[] = [];
			const emit = (message: unknown) => { messages.push(message); for (const listener of listeners) listener({ type: "message_end", message }); };
			return { session: {
				model: { provider: "bridge", id: "model" }, messages, sessionId: "s", extensionRunner: { hasHandlers: () => false },
				bindExtensions: async () => { if (childClaimsBridge === "session_start") modelRuntime.registerProvider("bridge", {}); },
				dispose() {}, abort: async () => {}, steer: async () => {}, followUp: async () => {},
				subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; },
				prompt: async (text: string) => { emit({ role: "user", content: [{ type: "text", text }] }); for (const reply of replies) { if (reply instanceof Error) throw reply; emit(reply); } },
			} };
		},
	} as unknown as PiCodingAgentModule;
}

describe("child model resolution diagnostic", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});
	afterEach(() => removeTempDir(tempDir));

	it("explains a foreground model that no parent provider serves", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const result = await runSync(tempDir, [makeAgent("provider-model-worker", { model: MODEL })], "provider-model-worker", "Task", {
			runId: "foreground-model-resolution",
			waitToolEnabled: false,
			childSessionFactory: factory,
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.usage.turns, 0);
		assert.deepEqual(result.messages, []);
		assert.ok(result.error?.startsWith(MODEL_NOT_FOUND), `core error must stay first, got: ${result.error}`);
		assert.match(result.error ?? "", /Agent 'provider-model-worker' ran as a foreground child, which never loads the parent's ambient extensions\. It inherits the providers they registered, but not virtual models/);
		assert.match(result.error ?? "", /If 'pengepul\/commandcode\/deepseek\/deepseek-v4\.1-flash' is served by a provider extension, check the parent's `\/model` list and the child extension diagnostics/);
		assert.doesNotMatch(result.error ?? "", /`async: true`/);
		assert.match(result.error ?? "", /Load the extension for this child with `subagentOnlyExtensions` or `extensions` in the agent frontmatter/);
	});

	it("tells a foreground child that the capability ceiling denied the extension, not the frontmatter", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const result = await runSync(tempDir, [makeAgent("provider-model-worker", { model: MODEL })], "provider-model-worker", "Task", {
			runId: "foreground-model-policy",
			waitToolEnabled: false,
			childSessionFactory: factory,
			capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] },
		});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.startsWith(MODEL_NOT_FOUND), `core error must stay first, got: ${result.error}`);
		assert.match(result.error ?? "", /Capability ceiling from policy-fixture denies extensions/);
		assert.match(result.error ?? "", /`async: true` does not help either/);
		assert.match(result.error ?? "", /Relax the capability ceiling to allow extensions/);
		assert.doesNotMatch(result.error ?? "", /must run as background children/);
	});

	it("explains a foreground first-request failure on a provider inherited from the parent", async () => {
		for (const [runId, replies] of [["foreground-inherited-error-reply", [errorReply]], ["foreground-inherited-thrown", [new Error(PROVIDER_ERROR)]]] as const) {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => bridgePi([...replies]) });
			const result = await runSync(tempDir, [makeAgent("bridge-worker", { model: "bridge/model" })], "bridge-worker", "Task", {
				runId,
				waitToolEnabled: false,
				childSessionFactory: factory,
				parentProviderRegistry: bridgeParent,
			});

			assert.equal(result.exitCode, 1, runId);
			assert.ok(result.error?.startsWith(`${PROVIDER_ERROR}\n\n`), `${runId}: provider error must stay first, got: ${result.error}`);
			assert.match(result.error ?? "", /Provider 'bridge' for 'bridge\/model' was registered by a parent extension; the child inherited the provider but not that extension's session hooks/);
			assert.match(result.error ?? "", /run this agent with `async: true`/);
		}
	});

	it("names the capability ceiling instead of suppressed remedies for an inherited provider", async () => {
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => bridgePi([errorReply]) });
		const result = await runSync(tempDir, [makeAgent("bridge-worker", { model: "bridge/model" })], "bridge-worker", "Task", {
			runId: "foreground-inherited-policy",
			waitToolEnabled: false,
			childSessionFactory: factory,
			parentProviderRegistry: bridgeParent,
			capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] },
		});

		assert.ok(result.error?.startsWith(`${PROVIDER_ERROR}\n\n`), `provider error must stay first, got: ${result.error}`);
		assert.match(result.error ?? "", /Capability ceiling from policy-fixture denies extensions, so that extension cannot load for this child: `async: true` does not help either/);
		assert.doesNotMatch(result.error ?? "", /run this agent with `async: true`/);
	});

	it("keeps the plain provider error when the child loaded the provider's extension itself or already had a successful response", async () => {
		const toolTurn = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse", usage: errorReply.usage };
		for (const [runId, pi] of [["foreground-claimed-provider", bridgePi([errorReply], "load")], ["foreground-after-success", bridgePi([toolTurn, errorReply])]] as const) {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			const result = await runSync(tempDir, [makeAgent("bridge-worker", { model: "bridge/model" })], "bridge-worker", "Task", {
				runId,
				waitToolEnabled: false,
				childSessionFactory: factory,
				parentProviderRegistry: bridgeParent,
			});

			assert.equal(result.exitCode, 1, runId);
			assert.equal(result.error, PROVIDER_ERROR, runId);
		}
	});

	it("keeps the plain model-not-found error for a background child that loaded the ambient extensions", async () => {
		const launch = buildRunnerChildLaunch(
			{ agent: "provider-model-worker", task: "Task" },
			{ cwd: tempDir, id: "runner-model-resolution", flatIndex: 0 },
			{ model: MODEL, sessionEnabled: false, watchdogStatus: () => {} },
		);
		assert.equal(launch.session.ambientExtensions, true, "the guard must exercise the ambient-extensions branch");
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });

		assert.equal(run.exitCode, 1);
		assert.equal(run.error, MODEL_NOT_FOUND);
		assert.equal(run.messages.length, 0);
	});

	it("tells a background child that the capability ceiling denied the extension", async () => {
		const launch = buildRunnerChildLaunch(
			{ agent: "provider-model-worker", task: "Task" },
			{ cwd: tempDir, id: "runner-model-policy", flatIndex: 0, capabilityCeiling: { version: 1, denyExtensions: true, sources: ["policy-fixture"] } },
			{ model: MODEL, sessionEnabled: false, watchdogStatus: () => {} },
		);
		assert.equal(launch.session.ambientExtensions, false, "the ceiling must disable ambient extensions for this launch");
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => unresolvedModelPi() });
		const run = await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {} });

		assert.equal(run.exitCode, 1);
		assert.match(run.error ?? "", /Capability ceiling from policy-fixture denies extensions/);
		assert.match(run.error ?? "", /does not enable ambient loading/);
		assert.match(run.error ?? "", /Relax the capability ceiling to allow extensions/);
	});

	it("explains a background child that failed without the parent extension registering its provider", async () => {
		const agents = [makeAgent("locked-down", { model: "bridge/model", extensions: [] }), makeAgent("ambient", { model: "bridge/model" })];
		const built = buildAsyncRunnerSteps("runner-parent-provider", {
			chain: [{ agent: "locked-down", task: "Task" }, { agent: "ambient", task: "Task" }],
			agents,
			ctx: { pi: {} as never, cwd: tempDir, currentSessionId: "parent", parentProviderRegistry: bridgeParent },
			availableModels: [{ provider: "bridge", id: "model", fullId: "bridge/model" }],
			asyncDir: tempDir,
			maxSubagentDepth: 1,
		});
		assert.ok("steps" in built, JSON.stringify(built));
		const [lockedDown, ambient] = built.steps as Array<Parameters<typeof buildRunnerChildLaunch>[0]>;
		assert.equal(ambient?.parentExtensionProvider, undefined, "a child that loads the ambient extensions loads the provider's extension too");

		const runStep = async (pi: PiCodingAgentModule) => {
			const launch = buildRunnerChildLaunch(lockedDown!, { cwd: tempDir, id: "runner-parent-provider", flatIndex: 0 }, { model: "bridge/model", sessionEnabled: false, watchdogStatus: () => {} });
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
			return runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {}, parentExtensionProvider: lockedDown!.parentExtensionProvider });
		};
		const failed = await runStep(bridgePi([errorReply]));
		assert.ok(failed.error?.startsWith(`${PROVIDER_ERROR}\n\n`), `provider error must stay first, got: ${failed.error}`);
		assert.match(failed.error ?? "", /Agent 'locked-down' ran as a background child without the ambient extensions\. In the parent, provider 'bridge' for 'bridge\/model' is registered by an extension that did not load in this child/);
		assert.match(failed.error ?? "", /list it in `subagentOnlyExtensions` or `extensions` in the agent frontmatter/);

		const toolTurn = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], stopReason: "toolUse", usage: errorReply.usage };
		const afterSuccess = await runStep(bridgePi([toolTurn, errorReply]));
		assert.equal(afterSuccess.error, PROVIDER_ERROR);

		for (const claim of ["load", "session_start"] as const) {
			const childLoadedProvider = await runStep(bridgePi([errorReply], claim));
			assert.equal(childLoadedProvider.error, PROVIDER_ERROR, `a child whose own extension registered the provider (${claim}) keeps the plain error`);
		}
	});

	it("warns an extensions: [] child only when it runs without the parent extension's provider", async () => {
		const agents = [makeAgent("locked-down", { model: "bridge/model", extensions: [] }), makeAgent("locked-down-core", { model: "magpie/model", extensions: [] })];
		const built = buildAsyncRunnerSteps("runner-provider-warning", {
			chain: [{ agent: "locked-down", task: "Task" }, { agent: "locked-down-core", task: "Task" }],
			agents,
			ctx: { pi: {} as never, cwd: tempDir, currentSessionId: "parent", parentProviderRegistry: bridgeParent },
			availableModels: [{ provider: "bridge", id: "model", fullId: "bridge/model" }, { provider: "magpie", id: "model", fullId: "magpie/model" }],
			asyncDir: tempDir,
			maxSubagentDepth: 1,
		});
		assert.ok("steps" in built, JSON.stringify(built));
		const [lockedDown, lockedDownCore] = built.steps as Array<Parameters<typeof buildRunnerChildLaunch>[0]>;
		const doneReply = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: errorReply.usage };
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
		try {
			const runStep = async (step: Parameters<typeof buildRunnerChildLaunch>[0], pi: PiCodingAgentModule) => {
				warnings.length = 0;
				const launch = buildRunnerChildLaunch(step, { cwd: tempDir, id: "runner-provider-warning", flatIndex: 0 }, { model: step.model, sessionEnabled: false, watchdogStatus: () => {} });
				const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
				await runChildSession({ factory, launch, prompt: "Task: Task", appendChildEvent: () => {}, writeOutputLine: () => {}, parentExtensionProvider: step.parentExtensionProvider });
				return [...warnings];
			};
			assert.deepEqual(await runStep(lockedDown!, bridgePi([doneReply])), ["[pi-subagents] Agent 'locked-down' runs 'bridge/model' without the extension that registers provider 'bridge' in the parent, so its requests go through the 'bridge' provider Pi has without that extension (built in or from models.json)."]);
			assert.deepEqual(await runStep(lockedDown!, bridgePi([doneReply], "load")), [], "a child whose own extension registers the provider loses nothing");
			assert.deepEqual(await runStep(lockedDownCore!, bridgePi([doneReply])), [], "a provider no parent extension registered loses nothing");

			warnings.length = 0;
			const foreground = await runSync(tempDir, [makeAgent("locked-down", { model: "bridge/model", extensions: [] })], "locked-down", "Task", {
				runId: "foreground-provider-warning",
				waitToolEnabled: false,
				childSessionFactory: createDefaultChildSessionFactory({ loadPiCodingAgent: async () => bridgePi([doneReply]) }),
				parentProviderRegistry: bridgeParent,
			});
			assert.equal(foreground.exitCode, 0, foreground.error);
			assert.deepEqual(warnings, [], "a foreground child inherits the parent's providers");
		} finally {
			console.warn = originalWarn;
		}
	});
});
