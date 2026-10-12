import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseFactory, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { keepInheritedToolDeclarations as keepInherited, toolsDeclaredBefore } from "../../src/runs/shared/subagent-prompt-runtime.ts";

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

	type Request = { tools: string[]; results: Message[] };

	/** Runs a real SDK session on `sessionFile` and returns what each provider request declared. */
	async function run(options: { sessionFile: string; tools: string[]; replies: Array<ReturnType<typeof fauxAssistantMessage>>; forkCacheKey?: string }): Promise<Request[]> {
		const faux = fauxProvider({ provider: "probe", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const requests: Request[] = [];
		faux.setResponses(options.replies.map((message): FauxResponseFactory => (context) => {
			requests.push({ tools: declared(context.messages as Message[]), results: (context.messages as Message[]).filter((entry) => entry.role === "toolResult") });
			return message;
		}));
		const { session } = buildInProcessChildLaunch({
			host: "parent", cwd: root, childAgentName: "worker", childIndex: 0, sessionEnabled: true, sessionFile: options.sessionFile, waitToolEnabled: false,
			model: "probe/local", systemPrompt: "Role instructions.", systemPromptMode: "append", tools: options.tools,
			...(options.forkCacheKey ? { forkCacheKey: options.forkCacheKey } : {}),
		});
		const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
		const child = await factory.create({ ...session, hooks: [...session.hooks, { name: "probe", factory: (pi: ExtensionAPI) => pi.registerProvider(faux.provider as never) }] });
		try {
			await child.prompt("Task");
		} finally {
			await child.dispose();
			await factory.dispose();
		}
		return requests;
	}

	async function forkOfParent(name: string): Promise<{ forkFile: string; parentTools: string[] }> {
		const parentFile = path.join(root, `${name}-parent.jsonl`);
		const [parentRequest] = await run({ sessionFile: parentFile, tools: ["read", "bash", "ls"], replies: [fauxAssistantMessage("done")] });
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const manager = SessionManager.open(parentFile, path.join(root, `${name}-forks`));
		const forkFile = manager.createBranchedSession(manager.getLeafId()!)!;
		return { forkFile, parentTools: parentRequest!.tools };
	}

	const callBash = (marker: string) => [
		fauxAssistantMessage(fauxToolCall("bash", { command: `touch ${JSON.stringify(marker)}` }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];

	it("declares its parent's tools, and a call to one it lacks is an error that runs nothing", async () => {
		const { forkFile, parentTools } = await forkOfParent("fork");
		const marker = path.join(root, "fork-ran");

		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(marker), forkCacheKey: "pi-fork:test" });

		assert.ok(parentTools.includes("bash") && parentTools.includes("ls"));
		assert.equal(requests.length, 2);
		for (const request of requests) assert.deepEqual(request.tools.slice(0, parentTools.length), parentTools, "every request starts with the parent's tools, in its order");
		const [result] = requests[1]!.results as Array<Message & { isError?: boolean; content: Array<{ text?: string }> }>;
		assert.equal(result!.isError, true);
		assert.match(result!.content[0]!.text ?? "", /Tool bash not found/);
		assert.equal(fs.existsSync(marker), false, "the parent-only tool never ran");
		const recorded = fs.readFileSync(forkFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
			.filter((entry) => entry.type === "message" && entry.message.role === "system").map((entry) => entry.message as SystemMessage);
		assert.ok(recorded.at(-1)!.toolsRemoved?.some((entry) => entry.name === "bash"), "the session keeps Pi's own record of the child's tools");
	});

	it("without a fork launch, declares only its own tools as before", async () => {
		const { forkFile } = await forkOfParent("plain");

		const requests = await run({ sessionFile: forkFile, tools: ["read"], replies: callBash(path.join(root, "plain-ran")) });

		assert.equal(requests[0]!.tools.includes("bash"), false);
	});
});
