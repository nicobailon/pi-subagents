import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanupSessionResources, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

const launch: ChildSessionLaunch = {
	cwd: process.cwd(),
	storage: { kind: "memory" },
	extensionPaths: [],
	ambientExtensions: false,
	hooks: [],
	noSkills: true,
	noContextFiles: true,
	runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
};

/** A fake SDK whose sessions run `onDispose` as their own copy of pi-ai's session cleanup. */
function sdk(sessionId: string, onDispose: (sessionId: string) => void): PiCodingAgentModule {
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({
			session: {
				bindExtensions: async () => {},
				dispose() { onDispose(sessionId); },
				extensionRunner: { hasHandlers: () => false },
				subscribe: () => () => {},
				messages: [],
				sessionId,
			},
		}),
	} as unknown as PiCodingAgentModule;
}

describe("child session resource cleanup", () => {
	it("releases the child's resources in the host's registry when the child's SDK uses another one", async () => {
		const released: string[] = [];
		const unregister = registerSessionResourceCleanup((sessionId) => { if (sessionId) released.push(sessionId); });
		try {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk("separate-registry-child", () => {}) });
			const child = await factory.create(launch);
			await child.dispose();
			assert.deepEqual(released, ["separate-registry-child"]);
		} finally {
			unregister();
		}
	});

	it("does not release the child's resources twice when the child's SDK shares the host's registry", async () => {
		const released: string[] = [];
		const unregister = registerSessionResourceCleanup((sessionId) => { if (sessionId) released.push(sessionId); });
		try {
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk("shared-registry-child", cleanupSessionResources) });
			const child = await factory.create(launch);
			await child.dispose();
			assert.deepEqual(released, ["shared-registry-child"]);
		} finally {
			unregister();
		}
	});
});
