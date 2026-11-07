import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { collapseSystemMessages, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseFactory, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { topLevelSupervisorTool } from "../../src/intercom/native-supervisor-channel.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import registerSubagentPromptRuntime, { applyForkSessionAffinity, modelBefore, projectForkRequest, stripParentOnlySubagentMessages, systemMessagesBefore } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";

const FORKED_AT = 1_000;
const tool = (name: string, description = `${name} tool`): Tool => ({ name, description, parameters: { type: "object", properties: {} } as never });
const system = (timestamp: number, change: { added?: Tool[]; removed?: string[]; content?: string; sections?: Record<string, string | null> }): SystemMessage => ({
	role: "system",
	content: change.content ?? "",
	timestamp,
	...(change.sections ? { sections: change.sections } : {}),
	...(change.added ? { toolsAdded: change.added } : {}),
	...(change.removed ? { toolsRemoved: change.removed.map((name) => ({ name })) } : {}),
} as SystemMessage);
const user = (timestamp: number, content = "task"): Message => ({ role: "user", content, timestamp });
const declared = (messages: Message[]) => getCurrentTools(messages).map((entry) => entry.name);
const subagentCalls = (messages: Message[]) => messages.flatMap((entry) => entry.role === "assistant" ? entry.content.filter((block) => block.type === "toolCall" && block.name === "subagent").map((block) => (block as { id: string }).id) : []);
const text = (message: Message | undefined) => typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
/** What a request sends when the session holds `messages`, which also stand for the session. */
const project = (messages: Message[], options: { session?: Message[]; boundary?: string } = {}) => projectForkRequest(messages, systemMessagesBefore(options.session ?? messages, FORKED_AT), FORKED_AT, { boundary: options.boundary });

/** A parent whose prompt declares a base text, a role section and tools, then a fork's own prompt and task. */
const parentHead = system(10, { content: "Parent base prompt.", sections: { preamble: "<preamble>parent</preamble>", tools: "<tools>a b c</tools>" }, added: [tool("a"), tool("b"), tool("c")] });
const forkSession = (): Message[] => [
	parentHead,
	user(20, "parent question"),
	system(FORKED_AT + 1, { sections: { tools: "<tools>a d</tools>", addendum: "<addendum>CHILD ROLE</addendum>" }, added: [tool("d")], removed: ["b", "c"] }),
	user(FORKED_AT + 2, "child task"),
];

describe("a forked child's requests", () => {
	it("start with the system messages the parent sent, and carry the child's instructions in its task message", () => {
		const messages = forkSession();

		const sent = project(messages, { boundary: "CHILD BOUNDARY" });

		assert.equal(sent[0], parentHead, "the inherited system message is sent as it was");
		assert.equal(sent[1], messages[1], "the inherited conversation is sent as it was");
		assert.equal(sent.filter((entry) => entry.role === "system" && entry.timestamp >= FORKED_AT && !entry.toolsAdded).length, 0, "the child's own prompt is not sent as a system message");
		const task = text(sent.at(-1));
		assert.match(task, /^<subagent_instructions>\n/);
		assert.match(task, /<addendum>CHILD ROLE<\/addendum>/);
		assert.match(task, /CHILD BOUNDARY\n<\/subagent_instructions>\n\nchild task$/);
		assert.match(task, /Tools you can call: a, d\./);
		assert.doesNotMatch(task, /<tools>/, "loadout sections are not repeated");
		assert.deepEqual(declared(messages), ["a", "d"], "Pi's own record restricts the child");
	});

	it("declare the parent's tools in its order, then the tools only the child has at the fork point", () => {
		const sent = project(forkSession());

		assert.deepEqual(declared(sent), ["a", "b", "c", "d"]);
		const additions = sent.filter((entry): entry is SystemMessage => entry.role === "system" && entry !== parentHead);
		assert.deepEqual(additions.map((entry) => ({ added: entry.toolsAdded?.map((added) => added.name), removed: entry.toolsRemoved, timestamp: entry.timestamp })), [{ added: ["d"], removed: undefined, timestamp: FORKED_AT }]);
		assert.equal(sent.indexOf(additions[0]!), 2, "after the inherited history, before the task");
	});

	it("add no system message when the child has no tool of its own", () => {
		const messages = [parentHead, user(20), system(FORKED_AT + 1, { removed: ["b"] }), user(FORKED_AT + 2)];

		const sent = project(messages);

		assert.deepEqual(sent.filter((entry) => entry.role === "system"), [parentHead]);
		assert.deepEqual(declared(sent), ["a", "b", "c"]);
	});

	it("keep the parent's declaration of a tool the child defines the same way", () => {
		const messages = [parentHead, user(20), system(FORKED_AT + 1, { added: [tool("b")], removed: ["b"] }), user(FORKED_AT + 2)];

		const sent = project(messages);

		assert.deepEqual(sent.filter((entry) => entry.role === "system"), [parentHead]);
		assert.equal(getCurrentTools(sent)[1], parentHead.toolsAdded![1]);
	});

	it("declare the child's own definition of a tool the parent defines differently", () => {
		const schema = (field: string) => ({ name: "structured_output", description: "Submit the result.", parameters: { type: "object", properties: { [field]: { type: "string" } }, required: [field] } as never });
		const parent = system(10, { added: [tool("a"), schema("verdict")] });
		const messages = [parent, user(20), system(FORKED_AT + 1, { added: [schema("summary")], removed: ["structured_output"] }), user(FORKED_AT + 2)];

		const sent = project(messages);

		assert.deepEqual(getCurrentTools(sent).find((entry) => entry.name === "structured_output")?.parameters, schema("summary").parameters, "the schema the child's tool checks");
		assert.deepEqual(declared(sent), ["a", "structured_output"]);
		const addition = sent.find((entry): entry is SystemMessage => entry.role === "system" && entry !== parent);
		assert.deepEqual(addition?.toolsRemoved, [{ name: "structured_output" }], "a changed definition is a removal and an addition, as Pi records it");
		assert.equal(sent.indexOf(addition!), 2, "at the fork point");
	});

	it("send the same leading message as the parent when Pi collapsed the request", () => {
		const session = forkSession();
		const collapsed = collapseSystemMessages({ messages: session }).messages;
		const parentCollapsed = collapseSystemMessages({ messages: session.slice(0, 2) }).messages;

		const sent = project(collapsed, { session });

		assert.deepEqual(sent[0], parentCollapsed[0], "the parent's own collapsed head");
		assert.equal(sent[1], collapsed[1], "the conversation is sent as it was");
		assert.match(text(sent.at(-1)), /<addendum>CHILD ROLE<\/addendum>/);
	});

	it("are the same for every fork of the same parent with the same instructions", () => {
		assert.deepEqual(project(forkSession(), { boundary: "B" }), project(forkSession(), { boundary: "B" }));
	});

	describe("in another folder than the parent", () => {
		/** A `project_context` section as Pi's system prompt builder writes it. */
		const projectContext = (files: Array<[string, string]>) => `<project_context>\n${["Project-specific instructions and guidelines:", ...files.map(([filePath, content]) => `<project_instructions path="${filePath}">\n${content}\n</project_instructions>`)].join("\n\n")}\n</project_context>`;
		const parentFiles: Array<[string, string]> = [["/home/me/.pi/agent/AGENTS.md", "Global rules."], ["/work/AGENTS.md", "Workspace rules."]];
		const session = (childFiles: Array<[string, string]>): Message[] => [
			system(10, { content: "Parent base prompt.", sections: { preamble: "<preamble>parent</preamble>", project_context: projectContext(parentFiles) }, added: [tool("a")] }),
			user(20, "parent question"),
			system(FORKED_AT + 1, { sections: { project_context: projectContext(childFiles) } }),
			user(FORKED_AT + 2, "child task"),
		];

		it("carry the project instruction files the parent's prompt lacks in the task message", () => {
			const task = text(project(session([...parentFiles, ["/work/repo/AGENTS.md", "Repo rules."], ["/work/repo/pkg/CLAUDE.md", "Package rules."]]), { boundary: "B" }).at(-1));

			assert.ok(task.includes([
				"Project instructions for your working folder, which the parent's prompt does not include:",
				"<project_instructions path=\"/work/repo/AGENTS.md\">\nRepo rules.\n</project_instructions>",
				"<project_instructions path=\"/work/repo/pkg/CLAUDE.md\">\nPackage rules.\n</project_instructions>",
			].join("\n\n")), task);
			assert.match(task, /<\/project_instructions>\n\nB\n<\/subagent_instructions>\n\nchild task$/);
			assert.doesNotMatch(task, /Global rules|Workspace rules|Project-specific instructions/, "the parent's own files are not repeated");
		});

		it("add nothing when the child has the parent's project instruction files", () => {
			const sameFiles = project(session(parentFiles), { boundary: "B" });
			const noFiles = project(session([]).filter((message) => message.timestamp !== FORKED_AT + 1), { boundary: "B" });

			assert.deepEqual(sameFiles.map(text), noFiles.map(text));
			assert.doesNotMatch(text(sameFiles.at(-1)), /project_instructions|Project instructions/);
		});
	});

	it("keep the instructions as a system section when the child has not written a user message", () => {
		const messages = [parentHead, user(20), system(FORKED_AT + 1, { sections: { addendum: "<addendum>CHILD ROLE</addendum>" } })];

		const sent = project(messages);

		assert.equal(sent[0], parentHead);
		assert.match((sent.at(-1) as SystemMessage).sections?.subagent_instructions ?? "", /CHILD ROLE/);
	});

	it("once a compaction in the child left no inherited message, send the child's own prompt with its boundary as a section", () => {
		const session = forkSession();
		const compacted = [system(FORKED_AT + 10, { content: "Child prompt.", added: [tool("a"), tool("d")] }), user(FORKED_AT + 10), user(FORKED_AT + 11)];

		assert.equal(project(compacted, { session }), compacted);
		const sent = project(compacted, { session, boundary: "CHILD BOUNDARY" });
		assert.equal(sent[0], compacted[0]);
		assert.match((sent[1] as SystemMessage).sections?.subagent_boundary ?? "", /CHILD BOUNDARY/);
		assert.deepEqual(sent.slice(2), compacted.slice(1));
	});
});

describe("a forked child's session-affinity header", () => {
	const anthropic = (compat?: Record<string, unknown>, id = "claude") => ({ api: "anthropic-messages", provider: "gateway", id, ...(compat ? { compat } : {}) }) as never;
	const reply = (timestamp: number, model: string) => ({ role: "assistant", content: [], api: "anthropic-messages", provider: "gateway", model, timestamp }) as unknown as Message;
	const parentModel = modelBefore([reply(30, "claude"), user(FORKED_AT + 1), reply(FORKED_AT + 2, "other")], FORKED_AT);

	it("names the parent session where Pi sends one", () => {
		const headers: Record<string, string> = {};
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" }), "parent-session", parentModel);
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }), "parent-session", parentModel);
		assert.deepEqual(headers, { "x-session-id": "parent-session", "x-session-affinity": "parent-session" });
	});

	it("adds nothing where Pi sends no session-affinity header", () => {
		const headers: Record<string, string> = {};
		applyForkSessionAffinity(headers, anthropic(), "parent-session", parentModel);
		applyForkSessionAffinity(headers, { api: "openai-responses", compat: { sendSessionAffinityHeaders: true } } as never, "parent-session", parentModel);
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }), undefined, parentModel);
		assert.deepEqual(headers, {});
	});

	it("keeps the child's own header when the child runs on another model than the one that wrote its inherited history", () => {
		const headers: Record<string, string> = { "x-session-affinity": "child-session" };
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }, "other"), "parent-session", parentModel);
		applyForkSessionAffinity(headers, anthropic({ sendSessionAffinityHeaders: true }), "parent-session", undefined);
		assert.deepEqual(headers, { "x-session-affinity": "child-session" });
	});
});

describe("a forked child session", () => {
	let root: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-tool-declarations-"));
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	});

	after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	});

	type Request = { tools: string[]; declarations: string; results: Message[]; messages: Message[] };

	type Launch = Partial<Parameters<typeof buildInProcessChildLaunch>[0]>;
	/** Runs a real SDK session on `sessionFile` and returns what each provider request declared. */
	async function run(options: { sessionFile: string; tools: string[]; replies: Array<ReturnType<typeof fauxAssistantMessage>>; forkCacheKey?: string; launch?: Launch; hooks?: Array<(pi: ExtensionAPI) => void> }): Promise<Request[]> {
		const faux = fauxProvider({ provider: "probe", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const requests: Request[] = [];
		faux.setResponses(options.replies.map((message): FauxResponseFactory => (context) => {
			const messages = context.messages as Message[];
			const declarations = JSON.stringify(getCurrentTools(messages).map(({ name, description, parameters }) => ({ name, description, parameters })));
			requests.push({ tools: declared(messages), declarations, results: messages.filter((entry) => entry.role === "toolResult"), messages });
			return message;
		}));
		const { session } = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "worker", childIndex: 0, sessionEnabled: true, sessionFile: options.sessionFile, waitToolEnabled: false,
			model: "probe/local", systemPrompt: "Role instructions.", systemPromptMode: "append", tools: options.tools,
			...(options.forkCacheKey ? { forkCacheKey: options.forkCacheKey } : {}),
			...options.launch,
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
		const hooks = [(pi: ExtensionAPI) => pi.registerProvider(faux.provider as never), ...options.hooks ?? []];
		const child = await factory.create({ ...session, hooks: [...session.hooks, ...hooks.map((hook, index) => ({ name: `probe-${index}`, factory: hook }))] });
		try {
			await child.prompt("Task");
		} finally {
			await child.dispose();
			await factory.dispose();
		}
		return requests;
	}

	async function forkOfParent(name: string, parent: { tools?: string[]; hooks?: Array<(pi: ExtensionAPI) => void> } = {}): Promise<{ forkFile: string; parentTools: string[]; parentDeclarations: string; parentSystem: Message[] }> {
		const parentFile = path.join(root, `${name}-parent.jsonl`);
		const [parentRequest] = await run({ sessionFile: parentFile, tools: parent.tools ?? ["read", "bash", "ls"], replies: [fauxAssistantMessage("done")], hooks: parent.hooks });
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const manager = SessionManager.open(parentFile, path.join(root, `${name}-forks`));
		// The parent launched this fork through `subagent` and got a notice from an earlier run.
		manager.appendMessage({ role: "custom", customType: "subagent-notify", content: "PARENT-NOTICE", display: false, timestamp: Date.now() } as never);
		manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "earlier" }, { id: "call_subagent_1" }), { stopReason: "toolUse" }), timestamp: Date.now() });
		manager.appendMessage({ role: "toolResult", toolCallId: "call_subagent_1", toolName: "subagent", content: [{ type: "text", text: "PARENT-SUBAGENT-RESULT" }], isError: false, timestamp: Date.now() } as never);
		manager.appendMessage({ ...fauxAssistantMessage(fauxToolCall("subagent", { agent: "worker", task: "this fork" }, { id: "call_subagent_2" }), { stopReason: "toolUse" }), timestamp: Date.now() });
		// A real fork comes after its parent's messages; keep them apart by more than a millisecond here.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const forkFile = manager.createBranchedSession(manager.getLeafId()!)!;
		return { forkFile, parentTools: parentRequest!.tools, parentDeclarations: parentRequest!.declarations, parentSystem: parentRequest!.messages.filter((entry) => entry.role === "system") };
	}

	const callBash = (marker: string) => [
		fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${JSON.stringify(marker)}` }, { id: "call_bash_1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("declares its parent's tools, and a call to one it lacks is an error that runs nothing", async () => {
		const { forkFile, parentTools } = await forkOfParent("fork");
		const marker = path.join(root, "fork-ran");

		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(marker), forkCacheKey: "pi-fork:test" });

		assert.ok(parentTools.includes("bash") && parentTools.includes("ls"));
		assert.equal(requests.length, 2);
		for (const request of requests) assert.deepEqual(request.tools.slice(0, parentTools.length), parentTools, "every request starts with the parent's tools, in its order");
		const result = (requests[1]!.results as Array<Message & { toolName?: string; isError?: boolean; content: Array<{ text?: string }> }>).find((entry) => entry.toolName === "bash");
		assert.equal(result!.isError, true);
		assert.match(result!.content[0]!.text ?? "", /Tool bash not found/);
		assert.equal(fs.existsSync(marker), false, "the parent-only tool never ran");
		const recorded = fs.readFileSync(forkFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message" && entry.message.role === "system").map((entry) => entry.message as SystemMessage);
		assert.ok(recorded.at(-1)!.toolsRemoved?.some((entry) => entry.name === "bash"), "the session keeps Pi's own record of the child's tools");
	});

	it("sends the history it inherited as the parent sent it, its system messages uncollapsed", async () => {
		const { forkFile } = await forkOfParent("history");

		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(path.join(root, "history-ran")), forkCacheKey: "pi-fork:test" });

		for (const { messages } of requests) {
			assert.deepEqual(subagentCalls(messages), ["call_subagent_1", "call_subagent_2"], "the parent's subagent calls, the pending one included");
			assert.ok(messages.some((entry) => entry.role === "toolResult" && entry.toolName === "subagent"), "the parent's subagent result");
			assert.match(JSON.stringify(messages), /PARENT-NOTICE/);
			assert.equal(messages.filter((entry) => entry.role === "system").length, 1, "only the parent's leading system message");
		}
	});

	it("sends its parent's system prompt unchanged and its own role in its task message", async () => {
		const { forkFile, parentSystem } = await forkOfParent("prompt");

		const requests = await run({
			sessionFile: forkFile, tools: ["read"], replies: [fauxAssistantMessage("done")], forkCacheKey: "pi-fork:test",
			launch: { systemPrompt: "FORK-ROLE instructions.", inheritProjectContext: false },
		});

		const { messages } = requests[0]!;
		assert.deepEqual(messages.filter((entry) => entry.role === "system"), parentSystem, "the parent's system prompt and tools, byte for byte");
		assert.doesNotMatch(JSON.stringify(parentSystem), /FORK-ROLE/);
		const task = messages.at(-1)!;
		assert.equal(task.role, "user");
		assert.match(JSON.stringify(task.content), /^\[\{"type":"text","text":"<subagent_instructions>\\n.*FORK-ROLE instructions\..*You are a child subagent.*<\/subagent_instructions>"\}/);
	});

	const supervised = { runId: "run-s3", orchestratorIntercomTarget: "parent-target", parentSessionId: "parent-session" };
	const callSupervisor = [
		fauxAssistantMessage(fauxToolCall("contact_supervisor", { reason: "progress_update", message: "halfway" }, { id: "call_supervisor_1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];
	const supervisorResult = (request: Request) => request.results.find((entry) => (entry as { toolName?: string }).toolName === "contact_supervisor") as (Message & { isError?: boolean; content: Array<{ text?: string }> }) | undefined;

	it("declares exactly its parent's tools when the parent declares contact_supervisor, and its own contact_supervisor works", async () => {
		const { forkFile, parentTools, parentDeclarations } = await forkOfParent("supervised", {
			tools: ["read", "bash", "ls", "contact_supervisor"],
			hooks: [(pi) => pi.registerTool(topLevelSupervisorTool())],
		});

		const requests = await run({ sessionFile: forkFile, tools: ["read", "contact_supervisor"], replies: callSupervisor, forkCacheKey: "pi-fork:test", launch: supervised });

		assert.ok(parentTools.includes("contact_supervisor"));
		for (const request of requests) assert.equal(request.declarations, parentDeclarations, "the same tools, order and definitions as the parent");
		const result = supervisorResult(requests[1]!);
		assert.notEqual(result!.isError, true);
		assert.equal(result!.content[0]!.text, "Supervisor progress update queued.");
	});

	it("keeps its working contact_supervisor in a background runner that loads this package as an ambient extension", async () => {
		const extensions = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions");
		fs.mkdirSync(extensions, { recursive: true });
		// This package's own entry point, loaded the way a runner child discovers an installed copy.
		const loaded = path.join(root, "ambient-loaded");
		fs.mkdirSync(path.join(extensions, "pi-subagents"));
		fs.writeFileSync(path.join(extensions, "pi-subagents", "index.ts"), [
			`import * as fs from "node:fs";`,
			`import registerSubagentExtension from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "..", "index.ts"))};`,
			`export default function (pi) { fs.writeFileSync(${JSON.stringify(loaded)}, "1"); return registerSubagentExtension(pi); }`,
		].join("\n"));
		const previous = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		try {
			const requests = await run({ sessionFile: path.join(root, "runner-child.jsonl"), tools: ["read", "contact_supervisor"], replies: callSupervisor, launch: { ...supervised, host: "runner" } });

			assert.ok(fs.existsSync(loaded), "the runner child loads this package's entry point");
			assert.equal(supervisorResult(requests[1]!)!.content[0]!.text, "Supervisor progress update queued.");
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = previous;
			fs.rmSync(extensions, { recursive: true, force: true });
		}
	});

	it("without a fork launch, declares only its own tools as before", async () => {
		const { forkFile } = await forkOfParent("plain");

		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(path.join(root, "plain-ran")) });

		assert.equal(requests[0]!.tools.includes("bash"), false);
		for (const { messages } of requests) {
			assert.deepEqual(subagentCalls(messages), []);
			assert.equal(messages.some((entry) => entry.role === "toolResult" && entry.toolName === "subagent"), false);
			assert.doesNotMatch(JSON.stringify(messages), /PARENT-NOTICE/);
		}
	});
});

describe("a child's context handler", () => {
	const contextHandler = (config: Partial<ChildRuntimeConfig>) => {
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		registerSubagentPromptRuntime({
			on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
			registerTool: () => {},
			events: { on: () => () => {} },
		} as never, { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false, ...config });
		const ctx = { model: { api: "anthropic-messages" }, sessionManager: { getHeader: () => ({ id: "fork", timestamp: new Date(FORKED_AT).toISOString() }), buildSessionProjection: () => ({ messages: [] }) } };
		return (messages: unknown[]) => (handlers.get("context_with_system")!({ messages }, ctx) as { messages: unknown[] } | undefined)?.messages ?? messages;
	};
	const notice = (timestamp: number) => ({ role: "custom", customType: "subagent-notify", content: "done", display: false, timestamp });
	const call = (timestamp: number) => ({ role: "assistant", content: [{ type: "toolCall", id: `call_${timestamp}`, name: "subagent", arguments: {} }], timestamp });
	const result = (timestamp: number) => ({ role: "toolResult", toolCallId: `call_${timestamp}`, toolName: "subagent", content: [], isError: false, timestamp });

	it("in a fork, strips only what the child itself added after the fork", () => {
		const inherited = [user(10), notice(20), call(30), result(40), call(50)];
		const own = [user(FORKED_AT + 1), notice(FORKED_AT + 2), call(FORKED_AT + 3), result(FORKED_AT + 4)];

		assert.deepEqual(contextHandler({ forkCacheKey: "pi-fork:test" })([...inherited, ...own]), [...inherited, own[0]]);
	});

	it("outside a fork, strips parent-only messages and subagent history as before, fanout or not", () => {
		const messages = [user(10), notice(20), call(30), result(40)];

		assert.deepEqual(contextHandler({})(messages), stripParentOnlySubagentMessages(messages));
		assert.deepEqual(contextHandler({})(messages), [messages[0]]);
		assert.deepEqual(contextHandler({ fanoutChild: true })(messages), [messages[0], messages[2], messages[3]]);
	});
});
