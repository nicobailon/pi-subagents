import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { assertChildThinkingApplied, assertPlacedChildThinkingApplied, childStrictThinking } from "../../src/shared/child-strict-thinking.ts";

const STRICT = { PI_SUBAGENT_STRICT_THINKING: "1" };

function session(thinkingLevel: string) {
	return { thinkingLevel, model: { provider: "acme", id: "m" }, getAvailableThinkingLevels: () => ["low", "medium"] };
}

describe("childStrictThinking", () => {
	it("is off unless set to 1", () => {
		assert.equal(childStrictThinking({}), false);
		assert.equal(childStrictThinking({ PI_SUBAGENT_STRICT_THINKING: "" }), false);
		assert.equal(childStrictThinking({ PI_SUBAGENT_STRICT_THINKING: "true" }), false);
		assert.equal(childStrictThinking(STRICT), true);
	});
});

describe("assertChildThinkingApplied", () => {
	it("keeps Pi's adjustment when strict thinking is off", () => {
		assert.doesNotThrow(() => assertChildThinkingApplied({ requested: "high", session: session("medium"), env: {} }));
	});

	it("refuses an adjusted level when strict thinking is on, naming the supported levels", () => {
		assert.throws(
			() => assertChildThinkingApplied({ requested: "high", session: session("medium"), env: STRICT }),
			/Model 'acme\/m' does not support thinking level 'high' \(supported: low, medium\)/,
		);
	});

	it("passes a supported level and a launch that requested none", () => {
		assert.doesNotThrow(() => assertChildThinkingApplied({ requested: "low", session: session("low"), env: STRICT }));
		assert.doesNotThrow(() => assertChildThinkingApplied({ requested: undefined, session: session("medium"), env: STRICT }));
	});
});

describe("assertPlacedChildThinkingApplied", () => {
	it("keeps the remote Pi's adjustment when strict thinking is off", () => {
		assert.doesNotThrow(() => assertPlacedChildThinkingApplied({ model: "acme/m:high", applied: "medium", env: {} }));
	});

	it("refuses a remote child that ran at another level or did not report one", () => {
		assert.throws(() => assertPlacedChildThinkingApplied({ model: "acme/m:high", applied: "medium", env: STRICT }), /Remote Pi model 'acme\/m:high' ran at thinking level 'medium'/);
		assert.throws(() => assertPlacedChildThinkingApplied({ model: "acme/m:high", applied: undefined, env: STRICT }), /did not report its thinking level/);
	});

	it("passes the requested level and a launch without a level suffix", () => {
		assert.doesNotThrow(() => assertPlacedChildThinkingApplied({ model: "acme/m:low", applied: "low", env: STRICT }));
		assert.doesNotThrow(() => assertPlacedChildThinkingApplied({ model: "acme/m", applied: "medium", env: STRICT }));
		assert.doesNotThrow(() => assertPlacedChildThinkingApplied({ model: undefined, applied: undefined, env: STRICT }));
	});
});

describe("native child launch with PI_SUBAGENT_STRICT_THINKING", () => {
	const previous = process.env.PI_SUBAGENT_STRICT_THINKING;
	afterEach(() => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_STRICT_THINKING;
		else process.env.PI_SUBAGENT_STRICT_THINKING = previous;
	});

	function factory(events: string[]) {
		const pi = {
			ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; } },
			SessionManager: { inMemory: () => ({}) },
			resolveCliModel: () => ({ model: { provider: "acme", id: "m" }, thinkingLevel: "high" }),
			createAgentSession: async () => ({
				session: {
					...session("medium"),
					bindExtensions: async () => { events.push("bind"); },
					dispose() { events.push("dispose"); },
					extensionRunner: { hasHandlers: () => false },
					subscribe: () => () => {},
					prompt: async () => {},
					abort: async () => {},
					steer: async () => {},
					followUp: async () => {},
					messages: [],
					sessionId: "child",
				},
			}),
		} as unknown as PiCodingAgentModule;
		return createDefaultChildSessionFactory({ loadPiCodingAgent: () => pi });
	}

	const launch: ChildSessionLaunch = {
		cwd: process.cwd(),
		storage: { kind: "memory" },
		model: "acme/m:high",
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, fast: false },
	};

	it("starts the child at Pi's adjusted level when unset", async () => {
		delete process.env.PI_SUBAGENT_STRICT_THINKING;
		const events: string[] = [];
		await factory(events).create(launch);
		assert.deepEqual(events, ["bind"]);
	});

	it("disposes the child before binding extensions and rejects the launch when set", async () => {
		process.env.PI_SUBAGENT_STRICT_THINKING = "1";
		const events: string[] = [];
		await assert.rejects(factory(events).create(launch), /does not support thinking level 'high'/);
		assert.deepEqual(events, ["dispose"]);
	});
});
