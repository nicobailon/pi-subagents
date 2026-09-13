import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { findConfiguredProjectRoot, resolveAgentName, type AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(name: string, localName?: string): AgentConfig {
	return {
		name,
		localName,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "Inspect",
		source: "project",
		filePath: `/.pi/agents/${name}.md`,
	};
}

describe("resolveAgentName", () => {
	it("prefers an exact canonical name over a packaged local name", () => {
		const plain = makeAgent("scout");
		const packaged = makeAgent("code-analysis.scout", "scout");

		assert.equal(resolveAgentName("scout", [plain, packaged]).agent, plain);
		assert.equal(resolveAgentName("code-analysis.scout", [plain, packaged]).agent, packaged);
	});

	it("uses a unique packaged local name when no canonical name exists", () => {
		const packaged = makeAgent("code-analysis.scout", "scout");

		assert.equal(resolveAgentName("scout", [packaged]).agent, packaged);
	});

	it("rejects a local name shared by multiple packaged agents", () => {
		const result = resolveAgentName("scout", [
			makeAgent("code-analysis.scout", "scout"),
			makeAgent("repository.scout", "scout"),
		]);

		assert.match(result.error ?? "", /Ambiguous local agent name 'scout': code-analysis\.scout, repository\.scout/);
	});
});

describe("findConfiguredProjectRoot", () => {
	it("does not reinterpret user config as project config", () => {
		const home = os.homedir();
		fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
		const nested = fs.mkdtempSync(path.join(home, "tmp", "agent-project-"));
		fs.mkdirSync(path.join(home, ".pi"), { recursive: true });

		assert.equal(findConfiguredProjectRoot(nested), null);

		fs.mkdirSync(path.join(nested, ".pi"));
		assert.equal(findConfiguredProjectRoot(nested), nested);
	});
});
