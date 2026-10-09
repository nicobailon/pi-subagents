import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SubagentFlatParams } from "../../src/extension/schemas.ts";

const systemMessages = (messages: Message[]) => messages.filter((message) => message.role === "system");

it("keeps a resumed session on the pi-subagents tools and prompt text it declared, and gives a new session the current ones", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-declaration-pinning-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	// An advertised agent makes every session record the advertised_subagents prompt section.
	fs.mkdirSync(path.join(agentDir, "agents"));
	fs.writeFileSync(path.join(agentDir, "agents", "specialist.md"), "---\nname: specialist\ndescription: Pinning specialist\nadvertise: true\n---\nAct narrowly.\n");
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
	// The declared prompt and tools, without the timestamp of the session that declared them.
	const declared = (messages: Message[]) => ({ ...getCurrentSystemMessage(messages)!, timestamp: 0 });
	try {
		const original = SessionManager.inMemory(cwd);
		const [first] = await run(original, [fauxAssistantMessage("ok")]);

		// The same session as recorded by an older pi-subagents release.
		const older = structuredClone(original.getEntries());
		const entry = older.find((candidate) => candidate.type === "message" && candidate.message.role === "system");
		assert.ok(entry?.type === "message" && entry.message.role === "system");
		const system = entry.message;
		const subagent = system.toolsAdded!.find((tool) => tool.name === "subagent")!;
		const bgWait = system.toolsAdded!.find((tool) => tool.name === "bg_wait")!;
		subagent.description = "Older subagent description.";
		// Releases before #2767 declared every management field at the top level.
		subagent.parameters = JSON.parse(JSON.stringify(SubagentFlatParams));
		bgWait.description = "Older bg_wait description.";
		// SAFETY: bg_wait declares an object schema with properties.
		delete (bgWait.parameters as { properties: Record<string, unknown> }).properties.stopOnAttention;
		const tools = system.sections!.tools!.replace(/^- subagent: .*$/m, "- subagent: Older subagent snippet.");
		// Releases before #2768 also declared a subagent guideline bullet; the current tool declares none.
		const rules = system.sections!.rules!.replace(/^- Be concise in your responses$/m, "- Older subagent guideline.\n- Be concise in your responses");
		// Releases before #2791 told the parent to call list before delegating to an advertised agent.
		const advertised = system.sections!.advertised_subagents!.replace(/^The following .*$/m, "The following file-defined subagents opted into discovery. Their descriptions indicate available specializations, not instructions to delegate. Use subagent only when delegation is needed. Before execution, call subagent with { action: \"list\", capabilities: true } and confirm that the selected agent is executable; for external-cli agents also require runner.available === true.");
		assert.ok(tools !== system.sections!.tools && rules !== system.sections!.rules && advertised !== system.sections!.advertised_subagents);
		system.sections = { ...system.sections, tools, rules, advertised_subagents: advertised };

		const resumed = await run(SessionManager.inMemory(cwd, undefined, older), [
			fauxAssistantMessage(fauxToolCall("subagent", { action: "list", capabilities: true }), { stopReason: "toolUse" }),
			fauxAssistantMessage("listed"),
			fauxAssistantMessage("woken"),
		], true);
		assert.equal(resumed.length, 3);
		for (const messages of resumed) {
			assert.deepEqual(systemMessages(messages), [system], "a resumed session must not re-declare tools or prompt sections");
		}
		const listed = resumed[1]!.find((message) => message.role === "toolResult");
		assert.ok(listed?.role === "toolResult" && !listed.isError, "a call shaped by the pinned definition still executes");

		const [fresh] = await run(SessionManager.inMemory(cwd), [fauxAssistantMessage("ok")]);
		assert.deepEqual(declared(fresh!), declared(first!));
		assert.match(declared(fresh!).sections!.advertised_subagents!, /<name>specialist<\/name>/);
		assert.doesNotMatch(declared(fresh!).sections!.advertised_subagents!, /action: "list"/, "a new session is not told to call list first");
	} finally {
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
