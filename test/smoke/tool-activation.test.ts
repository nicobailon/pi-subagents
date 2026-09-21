import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";

const packageToolNames = new Set(["subagents_enable", "bg_wait", "subagent_supervisor", "subagent"]);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function serializedCharacters(tools: ReturnType<typeof getCurrentTools>): number {
	return tools.filter((tool) => packageToolNames.has(tool.name)).reduce((total, tool) => total + JSON.stringify(tool).length, 0);
}

test("native Pi exposes the full subagent schema on the request immediately after activation", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tool-activation-"));
	roots.push(root);
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	const priorChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: registerSubagentExtension } = await import(`../../index.ts?native-activation=${Date.now()}`);
		const faux = fauxProvider({ provider: "tool-activation", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const captured: Array<{ names: string[]; characters: number }> = [];
		faux.setResponses([
			(context) => {
				const tools = getCurrentTools(context.messages);
				captured.push({ names: tools.map((tool) => tool.name), characters: serializedCharacters(tools) });
				const loader = tools.find((tool) => tool.name === "subagents_enable");
				const wait = tools.find((tool) => tool.name === "bg_wait");
				const supervisor = tools.find((tool) => tool.name === "subagent_supervisor");
				assert.ok(loader);
				assert.ok(wait);
				assert.ok(supervisor);
				assert.ok(JSON.stringify(loader).length <= 800);
				assert.ok(JSON.stringify(wait).length <= 1_300);
				assert.ok(JSON.stringify(supervisor).length <= 500);
				assert.ok(!tools.some((tool) => tool.name === "subagent"));
				return fauxAssistantMessage(fauxToolCall("subagents_enable", {}), { stopReason: "toolUse" });
			},
			(context) => {
				const tools = getCurrentTools(context.messages);
				captured.push({ names: tools.map((tool) => tool.name), characters: serializedCharacters(tools) });
				const subagent = tools.find((tool) => tool.name === "subagent");
				assert.ok(subagent);
				assert.deepEqual(subagent.parameters, createSubagentParamsSchema());
				return fauxAssistantMessage("Activation verified.");
			},
		]);
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (pi) => pi.registerProvider(faux.provider)],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({
			cwd, agentDir, settingsManager, resourceLoader, modelRuntime,
			model: faux.getModel("local"), sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		}));
		await session.bindExtensions({});
		await session.prompt("Use the authorized delegation tools.");

		assert.equal(captured.length, 2);
		assert.ok(captured[0]!.characters <= 2_700, `cold package schemas exceeded budget: ${captured[0]!.characters}`);
		assert.ok(captured[1]!.characters <= 20_700, `activated package schemas exceeded budget: ${captured[1]!.characters}`);
		console.log(`schema characters cold=${captured[0]!.characters} activated=${captured[1]!.characters}`);
	} finally {
		if (session) {
			await (session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
	}
});
