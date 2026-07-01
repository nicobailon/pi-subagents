import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { buildAsyncRunnerSteps } from "../../src/runs/background/async-execution.ts";

function makeAgent(name: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Do work",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
	};
}

describe("async permission forwarding session identity", () => {
	it("uses the parent session id for permission forwarding instead of the async status identity", () => {
		const currentSessionId = path.join("/tmp", "parent-session.jsonl");
		const built = buildAsyncRunnerSteps("run-abc", {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: {} as never,
				cwd: "/tmp/project",
				currentSessionId,
				parentSessionId: "session-abc123",
			},
			maxSubagentDepth: 1,
			asyncDir: "/tmp/async-run",
		});

		assert.ok(!("error" in built));
		const step = built.steps[0];
		assert.ok(step && !("parallel" in step));
		assert.equal(step.parentSessionId, "session-abc123");
	});

	it("consumes bounded dynamic fanout indexes before later static forked steps", () => {
		const built = buildAsyncRunnerSteps("run-abc", {
			chain: [
				{ agent: "source", task: "produce targets", as: "targets" },
				{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {item.path}" },
					collect: { as: "reviews" },
				},
				{ agent: "worker", task: "Use reviews" },
			],
			agents: [makeAgent("source"), makeAgent("reviewer"), { ...makeAgent("worker"), model: "anthropic/claude-sonnet-4-5:high", thinking: "high" }],
			ctx: {
				pi: {} as never,
				cwd: "/tmp/project",
				currentSessionId: "/tmp/parent-session.jsonl",
			},
			sessionFilesByFlatIndex: [undefined, "/tmp/dynamic-0.jsonl", "/tmp/dynamic-1.jsonl", "/tmp/static-worker.jsonl"],
			thinkingOverridesByFlatIndex: [undefined, "off", "off", "off"],
			maxSubagentDepth: 1,
			asyncDir: "/tmp/async-run",
		});

		assert.ok(!("error" in built));
		const dynamic = built.steps[1];
		assert.ok(dynamic && "expand" in dynamic && "collect" in dynamic);
		assert.deepEqual(dynamic.sessionFiles, ["/tmp/dynamic-0.jsonl", "/tmp/dynamic-1.jsonl"]);
		assert.deepEqual(dynamic.thinkingOverrides, ["off", "off"]);
		const staticWorker = built.steps[2];
		assert.ok(staticWorker && !("parallel" in staticWorker));
		assert.equal(staticWorker.sessionFile, "/tmp/static-worker.jsonl");
		assert.equal(staticWorker.model, "anthropic/claude-sonnet-4-5:off");
		assert.equal(staticWorker.thinking, "off");
	});

	it("applies thinking overrides to async fallback candidates", () => {
		const built = buildAsyncRunnerSteps("run-abc", {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [{ ...makeAgent("worker"), model: "openai/gpt-5-mini:high", fallbackModels: ["anthropic/claude-sonnet-4:low"], thinking: "high" }],
			ctx: {
				pi: {} as never,
				cwd: "/tmp/project",
				currentSessionId: "/tmp/parent-session.jsonl",
			},
			thinkingOverridesByFlatIndex: ["off"],
			maxSubagentDepth: 1,
			asyncDir: "/tmp/async-run",
		});

		assert.ok(!("error" in built));
		const step = built.steps[0];
		assert.ok(step && !("parallel" in step));
		assert.equal(step.model, "openai/gpt-5-mini:off");
		assert.deepEqual(step.modelCandidates, ["openai/gpt-5-mini:off", "anthropic/claude-sonnet-4:off"]);
		assert.equal(step.thinking, "off");
	});
});
