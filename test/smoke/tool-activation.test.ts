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
} from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createSubagentParamsSchema } from "../../src/extension/schemas.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

const packageToolNames = new Set(["subagents_enable", "bg_wait", "subagent_supervisor", "subagent"]);

function serializedCharacters(tools: ReturnType<typeof getCurrentTools>): number {
	return tools.filter((tool) => packageToolNames.has(tool.name)).reduce((total, tool) => total + JSON.stringify(tool).length, 0);
}

test("native Pi exposes the full subagent schema on the request immediately after activation", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-tool-activation-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd);
	fs.mkdirSync(agentDir);
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	const priorChild = process.env.PI_SUBAGENT_CHILD;
	// The activation gate trusts the running host or an explicit override; this
	// session runs inside the test runner, so declare the SDK host it simulates.
	const priorHostRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	const declaredHostRoot = priorHostRoot ?? resolveInstalledPiPackageRoot();
	if (declaredHostRoot) process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = declaredHostRoot;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const { default: registerSubagentExtension } = await import(`../../index.ts?native-activation=${Date.now()}`);
		const faux = fauxProvider({ provider: "tool-activation", models: [{ id: "local" }], tokensPerSecond: 100_000 });
		const captured: number[] = [];
		faux.setResponses([
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
		assert.ok(captured[0]! <= 5_500, `cold package schemas exceeded budget: ${captured[0]}`);
		assert.ok(captured[1]! <= 24_000, `activated package schemas exceeded budget: ${captured[1]}`);
		assert.ok(captured[1]! - captured[0]! >= 17_500, "lazy activation should remove the full subagent schema from cold requests");
		console.log(`schema characters cold=${captured[0]} activated=${captured[1]}`);
	} finally {
		if (session) {
			await (session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = priorChild;
		if (priorHostRoot === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]; else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = priorHostRoot;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
