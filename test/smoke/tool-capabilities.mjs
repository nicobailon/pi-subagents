import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-tool-capabilities-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, ".pi", "agent");
process.env.PI_SUBAGENTS_TEMP_ROOT = path.join(root, "runs");
const { discoverAgents } = await import("../../src/agents/agents.ts");
const { handleManagementAction } = await import("../../src/agents/agent-management.ts");
const { buildInProcessChildLaunch } = await import("../../src/runs/shared/child-launch.ts");
const { createDefaultChildSessionFactory } = await import("../../src/runs/shared/child-session.ts");
const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
const sdk = await import("@earendil-works/pi-coding-agent");
const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => sdk });
const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
const project = path.join(root, "project");
fs.mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "agents"), { recursive: true });
fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "agents", "verify-reviewer.md"), "---\nname: verify-reviewer\ndescription: Tool capability smoke\ntools: read, contact_supervisor\n---\nReport missing tools to your supervisor.\n");
fs.writeFileSync(settingsPath, JSON.stringify({ packages: [], extensions: [] }));

function reviewer() {
	return discoverAgents(project, "user").agents.find(agent => agent.name === "verify-reviewer");
}

async function runChild(agent, enabled, denyExtensions = false) {
	let faux;
	let active;
	let gatewayCalls = 0;
	const launch = buildInProcessChildLaunch({
		host: "runner", sessionEnabled: false, cwd: project,
		childAgentName: agent.name, childIndex: 0, runId: `verify-${enabled}-${denyExtensions}`,
		...(denyExtensions ? { capabilityCeiling: { sources: ["smoke"], denyExtensions: true } } : {}),
		parentSessionId: "verify-parent", orchestratorIntercomTarget: "verify-parent",
		model: "tool-smoke/local", tools: agent.tools, extensions: [],
		inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
	});
	launch.session.hooks.push({ name: "tool-smoke-provider", factory(pi) {
		faux = fauxProvider({ provider: "tool-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
		faux.setResponses([
			fauxAssistantMessage({ type: "toolCall", id: "smoke-call", name: enabled ? "mcp" : "contact_supervisor", arguments: enabled ? {} : {
				reason: "need_decision", missingTools: ["mcp"], message: "Independent research requires MCP.",
			} }),
			fauxAssistantMessage("verified"),
		]);
		pi.registerProvider(faux.provider);
		pi.registerTool({ name: "mcp", label: "MCP fixture", description: "Read-only local gateway fixture", parameters: { type: "object", properties: {} },
			async execute() { gatewayCalls++; return { content: [{ type: "text", text: "gateway called in child" }] }; },
		});
		pi.on("session_start", () => { active = pi.getActiveTools(); });
	} });
	const errors = [];
	const child = await factory.create({ ...launch.session, onExtensionError: error => errors.push(String(error.error)) });
	try {
		assert.equal(active.includes("mcp"), enabled);
		const completion = child.prompt("Exercise the configured tool contract.");
		completion.catch(() => {});
		if (!enabled) {
			const requests = path.join(launch.config.supervisorChannelDir, "requests");
			const deadline = Date.now() + 10000;
			let files = [];
			while (files.length === 0 && Date.now() < deadline) {
				files = fs.readdirSync(requests);
				if (files.length === 0) await delay(20);
			}
			assert.equal(files.length, 1, `Expected a supervisor request; errors: ${errors.join("; ")}`);
			const request = JSON.parse(fs.readFileSync(path.join(requests, files[0]), "utf8"));
			assert.match(request.message, /mcp: absent from the agent's strict tools allowlist/);
			if (denyExtensions) assert.match(request.message, /inherited capability ceiling denies extensions/);
			assert.match(request.message, /subagent\(\{action:"get",agent:"verify-reviewer"\}\)/);
			assert.match(request.message, /resuming this child retains its tool contract/);
			fs.writeFileSync(path.join(launch.config.supervisorChannelDir, "replies", `${request.id}.json`), JSON.stringify({
				type: "subagent.supervisor.reply", requestId: request.id, createdAt: Date.now(), message: "Finish; a new child will use an MCP-capable profile.",
			}));
		}
		await completion;
		assert.equal(gatewayCalls, enabled ? 1 : 0);
		assert.deepEqual(errors, []);
	} finally {
		await child.abort();
		await child.dispose();
	}
}

try {
	await runChild(reviewer(), false);
	await runChild(reviewer(), false, true);
	fs.writeFileSync(settingsPath, JSON.stringify({ packages: [], extensions: [], subagents: { additionalTools: ["mcp", "mcp"] } }));
	const configured = reviewer();
	assert.equal(configured.tools.filter(name => name === "mcp").length, 1);
	await runChild(configured, true);
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "agents", "verify-explicit.md"), "---\nname: verify-explicit\ndescription: Explicit native runner\nrunner: {\"type\":\"pi\"}\ntools: read\n---\nInspect.\n");
	for (const scope of ["user", "both"]) {
		const explicit = discoverAgents(project, scope).agents.find(agent => agent.name === "verify-explicit");
		assert.ok(explicit.tools.includes("mcp"));
	}
	const update = handleManagementAction("update", { agent: "verify-reviewer", config: { description: "Updated description" } }, { cwd: project, modelRegistry: { getAvailable: () => [] } });
	assert.ok(!update.isError, JSON.stringify(update));
	assert.match(fs.readFileSync(configured.filePath, "utf8"), /tools: read, contact_supervisor\n/);
	fs.writeFileSync(settingsPath, JSON.stringify({ packages: [], extensions: [] }));
	assert.ok(!reviewer().tools.includes("mcp"));
	fs.writeFileSync(settingsPath, JSON.stringify({ packages: [], extensions: [], subagents: { additionalTools: ["mcp"] } }));
	fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "verify-reviewer": { excludeTools: ["mcp"] } } } }));
	const excluded = discoverAgents(project, "both").agents.find(agent => agent.name === "verify-reviewer");
	const launch = buildInProcessChildLaunch({ host: "runner", sessionEnabled: false, cwd: project, childAgentName: excluded.name, childIndex: 0,
		tools: excluded.tools, excludeTools: excluded.excludeTools, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
	assert.ok(!launch.toolPlan.effectiveToolAllowlist.includes("mcp"));
	console.log("PASS: real child reports missing MCP and extension-denial policy; a fresh child calls the gateway; explicit native profiles receive shared tools; unrelated edits do not persist them; exclusions remain effective.");
} finally {
	await factory.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}
