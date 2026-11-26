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
import { actionTopicKey, callNotes, createGuidedSubagentTool, EMPTY_CALL_TEXT, EVENT_NOTES, FIELDS_DECLARED_TEXT, formatGuide, nestedSubagentRequest, SUBAGENT_TOOL_DESCRIPTION, SUBAGENT_TOOL_FIELD_PARAMETERS, SUBAGENT_TOOL_PARAMETERS, type CallFacts } from "../../src/extension/guided-tool.ts";
import { flattenSubagentToolOptions } from "../../src/extension/subagent-options.ts";
import { readSubagentGuide } from "../../src/extension/subagent-guide.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";
import { createMockPi } from "../support/mock-pi.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Step = Record<string, unknown> | Array<Record<string, unknown>> | string;

const mockPi = createMockPi();
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions: Session[] = [];
let root: string;
let agentDir: string;

type RequestContext = { messages: Parameters<typeof getCurrentTools>[0] };

const UI_CONTEXT = {
	...Object.fromEntries(["select", "confirm", "input", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "custom", "pasteToEditor", "setEditorText", "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded", "notify"].map((name) => [name, () => undefined])),
	theme: new Proxy({}, { get: () => (...args: unknown[]) => String(args.at(-1) ?? "") }),
};

async function startParent(steps: Step[], onRequest?: (context: RequestContext) => void, provider = "guided-tool", ui = false): Promise<Session> {
	const faux = fauxProvider({ provider, models: [{ id: "local" }], tokensPerSecond: 100_000 });
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
	await session.bindExtensions(ui ? { uiContext: UI_CONTEXT as never } : {});
	sessions.push(session);
	return session;
}

function subagentReplies(session: Session): string[] {
	return (session.messages as Array<{ role: string; toolName?: string; content?: Array<{ text?: string }> }>)
		.filter((message) => message.role === "toolResult" && message.toolName === "subagent")
		.map((message) => (message.content ?? []).map((part) => part.text ?? "").join("\n"));
}

function subagentDetails(session: Session): Array<{ timeoutMs?: number }> {
	return (session.messages as Array<{ role: string; toolName?: string; details?: { timeoutMs?: number } }>)
		.filter((message) => message.role === "toolResult" && message.toolName === "subagent")
		.map((message) => message.details ?? {});
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
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
		assert.match(held!, /^Not launched yet: this is the session's first subagent call, so here is the guide\. Call again to launch\.\nWould launch probe, task "Inspect"\.\n\nsubagent guide\./);
		assert.match(first!, /Async: probe \[/);
		assert.ok(first!.includes(EVENT_NOTES.launch), first);
		assert.doesNotMatch(first!, /subagent guide\./, "the guide is not repeated");
		assert.ok(!second!.includes(EVENT_NOTES.launch), "the launch note appears once while it is in the chat");
		assert.match(second!, new RegExp(`⚠ Also running from ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: probe [0-9a-f]{8}\\.`));
		assert.ok(second!.includes("One writer per folder; readers, reviewers and worktree runs can share it."), second);
		assert.equal(mockPi.callCount(), 2);
	});

	it("gives default background launches and resumes no deadline with a UI, and 30 minutes without one", { timeout: 90_000 }, async () => {
		for (const ui of [true, false]) {
			mockPi.reset();
			mockPi.onCall({ output: "done" });
			mockPi.onCall({ output: "slow", delay: 20_000 });
			mockPi.onCall({ output: "slow", delay: 20_000 });
			const steps: Step[] = [{}, { agent: "probe", task: "Inspect", async: false }, { agent: "probe", task: "Background", async: true }, "launched"];
			const session = await startParent(steps, undefined, "guided-tool", ui);
			await session.prompt("go");
			const id = /\nRun ([0-9a-f]{8}) is done\./.exec(subagentReplies(session)[1]!)?.[1];
			assert.ok(id, subagentReplies(session)[1]);
			steps.push({ action: "resume", id, message: "More" }, "resumed");
			await session.prompt("go");
			const [, , launched, resumed] = subagentDetails(session);
			assert.deepEqual([launched?.timeoutMs, resumed?.timeoutMs], ui ? [undefined, undefined] : [1_800_000, 1_800_000], subagentReplies(session).join("\n---\n"));
		}
	});

	it("keeps the agent's own timeoutMs when a run is resumed, with or without a UI", { timeout: 90_000 }, async () => {
		fs.writeFileSync(path.join(agentDir, "agents", "timed.md"), "---\nname: timed\ndescription: Timed\ntools: read\ntimeoutMs: 7200000\ndefaultContext: fresh\n---\nDo the task.\n");
		for (const ui of [true, false]) {
			mockPi.reset();
			mockPi.onCall({ output: "done" });
			mockPi.onCall({ output: "slow", delay: 20_000 });
			const steps: Step[] = [{}, { agent: "timed", task: "Inspect", async: false }, "ran"];
			const session = await startParent(steps, undefined, "guided-tool", ui);
			await session.prompt("go");
			const id = /\nRun ([0-9a-f]{8}) is done\./.exec(subagentReplies(session)[1]!)?.[1];
			assert.ok(id, subagentReplies(session)[1]);
			steps.push({ action: "resume", id, message: "More" }, "resumed");
			await session.prompt("go");
			assert.equal(subagentDetails(session)[2]?.timeoutMs, 7_200_000, subagentReplies(session)[2]);
		}
	});

	it("names a foreground run's id with the call that resumes it", { timeout: 60_000 }, async () => {
		mockPi.reset();
		mockPi.onCall({ output: "done" });
		const steps: Step[] = [{}, { agent: "probe", task: "Inspect", async: false }, "ran"];
		const session = await startParent(steps);
		await session.prompt("go");
		const ran = subagentReplies(session)[1]!;
		const id = /\nRun ([0-9a-f]{8}) is done\. To continue it: subagent\(\{action:"resume", id:"\1", message\}\)/.exec(ran)?.[1];
		assert.ok(id, ran);
		assert.ok(!ran.includes(EVENT_NOTES.launch), "a finished foreground run gets no detached-run advice");
		steps.push({ action: "resume", id, message: "More", async: false }, "resumed");
		await session.prompt("go");
		assert.equal(mockPi.callCount(), 2, "the named id resumes the run");
		assert.doesNotMatch(subagentReplies(session)[2]!, /not found|unknown/i);
	});

	it("stops or interrupts a list of ids in one call, one line per entry", { timeout: 90_000 }, async () => {
		mockPi.reset();
		mockPi.onCall({ output: "slow", delay: 20_000 });
		const steps: Step[] = [{}, { agent: "probe", task: "Live", async: true }, { agent: "probe", task: "Ended", async: true }];
		let live = "";
		let ended = "";
		const session = await startParent(steps, (context) => {
			if (live || steps.length > 0) return;
			const texts = (context.messages as Array<{ role: string; content?: Array<{ text?: string }> }>).filter((message) => message.role === "toolResult").map((message) => (message.content ?? []).map((part) => part.text ?? "").join("\n"));
			[live, ended] = texts.flatMap((text) => /Async: probe \[([^\]]+)\]/.exec(text)?.[1] ?? []);
			steps.push({ action: "stop", id: ended }, { action: "wait", id: ended }, { action: "stop", id: [live, ended, "x9-missing"] }, { action: "interrupt", args: { id: JSON.stringify([ended, "x9-missing"]) } }, { action: "stop", id: "[x1,x2]" }, "stopped");
		});
		await session.prompt("go");
		const [stopped, interrupted, malformed] = subagentReplies(session).slice(-3);
		assert.equal(stopped, `Stop requested for async run ${live}.\nNo running or queued async run was found for '${ended}'.\nNo stoppable async run found for 'x9-missing'.`);
		assert.equal(interrupted, `No running async run with an interrupt-capable pid was found for '${ended}'.\nNo interrupt-capable run found for 'x9-missing'.`);
		assert.match(malformed!, /subagent: 'stop' takes id as one run id or a list of run ids\./);
	});

	it("teaches one lookup call that answers an action, a subject or a wrong guess", { timeout: 60_000 }, async () => {
		const session = await startParent([{}, { action: "guide", topic: "schedule" }, { action: "guide", topic: "workflows" }, { action: "guide", topic: "nope" }, "done"]);
		await session.prompt("go");
		const [guide, action, subject, wrong] = subagentReplies(session);
		assert.match(guide!, /^- unsure\? \{action:"guide", topic:"<action, family or subject, e\.g\. workflows>"\}; a wrong guess lists topics$/m);
		assert.match(action!, /^schedule\.create: name or id/);
		assert.match(subject!, /^Sections of guide topic 'workflows'\./m);
		assert.match(wrong!, /^Unknown subagents guide topic 'nope'\. Valid topics: overview, workflows, /);
	});

	it("accepts a list id from a provider that gets declared fields", { timeout: 60_000 }, async () => {
		const session = await startParent([{}, { action: "stop", id: ["x1", "x2"] }, "stopped"], undefined, "xai");
		await session.prompt("go");
		assert.equal(subagentReplies(session)[1], "No stoppable async run found for 'x1'.\nNo stoppable async run found for 'x2'.");
	});

	it("refuses a blanked number field from a provider that gets declared fields, instead of launching with it", { timeout: 60_000 }, async () => {
		const session = await startParent([{}, { agent: "probe", task: "Inspect", timeoutMs: true }, { workflow: "parallel", args: { tasks: [{ agent: "probe", task: "Inspect" }] }, timeoutMs: true }, "done"], undefined, "xai");
		await session.prompt("go");
		const [, reply, workflowReply] = subagentReplies(session);
		assert.match(reply, /'timeoutMs' must be a number, not true\. If your fields arrive missing or changed, pass them inside args/);
		assert.doesNotMatch(reply, /Async:|Run [0-9a-f]{8}/);
		assert.match(workflowReply!, /'timeoutMs' must be a number, not true\. For a workflow call, set timeoutMs on each child in a workflow: true script\./);
		assert.doesNotMatch(workflowReply!, /inside args|Async/);
	});

	const listTool = (answer: boolean) => {
		const prompts: string[] = [];
		const pi = { on: () => {} };
		const authorityPolicy = { stopRun: "confirm" } as const;
		const executor = createSubagentExecutor({
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
			state: createChildSafeState(),
			config: { maxSubagentDepth: 2, control: {}, intercomBridge: {}, authorityPolicy } as never,
			asyncByDefault: false,
			tempArtifactsDir: os.tmpdir(),
			getSubagentSessionRoot: () => os.tmpdir(),
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		const ui = { confirm: async (title: string) => { prompts.push(title); return answer; } };
		const sessionManager = { getSessionId: () => "session", getSessionFile: () => null, buildContextEntries: () => [{ type: "message", message: { role: "toolResult", details: { taught: ["guide"] } } }] };
		const ctx = { cwd: root, hasUI: true, ui, sessionManager, modelRegistry: { getAvailable: () => [] } };
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => ({ text: "GUIDE" }),
			flatten: (params) => flattenSubagentToolOptions(params),
			authorityPolicy,
			run: (id, request, _nested, signal, onUpdate, runCtx) => executor.execute(id, request, signal ?? new AbortController().signal, onUpdate, runCtx),
		});
		const call = async (params: Record<string, unknown> = { action: "stop", id: ["a1", "b2"] }) => {
			const result = await tool.execute("stop", params as never, undefined, undefined, ctx as never);
			return { text: result.content.map((part) => part.type === "text" ? part.text : "").join("\n"), isError: result.isError === true };
		};
		return { prompts, call };
	};

	it("asks once, naming the ids, before stopping a list under a confirm policy", async () => {
		const approved = listTool(true);
		await assert.rejects(approved.call(), { message: "No stoppable async run found for 'a1'.\nNo stoppable async run found for 'b2'." });
		assert.deepEqual(approved.prompts, ["Authorize subagent stop of a1, b2?"]);
		const declined = listTool(false);
		assert.deepEqual(await declined.call(), { text: "Action 'stop' canceled; authority was not granted.", isError: false });
		assert.deepEqual(declined.prompts, ["Authorize subagent stop of a1, b2?"]);
	});

	it("skips the rest of a list once the call is cancelled", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const sessionManager = { buildContextEntries: () => [{ type: "message", message: { role: "toolResult", details: { taught: ["guide"] } } }] };
		const { tool } = createGuidedSubagentTool({ on: () => {} } as never, {
			guide: async () => ({ text: "GUIDE" }),
			flatten: (params) => flattenSubagentToolOptions(params),
			run: async (_id, request) => {
				ran.push(String(request.id));
				controller.abort();
				return { content: [{ type: "text", text: `Stop requested for async run ${request.id}.` }], details: { mode: "management", results: [] } };
			},
		});
		const result = await tool.execute("stop", { action: "stop", id: ["a1", "b2", "c3"] } as never, controller.signal, undefined, { cwd: os.tmpdir(), hasUI: false, sessionManager } as never);
		assert.deepEqual(ran, ["a1"]);
		assert.equal(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"), "Stop requested for async run a1.\nb2: skipped, the call was cancelled.\nc3: skipped, the call was cancelled.");
	});

	it("refuses a list in id next to runId or dir, or with an entry containing spaces", async () => {
		const { prompts, call } = listTool(true);
		await assert.rejects(call({ action: "stop", id: ["a1", "b2"], runId: "zz-other" }), { message: "subagent: a list in id can't be combined with runId; put every target in id." });
		await assert.rejects(call({ action: "stop", id: ["a1", "b2"], dir: "/tmp/run" }), { message: "subagent: a list in id can't be combined with dir; put every target in id." });
		await assert.rejects(call({ action: "stop", id: ["a1", "b2?\nAuthorize something else"] }), { message: "subagent: 'stop' takes id as one run id or a list of run ids." });
		assert.deepEqual(prompts, []);
	});

	it("gives a detached foreground run the launch note and a paused one the resume call", async () => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "toolResult", details: { taught: ["guide"] } } }] } };
		const launch = async (run: Record<string, unknown>) => {
			const { tool } = createGuidedSubagentTool(pi as never, {
				guide: async () => ({ text: "GUIDE" }),
				flatten: (params) => flattenSubagentToolOptions(params),
				run: async () => ({ content: [{ type: "text", text: "child reply" }], details: { mode: "single", runId: "abcdef12-3456", results: [run as never] } }),
				notes: (request, result) => callNotes(request, result, {}),
			});
			const result = await tool.execute("launch", { agent: "probe", task: "t", async: false } as never, undefined, undefined, ctx as never);
			return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
		};
		const detached = await launch({ agent: "probe", detached: true });
		assert.ok(detached.includes(EVENT_NOTES.launch), detached);
		assert.doesNotMatch(detached, /resume/);
		assert.match(await launch({ agent: "probe", interrupted: true }), /\nRun abcdef12 is paused\. To continue it: subagent\(\{action:"resume", id:"abcdef12", message\}\)$/);
	});

	it("refuses multi-line workflow text on the first call with the guide instead of holding it", async () => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [] } };
		const { tool } = createGuidedSubagentTool(pi as never, { guide: async () => ({ text: "GUIDE" }), flatten: (params) => flattenSubagentToolOptions(params), run: async () => assert.fail("refused") });
		const result = await tool.execute("script-text", { workflow: "const r = await runs.run(\"scan\", { agent: \"scout\", task: \"Read /Users/someone/repo/src/index.ts\" });\nreturn r.output;" } as never, undefined, undefined, ctx as never);
		const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
		assert.match(text, /^subagent: workflow has line breaks, so it is script text; pass it as options\.script/);
		assert.match(text, /\n\nGUIDE$/);
		assert.doesNotMatch(text, /Call again to launch|Would launch/);
	});

	it("previews a chain's parallel step in plain words", async () => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [] } };
		const { tool } = createGuidedSubagentTool(pi as never, { guide: async () => ({ text: "GUIDE" }), flatten: (params) => params, run: async () => assert.fail("held") });
		const held = await tool.execute("chain", { chain: [{ agent: "scout" }, { parallel: [{ agent: "reviewer" }] }], task: "Check" } as never, undefined, undefined, ctx as never);
		assert.match(held.content[0]!.type === "text" ? held.content[0]!.text : "", /\nWould launch a chain: scout → parallel step, task "Check"\.\n/);
	});

	const launchesWith = async (facts: (request: Record<string, unknown>) => CallFacts, launches: Array<Record<string, unknown>>) => {
		const pi = { on: () => {} };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [] } };
		const { tool } = createGuidedSubagentTool(pi as never, {
			guide: async () => ({ text: "GUIDE" }),
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
		const held = "Not launched yet: the guide came back in another subagent call of this same message. Read it, then call again to launch.";
		assert.equal(sibling, `${held}\nWould launch probe, task "Inspect".`);
		assert.equal(workflow, `${held} Repeat the call with its \`\`\`js workflow block in that reply.\nWould launch a \`\`\`js workflow block.`);
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
			guide: async () => ({ text: "GUIDE" }),
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
			guide: async () => ({ text: "GUIDE" }),
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
			guide: async () => ({ text: "GUIDE" }),
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
		assert.match(held.content[0]!.type === "text" ? held.content[0]!.text : "", /^Not launched yet[^\n]*\nWould launch probe, task "two"\.\n\nGUIDE$/);
	});

	it("keeps the guide's display summary out of the text the model gets", async () => {
		const summary = { tokens: 900, launch: ["subagent({agent, task, …})", "cwd"], manage: ["status"], agents: ["scout"] };
		const ctx = { cwd: root, sessionManager: { buildContextEntries: () => [] } };
		const { tool } = createGuidedSubagentTool({ on: () => {} } as never, {
			guide: async () => ({ text: "GUIDE", summary }),
			flatten: (params) => params,
			run: async () => assert.fail("held"),
		});
		const held = await tool.execute("id", { agent: "probe", task: "Review the auth changes" } as never, undefined, undefined, ctx as never);
		assert.deepEqual(held.content, [{ type: "text", text: "Not launched yet: this is the session's first subagent call, so here is the guide. Call again to launch.\nWould launch probe, task \"Review the auth changes\".\n\nGUIDE" }]);
		assert.deepEqual(held.details?.guide, summary);
		assert.equal(held.details?.heldLaunch, "Would launch probe, task \"Review the auth changes\".");
		const topic = await tool.execute("id", { action: "guide", topic: "schedule" } as never, undefined, undefined, ctx as never);
		assert.equal(topic.details?.guideTopic?.title, "schedule");
		assert.match(topic.details?.guideTopic?.lead ?? "", /^schedule\.create: name or id, /);
		assert.doesNotMatch(topic.details?.guideTopic?.lead ?? "", /Example:/);
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
			guide: async () => ({ text: "GUIDE" }),
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

	it("keeps both declarations within their caps, and the description and the guide with the bundled agents within 2,400", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-guide-size-"));
		process.env.PI_CODING_AGENT_DIR = empty;
		try {
			const agents = discoverAgents(empty, "both").agents;
			assert.ok(agents.some((agent) => agent.name === "scout"), "bundled agents are listed");
			const size = SUBAGENT_TOOL_DESCRIPTION.length + formatGuide(agents, { canLaunch: true }).length;
			assert.ok(size <= 2_400, `description + guide is ${size} chars`);
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
			fs.rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

	it("gives every accepted action guide text, and names only real actions in the guide", () => {
		for (const action of SUBAGENT_ACTIONS) assert.ok(action === "guide" || actionTopicKey(action), `${action} has no guide text`);
		const guide = formatGuide([{ name: "scout" }], { canLaunch: true });
		const named = (label: string) => new RegExp(`^- ${label}: (.+)$`, "m").exec(guide)![1]!.split(", ");
		for (const action of named("also")) assert.ok((SUBAGENT_ACTIONS as readonly string[]).includes(action), `guide names '${action}'`);
		for (const family of named("families")) assert.ok(SUBAGENT_ACTIONS.some((action) => action.startsWith(`${family}.`) || action === family), `guide names family '${family}'`);
		assert.match(guide, /\n\nAgents \(as of now; \{action:"list"\} refreshes\):\n- scout$/);
	});

	it("points the guide only at guide topics that exist, including the lanes section, and names the run deadline", () => {
		const guide = formatGuide([{ name: "scout" }], { canLaunch: true });
		const topics = [...guide.matchAll(/topic:"([^"<]+)"/g)].map((match) => match[1]!);
		assert.ok(topics.includes("workflows/parallel-sequential-lanes"), `guide topics: ${topics.join(", ")}`);
		for (const topic of topics) assert.doesNotMatch(readSubagentGuide(topic), /^Unknown/, topic);
		assert.match(guide, /^- timeoutMs: hard deadline in ms; with none \(call\/agent\/config\) a check-in wakes you every 30 min \(no UI: 30-min stop\)$/m);
	});
});
