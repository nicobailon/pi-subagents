import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { makeMinimalCtx } from "../support/helpers.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function launch(params: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> {
	const executor = createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
		state: createChildSafeState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
		asyncByDefault: false,
		tempArtifactsDir: tempHome,
		getSubagentSessionRoot: () => tempHome,
		expandTilde: (value) => value,
		discoverAgents: (cwd, scope) => discoverAgents(cwd, scope),
	});
	return executor.execute("launch", params as never, new AbortController().signal, undefined, makeMinimalCtx(tempProject) as never);
}

const text = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text ?? "").join("\n");

describe("agent choice errors at launch", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-choice-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-choice-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("answers an unknown agent with a suggestion and the available agents and their descriptions", async () => {
		const result = await launch({ agent: "reviwer", task: "Review" });

		assert.equal(result.isError, true);
		assert.match(text(result), /^Unknown agent: reviwer\. Did you mean 'reviewer'\?\n/);
		assert.match(text(result), /\nAvailable agents:\n[\s\S]*- reviewer \(builtin\) — \S[\s\S]*- worker \(builtin\) — \S/);
		for (const line of text(result).split("\n").filter((entry) => entry.startsWith("- ") && entry.includes(" — "))) {
			assert.ok(line.split(" — ")[1]!.length <= 80, line);
		}
	});

	it("lists the available agents once for a workflow script with several unknown agents", async () => {
		const workflowScript = `const a = await runs.run("a", { agent: "reviwer", task: "A" });\nreturn runs.run("b", { agent: "nobody", task: a.output });`;
		const result = text(await launch({ async: false, workflowScript }));

		assert.match(result, /Unknown agent 'reviwer'\. Did you mean 'reviewer'\? Available agents:\n- /);
		assert.match(result, /Unknown agent 'nobody'\./);
		assert.equal(result.split("Available agents:").length - 1, 1);
	});

	it("names a disabled agent as disabled and lists the agents that can run instead", async () => {
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { disabled: true } } } }));

		const result = text(await launch({ agent: "reviewer", task: "Review" }));

		assert.match(result, /^Unknown agent: reviewer is disabled by a settings override\.\n/);
		assert.match(result, /\nAvailable agents:\n[\s\S]*- worker \(builtin\) — \S/);
		assert.doesNotMatch(result, /- reviewer \(/);
	});
});
