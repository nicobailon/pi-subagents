import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { loadConfig } from "../../src/extension/config.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { createGuidedSubagentTool, EMPTY_CALL_TEXT, EVENT_NOTES, formatGuide, nestedSubagentRequest, SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_PARAMETERS } from "../../src/extension/guided-tool.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { createMockPi } from "../support/mock-pi.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Step = Record<string, unknown> | Array<Record<string, unknown>> | string;

const mockPi = createMockPi();
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions: Session[] = [];
let root: string;
let agentDir: string;

/** A parent session on a scripted model: each step is one assistant message (subagent calls, or text). */
async function startParent(steps: Step[]): Promise<Session> {
	const faux = fauxProvider({ provider: "guided-tool", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 40 }, () => () => {
		const next = steps.shift() ?? "ok";
		if (typeof next === "string") return fauxAssistantMessage(next);
		const calls = Array.isArray(next) ? next : [next];
		return fauxAssistantMessage(calls.map((args) => fauxToolCall("subagent", args)), { stopReason: "toolUse" });
	}));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (pi) => pi.registerProvider(faux.provider)],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
	const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
	await session.bindExtensions({});
	sessions.push(session);
	return session;
}

/** The text of each subagent tool result, in order. */
function subagentReplies(session: Session): string[] {
	return (session.messages as Array<{ role: string; toolName?: string; content?: Array<{ text?: string }> }>)
		.filter((message) => message.role === "toolResult" && message.toolName === "subagent")
		.map((message) => (message.content ?? []).map((part) => part.text ?? "").join("\n"));
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-guided-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "agents", "probe.md"), "---\nname: probe\ndescription: Probe\ntools: read\ndefaultContext: fresh\n---\nDo the task.\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mockPi.install();
});

after(async () => {
	for (const session of sessions) {
		await (session.extensionRunner as { emit(event: unknown): Promise<void> }).emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	mockPi.uninstall();
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

describe("guide first", () => {
	it("holds a first launch with the guide, then launches, teaches the launch once and warns of a second run in the cwd", { timeout: 60_000 }, async () => {
		mockPi.reset();
		mockPi.onCall({ output: "done", delay: 3_000 });
		const launch = { agent: "probe", task: "Inspect", async: true };
		// The second launch comes in the same turn, before Pi drains the first run at agent_end.
		const session = await startParent([launch, "held", launch, launch, "launched"]);
		await session.prompt("go");
		assert.equal(mockPi.callCount(), 0, "a launch before the guide is in the chat does not start a child");
		await session.prompt("go");
		const [held, first, second] = subagentReplies(session);
		assert.match(held!, /^subagent guide\./);
		assert.match(held!, /- probe: Probe/);
		assert.match(held!, /Not launched yet: this is the session's first subagent call, so here is the guide\. Call again to launch\.$/);
		assert.match(first!, /Async: probe \[/);
		assert.ok(first!.includes(EVENT_NOTES.launch), first);
		assert.doesNotMatch(first!, /subagent guide\./, "the guide is not repeated");
		assert.ok(!second!.includes(EVENT_NOTES.launch), "the launch note appears once while it is in the chat");
		assert.match(second!, new RegExp(`⚠ Another run is live in ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. One writer per folder: if they could both edit, use worktree:true\\.`));
		assert.equal(mockPi.callCount(), 2);
	});

	it("holds every launch in the batch that brought the guide, with the workflow:true wording", { timeout: 60_000 }, async () => {
		mockPi.reset();
		const session = await startParent([[{}, { agent: "probe", task: "Inspect", async: true }, { workflow: true }], "held"]);
		await session.prompt("go");
		const [guide, sibling, workflow] = subagentReplies(session);
		assert.match(guide!, /^subagent guide\./);
		assert.equal(sibling, "Not launched yet: the guide came back in another subagent call of this same message. Read it, then call again to launch.");
		assert.equal(workflow, `${sibling} Repeat the call with its \`\`\`js workflow block in that reply.`);
		assert.equal(mockPi.callCount(), 0);
	});
});

describe("taught state", () => {
	it("answers an empty call with one line once the guide is in the chat", { timeout: 60_000 }, async () => {
		const session = await startParent([{}, "read", {}, "again"]);
		await session.prompt("go");
		await session.prompt("go");
		const [guide, empty] = subagentReplies(session);
		assert.match(guide!, /^subagent guide\./);
		assert.equal(empty, EMPTY_CALL_TEXT);
	});

	it("creates a schedule whose fields arrive only inside args", { timeout: 60_000 }, async () => {
		fs.writeFileSync(path.join(root, "nightly.js"), `return runs.run("main", { agent: "probe", task: "Check" });`);
		const session = await startParent([{}, { action: "schedule.create", args: { name: "nightly-args", workflow: "./nightly.js", every: "day", at: "09:00", timezone: "UTC" } }, { action: "schedule.list" }, "done"]);
		await session.prompt("go");
		const [, created, listed] = subagentReplies(session);
		assert.doesNotMatch(created!, /error|requires|unknown field/i, created);
		assert.match(listed!, /nightly-args/);
	});

	it("keeps args as script input when the call has a top-level workflow (schedule.create, validate)", { timeout: 60_000 }, async () => {
		fs.writeFileSync(path.join(root, "backlog.js"), `return runs.run("main", { agent: "probe", task: args.task });`);
		// docs/missions.md: a fixed recurring workflow from a script file.
		const session = await startParent([{}, { action: "schedule.create", id: "backlog", workflow: "./backlog.js", args: { task: "Maintain core" }, options: { every: "6h", catchUp: "latest" } }, { action: "validate", workflow: "./backlog.js", args: { task: "review" } }, { action: "schedule.list" }, "done"]);
		await session.prompt("go");
		const [, created, validated, listed] = subagentReplies(session);
		assert.doesNotMatch(created!, /does not accept direct agent, task|requires|unknown field/i, created);
		assert.doesNotMatch(validated!, /does not accept direct agent, task|cannot be combined/i, validated);
		assert.match(listed!, /backlog/);
	});

	it("returns a first call's error with the guide taught, so tree navigation does not hold the next launch", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
		let entries: unknown[] = [];
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => entries } };
		const runs: unknown[] = [];
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => "GUIDE",
			flatten: (params) => flattenSubagentToolOptions(params),
			run: async (_id, request) => { runs.push(request); return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [] } }; },
		});
		const call = (params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, ctx as never);
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		const failed = await call({ agent: "probe", task: "one", bogus: 1 });
		assert.equal(failed.isError, true);
		assert.deepEqual(failed.details?.taught, ["guide"]);
		assert.match(failed.content[0]!.type === "text" ? failed.content[0]!.text : "", /unknown field 'bogus'[^]*GUIDE$/);
		entries = [{ type: "message", message: { role: "toolResult", details: failed.details } }];
		for (const handler of handlers.get("session_tree") ?? []) handler({}, ctx);
		await call({ agent: "probe", task: "two" });
		assert.equal(runs.length, 1, "the launch after tree navigation runs");
	});

	it("shows the guide again once compaction removed it from the chat", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
		let entries: unknown[] = [];
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => entries } };
		const runs: unknown[] = [];
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => "GUIDE",
			flatten: (params) => params,
			run: async (_id, request) => { runs.push(request); return { content: [{ type: "text", text: "launched" }], details: { mode: "single", results: [] } }; },
		});
		const call = (params: Record<string, unknown>) => tool.execute("id", params as never, undefined, undefined, ctx as never);
		for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		const guide = await call({});
		assert.deepEqual(guide.details?.taught, ["guide"]);
		entries = [{ type: "message", message: { role: "toolResult", details: guide.details } }];
		await call({ agent: "probe", task: "one" });
		assert.equal(runs.length, 1);
		// Compaction summarized the guide away.
		entries = [];
		for (const handler of handlers.get("session_compact") ?? []) handler({}, ctx);
		const held = await call({ agent: "probe", task: "two" });
		assert.equal(runs.length, 1, "the launch after compaction is held");
		assert.match(held.content[0]!.type === "text" ? held.content[0]!.text : "", /^GUIDE\n\nNot launched yet/);
	});
});

describe("guided tool surface", () => {
	it("keeps the declaration within 650 chars, and the description and the guide with the bundled agents within 2,100", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-guide-size-"));
		process.env.PI_CODING_AGENT_DIR = empty;
		try {
			const agents = discoverAgents(empty, "both").agents;
			assert.ok(agents.some((agent) => agent.name === "scout"), "bundled agents are listed");
			const size = SUBAGENT_TOOL_DESCRIPTION.length + formatGuide(agents, { canLaunch: true }).length;
			assert.ok(size <= 2_100, `description + guide is ${size} chars`);
			assert.deepEqual(Object.keys(SUBAGENT_TOOL_PARAMETERS.properties), ["action", "agent", "task", "id", "message", "cwd", "context", "model", "output", "label", "worktree", "workflow", "args", "topic"]);
			assert.equal(SUBAGENT_TOOL_PARAMETERS.additionalProperties, true);
			const declaration = JSON.stringify({ name: "subagent", description: SUBAGENT_TOOL_DESCRIPTION, parameters: SUBAGENT_TOOL_PARAMETERS }).length;
			assert.ok(declaration <= 650, `declaration is ${declaration} chars`);
		} finally {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	it("fails config loading on a removed setting, naming what replaces it", () => {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ waitTool: { enabled: true } }));
		try {
			assert.throws(() => loadConfig(), /config\.waitTool was removed: waiting is subagent\(\{action:"wait"\}\); remove the key\./);
		} finally {
			fs.rmSync(configPath);
		}
	});

	it("runs a script's launch async and refuses a script's wait", () => {
		assert.deepEqual(nestedSubagentRequest({ agent: "probe", task: "t" }, undefined), { agent: "probe", task: "t", async: true });
		assert.equal(nestedSubagentRequest({ action: "wait", id: "r-1" }, undefined), "subagent action 'wait' cannot run from a codemode script: the completion notice wakes the session; end the script.");
	});
});
