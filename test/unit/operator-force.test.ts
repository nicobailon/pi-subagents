import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearAgentDiscoveryCache, discoverAgents } from "../../src/agents/agents.ts";
import { operatorForcedModelForAgent, parseOperatorForceSettings } from "../../src/agents/operator-force.ts";
import { resolveEffectiveSubagentModel, resolveModelOrigin, resolveModelSelection, resolveSubagentModelOverride } from "../../src/runs/shared/model-resolution.ts";
import { resolveStepBehavior } from "../../src/runs/shared/child-launch-plan.ts";

const FILE = "/tmp/settings.json";
const models = [
	{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	{ provider: "policy", id: "pools.impl.sol", fullId: "policy/pools.impl.sol" },
];
const parent = { provider: "anthropic", id: "claude-sonnet-4" };

describe("parseOperatorForceSettings", () => {
	it("returns undefined when force is absent or disabled, without validating a disabled agents map", () => {
		assert.equal(parseOperatorForceSettings({}, FILE), undefined);
		assert.equal(parseOperatorForceSettings({ operatorModelOverride: { enabled: false } }, FILE), undefined);
		assert.equal(parseOperatorForceSettings({ operatorModelOverride: { enabled: false, agents: "garbage" } }, FILE), undefined);
	});

	it("parses an enabled force map when every policy id exists in the same file's modelPolicies", () => {
		const parsed = parseOperatorForceSettings({
			modelPolicies: { "pools.impl.sol": { primary: { model: "openai/gpt-5-mini" } } },
			operatorModelOverride: { enabled: true, agents: { worker: "pools.impl.sol" } },
		}, FILE);
		assert.deepEqual(parsed, { agents: { worker: "pools.impl.sol" } });
	});

	it("fails closed on malformed force authority", () => {
		assert.throws(() => parseOperatorForceSettings({ operatorModelOverride: "policy/x" }, FILE), /invalid 'operatorModelOverride'.*fails closed/);
		assert.throws(() => parseOperatorForceSettings({ operatorModelOverride: { enabled: "yes" } }, FILE), /invalid 'operatorModelOverride\.enabled'.*fails closed/);
		assert.throws(() => parseOperatorForceSettings({ operatorModelOverride: { enabled: true } }, FILE), /invalid 'operatorModelOverride\.agents'/);
		assert.throws(
			() => parseOperatorForceSettings({ modelPolicies: {}, operatorModelOverride: { enabled: true, agents: { worker: "has space" } } }, FILE),
			/invalid 'operatorModelOverride\.agents\["worker"\]'/,
		);
		assert.throws(
			() => parseOperatorForceSettings({ operatorModelOverride: { enabled: true, agents: { worker: 3 } } }, FILE),
			/invalid 'operatorModelOverride\.agents\["worker"\]'/,
		);
	});

	it("refuses a forced policy id that is not defined in the same user file", () => {
		assert.throws(
			() => parseOperatorForceSettings({ modelPolicies: { other: {} }, operatorModelOverride: { enabled: true, agents: { worker: "missing.policy" } } }, FILE),
			/force agent 'worker' onto policy 'missing\.policy'.*not defined in the user settings 'subagents\.modelPolicies'/,
		);
		assert.throws(
			() => parseOperatorForceSettings({ operatorModelOverride: { enabled: true, agents: { worker: "missing.policy" } } }, FILE),
			/not defined in the user settings 'subagents\.modelPolicies'/,
		);
	});
});

describe("operatorForcedModelForAgent", () => {
	const force = { agents: { worker: "pools.impl.sol" } };

	it("forces native agents and leaves everyone else unforced", () => {
		assert.equal(operatorForcedModelForAgent(force, { name: "worker" }), "policy/pools.impl.sol");
		assert.equal(operatorForcedModelForAgent(force, { name: "worker", runner: { type: "pi" } }), "policy/pools.impl.sol");
		assert.equal(operatorForcedModelForAgent(force, { name: "worker", runner: { type: "external-cli" } }), undefined);
		assert.equal(operatorForcedModelForAgent(force, { name: "worker", runner: { type: "external-job" } }), undefined);
		assert.equal(operatorForcedModelForAgent(force, { name: "worker", machine: "build-box" }), undefined);
		assert.equal(operatorForcedModelForAgent(force, { name: "scout" }), undefined);
		assert.equal(operatorForcedModelForAgent(undefined, { name: "worker" }), undefined);
	});
});

describe("operator force in model resolution", () => {
	it("beats the explicit per-call model, the configured model, and inheritance", () => {
		const forcedModel = "policy/pools.impl.sol";
		assert.equal(
			resolveEffectiveSubagentModel("gpt-5-mini", "claude-sonnet-4", parent, models, undefined, { forcedModel }),
			forcedModel,
		);
		assert.equal(resolveSubagentModelOverride(undefined, parent, models, undefined, { forcedModel }), forcedModel);
		assert.equal(resolveSubagentModelOverride("inherit", parent, models, undefined, { forcedModel }), forcedModel);
	});

	it("keeps normal precedence when no force is set", () => {
		assert.equal(resolveEffectiveSubagentModel("gpt-5-mini", "claude-sonnet-4", parent, models), "openai/gpt-5-mini");
		assert.equal(resolveEffectiveSubagentModel(undefined, "gpt-5-mini", parent, models), "openai/gpt-5-mini");
	});

	it("fails the launch when the forced model is not in the parent registry", () => {
		assert.throws(
			() => resolveSubagentModelOverride("gpt-5-mini", parent, models, undefined, { forcedModel: "policy/not.registered" }),
			/Unknown subagent model 'policy\/not\.registered'/,
		);
	});

	it("reports origin as configured and keeps the originally requested model as evidence", () => {
		assert.equal(
			resolveModelOrigin({ explicitModel: "gpt-5-mini", agentModel: "claude-sonnet-4", parentModel: parent, forcedModel: "policy/pools.impl.sol" }),
			"configured",
		);
		assert.deepEqual(
			resolveModelSelection("policy/pools.impl.sol", models, undefined, { origin: "configured", requestedModel: "gpt-5-mini" }),
			{ model: "policy/pools.impl.sol", requestedModel: "gpt-5-mini" },
		);
	});

	it("wins in chain step behavior over the step model", () => {
		const agent = {
			name: "worker",
			model: "claude-sonnet-4",
			operatorForcedModel: "policy/pools.impl.sol",
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritGlobalContext: true,
			inheritSkills: true,
			description: "",
			systemPrompt: "",
			source: "user",
			filePath: "/tmp/worker.md",
		} as Parameters<typeof resolveStepBehavior>[0];
		assert.equal(resolveStepBehavior(agent, { model: "gpt-5-mini" }).model, "policy/pools.impl.sol");
	});
});

describe("operator force in agent discovery", () => {
	let tempHome = "";
	let tempProject = "";
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalExtraAgentDirs = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;

	function writeJson(filePath: string, value: unknown): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
	}

	function writeUserAgent(name: string, body: string): void {
		const filePath = path.join(tempHome, ".pi", "agent", "agents", `${name}.md`);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, body, "utf-8");
	}

	const forceSettings = {
		subagents: {
			modelPolicies: { "pools.impl.sol": { primary: { model: "openai/gpt-5-mini" } } },
			operatorModelOverride: { enabled: true, agents: { "pool-worker": "pools.impl.sol", "pool-external": "pools.impl.sol" } },
		},
	};

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		clearAgentDiscoveryCache();
		writeUserAgent("pool-worker", "---\nname: pool-worker\ndescription: Native worker\nmodel: anthropic/claude-sonnet-4\n---\nWork.\n");
		writeUserAgent("pool-external", "---\nname: pool-external\ndescription: External worker\nrunner:\n  type: external-cli\n  command: echo hi\n---\nWork.\n");
	});

	afterEach(() => {
		clearAgentDiscoveryCache();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		if (originalExtraAgentDirs === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = originalExtraAgentDirs;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("stamps operatorForcedModel on forced native agents only", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), forceSettings);
		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((agent) => agent.name === "pool-worker")?.operatorForcedModel, "policy/pools.impl.sol");
		assert.equal(agents.find((agent) => agent.name === "pool-external")?.operatorForcedModel, undefined);
	});

	it("ignores operatorModelOverride in project settings entirely", () => {
		writeJson(path.join(tempProject, ".pi", "settings.json"), forceSettings);
		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((agent) => agent.name === "pool-worker")?.operatorForcedModel, undefined);
	});

	it("does not stamp when force is disabled", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				modelPolicies: { "pools.impl.sol": { primary: { model: "openai/gpt-5-mini" } } },
				operatorModelOverride: { enabled: false, agents: { "pool-worker": "pools.impl.sol" } },
			},
		});
		const { agents } = discoverAgents(tempProject, "both");
		assert.equal(agents.find((agent) => agent.name === "pool-worker")?.operatorForcedModel, undefined);
	});

	it("fails discovery closed when the forced policy is undefined in user settings", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { operatorModelOverride: { enabled: true, agents: { "pool-worker": "missing.policy" } } },
		});
		assert.throws(() => discoverAgents(tempProject, "both"), /force agent 'pool-worker' onto policy 'missing\.policy'.*not defined/);
	});
});
