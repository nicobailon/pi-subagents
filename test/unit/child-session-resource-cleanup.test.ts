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
	// SAFETY: the fake SDK below never reads the runtime fields left out here.
	runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
};

/** Disposes a child whose SDK's `dispose()` calls `releaseInSdkRegistry`, and returns the session ids the host's registry released. */
async function releasedByHost(releaseInSdkRegistry: (sessionId: string) => void): Promise<Array<string | undefined>> {
	const released: Array<string | undefined> = [];
	const unregister = registerSessionResourceCleanup((sessionId) => { released.push(sessionId); });
	// SAFETY: launching and disposing a child without extensions uses only these SDK members.
	const sdk = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({
			session: {
				sessionId: "child",
				messages: [],
				bindExtensions: async () => {},
				dispose: () => releaseInSdkRegistry("child"),
				extensionRunner: { hasHandlers: () => false },
				subscribe: () => () => {},
			},
		}),
	} as PiCodingAgentModule;
	try {
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk }).create(launch);
		await child.dispose();
	} finally {
		unregister();
	}
	return released;
}

describe("child session resource cleanup", () => {
	it("releases the child's resources in the host's registry when its SDK has a separate one", async () => {
		assert.deepEqual(await releasedByHost(() => {}), ["child"]);
	});

	it("releases the child's resources once when its SDK shares the host's registry", async () => {
		assert.deepEqual(await releasedByHost(cleanupSessionResources), ["child"]);
	});
});
