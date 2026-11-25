import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { loadConfig } from "../../src/extension/config.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { callNotes, createGuidedSubagentTool, EMPTY_CALL_TEXT, EVENT_NOTES, FIELDS_DECLARED_TEXT, formatGuide, nestedSubagentRequest, SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_FIELD_PARAMETERS, SUBAGENT_TOOL_PARAMETERS, type CallFacts } from "../../src/extension/guided-tool.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { createMockPi } from "../support/mock-pi.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Step = Record<string, unknown> | Array<Record<string, unknown>> | string;

const mockPi = createMockPi();
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions: Session[] = [];
let root: string;
let agentDir: string;

type RequestContext = { messages: Parameters<typeof getCurrentTools>[0] };

async function startParent(steps: Step[], onRequest?: (context: RequestContext) => void): Promise<Session> {
	const faux = fauxProvider({ provider: "guided-tool", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 40 }, () => (context: RequestContext) => {
		onRequest?.(context);
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
		const session = await startParent([launch, "held", launch, launch, "launched"]);
		await session.prompt("go");
		assert.equal(mockPi.callCount(), 0, "a launch before the guide is in the chat does not start a child");
		await session.prompt("go");
		const [held, first, second] = subagentReplies(session);
		assert.match(held!, /- probe: Probe/);
		assert.match(held!, /^Not launched yet: this is the session's first subagent call, so here is the guide\. Call again to launch\.\n\nsubagent guide\./);
		assert.match(first!, /Async: probe \[/);
		assert.ok(first!.includes(EVENT_NOTES.launch), first);
		assert.doesNotMatch(first!, /subagent guide\./, "the guide is not repeated");
		assert.ok(!second!.includes(EVENT_NOTES.launch), "the launch note appears once while it is in the chat");
		assert.match(second!, new RegExp(`⚠ Also running from ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: probe [0-9a-f]{8}\\.`));
		assert.ok(second!.includes("One writer per folder; readers, reviewers and worktree runs can share it."), second);
		assert.equal(mockPi.callCount(), 2);
	});

	const launchesWith = async (facts: (request: Record<string, unknown>) => CallFacts, launches: Array<Record<string, unknown>>) => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [] } };
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => "GUIDE",
			flatten: (params) => flattenSubagentToolOptions(params),
			run: async () => ({ content: [{ type: "text", text: "Async: worker [r-1]" }], details: { mode: "single", results: [] } }),
			notes: (request, result) => callNotes(request, result, facts(request as Record<string, unknown>)),
		});
		await tool.execute("guide", {} as never, undefined, undefined, ctx as never);
		const replies: string[] = [];
		for (const params of launches) {
			const result = await tool.execute("launch", params as never, undefined, undefined, ctx as never);
			replies.push(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
		}
		return replies;
	};

	it("lists the runs in the same folder on every launch and teaches the one-writer lesson once", async () => {
		const replies = await launchesWith(() => ({ liveRunsInCwd: { cwd: "/repo", runs: [{ label: "worker", id: "abcd1234" }, { label: "reviewer", id: "ef567890" }] } }), [
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
		]);
		const lesson = "One writer per folder; readers, reviewers and worktree runs can share it.";
		for (const reply of replies) assert.ok(reply.includes("⚠ Also running from /repo: worker abcd1234, reviewer ef567890."), reply);
		assert.ok(replies[0]!.includes(lesson), replies[0]);
		assert.ok(!replies[1]!.includes(lesson), "the lesson comes once per session");
	});

	it("warns once per writer agent given a toolBudget", async () => {
		const replies = await launchesWith((request) => ({ cappedWriter: request.agent as string }), [
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
			{ agent: "fixer", task: "three" },
		]);
		const warning = (name: string) => `⚠ ${name} is a writer (acceptanceRole: writer) with a toolBudget; a capped writer may stop mid-edit. Launch writers without toolBudget.`;
		assert.ok(replies[0]!.includes(warning("worker")), replies[0]);
		assert.ok(!replies[1]!.includes(warning("worker")), "the same writer is warned once");
		assert.ok(replies[2]!.includes(warning("fixer")), replies[2]);
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
		const scripted = await startParent([{ async: true, options: { script: `return runs.run("one", { agent: "probe", task: "Inspect" });` } }, "held"]);
		await scripted.prompt("go");
		assert.match(subagentReplies(scripted)[0]!, /^Not launched yet: this is the session's first subagent call[^]*\n\nsubagent guide\./);
		assert.equal(mockPi.callCount(), 0);
	});
});

describe("taught state", () => {
	it("reads a reply's fields from args when workflow is a placeholder", async () => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "toolResult", details: { taught: ["guide"] } } }] } };
		const runs: Array<Record<string, unknown>> = [];
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => "GUIDE",
			flatten: (params) => flattenSubagentToolOptions(params),
			run: async (_id, request) => { runs.push(request as Record<string, unknown>); return { content: [{ type: "text", text: "replied" }], details: { mode: "management", results: [] } }; },
		});
		await tool.execute("id", { action: "reply", workflow: "null", args: { replyTo: "q-1", message: "Use option A" } } as never, undefined, undefined, ctx as never);
		assert.deepEqual(runs, [{ action: "reply", replyTo: "q-1", message: "Use option A" }]);
	});

	it("declares the main fields after a blank call on a provider that blanks them, then launches", { timeout: 60_000 }, async () => {
		mockPi.reset();
		mockPi.onCall({ output: "done" });
		const declared: number[] = [];
		const fieldCount = (context: RequestContext) => {
			const subagent = getCurrentTools(context.messages).find((tool) => tool.name === "subagent") as { parameters?: { properties?: object } } | undefined;
			declared.push(Object.keys(subagent?.parameters?.properties ?? {}).length);
		};
		const session = await startParent([{}, "read", { agent: true, task: true }, { agent: "probe", task: "Inspect", async: false }, "launched"], fieldCount);
		await session.prompt("go");
		await session.prompt("go");
		const [guide, blank, launched] = subagentReplies(session);
		assert.match(guide!, /^subagent guide\./);
		assert.equal(blank, FIELDS_DECLARED_TEXT);
		assert.match(launched!, /done/);
		assert.equal(mockPi.callCount(), 1, "the next real launch runs");
		assert.equal(declared[0], 0, "a provider not on the known list starts with no declared fields");
		assert.equal(declared.at(-1), 14, "after the blank call the tool declares its 14 main fields");
		const again = await startParent([{}, "read", {}, "again"]);
		await again.prompt("go");
		await again.prompt("go");
		assert.equal(subagentReplies(again)[1], EMPTY_CALL_TEXT, "the same model already needs fields in this process");
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
		entries = [];
		for (const handler of handlers.get("session_compact") ?? []) handler({}, ctx);
		const held = await call({ agent: "probe", task: "two" });
		assert.equal(runs.length, 1, "the launch after compaction is held");
		assert.match(held.content[0]!.type === "text" ? held.content[0]!.text : "", /^Not launched yet[^\n]*\n\nGUIDE$/);
	});
});

describe("guided tool surface", () => {
	const declaredTool = () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const declarations: number[] = [];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			registerTool: (tool: { parameters: { properties: object } }) => declarations.push(Object.keys(tool.parameters.properties).length),
		};
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => "GUIDE",
			flatten: (params) => flattenSubagentToolOptions(params),
			run: async () => ({ content: [{ type: "text", text: "ok" }], details: { mode: "management", results: [] } }),
		});
		pi.registerTool(tool as never);
		const emit = (name: string, event: unknown, ctx: unknown) => { for (const handler of handlers.get(name) ?? []) handler(event, ctx); };
		return { tool, declarations, emit };
	};

	it("declares no fields by default and the 14 main fields for a provider known to blank undeclared ones", () => {
		const anthropic = declaredTool();
		const session = { sessionManager: { buildContextEntries: () => [] } };
		anthropic.emit("session_start", {}, { ...session, model: { provider: "anthropic", id: "claude-opus-5-5" } });
		assert.deepEqual(anthropic.declarations, [0]);
		const xai = declaredTool();
		xai.emit("session_start", {}, { ...session, model: { provider: "xai", id: "grok-4.6" } });
		assert.deepEqual(xai.declarations, [0, 14]);
		xai.emit("model_select", { model: { provider: "anthropic", id: "claude-opus-5-5" } }, {});
		assert.deepEqual(xai.declarations, [0, 14, 0], "switching to a provider that keeps fields drops them again");
	});

	it("declares the fields at once when a resumed session recorded a blank call on its model", () => {
		const resumed = declaredTool();
		const entries = [{ type: "message", message: { role: "toolResult", details: { taught: ["guide", "fields:restarted/m"] } } }];
		resumed.emit("session_start", {}, { model: { provider: "restarted", id: "m" }, sessionManager: { buildContextEntries: () => entries } });
		assert.deepEqual(resumed.declarations, [0, 14]);
	});

	it("runs a workflow with empty input after the guide instead of treating it as blank", async () => {
		const { tool, declarations, emit } = declaredTool();
		const ctx = { cwd: root, model: { provider: "keeps-fields-2", id: "m" }, sessionManager: { buildContextEntries: () => [] } };
		emit("session_start", {}, ctx);
		await tool.execute("guide", {} as never, undefined, undefined, ctx as never);
		const result = await tool.execute("flow", { workflow: true, args: {} } as never, undefined, undefined, ctx as never);
		assert.notEqual(result.content[0]?.type === "text" ? result.content[0].text : "", EMPTY_CALL_TEXT);
		assert.notEqual(result.content[0]?.type === "text" ? result.content[0].text : "", FIELDS_DECLARED_TEXT);
		assert.deepEqual(declarations, [0]);
	});

	it("keeps the 0-field declaration when a later call is not blank", async () => {
		const { tool, declarations, emit } = declaredTool();
		const ctx = { cwd: root, model: { provider: "keeps-fields", id: "m" }, sessionManager: { buildContextEntries: () => [] } };
		emit("session_start", {}, ctx);
		await tool.execute("guide", {} as never, undefined, undefined, ctx as never);
		await tool.execute("list", { action: "list", agent: true } as never, undefined, undefined, ctx as never);
		assert.deepEqual(declarations, [0]);
		await tool.execute("again", {} as never, undefined, undefined, ctx as never);
		assert.deepEqual(declarations, [0]);
		await tool.execute("again-2", {} as never, undefined, undefined, ctx as never);
		assert.deepEqual(declarations, [0, 14]);
	});

	it("keeps both declarations within their caps, and the description and the guide with the bundled agents within 2,200", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-guide-size-"));
		process.env.PI_CODING_AGENT_DIR = empty;
		try {
			const agents = discoverAgents(empty, "both").agents;
			assert.ok(agents.some((agent) => agent.name === "scout"), "bundled agents are listed");
			const size = SUBAGENT_TOOL_DESCRIPTION.length + formatGuide(agents, { canLaunch: true }).length;
			assert.ok(size <= 2_200, `description + guide is ${size} chars`);
			assert.match(formatGuide(agents, { canLaunch: true }), /Not for messaging a Pi session that is already open; use a messaging tool for that\./);
			assert.doesNotMatch(formatGuide(agents, { canLaunch: true, child: true }), /messaging tool/);
			assert.deepEqual(SUBAGENT_TOOL_PARAMETERS, { type: "object", properties: {}, additionalProperties: true });
			assert.deepEqual(Object.keys(SUBAGENT_TOOL_FIELD_PARAMETERS.properties), ["action", "agent", "task", "id", "message", "cwd", "context", "model", "output", "label", "worktree", "workflow", "args", "topic"]);
			assert.equal(SUBAGENT_TOOL_FIELD_PARAMETERS.additionalProperties, true);
			const declared = (parameters: unknown) => JSON.stringify({ name: "subagent", description: SUBAGENT_TOOL_DESCRIPTION, parameters }).length;
			assert.ok(declared(SUBAGENT_TOOL_PARAMETERS) <= 240, `0-field declaration is ${declared(SUBAGENT_TOOL_PARAMETERS)} chars`);
			assert.ok(declared(SUBAGENT_TOOL_FIELD_PARAMETERS) <= 650, `14-field declaration is ${declared(SUBAGENT_TOOL_FIELD_PARAMETERS)} chars`);
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
