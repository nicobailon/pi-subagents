import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

let previousAgentDir: string | undefined;
let agentDir: string;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observed-model-agent-"));
	fs.chmodSync(agentDir, 0o700);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function baseConfig(root: string, id: string, steps: SubagentRunConfig["steps"]): SubagentRunConfig {
	const asyncDir = path.join(root, `${id}-async`);
	fs.mkdirSync(asyncDir, { recursive: true });
	return {
		id,
		steps,
		resultPath: path.join(root, `${id}-result.json`),
		cwd: root,
		asyncDir,
		sessionId: `session-${id}`,
		artifactConfig: { enabled: false },
		share: false,
		placeholder: "{previous}",
	};
}

function stepModels(config: SubagentRunConfig): Array<{ model?: string; launchModel?: string }> {
	const status = JSON.parse(fs.readFileSync(path.join(config.asyncDir!, "status.json"), "utf-8")) as { steps: Array<{ model?: string; launchModel?: string }> };
	return status.steps.map(({ model, launchModel }) => ({ model, launchModel }));
}

describe("async step reports the observed child model", () => {
	it("publishes the model the assistant actually ran on, not the launch model", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observed-model-switch-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
			output: "done on the rerouted model",
			reportedModel: "openai-codex/gpt-6-sol",
		}));
		const fake = createFakeChildSessions(() => queue);
		const config = baseConfig(root, "observed-switch", [
			{ agent: "qwen_worker", task: "do the work", model: "llama-swap/qwen3.5:9b" },
		]);
		try {
			await runSubagent(config, fake.factory);
			assert.equal(fake.sessions.length, 1, "the child session must launch");
			const models = stepModels(config);
			assert.deepEqual(
				models,
				[{ model: "openai-codex/gpt-6-sol", launchModel: "llama-swap/qwen3.5:9b" }],
				"the step must report the observed model and keep the launch model for revival",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the launch model when the child reports the same model", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observed-model-same-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({
			output: "done on the launch model",
			reportedModel: "llama-swap/qwen3.5:9b",
		}));
		const fake = createFakeChildSessions(() => queue);
		const config = baseConfig(root, "observed-same", [
			{ agent: "qwen_worker", task: "do the work", model: "llama-swap/qwen3.5:9b" },
		]);
		try {
			await runSubagent(config, fake.factory);
			const models = stepModels(config);
			assert.deepEqual(models, [{ model: "llama-swap/qwen3.5:9b", launchModel: undefined }], "a stable model must be reported unchanged");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
