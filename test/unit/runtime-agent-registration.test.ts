import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgent } from "../../src/api/agents.ts";
import { handleList } from "../../src/agents/agent-management.ts";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { clearRuntimeAgentsForPi, mergeRuntimeAgents } from "../../src/agents/runtime-agent-registry.ts";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

let tempHome = "";
let tempProject = "";
let pi: ExtensionAPI;

function makePi(): ExtensionAPI {
	return {
		on() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
}

function writeProjectAgent(name: string, aliases: string[] = []): void {
	const filePath = path.join(tempProject, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: Project agent\n${aliases.length ? `aliases: ${aliases.join(", ")}\n` : ""}---\n\nProject prompt.\n`, "utf-8");
}

function writeUserAgent(name: string, aliases: string[] = []): void {
	const filePath = path.join(tempHome, ".pi", "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: User agent\n${aliases.length ? `aliases: ${aliases.join(", ")}\n` : ""}---\n\nUser prompt.\n`, "utf-8");
}

describe("runtime agent registration", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-agent-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-agent-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		delete process.env.PI_CODING_AGENT_DIR;
		pi = makePi();
	});

	afterEach(() => {
		clearRuntimeAgentsForPi(pi);
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("adds runtime agents to extension discovery without writing config", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		const registration = registerAgent({
			pi,
			name: "runtime-helper",
			definition: {
				description: "Runtime helper",
				systemPrompt: "Help at runtime.",
				aliases: ["helper"],
				model: "openai/gpt-5-mini",
			},
		});

		const agents = mergeRuntimeAgents(pi, discoverAgents(tempProject, "both")).agents;
		const agent = agents.find((candidate) => candidate.name === "runtime-helper");
		assert.equal(agent?.source, "runtime");
		assert.deepEqual(agent?.aliases, ["helper"]);
		assert.equal(agent?.systemPrompt, "Help at runtime.");
		assert.equal(fs.existsSync(settingsPath), false);

		registration.dispose();
		assert.equal(mergeRuntimeAgents(pi, discoverAgents(tempProject, "both")).agents.some((candidate) => candidate.name === "runtime-helper"), false);
		registration.dispose();
	});

	it("lists runtime agents for the matching Pi runtime", () => {
		registerAgent({
			pi,
			name: "runtime-helper",
			definition: { description: "Runtime helper", systemPrompt: "Help at runtime.", aliases: ["helper"] },
		});

		const listed = handleList({}, { cwd: tempProject, modelRegistry: { getAvailable: () => [] }, runtimeAgentOwner: pi });
		const text = listed.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n");
		assert.match(text, /- runtime-helper \(runtime, aliases: helper\): Runtime helper/);
	});

	it("fails closed for builtin and duplicate runtime identities", () => {
		assert.throws(
			() => registerAgent({ pi, name: "claude-code", definition: { description: "Unsafe", systemPrompt: "Write.", runner: { type: "external-cli", adapter: "claude-code-writer", command: "claude" } } }),
			/reserved for the read-only 'claude-code' adapter/,
		);
		assert.throws(
			() => registerAgent({ pi, name: "runtime-writer", definition: { description: "Unsafe alias", systemPrompt: "Write.", aliases: ["claude-code"], runner: { type: "external-cli", adapter: "claude-code-writer", command: "claude" } } }),
			/Selection name 'claude-code' is reserved/,
		);
		for (const [readOnly, writer, command] of [["codex-exec", "codex-exec-writer", "codex"], ["cursor-agent", "cursor-agent-writer", "cursor-agent"]] as const) {
			assert.throws(
				() => registerAgent({ pi, name: readOnly, definition: { description: "Unsafe", systemPrompt: "Write.", runner: { type: "external-cli", adapter: writer, command } } }),
				/reserved for the read-only/,
			);
			assert.throws(
				() => registerAgent({ pi, name: `runtime-${writer}`, definition: { description: "Unsafe alias", systemPrompt: "Write.", aliases: [readOnly], runner: { type: "external-cli", adapter: writer, command } } }),
				/Selection name .* is reserved/,
			);
		}
		assert.throws(
			() => registerAgent({ pi, name: "worker", definition: { description: "Bad", systemPrompt: "Bad." } }),
			/Worker|builtin agent 'worker'|collides with builtin agent 'worker'/i,
		);

		registerAgent({ pi, name: "runtime-a", definition: { description: "A", systemPrompt: "A.", aliases: ["shared"] } });
		assert.throws(
			() => registerAgent({ pi, name: "runtime-b", definition: { description: "B", systemPrompt: "B.", aliases: ["shared"] } }),
			/collides with runtime agent 'runtime-a' on name or alias 'shared'/,
		);
	});

	it("rejects malformed nested runtime definition fields at registration", () => {
		const cases: Array<[string, Record<string, unknown>, RegExp]> = [
			["defaultTurnBudget", { defaultTurnBudget: { maxTurns: 0 } }, /defaultTurnBudget\.maxTurns must be an integer >= 1/],
			["defaultAcceptance", { defaultAcceptance: { level: "verified" } }, /defaultAcceptance\.verify must contain at least one runtime command/],
			["runner", { runner: { type: "external-cli" } }, /external-cli runner requires a non-empty command string/],
			["toolBudget", { toolBudget: { hard: 0 } }, /toolBudget\.hard must be an integer >= 1/],
			["permissions", { permissions: { bash: "deny" } }, /permissions\.bash is unsupported/],
		];

		for (const [name, extra, pattern] of cases) {
			assert.throws(
				() => registerAgent({ pi, name: `runtime-${name}`, definition: { description: "Bad", systemPrompt: "Bad.", ...extra } }),
				pattern,
			);
		}
	});

	it("fails closed when cwd discovery introduces a configured collision", () => {
		registerAgent({ pi, name: "runtime-helper", definition: { description: "Runtime helper", systemPrompt: "Help.", aliases: ["helper"] } });
		writeProjectAgent("project-helper", ["helper"]);

		assert.throws(
			() => mergeRuntimeAgents(pi, discoverAgents(tempProject, "both")),
			/collides with configured agent 'project-helper' on name or alias 'helper'/,
		);
	});

	it("fails closed against configured definitions hidden by scope precedence", () => {
		registerAgent({ pi, name: "hidden-user", definition: { description: "Runtime helper", systemPrompt: "Help." } });
		writeUserAgent("hidden-user");
		writeProjectAgent("hidden-user");
		const discovered = discoverAgents(tempProject, "both");
		assert.equal(discovered.agents.find((agent) => agent.name === "hidden-user")?.source, "project");

		const allDiscovered = discoverAgentsAll(tempProject);
		const all = [...allDiscovered.builtin, ...allDiscovered.package, ...allDiscovered.user, ...allDiscovered.project];
		assert.throws(
			() => mergeRuntimeAgents(pi, discovered, all),
			/collides with configured agent 'hidden-user' on name or alias 'hidden-user'/,
		);
	});

	it("fails closed against configured definitions hidden by explicit scope", () => {
		registerAgent({ pi, name: "hidden-user", definition: { description: "Runtime helper", systemPrompt: "Help." } });
		writeUserAgent("hidden-user");
		const projectScoped = discoverAgents(tempProject, "project");
		const allProject = discoverAgentsAll(tempProject);
		assert.equal(projectScoped.agents.some((agent) => agent.name === "hidden-user"), false);
		assert.throws(
			() => mergeRuntimeAgents(pi, projectScoped, [...allProject.builtin, ...allProject.package, ...allProject.user, ...allProject.project]),
			/collides with configured agent 'hidden-user' on name or alias 'hidden-user'/,
		);
	});

	it("fails closed for management lists when scoped discovery hides a configured collision", () => {
		registerAgent({ pi, name: "hidden-user", definition: { description: "Runtime hidden", systemPrompt: "Help." } });
		writeUserAgent("hidden-user");

		assert.throws(
			() => handleList({ agentScope: "project" }, { cwd: tempProject, modelRegistry: { getAvailable: () => [] }, runtimeAgentOwner: pi }),
			/collides with configured agent 'hidden-user' on name or alias 'hidden-user'/,
		);
	});
});
