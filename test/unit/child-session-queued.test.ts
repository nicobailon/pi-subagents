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
