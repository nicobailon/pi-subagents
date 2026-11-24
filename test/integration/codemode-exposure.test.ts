import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createMockPi } from "../support/helpers.ts";
import { setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";

const DEFERRED_PROMPT = 'pi-subagents: start child agents from codemode with tools.subagent({agent,task}) (async only); describeTool("subagent") for usage. Delegate only when the operator asked.';
const packageToolNames = new Set(["subagents_enable", "bg_wait", "subagent_supervisor", "contact_supervisor", "subagent"]);
const packageToolChars = (tools: ReturnType<typeof getCurrentTools>) => tools.filter((tool) => packageToolNames.has(tool.name)).reduce((total, tool) => total + JSON.stringify(tool).length, 0);
const script = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
const toolResults = (messages: readonly unknown[]) => (messages as Array<{ role: string; toolName?: string; isError?: boolean; content?: Array<{ text?: string }> }>)
	.filter((message) => message.role === "toolResult")
	.map((message) => ({ tool: message.toolName, isError: message.isError === true, text: (message.content ?? []).map((part) => part.text ?? "").join("\n") }));

async function runDeferredSession(responses: FauxResponseStep[], options: { codemode?: boolean; afterPrompt?: (cwd: string) => Promise<void> } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codemode-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
	fs.mkdirSync(cwd);
	fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ toolExposure: "deferred" }));
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
					if (options.codemode !== false) pi.on("session_start", () => pi.setActiveTools([...pi.getActiveTools(), "codemode"]));
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
		await options.afterPrompt?.(cwd);
		return [...session.messages];
	} finally {
		if (session) {
			await (session.extensionRunner as { emit(event: unknown): Promise<void> }).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test("deferred exposure: codemode scripts launch tracked async runs and nothing else", { timeout: 60_000 }, async () => {
	const mockPi = createMockPi();
	mockPi.install();
	mockPi.onCall({ output: "probe done", delay: 2_000 });
	const sizes: Record<string, number> = {};
	let prompt = "";
	try {
		const messages = await runDeferredSession([
			(context) => {
				const tools = getCurrentTools(context.messages);
				prompt = getCurrentSystemPrompt(context.messages);
				sizes.cold = packageToolChars(tools);
				assert.deepEqual(tools.map((tool) => tool.name), ["codemode"], "deferred mode declares no pi-subagents tool");
				return script(`return await tools.subagent({ agent: "worker", task: "Probe A", async: true });`);
			},
			// Not awaited: Pi cancels the call when the script returns.
			() => script(`tools.subagent({ agent: "worker", task: "Probe B", async: true }); return "returned";`),
			() => script(`const refusals = [];
for (const args of [{ agent: "worker", task: "Probe C", async: false }, { workflow: true, async: true }, { action: "create", config: { name: "x" } }]) {
	try { await tools.subagent(args); refusals.push("ran"); } catch (error) { refusals.push(String(error.message)); }
}
return JSON.stringify(refusals);`),
			() => script(`return await tools.subagent({ action: "status" });`),
			(context) => {
				sizes.afterDelegation = packageToolChars(getCurrentTools(context.messages));
				return fauxAssistantMessage("Done.");
			},
		]);
		const [launched, unawaited, refused, status] = toolResults(messages);
		assert.ok(prompt.includes(DEFERRED_PROMPT), "the prompt line carries the call shape and the authorization rule");
		assert.equal(launched?.isError, false, launched?.text);
		const launchedId = launched!.text.match(/Async: worker \[([0-9a-f-]+)\]/)?.[1];
		assert.ok(launchedId, launched!.text);
		assert.match(unawaited!.text, /Output:\n\nreturned$/);
		const refusals = JSON.parse(refused!.text.split("Output:\n\n")[1]!) as string[];
		assert.match(refusals[0]!, /must be async: pass async:true/);
		assert.match(refusals[1]!, /workflow:true reads a ```js block.*options\.script/);
		assert.match(refusals[2]!, /action 'create' cannot run from a codemode script/);
		assert.equal(mockPi.callCount(), 2, "only the two async launches started children");
		// Both children run after their scripts ended, including the one whose call was never awaited.
		assert.match(status!.text, /Active async runs: 2/);
		assert.equal(status!.text.match(/\| running \|/g)?.length, 2, status!.text);
		assert.ok(status!.text.includes(launchedId!));
		assert.equal(sizes.cold, 0);
		assert.equal(sizes.afterDelegation, 0);
		console.log(`deferred package tool characters cold=${sizes.cold} afterDelegation=${sizes.afterDelegation} promptLine=${DEFERRED_PROMPT.length}`);
	} finally {
		mockPi.uninstall();
	}
});

test("deferred exposure: a child's ask reaches the parent and subagent_supervisor answers it", { timeout: 60_000 }, async () => {
	setChildSessionFactoryModule(fileURLToPath(new URL("../support/asking-child-session-factory.ts", import.meta.url)));
	let wakeChars = -1;
	let ask: { reply?: unknown; error?: string } | undefined;
	try {
		const messages = await runDeferredSession([
			() => script(`return await tools.subagent({ agent: "worker", task: "Ask before deciding", async: true });`),
			() => fauxAssistantMessage("Launched."),
			(context) => {
				wakeChars = packageToolChars(getCurrentTools(context.messages));
				return fauxAssistantMessage(fauxToolCall("subagent_supervisor", { action: "reply", message: "Proceed with approach A" }), { stopReason: "toolUse" });
			},
			() => fauxAssistantMessage("Replied."),
			() => fauxAssistantMessage("Noted."),
		], {
			afterPrompt: async (cwd) => {
				const deadline = Date.now() + 20_000;
				let file: string | undefined;
				while (!(file = fs.readdirSync(cwd).find((name) => name.endsWith("-ask.json"))) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
				assert.ok(file, "the child recorded its ask outcome");
				ask = JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"));
			},
		});
		assert.equal(ask?.error, undefined);
		assert.match(JSON.stringify(ask?.reply), /Proceed with approach A/);
		assert.ok(toolResults(messages).some((result) => result.tool === "subagent_supervisor" && !result.isError));
		assert.equal(wakeChars > 0 && wakeChars < 600, true, `only subagent_supervisor is declared for the reply, got ${wakeChars}`);
		console.log(`deferred package tool characters with a pending ask=${wakeChars}`);
	} finally {
		setChildSessionFactoryModule(undefined);
	}
});

test("deferred exposure without codemode reports the setting instead of falling back to direct", { timeout: 30_000 }, async () => {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	let prompt = "";
	let declared: string[] = [];
	try {
		await runDeferredSession([(context) => {
			prompt = getCurrentSystemPrompt(context.messages);
			declared = getCurrentTools(context.messages).map((tool) => tool.name);
			return fauxAssistantMessage("Nothing to do.");
		}], { codemode: false });
	} finally {
		console.error = original;
	}
	assert.ok(!declared.includes("subagent"));
	assert.ok(!prompt.includes(DEFERRED_PROMPT));
	assert.ok(errors.some((line) => /toolExposure "deferred" needs the codemode tool/.test(line)), errors.join("\n"));
});
