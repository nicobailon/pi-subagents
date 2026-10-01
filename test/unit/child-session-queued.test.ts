import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	childSessionHasQueuedMessages,
	createDefaultChildSessionFactory,
	type ChildSession,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

describe("childSessionHasQueuedMessages", () => {
	it("treats a missing session or method as no queued input", () => {
		assert.equal(childSessionHasQueuedMessages(undefined), false);
		assert.equal(childSessionHasQueuedMessages({} as ChildSession), false);
	});

	it("keeps the drain hold when the session reports queued input", () => {
		assert.equal(childSessionHasQueuedMessages({ hasQueuedMessages: () => true } as ChildSession), true);
		assert.equal(childSessionHasQueuedMessages({ hasQueuedMessages: () => false } as ChildSession), false);
	});

	it("does not throw when hasQueuedMessages reads a missing agent", () => {
		const session = {
			hasQueuedMessages() {
				const agent: { hasQueuedMessages?: () => boolean } | undefined = undefined;
				return agent!.hasQueuedMessages!();
			},
		} as ChildSession;
		assert.equal(childSessionHasQueuedMessages(session), false);
	});
});

describe("default factory queued-message probe", () => {
	it("rejects a required loader failure before requested-model resolution", async () => {
		let modelResolved = false;
		const requiredPath = "/tmp/required-provider.mjs";
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class {
					async reload() {}
					getExtensions() { return { extensions: [], errors: [{ path: requiredPath, error: "import failed" }], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; }
				},
				resolveCliModel: () => { modelResolved = true; return {}; },
			} as unknown as PiCodingAgentModule),
		});
		await assert.rejects(() => factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, model: "provider/model", extensionPaths: [requiredPath], requiredExtensions: [{ id: "provider", path: requiredPath }], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] }), /Required child extension failed to load/);
		assert.equal(modelResolved, false);
	});

	it("rejects a required provider-registration failure before requested-model resolution", async () => {
		let modelResolved = false;
		const requiredPath = "/tmp/required-provider.mjs";
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
			ModelRuntime: { create: async () => ({ registerProvider() { throw new Error("bad provider"); }, refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [{ name: "required", config: {}, extensionPath: requiredPath }], pendingNativeProviderRegistrations: [] } }; } },
			resolveCliModel: () => { modelResolved = true; return {}; },
		} as unknown as PiCodingAgentModule) });
		await assert.rejects(() => factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, model: "provider/model", extensionPaths: [requiredPath], requiredExtensions: [{ id: "provider", path: requiredPath }], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] }), /provider registration failed.*bad provider/);
		assert.equal(modelResolved, false);
	});

	it("registers queued virtual models before requested-model resolution", async () => {
		const events: string[] = [];
		const definition = { provider: "router", id: "auto", name: "Auto", route: async () => ({}) };
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
			ModelRuntime: { create: async () => ({ registerVirtualModel: (received: unknown) => { events.push(`virtual:${JSON.stringify(received)}`); }, registerProvider: () => { events.push("provider"); }, refresh: async () => { events.push("refresh"); } }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [], pendingVirtualModelRegistrations: [{ definition, extensionPath: "/tmp/router.ts" }] } }; } },
			SessionManager: { inMemory: () => ({}) },
			resolveCliModel: () => { events.push("resolve"); return {}; },
			createAgentSession: async () => ({
				session: {
					bindExtensions: async () => {},
					dispose() {},
					extensionRunner: { hasHandlers: () => false },
					subscribe: () => () => {},
					prompt: async () => {},
					abort: async () => {},
					steer: async () => {},
					followUp: async () => {},
					messages: [],
					sessionId: "virtual-model-child",
				},
			}),
		}) as unknown as PiCodingAgentModule });
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			model: "router/auto",
			extensionPaths: ["/tmp/router.ts"],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.ok(child);
		assert.deepEqual(events, [`virtual:${JSON.stringify(definition)}`, "refresh", "resolve"]);
	});

	it("rejects a required virtual-model registration failure before requested-model resolution", async () => {
		let modelResolved = false;
		const requiredPath = "/tmp/required-router.mjs";
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
			ModelRuntime: { create: async () => ({ registerVirtualModel() { throw new Error("bad virtual model"); }, refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [], pendingVirtualModelRegistrations: [{ definition: {}, extensionPath: requiredPath }] } }; } },
			resolveCliModel: () => { modelResolved = true; return {}; },
		} as unknown as PiCodingAgentModule) });
		await assert.rejects(() => factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, model: "router/auto", extensionPaths: [requiredPath], requiredExtensions: [{ id: "router", path: requiredPath }], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"] }), /virtual model registration failed.*bad virtual model/);
		assert.equal(modelResolved, false);
	});

	it("reports no queued messages for an agent-less wrapped session", async () => {
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class { async reload() {} },
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({
					session: {
						bindExtensions: async () => {},
						dispose() {},
						extensionRunner: { hasHandlers: () => false },
						subscribe: () => () => {},
						prompt: async () => {},
						abort: async () => {},
						steer: async () => {},
						followUp: async () => {},
						messages: [],
						sessionId: "agent-less",
					},
				}),
			} as unknown as PiCodingAgentModule),
		});
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.equal(child.hasQueuedMessages?.(), false);
		assert.equal(childSessionHasQueuedMessages(child), false);
	});

	it("re-arms from a wrapped session whose agent reports queued input", async () => {
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class { async reload() {} },
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({
					session: {
						agent: { hasQueuedMessages: () => true },
						bindExtensions: async () => {},
						dispose() {},
						extensionRunner: { hasHandlers: () => false },
						subscribe: () => () => {},
						prompt: async () => {},
						abort: async () => {},
						steer: async () => {},
						followUp: async () => {},
						messages: [],
						sessionId: "queued",
					},
				}),
			} as unknown as PiCodingAgentModule),
		});
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.equal(child.hasQueuedMessages?.(), true);
		assert.equal(childSessionHasQueuedMessages(child), true);
	});
});

describe("default factory virtual model selection", () => {
	it("reports the live selection only when Pi marks it virtual", async () => {
		const session = {
			model: { provider: "router", id: "auto", api: "openai-responses" } as { provider: string; id: string; api: string },
			bindExtensions: async () => {},
			dispose() {},
			extensionRunner: { hasHandlers: () => false },
			subscribe: () => () => {},
			messages: [],
			sessionId: "virtual",
		};
		const factory = createDefaultChildSessionFactory({
			loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class { async reload() {} },
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({ session }),
			} as unknown as PiCodingAgentModule),
		});
		const child = await factory.create({
			cwd: process.cwd(),
			storage: { kind: "memory" },
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		});
		assert.equal(child.virtualModelId, undefined);
		session.model = { provider: "router", id: "auto", api: "pi-virtual" };
		assert.equal(child.virtualModelId, "router/auto");
		assert.equal(child.modelId, "router/auto");
	});
});
