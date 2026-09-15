import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDefaultChildSessionFactory,
	type ChildSessionLaunch,
	type ParentProviderRegistry,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

type Config = { marker: string };
type Native = { id: string; marker: string };
type Pending = {
	pendingProviderRegistrations?: Array<{ name: string; config: Config; extensionPath: string }>;
	pendingNativeProviderRegistrations?: Array<{ provider: Native; extensionPath: string }>;
};

type Runtime = {
	configs: Map<string, Config>;
	native: Map<string, Native>;
	refreshes: number;
	registerProvider(id: string, config: Config): void;
	registerNativeProvider(provider: Native): void;
	refresh(): Promise<void>;
};

function launch(parentProviderRegistry?: ParentProviderRegistry): ChildSessionLaunch {
	return {
		cwd: process.cwd(),
		storage: { kind: "memory" },
		model: "router/model",
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		...(parentProviderRegistry ? { parentProviderRegistry } : {}),
	};
}

function registry(configs: Map<string, Config>, native = new Map<string, Native>()): ParentProviderRegistry {
	return {
		getRegisteredProviderIds: () => [...new Set([...configs.keys(), ...native.keys()])],
		getRegisteredProviderConfig: (id) => configs.get(id) as never,
		getRegisteredNativeProvider: (id) => native.get(id) as never,
	};
}

function fakePi(input: {
	pending?: () => Pending;
	onRuntime?: (runtime: Runtime) => void;
	onRegisterConfig?: (id: string, config: Config) => void;
	onRefresh?: (runtime: Runtime) => void;
	onResolve?: (runtime: Runtime) => void;
} = {}): PiCodingAgentModule {
	return {
		ModelRuntime: {
			create: async () => {
				const runtime: Runtime = {
					configs: new Map(),
					native: new Map(),
					refreshes: 0,
					registerProvider(id, config) {
						input.onRegisterConfig?.(id, config);
						this.native.delete(id);
						this.configs.set(id, config);
					},
					registerNativeProvider(provider) {
						this.configs.delete(provider.id);
						this.native.set(provider.id, provider);
					},
					async refresh() {
						this.refreshes += 1;
						input.onRefresh?.(this);
					},
				};
				input.onRuntime?.(runtime);
				return runtime;
			},
		},
		SettingsManager: { create: () => ({ getTheme: () => ({}) }) },
		DefaultResourceLoader: class {
			runtime: Pending = {};
			async reload() { this.runtime = input.pending?.() ?? {}; }
			getExtensions() { return { extensions: [], errors: [], runtime: this.runtime }; }
		},
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: ({ modelRuntime }) => {
			input.onResolve?.(modelRuntime as unknown as Runtime);
			return { error: "stop" };
		},
	} as unknown as PiCodingAgentModule;
}

describe("default factory parent provider inheritance", () => {
	it("isolates sequential launches and reflects explicit override, parent replacement, and removal", async () => {
		const parentConfigs = new Map<string, Config>([["router", { marker: "parent-1" }]]);
		let pending: Pending = {
			pendingProviderRegistrations: [{ name: "router", config: { marker: "child-a" }, extensionPath: "/child-a.ts" }],
		};
		const runtimes: Runtime[] = [];
		const resolved: Array<Config | undefined> = [];
		const pi = fakePi({
			pending: () => pending,
			onRuntime: (runtime) => runtimes.push(runtime),
			onResolve: (runtime) => resolved.push(runtime.configs.get("router")),
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const parent = registry(parentConfigs);

		await assert.rejects(() => factory.create(launch(parent)), /stop/);
		pending = {};
		parentConfigs.set("router", { marker: "parent-2" });
		await assert.rejects(() => factory.create(launch(parent)), /stop/);
		parentConfigs.delete("router");
		await assert.rejects(() => factory.create(launch(parent)), /stop/);

		assert.equal(new Set(runtimes).size, 3, "each foreground launch must own a fresh runtime");
		assert.deepEqual(resolved.map((config) => config?.marker), ["child-a", "parent-2", undefined]);
		assert.equal(runtimes[0]!.configs.get("router")?.marker, "child-a", "later launches must not mutate an earlier sibling");
		assert.deepEqual(runtimes.map((runtime) => runtime.refreshes), [1, 1, 0]);
	});

	it("binds concurrent launches to their own parent config and native providers", async () => {
		const resolved: Array<{ config?: string; native?: string }> = [];
		const pi = fakePi({
			onResolve: (runtime) => resolved.push({
				config: runtime.configs.get("router")?.marker,
				native: runtime.native.get("native-router")?.marker,
			}),
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const parentA = registry(new Map([["router", { marker: "a-config" }]]), new Map([["native-router", { id: "native-router", marker: "a-native" }]]));
		const parentB = registry(new Map([["router", { marker: "b-config" }]]), new Map([["native-router", { id: "native-router", marker: "b-native" }]]));

		const results = await Promise.allSettled([factory.create(launch(parentA)), factory.create(launch(parentB))]);
		assert.ok(results.every((result) => result.status === "rejected" && /stop/.test(String(result.reason))));
		assert.deepEqual(resolved, [
			{ config: "a-config", native: "a-native" },
			{ config: "b-config", native: "b-native" },
		]);
	});

	it("does not fall back to a parent provider when the explicit child registration fails", async () => {
		const errors: string[] = [];
		let resolved: Runtime | undefined;
		const pi = fakePi({
			pending: () => ({ pendingProviderRegistrations: [{ name: "router", config: { marker: "broken-child" }, extensionPath: "/broken.ts" }] }),
			onRegisterConfig: (_id, config) => { if (config.marker === "broken-child") throw new Error("bad child provider"); },
			onResolve: (runtime) => { resolved = runtime; },
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
		const parent = registry(new Map([["router", { marker: "parent" }]]));

		await assert.rejects(() => factory.create({
			...launch(parent),
			onExtensionError: ({ extensionPath, error }) => errors.push(`${extensionPath}: ${(error as Error).message}`),
		}), /stop/);

		assert.deepEqual(errors, ["/broken.ts: bad child provider"]);
		assert.equal(resolved?.configs.has("router"), false);
		assert.equal(resolved?.refreshes, 0);
	});

	it("reports refresh failure and fails before model resolution", async () => {
		const errors: string[] = [];
		let resolved = false;
		const pi = fakePi({
			onRefresh: () => { throw new Error("offline refresh failed"); },
			onResolve: () => { resolved = true; },
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });

		await assert.rejects(() => factory.create({
			...launch(registry(new Map([["router", { marker: "parent" }]]))),
			onExtensionError: ({ extensionPath, event, error }) => errors.push(`${extensionPath}:${event}: ${(error as Error).message}`),
		}), /offline refresh failed/);

		assert.deepEqual(errors, ["<provider-refresh>:refresh_providers: offline refresh failed"]);
		assert.equal(resolved, false);
	});

	it("reports parent inheritance failure and does not resolve against a partial runtime", async () => {
		const errors: string[] = [];
		let resolved = false;
		const pi = fakePi({
			onRegisterConfig: (_id, config) => { if (config.marker === "broken-parent") throw new Error("parent registration failed"); },
			onResolve: () => { resolved = true; },
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });

		await assert.rejects(() => factory.create({
			...launch(registry(new Map([["router", { marker: "broken-parent" }]]))),
			onExtensionError: ({ extensionPath, event, error }) => errors.push(`${extensionPath}:${event}: ${(error as Error).message}`),
		}), /parent registration failed/);

		assert.deepEqual(errors, ["<parent-provider:router>:inherit_provider: parent registration failed"]);
		assert.equal(resolved, false);
	});
});
