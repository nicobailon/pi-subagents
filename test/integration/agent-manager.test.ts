import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AgentManagerComponent, type AgentData, type ManagerResult } from "../../agent-manager.ts";
import { discoverAgentsAll, type AgentConfig, type ChainConfig } from "../../agents.ts";

const tempDirs: string[] = [];

function createTempRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(root);
	return root;
}

function theme() {
	return {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
	} as { fg(color: string, text: string): string; bg(color: string, text: string): string };
}

function testAgent(root: string, name: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "",
		source: "user",
		filePath: path.join(root, `${name}.md`),
	};
}

function createAgentData(root: string, agents: AgentConfig[], chains: ChainConfig[] = []): AgentData {
	return {
		builtin: [],
		user: agents,
		project: [],
		chains,
		userDir: root,
		projectDir: null,
		userSettingsPath: path.join(root, "settings.json"),
		projectSettingsPath: null,
		cwd: root,
	};
}

function createManager(root: string, done: (result: ManagerResult) => void = () => {}) {
	return new AgentManagerComponent(
		{ requestRender() {} } as { requestRender(): void },
		theme(),
		createAgentData(root, [testAgent(root, "alpha"), testAgent(root, "beta")]),
		[],
		[],
		done,
	);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent manager", () => {
	it("renames the backing file when saving an existing renamed agent", () => {
		const root = createTempRoot("pi-agent-manager-rename-");
		const agentsDir = path.join(root, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const originalPath = path.join(agentsDir, "alpha.md");
		fs.writeFileSync(originalPath, `---\nname: alpha\ndescription: Alpha\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\n\nHello\n`, "utf-8");

		const component = new AgentManagerComponent(
			{ requestRender() {} } as { requestRender(): void },
			theme(),
			{ ...discoverAgentsAll(root), cwd: root },
			[],
			[],
			() => {},
		);

		const entry = component["agents"].find((candidate) => candidate.config.name === "alpha");
		assert.ok(entry);
		component["enterEdit"](entry);
		component["editState"].draft.name = "beta";

		assert.equal(component["saveEdit"](), true);
		assert.equal(fs.existsSync(originalPath), false);
		assert.equal(fs.existsSync(path.join(agentsDir, "beta.md")), true);
	});

	it("does not expose builtin-only disabled editing for regular agents", () => {
		const root = createTempRoot("pi-agent-manager-fields-");
		const agentsDir = path.join(root, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "alpha.md"), `---\nname: alpha\ndescription: Alpha\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\n\nHello\n`, "utf-8");

		const component = new AgentManagerComponent(
			{ requestRender() {} } as { requestRender(): void },
			theme(),
			{ ...discoverAgentsAll(root), cwd: root },
			[],
			[],
			() => {},
		);

		const entry = component["agents"].find((candidate) => candidate.config.name === "alpha");
		assert.ok(entry);
		component["enterEdit"](entry);

		assert.equal(component["editState"]?.fields.includes("disabled"), false);
	});

	it("collects a task before launching a multi-agent chain selection", () => {
		const root = createTempRoot("pi-agent-manager-chain-task-");
		let result: ManagerResult;

		const component = new AgentManagerComponent(
			{ requestRender() {} } as { requestRender(): void },
			theme(),
			{ ...discoverAgentsAll(root), cwd: root },
			[],
			[],
			(next) => { result = next; },
		);

		const entries = component["agents"].slice(0, 2);
		assert.equal(entries.length, 2);
		component["enterTaskInput"](entries.map((entry) => entry.id));

		assert.equal(component["screen"], "task-input");
		assert.equal(result, undefined);

		component["taskEditor"].buffer = "Investigate";
		component["taskEditor"].cursor = "Investigate".length;
		component.handleInput("\r");

		assert.deepEqual(result, {
			action: "chain",
			agents: entries.map((entry) => entry.config.name),
			task: "Investigate",
			skipClarify: true,
		});
	});

	it("renders fork and background toggles but not worktree for single-agent launch", () => {
		const root = createTempRoot("pi-agent-manager-single-toggles-");
		const component = createManager(root);
		const entry = component["agents"][0];
		assert.ok(entry);

		component["enterTaskInput"]([entry.id], "detail");
		const rendered = component.render(84).join("\n");

		assert.match(rendered, /\[ctrl\+f\] fork:off/);
		assert.match(rendered, /\[ctrl\+b\] bg:off/);
		assert.doesNotMatch(rendered, /worktree/);
	});

	it("keeps plain toggle letters editable in task input", () => {
		const root = createTempRoot("pi-agent-manager-toggle-letter-text-");
		let result: ManagerResult;
		const component = createManager(root, (next) => { result = next; });
		const entry = component["agents"][0];
		assert.ok(entry);

		component["enterTaskInput"]([entry.id], "detail");
		component.handleInput("f");
		component.handleInput("b");
		component.handleInput("w");
		component.handleInput("\r");

		assert.deepEqual(result, {
			action: "launch",
			agent: "alpha",
			task: "fbw",
			skipClarify: true,
		});
	});

	it("includes fork and background flags in single-agent launch results", () => {
		const root = createTempRoot("pi-agent-manager-single-flags-");
		let result: ManagerResult;
		const component = createManager(root, (next) => { result = next; });
		const entry = component["agents"][0];
		assert.ok(entry);

		component["enterTaskInput"]([entry.id], "detail");
		component.handleInput("\x06");
		component.handleInput("\x02");
		component["taskEditor"].buffer = "Investigate";
		component["taskEditor"].cursor = "Investigate".length;
		component.handleInput("\r");

		assert.deepEqual(result, {
			action: "launch",
			agent: "alpha",
			task: "Investigate",
			skipClarify: true,
			fork: true,
			background: true,
		});
	});

	it("renders and returns worktree for parallel launches", () => {
		const root = createTempRoot("pi-agent-manager-parallel-toggles-");
		let result: ManagerResult;
		const component = createManager(root, (next) => { result = next; });
		const entries = component["agents"].slice(0, 2);
		assert.equal(entries.length, 2);

		component["enterParallelBuilder"](entries.map((entry) => entry.id));
		component.handleInput("\x12");
		assert.match(component.render(84).join("\n"), /\[ctrl\+w\] worktree:off/);
		component.handleInput("\x17");
		assert.match(component.render(84).join("\n"), /\[ctrl\+w\] worktree:on/);
		component["taskEditor"].buffer = "Compare";
		component["taskEditor"].cursor = "Compare".length;
		component.handleInput("\r");

		assert.deepEqual(result, {
			action: "parallel",
			tasks: [
				{ agent: "alpha", task: "Compare" },
				{ agent: "beta", task: "Compare" },
			],
			skipClarify: true,
			worktree: true,
		});
	});

	it("shows worktree only for saved chains with a parallel step", () => {
		const root = createTempRoot("pi-agent-manager-chain-worktree-");
		const agents = [testAgent(root, "alpha"), testAgent(root, "beta")];
		const sequentialChain: ChainConfig = {
			name: "sequential",
			description: "Sequential chain",
			source: "user",
			filePath: path.join(root, "sequential.chain.md"),
			steps: [{ agent: "alpha", task: "Do A" }],
		};
		const parallelChain = {
			name: "parallel",
			description: "Parallel chain",
			source: "user",
			filePath: path.join(root, "parallel.chain.md"),
			steps: [
				{ agent: "alpha", task: "Do A" },
				{ parallel: [{ agent: "alpha", task: "Review A" }, { agent: "beta", task: "Review B" }] },
			],
		} as unknown as ChainConfig;
		const component = new AgentManagerComponent(
			{ requestRender() {} } as { requestRender(): void },
			theme(),
			createAgentData(root, agents, [sequentialChain, parallelChain]),
			[],
			[],
			() => {},
		);

		const sequentialEntry = component["chains"].find((entry) => entry.config.name === "sequential");
		assert.ok(sequentialEntry);
		component["enterSavedChainLaunch"](sequentialEntry);
		assert.doesNotMatch(component.render(84).join("\n"), /worktree/);

		const parallelEntry = component["chains"].find((entry) => entry.config.name === "parallel");
		assert.ok(parallelEntry);
		component["enterChainDetail"](parallelEntry);
		assert.match(component.render(84).join("\n"), /Parallel: alpha \+ beta/);
		component.handleInput("l");
		assert.match(component.render(84).join("\n"), /\[ctrl\+w\] worktree:off/);
	});
});
