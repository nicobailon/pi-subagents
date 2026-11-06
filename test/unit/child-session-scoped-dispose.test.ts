import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDefaultChildSessionFactory,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

/**
 * A multi-session host such as pi-web runs several parent sessions in one process.
 * Its idle reaper shuts wrappers down one at a time, each shutdown emitting
 * `session_shutdown` to that session's extension instance. The extension must dispose
 * only that session's children: one session's shutdown must not abort another
 * session's running children.
 */

interface SessionLog {
	parent: string | undefined;
	events: string[];
}

function stubPiModule(logs: SessionLog[]): () => PiCodingAgentModule {
	return () => {
		const log: SessionLog = { parent: undefined, events: [] };
		logs.push(log);
		return {
			ModelRuntime: { create: async () => ({ refresh: async () => {} }) },
			SettingsManager: { create: () => ({}) },
			DefaultResourceLoader: class { async reload() {} getExtensions() { return { extensions: [], errors: [], runtime: { pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } }; } },
			SessionManager: { inMemory: () => ({}) },
			resolveCliModel: () => ({}),
			createAgentSession: async () => ({
				session: {
					bindExtensions: async () => {},
					dispose() { log.events.push("dispose"); },
					extensionRunner: { hasHandlers: () => false },
					subscribe: () => () => {},
					prompt: async () => {},
					abort: async () => { log.events.push("abort"); },
					steer: async () => {},
					followUp: async () => {},
					messages: [],
					sessionId: `child-${logs.length}`,
				},
			}),
		} as unknown as PiCodingAgentModule;
	};
}

function launchFor(parentSessionFile: string | undefined, cwd: string): ChildSessionLaunch {
	return {
		cwd,
		storage: { kind: "memory" },
		parentSessionFile,
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false },
	};
}

describe("disposeForParent scopes child disposal to one session", () => {
	it("disposes only the parent's own children, leaving other sessions' children running", async () => {
		const logs: SessionLog[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: stubPiModule(logs) });
		const parentA = "/tmp/sessions/parent-a.jsonl";
		const parentB = "/tmp/sessions/parent-b.jsonl";
		const childA1 = await factory.create(launchFor(parentA, process.cwd()));
		await factory.create(launchFor(parentB, process.cwd()));
		const childA1Abort = childA1.abort.bind(childA1);

		await factory.disposeForParent(parentA);

		assert.deepEqual(logs[0]?.events, ["abort", "dispose"], "parent A's child is aborted and disposed");
		assert.deepEqual(logs[1]?.events, [], "parent B's child is untouched");
		// The surviving child still works and can be disposed on its own session's shutdown.
		await assert.doesNotReject(childA1Abort);
	});

	it("disposes only children of file-less parents when the parent session has no file", async () => {
		const logs: SessionLog[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: stubPiModule(logs) });
		await factory.create(launchFor("/tmp/sessions/parent-a.jsonl", process.cwd()));
		await factory.create(launchFor(undefined, process.cwd()));

		await factory.disposeForParent(undefined);

		assert.deepEqual(logs[0]?.events, [], "the file-backed parent's child is untouched");
		assert.deepEqual(logs[1]?.events, ["abort", "dispose"], "the file-less parent's child is disposed");
	});

	it("dispose() still disposes every live child", async () => {
		const logs: SessionLog[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: stubPiModule(logs) });
		await factory.create(launchFor("/tmp/sessions/parent-a.jsonl", process.cwd()));
		await factory.create(launchFor("/tmp/sessions/parent-b.jsonl", process.cwd()));
		await factory.create(launchFor(undefined, process.cwd()));

		await factory.dispose();

		for (const log of logs) {
			assert.deepEqual(log.events, ["abort", "dispose"], "every child is aborted and disposed");
		}
	});

	it("detached children keep running across both disposal scopes", async () => {
		const logs: SessionLog[] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: stubPiModule(logs) });
		const parentA = "/tmp/sessions/parent-a.jsonl";
		const child = await factory.create(launchFor(parentA, process.cwd()));
		child.detached = true;

		await factory.disposeForParent(parentA);
		await factory.dispose();

		assert.deepEqual(logs[0]?.events, [], "a detached child is never aborted by disposal");
	});
});
