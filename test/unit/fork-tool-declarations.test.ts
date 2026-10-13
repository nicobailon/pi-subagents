import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseFactory, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { topLevelSupervisorTool } from "../../src/intercom/native-supervisor-channel.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import registerSubagentPromptRuntime, { keepInheritedToolDeclarations as keepInherited, stripParentOnlySubagentMessages, toolsDeclaredBefore } from "../../src/runs/shared/subagent-prompt-runtime.ts";
import type { ChildRuntimeConfig } from "../../src/runs/shared/child-runtime-config.ts";

const FORKED_AT = 1_000;
const tool = (name: string, description = `${name} tool`): Tool => ({ name, description, parameters: { type: "object", properties: {} } as never });
const system = (timestamp: number, change: { added?: Tool[]; removed?: string[] }): SystemMessage => ({
	role: "system",
	content: "",
	timestamp,
	...(change.added ? { toolsAdded: change.added } : {}),
	...(change.removed ? { toolsRemoved: change.removed.map((name) => ({ name })) } : {}),
} as SystemMessage);
const user = (timestamp: number): Message => ({ role: "user", content: "task", timestamp });
const declared = (messages: Message[]) => getCurrentTools(messages).map((entry) => entry.name);
const subagentCalls = (messages: Message[]) => messages.flatMap((entry) => entry.role === "assistant" ? entry.content.filter((block) => block.type === "toolCall" && block.name === "subagent").map((block) => (block as { id: string }).id) : []);
/** What a request sends when the session holds `messages`, which also stand for the session. */
const keepInheritedToolDeclarations = (messages: Message[], forkedAt: number, session = messages) => keepInherited(messages, toolsDeclaredBefore(session, forkedAt), forkedAt);

describe("a forked child's requests", () => {
	it("declare every tool its inherited history declares, in that order, then the tools it adds", () => {
		const messages = [system(10, { added: [tool("a"), tool("b"), tool("c")] }), user(20), system(FORKED_AT + 1, { added: [tool("d")], removed: ["b", "c"] }), user(FORKED_AT + 2)];

		const sent = keepInheritedToolDeclarations(messages, FORKED_AT);

		assert.deepEqual(declared(messages), ["a", "d"], "Pi's own record restricts the child");
		assert.deepEqual(declared(sent), ["a", "b", "c", "d"]);
		assert.equal(sent[0], messages[0], "the inherited system message is sent as it was");
	});

	it("keep an inherited tool where it was when the child declares it again", () => {
		const messages = [system(10, { added: [tool("a"), tool("b"), tool("c")] }), system(FORKED_AT, { added: [tool("b", "child b")], removed: ["b", "c"] })];

		const tools = getCurrentTools(keepInheritedToolDeclarations(messages, FORKED_AT));

		assert.deepEqual(tools.map((entry) => entry.name), ["a", "b", "c"]);
		assert.equal(tools[1]!.description, "child b");
	});

	it("keep removals made before the fork and removals of tools the child added itself", () => {
		const parentRemoval = system(30, { removed: ["c"] });
		const messages = [system(10, { added: [tool("a"), tool("c")] }), parentRemoval, system(FORKED_AT, { added: [tool("x")] }), system(FORKED_AT + 5, { removed: ["x", "a"] })];

		const sent = keepInheritedToolDeclarations(messages, FORKED_AT);

		assert.equal(sent[1], parentRemoval);
		assert.deepEqual((sent[3] as SystemMessage).toolsRemoved, [{ name: "x" }]);
		assert.deepEqual(declared(sent), ["a"]);
	});

	it("are unchanged when nothing before the fork declares a tool", () => {
		const messages = [system(FORKED_AT, { added: [tool("a"), tool("b")] }), user(FORKED_AT + 1), system(FORKED_AT + 2, { removed: ["b"] })];
		assert.equal(keepInheritedToolDeclarations(messages, FORKED_AT), messages);
	});

	it("declare the same list when Pi collapsed the request into one leading system message", () => {
		const session = [system(10, { added: [tool("a"), tool("b"), tool("c")] }), user(20), system(FORKED_AT + 1, { added: [tool("d")], removed: ["b", "c"] }), user(FORKED_AT + 2)];
		const collapsed = [system(10, { added: [tool("a"), tool("d")] }), user(20), user(FORKED_AT + 2)];

		const sent = keepInheritedToolDeclarations(collapsed, FORKED_AT, session);

		assert.deepEqual(declared(sent), ["a", "b", "c", "d"]);
		assert.equal(sent[1], collapsed[1], "the conversation is sent as it was");
	});

	it("are unchanged once a compaction in the child left no inherited message", () => {
		const session = [system(10, { added: [tool("a"), tool("b"), tool("c")] }), user(20), system(FORKED_AT + 1, { added: [tool("d")], removed: ["b", "c"] }), user(FORKED_AT + 2)];
		const compacted = [system(FORKED_AT + 10, { added: [tool("a"), tool("d")] }), user(FORKED_AT + 10), user(FORKED_AT + 11)];

		assert.equal(keepInheritedToolDeclarations(compacted, FORKED_AT, session), compacted);
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

	/** Runs a real SDK session on `sessionFile` and returns what each provider request declared. */
	type Launch = Partial<Parameters<typeof buildInProcessChildLaunch>[0]>;
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

	async function forkOfParent(name: string, parent: { tools?: string[]; hooks?: Array<(pi: ExtensionAPI) => void> } = {}): Promise<{ forkFile: string; parentTools: string[]; parentDeclarations: string }> {
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
		return { forkFile, parentTools: parentRequest!.tools, parentDeclarations: parentRequest!.declarations };
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
			assert.equal(messages.filter((entry) => entry.role === "system").length, 2, "the parent's leading system message and the child's own");
		}
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
		const ctx = { model: { api: "anthropic-messages" }, sessionManager: { getHeader: () => ({ id: "fork", timestamp: new Date(FORKED_AT).toISOString() }) } };
		return (messages: unknown[]) => (handlers.get("context")!({ messages }, ctx) as { messages: unknown[] } | undefined)?.messages ?? messages;
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
