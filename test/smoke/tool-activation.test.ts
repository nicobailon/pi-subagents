import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type FauxResponseFactory,
	type FauxResponseStep,
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

function serializedCharacters(tools: ReturnType<typeof getCurrentTools>): number {
	return tools.filter((tool) => packageToolNames.has(tool.name)).reduce((total, tool) => total + JSON.stringify(tool).length, 0);
}

async function runNativeSession(config: Record<string, unknown> | undefined, responses: FauxResponseStep[], prompts: string[]): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tool-activation-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	if (config) {
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify(config));
	}
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	const priorChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: registerSubagentExtension } = await import(`../../index.ts?native-activation=${Date.now()}`);
		const faux = fauxProvider({ provider: "tool-activation", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		faux.setResponses(responses);
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
		for (const prompt of prompts) await session.prompt(prompt);
	} finally {
		if (session) {
			await (session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("native Pi exposes the full subagent schema on the request immediately after activation", { timeout: 30_000 }, async () => {
	const captured: number[] = [];
	await runNativeSession({ toolActivation: "dynamic" }, [
		(context) => {
			const tools = getCurrentTools(context.messages);
			const systemPrompt = getCurrentSystemPrompt(context.messages);
			assert.match(systemPrompt, /pi-subagents is installed/i);
			assert.match(systemPrompt, /complexity alone is not authorization/i);
			captured.push(serializedCharacters(tools));
			const loader = tools.find((tool) => tool.name === "subagents_enable");
			const wait = tools.find((tool) => tool.name === "bg_wait");
			const supervisor = tools.find((tool) => tool.name === "subagent_supervisor");
			assert.ok(loader);
			assert.ok(wait);
			assert.ok(supervisor);
			assert.ok(JSON.stringify(loader).length <= 800);
			assert.ok(!tools.some((tool) => tool.name === "subagent"));
			return fauxAssistantMessage(fauxToolCall("subagents_enable", {}), { stopReason: "toolUse" });
		},
		(context) => {
			const tools = getCurrentTools(context.messages);
			captured.push(serializedCharacters(tools));
			// Replay on resume relies on the first declared tool set recording the loader.
			const firstDeclared = context.messages.find((message) => message.role === "system" && message.toolsAdded?.length);
			assert.ok(firstDeclared?.role === "system" && firstDeclared.toolsAdded?.some((tool) => tool.name === "subagents_enable"));
			const subagent = tools.find((tool) => tool.name === "subagent");
			assert.ok(subagent);
			assert.deepEqual(subagent.parameters, createSubagentParamsSchema());
			return fauxAssistantMessage("Activation verified.");
		},
	], ["Use the authorized delegation tools."]);

	assert.equal(captured.length, 2);
	assert.ok(captured[0]! <= 5_500, `cold package schemas exceeded budget: ${captured[0]}`);
	assert.ok(captured[1]! <= 6_000, `activated package schemas exceeded budget: ${captured[1]}`);
	assert.ok(captured[1]! - captured[0]! >= 3_000, "lazy activation should remove the full subagent schema from cold requests");
	console.log(`schema characters cold=${captured[0]} activated=${captured[1]}`);
});

test("native Pi starts auto sessions with subagent and no loader when the model cannot add tools", { timeout: 30_000 }, async () => {
	// The faux model sets no compat flags.
	const requests: string[][] = [];
	const record: FauxResponseFactory = (context) => {
		// One tool declaration across both prompts: the tool list never changed.
		assert.equal(context.messages.filter((message) => message.role === "system" && (message.toolsAdded?.length || message.toolsRemoved?.length)).length, 1);
		requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
		return fauxAssistantMessage("ok");
	};
	await runNativeSession(undefined, [record, record], ["First prompt.", "Second prompt."]);

	assert.equal(requests.length, 2);
	assert.ok(requests[0]!.includes("subagent") && requests[0]!.includes("bg_wait"));
	assert.equal(requests[0]!.includes("subagents_enable"), false);
});
