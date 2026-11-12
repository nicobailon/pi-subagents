import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";
import { createMockPi } from "../support/mock-pi.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Parent = { session: Session; replies: Array<Record<string, unknown> | string>; completions: number; completed?: () => void };

const mockPi = createMockPi();
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
const parents: Parent[] = [];
let root: string;
let agentDir: string;

/** The first message each child received, in start order. */
const childPrompts = () => fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort()
	.map((name) => (JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { args: string[] }).args.at(-1)!);

// Like an extension that rewrites briefs: it changes a workflow child's task in its tool_call handler.
async function startParent(config: Record<string, unknown> = {}): Promise<Parent> {
	const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(config));
	const state = { replies: [], completions: 0 } as unknown as Parent;
	const faux = fauxProvider({ provider: "launch-task", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	faux.setResponses(Array.from({ length: 50 }, () => () => {
		const next = state.replies.shift() ?? "ok";
		return typeof next === "string" ? fauxAssistantMessage(next) : fauxAssistantMessage(fauxToolCall("subagent", next), { stopReason: "toolUse" });
	}));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [registerSubagentExtension, (pi) => {
			pi.registerProvider(faux.provider);
			pi.on("tool_call", async (event) => {
				const input = event.input as { task?: string };
				if (event.toolName === "subagent_launch" && input.task?.startsWith("/better ")) input.task = `Deepened: ${input.task.slice(8)}`;
			});
			pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, () => { state.completions += 1; state.completed?.(); });
		}],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
	({ session: state.session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
	await state.session.bindExtensions({});
	fs.rmSync(configPath);
	parents.push(state);
	return state;
}

async function callSubagent(parent: Parent, args: Record<string, unknown>): Promise<void> {
	await parent.session.waitForIdle();
	parent.replies.push(args, "ok");
	await parent.session.prompt("go");
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-launch-task-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "agents", "probe.md"), "---\nname: probe\ndescription: Probe\ntools: read\ndefaultContext: fresh\n---\nDo the task.\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mockPi.install();
});

beforeEach(() => {
	mockPi.reset();
	mockPi.onCall({ output: "done" });
});

after(async () => {
	for (const parent of parents) {
		await (parent.session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
		parent.session.dispose();
	}
	mockPi.uninstall();
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

it("a task a tool_call handler sets on subagent_launch is what the workflow child receives", { timeout: 60_000 }, async () => {
	const parent = await startParent();
	await callSubagent(parent, { async: false, options: { script: `return (await runs.run("one", { agent: "probe", task: "/better from a script" })).output;` } });
	assert.deepEqual(childPrompts(), ["Task: Deepened: from a script"]);

	mockPi.reset();
	mockPi.onCall({ output: "done" });
	await callSubagent(parent, { workflow: "parallel", args: { tasks: [{ agent: "probe", task: "/better add a flag" }, { agent: "probe", task: "review the diff" }] }, async: false });
	assert.deepEqual(childPrompts().sort(), ["Task: Deepened: add a flag", "Task: review the diff"]);

	// A background workflow starts its child after the subagent call has returned.
	mockPi.reset();
	mockPi.onCall({ output: "done" });
	const target = parent.completions + 1;
	await callSubagent(parent, { async: true, options: { script: `return (await runs.run("bg", { agent: "probe", task: "/better in the background" })).output;` } });
	while (parent.completions < target) await new Promise<void>((resolve) => { parent.completed = resolve; });
	assert.deepEqual(childPrompts(), ["Task: Deepened: in the background"]);
});

it("a chain step's task is offered after {previous} is filled in, and the change reaches that step", { timeout: 60_000 }, async () => {
	// A top-level chain is accepted only when workflow scripts are off.
	const parent = await startParent({ disabledFeatures: ["workflow-scripts"] });
	await callSubagent(parent, { async: false, chain: [{ agent: "probe", task: "first step" }, { agent: "probe", task: "/better build on {previous}" }] });
	const prompts = childPrompts();
	assert.equal(prompts.length, 2);
	assert.equal(prompts[0], "Task: first step");
	assert.match(prompts[1]!, /^Task: Deepened: build on done/);
});
