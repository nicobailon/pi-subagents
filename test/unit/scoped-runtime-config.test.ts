import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	expandRuntimePath,
	mergeRuntimeConfig,
	readProjectRuntimeConfig,
	resolveAgentRuntimeConfig,
} from "../../src/shared/scoped-runtime-config.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Worker",
		systemPrompt: "Do work",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "/tmp/worker.md",
		...overrides,
	};
}

describe("scoped runtime config", () => {
	it("reads project-level and per-agent subagent runtime config from .pi/settings.json", () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-runtime-"));
		try {
			fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({
				subagents: {
					defaultSessionDir: ".pi/subagents/sessions",
					worktreeRoot: ".pi/subagents/worktrees",
					agentDefaults: {
						worker: {
							defaultSessionDir: ".pi/subagents/sessions/{agent}",
							keepWorktrees: true,
						},
					},
				},
			}, null, 2), "utf-8");

			const projectConfig = readProjectRuntimeConfig(path.join(project, "packages", "app"));
			assert.equal(projectConfig.baseDir, project);
			assert.equal(projectConfig.config.defaultSessionDir, ".pi/subagents/sessions");
			assert.equal(projectConfig.config.worktreeRoot, ".pi/subagents/worktrees");
			assert.equal(projectConfig.config.agentDefaults?.worker?.defaultSessionDir, ".pi/subagents/sessions/{agent}");
			assert.equal(projectConfig.config.agentDefaults?.worker?.keepWorktrees, true);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
		}
	});

	it("merges global, project, settings agentDefaults, and agent frontmatter in priority order", () => {
		const merged = mergeRuntimeConfig(
			{
				defaultSessionDir: "~/global-sessions",
				worktreeRoot: "~/global-worktrees",
				agentDefaults: { worker: { worktreeRoot: "~/global-worker-worktrees" } },
			},
			{
				defaultSessionDir: ".pi/subagents/sessions",
				agentDefaults: { worker: { worktreeRoot: ".pi/subagents/worktrees/worker" } },
			},
		);

		assert.deepEqual(resolveAgentRuntimeConfig(merged, "worker"), {
			defaultSessionDir: ".pi/subagents/sessions",
			worktreeRoot: ".pi/subagents/worktrees/worker",
			worktreeSetupHook: undefined,
			worktreeSetupHookTimeoutMs: undefined,
			keepWorktrees: undefined,
		});

		const agent = makeAgent({ worktreeRoot: ".pi/subagents/worktrees/frontmatter" });
		assert.equal(resolveAgentRuntimeConfig(merged, "worker", agent).worktreeRoot, ".pi/subagents/worktrees/frontmatter");
	});

	it("expands runtime path templates relative to the project root", () => {
		const expanded = expandRuntimePath(".pi/subagents/{agent}/{runId}/{index}", {
			cwd: "/repo/packages/app",
			baseDir: "/repo",
			agent: "worker",
			runId: "abc123",
			index: 2,
		});
		assert.equal(expanded, path.join("/repo", ".pi", "subagents", "worker", "abc123", "2"));
	});
});
