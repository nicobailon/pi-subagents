import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type ChildSessionLaunch, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

// Real Pi resource loading, stopped right before a session is created.
function piCapturingAppendPrompt(captured: string[][]): PiCodingAgentModule {
	// SAFETY: the factory touches only these members before createAgentSession, which throws to end the launch.
	return {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager,
		DefaultResourceLoader,
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async ({ resourceLoader }: { resourceLoader: DefaultResourceLoader }) => {
			captured.push(resourceLoader.getAppendSystemPrompt());
			throw new Error("stop");
		},
	} as unknown as PiCodingAgentModule;
}

function launch(cwd: string, prompt: Pick<ChildSessionLaunch, "systemPrompt" | "appendSystemPrompt">): ChildSessionLaunch {
	return {
		cwd,
		storage: { kind: "memory" },
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		// SAFETY: the loader path under test reads no other runtime field.
		runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"],
		...prompt,
	};
}

describe("default child factory and the operator's APPEND_SYSTEM.md", () => {
	let root: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-append-system-"));
		const agentDir = path.join(root, "agent");
		fs.mkdirSync(agentDir);
		fs.mkdirSync(path.join(root, "project"));
		fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "OPERATOR-APPEND-MARKER");
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.promises.rm(root, { recursive: true, force: true });
	});

	it("keeps it out of replace-mode, append-mode, and prompt-less children", async () => {
		const captured: string[][] = [];
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => piCapturingAppendPrompt(captured) });
		const cwd = path.join(root, "project");
		try {
			await assert.rejects(() => factory.create(launch(cwd, { systemPrompt: "ROLE" })), /stop/);
			await assert.rejects(() => factory.create(launch(cwd, { appendSystemPrompt: "ROLE" })), /stop/);
			await assert.rejects(() => factory.create(launch(cwd, {})), /stop/);
		} finally {
			await factory.dispose();
		}
		assert.deepEqual(captured, [[], ["ROLE"], []]);
	});
});
