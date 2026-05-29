import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	buildFlatAgentNameResolver,
	collectInvocationAgentNames,
	createPerAgentForkContextResolver,
	invocationUsesForkContext,
	resolveAgentContext,
	wrapChainTasksForAgentContext,
	wrapTaskForAgentContext,
} from "../../src/shared/agent-context-policy.ts";

const agents: AgentConfig[] = [
	makeAgent("scout", "fresh"),
	makeAgent("worker", "fork"),
	makeAgent("oracle", "fork"),
];

function makeAgent(name: string, defaultContext: "fresh" | "fork"): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		defaultContext,
		systemPrompt: `${name} prompt`,
		source: "user",
		filePath: `/user/${name}.md`,
	};
}

describe("resolveAgentContext", () => {
	it("uses explicit caller context when provided", () => {
		assert.equal(resolveAgentContext("fresh", "worker", agents), "fresh");
		assert.equal(resolveAgentContext("fork", "scout", agents), "fork");
	});

	it("falls back to agent defaultContext when caller context is omitted", () => {
		assert.equal(resolveAgentContext(undefined, "scout", agents), "fresh");
		assert.equal(resolveAgentContext(undefined, "worker", agents), "fork");
	});
});

describe("invocationUsesForkContext", () => {
	it("reports fork usage when any agent defaults to fork", () => {
		const names = collectInvocationAgentNames({
			tasks: [
				{ agent: "scout" },
				{ agent: "worker" },
			],
		});
		assert.deepEqual(names, ["scout", "worker"]);
		assert.equal(invocationUsesForkContext(undefined, names, agents), true);
	});

	it("stays fresh when no agent defaults to fork", () => {
		assert.equal(invocationUsesForkContext(undefined, ["scout"], agents), false);
	});
});

describe("wrapTaskForAgentContext", () => {
	it("wraps only fork-default agents when caller context is omitted", () => {
		const scoutTask = wrapTaskForAgentContext("find files", undefined, "scout", agents);
		const workerTask = wrapTaskForAgentContext("implement fix", undefined, "worker", agents);
		assert.equal(scoutTask, "find files");
		assert.match(workerTask, /delegated subagent/i);
	});

	it("honors explicit fresh override for fork-default agents", () => {
		const workerTask = wrapTaskForAgentContext("implement fix", "fresh", "worker", agents);
		assert.equal(workerTask, "implement fix");
	});
});

describe("wrapChainTasksForAgentContext", () => {
	it("applies fork wrapping per chain step agent", () => {
		const wrapped = wrapChainTasksForAgentContext(
			[
				{ agent: "scout", task: "scout task" },
				{ agent: "worker", task: "worker task" },
			],
			undefined,
			agents,
		);
		assert.equal((wrapped[0] as { task?: string }).task, "scout task");
		assert.match((wrapped[1] as { task?: string }).task ?? "", /delegated subagent/i);
	});
});

describe("createPerAgentForkContextResolver", () => {
	it("forks only indices whose agent defaults to fork", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-per-agent-fork-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			fs.mkdirSync(path.dirname(parentSessionFile), { recursive: true });
			fs.writeFileSync(
				parentSessionFile,
				'{"type":"session","version":1,"id":"parent","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n',
				"utf-8",
			);

			let forkCalls = 0;
			const resolver = createPerAgentForkContextResolver(
				{
					getSessionFile: () => parentSessionFile,
					getLeafId: () => "leaf-1",
				},
				(index = 0) => (index === 1 ? "fork" : "fresh"),
				{
					openSession: () => ({
						createBranchedSession: () => {
							forkCalls++;
							const childSessionFile = path.join(tempDir, `child-${forkCalls}.jsonl`);
							fs.writeFileSync(
								childSessionFile,
								`{"type":"session","version":1,"id":"child-${forkCalls}","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n`,
								"utf-8",
							);
							return childSessionFile;
						},
					}),
				},
			);

			assert.equal(resolver.sessionFileForIndex(0), undefined);
			assert.equal(resolver.sessionFileForIndex(1), path.join(tempDir, "child-1.jsonl"));
			assert.equal(forkCalls, 1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("buildFlatAgentNameResolver", () => {
	it("maps parallel task indices to agent names", () => {
		const resolve = buildFlatAgentNameResolver({
			tasks: [{ agent: "scout" }, { agent: "worker" }],
		});
		assert.equal(resolve(0), "scout");
		assert.equal(resolve(1), "worker");
	});
});
