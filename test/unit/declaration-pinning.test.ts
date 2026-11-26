import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemMessage, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SubagentFlatParams } from "../../src/extension/schemas.ts";
import { SUBAGENT_TOOL_PARAMETERS } from "../../src/extension/guided-tool.ts";

/** A temporary Pi agent directory and project that load pi-subagents, and a way to run one session in them. */
function pinningHarness() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-declaration-pinning-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	const priorChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	const faux = fauxProvider({ provider: "declaration-pinning", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	// Runs one prompt, and optionally a background wake, and returns the messages of every request.
	const run = async (sessionManager: SessionManager, replies: AssistantMessage[], wake = false): Promise<Message[][]> => {
		const requests: Message[][] = [];
		faux.setResponses(replies.map((reply) => (context) => {
			requests.push(context.messages);
			return reply;
		}));
		// Pi loads extensions again for every session it starts or resumes.
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (pi) => pi.registerProvider(faux.provider)],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager, noTools: "builtin" });
		try {
			await session.bindExtensions({});
			await session.prompt("Prompt.");
			// A background wake starts a run without before_agent_start, from the registered tools alone.
			if (wake) await session.sendCustomMessage({ customType: "declaration-pinning", content: "Background update.", display: true }, { triggerTurn: true });
		} finally {
			// SAFETY: AgentSession exposes its extension runner; its public type omits emit.
			await (session.extensionRunner as unknown as { emit(event: unknown): Promise<unknown> }).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		return requests;
	};
	const dispose = () => {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	};
	return { cwd, agentDir, run, dispose };
}

it("keeps a resumed session on the contact_supervisor it declared, replaces an older subagent declaration and drops removed tools, and re-declares everything when pinToolDeclarations is false", { timeout: 30_000 }, async () => {
	const { cwd, agentDir, run, dispose } = pinningHarness();
	const declared = (messages: Message[]) => ({ ...getCurrentSystemMessage(messages)!, timestamp: 0 });
	const tool = (messages: Message[], name: string) => declared(messages).toolsAdded?.find((candidate) => candidate.name === name);
	try {
		const original = SessionManager.inMemory(cwd);
		const [first] = await run(original, [fauxAssistantMessage("ok")]);
		assert.deepEqual(tool(first!, "subagent")?.parameters, JSON.parse(JSON.stringify(SUBAGENT_TOOL_PARAMETERS)));

		const older = structuredClone(original.getEntries());
		const entry = older.find((candidate) => candidate.type === "message" && candidate.message.role === "system");
		assert.ok(entry?.type === "message" && entry.message.role === "system");
		const system = entry.message;
		const subagent = system.toolsAdded!.find((candidate) => candidate.name === "subagent")!;
		subagent.description = "Older subagent description.";
		subagent.parameters = JSON.parse(JSON.stringify(SubagentFlatParams));
		system.toolsAdded!.push({ name: "bg_wait", description: "Older bg_wait description.", parameters: { type: "object", properties: {} } });
		system.toolsAdded!.find((candidate) => candidate.name === "contact_supervisor")!.description = "Older contact_supervisor description.";

		const [resumed] = await run(SessionManager.inMemory(cwd, undefined, older), [fauxAssistantMessage("ok")]);
		assert.equal(tool(resumed!, "contact_supervisor")?.description, "Older contact_supervisor description.", "a pinned tool keeps its recorded text");
		assert.deepEqual(tool(resumed!, "subagent"), tool(first!, "subagent"), "the old subagent declaration is replaced");
		assert.equal(tool(resumed!, "bg_wait"), undefined, "a removed tool is dropped");

		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ pinToolDeclarations: false }));
		const [refreshed] = await run(SessionManager.inMemory(cwd, undefined, structuredClone(older)), [fauxAssistantMessage("ok")]);
		assert.deepEqual(tool(refreshed!, "contact_supervisor"), tool(first!, "contact_supervisor"));
	} finally {
		dispose();
	}
});

it("pins a tool description without the note a host appends to it, so the note is declared once across resumes", { timeout: 30_000 }, async () => {
	const { cwd, run, dispose } = pinningHarness();
	const name = "contact_supervisor";
	const note = `\n\nCodemode: \`tools.${name}(args)\` resolves to a string.`;
	const declaredTool = (messages: Message[]) => getCurrentSystemMessage(messages)!.toolsAdded!.find((tool) => tool.name === name)!;
	const decorate = (entries: ReturnType<SessionManager["getEntries"]>) => {
		const latest = entries.findLast((entry) => entry.type === "message" && entry.message.role === "system" && entry.message.toolsAdded?.some((tool) => tool.name === name));
		assert.ok(latest?.type === "message" && latest.message.role === "system");
		latest.message.toolsAdded!.find((tool) => tool.name === name)!.description += note;
		return entries;
	};
	try {
		const original = SessionManager.inMemory(cwd);
		const [first] = await run(original, [fauxAssistantMessage("ok")]);
		const description = declaredTool(first!).description;
		let entries = decorate(structuredClone(original.getEntries()));
		for (let start = 2; start <= 3; start++) {
			const session = SessionManager.inMemory(cwd, undefined, entries);
			const [request] = await run(session, [fauxAssistantMessage("ok")]);
			assert.equal(declaredTool(request!).description, description, `session start ${start} registers ${name} without the note`);
			entries = decorate(structuredClone(session.getEntries()));
		}
		const polluted = structuredClone(original.getEntries());
		const system = polluted.find((entry) => entry.type === "message" && entry.message.role === "system");
		assert.ok(system?.type === "message" && system.message.role === "system");
		system.message.toolsAdded!.find((tool) => tool.name === name)!.description = `Older ${name} description.` + note + note;
		const [cleaned] = await run(SessionManager.inMemory(cwd, undefined, polluted), [fauxAssistantMessage("ok")]);
		assert.equal(declaredTool(cleaned!).description, `Older ${name} description.` + note);
	} finally {
		dispose();
	}
});
