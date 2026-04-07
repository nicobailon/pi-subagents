import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { serializeAgent } from "../../agent-serializer.ts";
import { discoverAgents, type AgentConfig } from "../../agents.ts";

const tempDirs: string[] = [];
let tempHome: string;
let prevHomeEnv: string | undefined;

beforeEach(() => {
	tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-overlay-home-"));
	prevHomeEnv = process.env.PI_SUBAGENTS_HOME;
	process.env.PI_SUBAGENTS_HOME = tempHome;
});

afterEach(() => {
	if (prevHomeEnv === undefined) delete process.env.PI_SUBAGENTS_HOME;
	else process.env.PI_SUBAGENTS_HOME = prevHomeEnv;
	fs.rmSync(tempHome, { recursive: true, force: true });
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("agent frontmatter maxSubagentDepth", () => {
	it("serializes maxSubagentDepth into agent frontmatter", () => {
		const agent: AgentConfig = {
			name: "scout",
			description: "Scout",
			systemPrompt: "Inspect code",
			source: "project",
			filePath: "/tmp/scout.md",
			maxSubagentDepth: 1,
		};

		const serialized = serializeAgent(agent);
		assert.match(serialized, /maxSubagentDepth: 1/);
	});

	it("parses maxSubagentDepth from discovered agent frontmatter", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-frontmatter-"));
		tempDirs.push(dir);
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "scout.md"), `---
name: scout
description: Scout
maxSubagentDepth: 1
---

Inspect code
`, "utf-8");

		const result = discoverAgents(dir, "project");
		const scout = result.agents.find((agent) => agent.name === "scout");
		assert.equal(scout?.maxSubagentDepth, 1);
	});
});
