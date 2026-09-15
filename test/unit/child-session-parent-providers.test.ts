import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createDefaultChildSessionFactory,
	setParentProviderRegistry,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

function launch(ambientExtensions: boolean): ChildSessionLaunch {
	return {
		cwd: process.cwd(),
		storage: { kind: "memory" },
		model: "bifrost/gemini",
		extensionPaths: [],
		ambientExtensions,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
	};
}

function fakePi(runtime: Record<string, unknown>, onResolve: () => void): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => runtime },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => { onResolve(); return { error: "stop" }; },
	} as unknown as PiCodingAgentModule;
}

describe("default factory parent provider inheritance", () => {
	afterEach(() => setParentProviderRegistry(undefined));

	it("registers the parent's providers, including overrides of ids the child already knows, before resolving a child without ambient extensions", async () => {
		const calls: string[] = [];
		let refreshed = false;
		const bifrost = { baseUrl: "https://bifrost.example", api: "openai-completions", models: [{ id: "gemini" }] };
		const anthropicOverride = { baseUrl: "https://proxy.example", api: "anthropic", models: [] };
		const nativeProvider = { id: "native-router" };
		const parentConfig: Record<string, unknown> = { bifrost, anthropic: anthropicOverride };
		setParentProviderRegistry({
			getRegisteredProviderIds: () => ["bifrost", "native-router", "anthropic"],
			getRegisteredProviderConfig: (id) => parentConfig[id],
			getRegisteredNativeProvider: (id) => (id === "native-router" ? nativeProvider : undefined),
		} as never);
		const runtime = {
			registerProvider: (id: string, config: unknown) => { calls.push(`config:${id}`); assert.equal(config, parentConfig[id]); },
			registerNativeProvider: (provider: unknown) => { calls.push("native"); assert.equal(provider, nativeProvider); },
			refresh: async () => { refreshed = true; },
		};
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(runtime, () => calls.push("resolve")) });
		await assert.rejects(() => factory.create(launch(false)), /stop/);
		assert.deepEqual(calls, ["config:bifrost", "native", "config:anthropic", "resolve"]);
		assert.equal(refreshed, true);
	});

	it("reports a refresh failure without aborting model resolution", async () => {
		const errors: string[] = [];
		let resolved = false;
		setParentProviderRegistry({
			getRegisteredProviderIds: () => ["bifrost"],
			getRegisteredProviderConfig: () => ({ models: [] }),
			getRegisteredNativeProvider: () => undefined,
		} as never);
		const runtime = {
			registerProvider: () => {},
			refresh: async () => { throw new Error("offline refresh failed"); },
		};
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(runtime, () => { resolved = true; }) });
		await assert.rejects(() => factory.create({ ...launch(false), onExtensionError: ({ extensionPath, error }) => errors.push(`${extensionPath}: ${(error as Error).message}`) }), /stop/);
		assert.deepEqual(errors, ["<parent-provider:refresh>: offline refresh failed"]);
		assert.equal(resolved, true);
	});

	it("leaves a child with ambient extensions to register providers itself", async () => {
		setParentProviderRegistry({
			getRegisteredProviderIds: () => { throw new Error("parent registry read"); },
			getRegisteredProviderConfig: () => undefined,
			getRegisteredNativeProvider: () => undefined,
		} as never);
		const runtime = { getRegisteredProviderIds: () => [], refresh: async () => {} };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(runtime, () => {}) });
		await assert.rejects(() => factory.create(launch(true)), /stop/);
	});

	it("reports a failed parent provider registration and still resolves the model", async () => {
		const errors: string[] = [];
		let resolved = false;
		setParentProviderRegistry({
			getRegisteredProviderIds: () => ["broken"],
			getRegisteredProviderConfig: () => ({ models: [] }),
			getRegisteredNativeProvider: () => undefined,
		} as never);
		const runtime = {
			getRegisteredProviderIds: () => [],
			registerProvider: () => { throw new Error("bad provider"); },
			refresh: async () => { assert.fail("nothing registered"); },
		};
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => fakePi(runtime, () => { resolved = true; }) });
		await assert.rejects(() => factory.create({ ...launch(false), onExtensionError: ({ extensionPath, error }) => errors.push(`${extensionPath}: ${(error as Error).message}`) }), /stop/);
		assert.deepEqual(errors, ["<parent-provider:broken>: bad provider"]);
		assert.equal(resolved, true);
	});
});
