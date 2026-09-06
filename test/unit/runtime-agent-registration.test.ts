import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RUNTIME_AGENT_REGISTER_EVENT, registerAgent, registerAgentViaEvents, type RuntimeAgentRegistrationRequest } from "../../src/api/agents.ts";
import { registerRuntimeAgentEventListener } from "../../src/agents/runtime-agent-events.ts";
import { handleList, handleManagementAction } from "../../src/agents/agent-management.ts";
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

function makeEventBus(): ExtensionAPI["events"] {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const listeners = handlers.get(channel) ?? new Set();
			listeners.add(handler);
			handlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
	};
}

function makePiWithEvents(events: ExtensionAPI["events"]): ExtensionAPI {
	return { on() {}, registerTool() {}, events } as unknown as ExtensionAPI;
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

	it("accepts inheritGlobalContext in a runtime agent definition", () => {
		const registration = registerAgent({
			pi,
			name: "runtime-global-helper",
			definition: {
				description: "Runtime global helper",
				systemPrompt: "Help at runtime.",
				inheritProjectContext: true,
				inheritGlobalContext: true,
			},
		});

		const agents = mergeRuntimeAgents(pi, discoverAgents(tempProject, "both")).agents;
		const agent = agents.find((candidate) => candidate.name === "runtime-global-helper");
		assert.equal(agent?.inheritProjectContext, true);
		assert.equal(agent?.inheritGlobalContext, true);

		registration.dispose();
	});

	it("preserves excludeTools on runtime agents", () => {
		const registration = registerAgent({
			pi,
			name: "runtime-exclude-helper",
			definition: {
				description: "Runtime exclude helper",
				systemPrompt: "Help at runtime.",
				tools: ["read", "write"],
				excludeTools: ["write", "unknown_tool"],
			},
		});

		const agent = mergeRuntimeAgents(pi, discoverAgents(tempProject, "both")).agents.find((candidate) => candidate.name === "runtime-exclude-helper");
		assert.deepEqual(agent?.excludeTools, ["write", "unknown_tool"]);
		registration.dispose();
	});

	it("registers through the owner runtime when consumer and owner API objects differ", () => {
		const events = makeEventBus();
		const ownerPi = makePiWithEvents(events);
		const consumerPi = makePiWithEvents(events);
		const unsubscribe = registerRuntimeAgentEventListener(ownerPi);
		const registration = registerAgentViaEvents({
			pi: consumerPi,
			name: "runtime-event-helper",
			definition: { description: "Event helper", systemPrompt: "Help through the owner." },
		});

		assert.equal(mergeRuntimeAgents(ownerPi, discoverAgents(tempProject, "both")).agents.some((agent) => agent.name === "runtime-event-helper"), true);
		assert.equal(mergeRuntimeAgents(consumerPi, discoverAgents(tempProject, "both")).agents.some((agent) => agent.name === "runtime-event-helper"), false);
		assert.throws(
			() => registerAgentViaEvents({ pi: consumerPi, name: "runtime-event-helper", definition: { description: "Duplicate", systemPrompt: "Duplicate." } }),
			/collides with runtime agent 'runtime-event-helper'/,
		);

		registration.dispose();
		assert.equal(mergeRuntimeAgents(ownerPi, discoverAgents(tempProject, "both")).agents.some((agent) => agent.name === "runtime-event-helper"), false);
		unsubscribe();
		clearRuntimeAgentsForPi(ownerPi);
	});

	it("uses first-handler-wins semantics for duplicate owners", () => {
		const events = makeEventBus();
		const firstOwner = makePiWithEvents(events);
		const secondOwner = makePiWithEvents(events);
		const consumer = makePiWithEvents(events);
		const unsubscribeFirst = registerRuntimeAgentEventListener(firstOwner);
		const unsubscribeSecond = registerRuntimeAgentEventListener(secondOwner);

		const registration = registerAgentViaEvents({
			pi: consumer,
			name: "first-owner-agent",
			definition: { description: "First owner", systemPrompt: "Use the first owner." },
		});
		assert.equal(mergeRuntimeAgents(firstOwner, discoverAgents(tempProject, "both")).agents.some((agent) => agent.name === "first-owner-agent"), true);
		assert.equal(mergeRuntimeAgents(secondOwner, discoverAgents(tempProject, "both")).agents.some((agent) => agent.name === "first-owner-agent"), false);

		registration.dispose();
		unsubscribeFirst();
		unsubscribeSecond();
		clearRuntimeAgentsForPi(firstOwner);
		clearRuntimeAgentsForPi(secondOwner);
	});

	it("returns useful event registration errors and detects a missing owner", () => {
		const events = makeEventBus();
		const owner = makePiWithEvents(events);
		const consumer = makePiWithEvents(events);
		const unsubscribe = registerRuntimeAgentEventListener(owner);
		const unsupported = { version: 2, name: "bad-version", definition: {} } as unknown as RuntimeAgentRegistrationRequest;
		events.emit(RUNTIME_AGENT_REGISTER_EVENT, unsupported);
		assert.equal(unsupported.result?.ok, false);
		if (unsupported.result?.ok === false) assert.match(unsupported.result.error.message, /Unsupported runtime agent registration event version '2'/);

		const malformed = { version: 1, name: "bad-definition" } as unknown as RuntimeAgentRegistrationRequest;
		events.emit(RUNTIME_AGENT_REGISTER_EVENT, malformed);
		assert.equal(malformed.result?.ok, false);
		if (malformed.result?.ok === false) assert.match(malformed.result.error.message, /definition must be an object/i);
		unsubscribe();
		assert.throws(
			() => registerAgentViaEvents({ pi: consumer, name: "no-owner", definition: { description: "Missing", systemPrompt: "Missing." } }),
			/not installed, not ready, or does not support/,
		);
		const unsubscribeMalformed = events.on(RUNTIME_AGENT_REGISTER_EVENT, (raw) => {
			(raw as { result?: unknown }).result = {};
		});
		assert.throws(
			() => registerAgentViaEvents({ pi: consumer, name: "malformed-result", definition: { description: "Malformed", systemPrompt: "Malformed." } }),
			/malformed runtime agent registration result/,
		);
		unsubscribeMalformed();
		clearRuntimeAgentsForPi(owner);
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

	it("reports runtime agent model mappings by name and alias", () => {
		const registration = registerAgent({
			pi,
			name: "runtime-model-helper",
			definition: {
				description: "Runtime model helper",
				systemPrompt: "Help with model routing.",
				aliases: ["model-helper"],
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
				thinking: "high",
			},
		});
		try {
			const ctx = {
				cwd: tempProject,
				modelRegistry: {
					getAvailable: () => [
						{ provider: "openai", id: "gpt-5-mini" },
						{ provider: "anthropic", id: "claude-sonnet-4" },
					],
				},
				model: { provider: "openai", id: "gpt-5-mini" },
				runtimeAgentOwner: pi,
			};
			const all = handleManagementAction("models", {}, ctx);
			const allText = all.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n");
			assert.equal(all.isError, false);
			assert.match(allText, /runtime-model-helper\n  model:\n    openai\/gpt-5-mini\n  source: runtime agent config\n  thinking: high\n  fallback models:\n    anthropic\/claude-sonnet-4/);

			const filtered = handleManagementAction("models", { agent: "model-helper" }, ctx);
			const filteredText = filtered.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("\n");
			assert.equal(filtered.isError, false);
			assert.match(filteredText, /Agent: model-helper/);
			assert.match(filteredText, /Effective model:\n  openai\/gpt-5-mini/);
			assert.match(filteredText, /Source: runtime agent config/);
			assert.match(filteredText, /Fallback models:\n  anthropic\/claude-sonnet-4/);
		} finally {
			registration.dispose();
		}
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
