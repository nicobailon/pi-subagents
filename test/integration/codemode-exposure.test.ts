import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createMockPi, removeTempDir } from "../support/helpers.ts";

const script = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const toolResults = (messages: readonly unknown[]) => (messages as Array<{ role: string; toolName?: string; isError?: boolean; content?: Array<{ text?: string }> }>)
	.filter((message) => message.role === "toolResult")
	.map((message) => ({ tool: message.toolName, isError: message.isError === true, text: (message.content ?? []).map((part) => part.text ?? "").join("\n") }));

async function runCodemodeSession(responses: FauxResponseStep[], agents: Record<string, string>) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codemode-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.mkdirSync(cwd);
	for (const [name, content] of Object.entries(agents)) fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), content);
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: registerSubagentExtension } = await import(`../../index.ts?codemode-exposure=${Date.now()}`);
		const faux = fauxProvider({ provider: "codemode-exposure", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses(responses);
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [
				registerSubagentExtension,
				createCodemodeExtension({ models: false }),
				(pi) => {
					pi.registerProvider(faux.provider);
					pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "codemode"]));
				},
			],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({
			cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
			model: faux.getModel("local"), sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		}));
		await session.bindExtensions({});
		await session.prompt("Delegate the probe.");
		return [...session.messages];
	} finally {
		if (session) {
			await (session.extensionRunner as { emit(event: unknown): Promise<void> }).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		// Windows keeps the runner's files locked briefly after the child exits.
		removeTempDir(root);
	}
}

test("a codemode script's launch runs async, and its wait is refused", { timeout: 60_000 }, async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "probe done", delay: 2_000 });
	let declared: string[] = [];
	try {
		const messages = await runCodemodeSession([
			(context) => {
				declared = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage(fauxToolCall("subagent", {}), { stopReason: "toolUse" });
			},
			() => script(`return await tools.subagent({ agent: "foreground-probe", task: "Probe" });`),
			() => script(`const out = [];
for (const args of [{ action: "wait", all: true }, { agent: "foreground-probe", task: "Probe B", async: false }]) {
	try { await tools.subagent(args); out.push("ran"); } catch (error) { out.push(String(error.message)); }
}
return JSON.stringify(out);`),
			() => script(`return await tools.subagent({ action: "status" });`),
			() => fauxAssistantMessage("Done."),
		], { "foreground-probe": "---\nname: foreground-probe\ndescription: Defaults to foreground\nasync: false\n---\nProbe.\n" });
		assert.ok(declared.includes("subagent") && declared.includes("codemode"), declared.join(", "));
		const [guide, launched, refused, status] = toolResults(messages);
		assert.match(guide!.text, /^subagent guide\./);
		assert.equal(launched?.isError, false, launched?.text);
		const id = launched!.text.match(/Async: foreground-probe \[([0-9a-f-]+)\]/)?.[1];
		assert.ok(id, launched!.text);
		const refusals = JSON.parse(refused!.text.split("Output:\n\n")[1]!) as string[];
		assert.match(refusals[0]!, /action 'wait' cannot run from a codemode script: the completion notice wakes the session; end the script/);
		assert.match(refusals[1]!, /must be async: omit async or pass async:true/);
		assert.equal(mockPi.callCount(), 1, "only the forced-async launch started a child");
		assert.match(status!.text, new RegExp(`${id} \\| running \\|`));
	} finally {
		mockPi.uninstall();
	}
});
