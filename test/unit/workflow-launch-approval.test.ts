import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

type Completion = { success?: boolean; error?: string };
const refusal = /Workflow child 'review' was not started: the subagent_launch call was refused: Reviewer launches need approval\./;

it("offers each workflow child start to tool_call handlers and does not start a blocked child", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-launch-approval-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const launches: Array<Record<string, unknown>> = [];
	const completions = new Map<string, Completion>();
	let completed: (() => void) | undefined;
	const marker = path.join(root, "verify-ran");
	const output = path.join(root, "review.md");
	const verify = { id: "mark", command: `node -e "require('fs').writeFileSync(process.env.MARKER, 'x')"`, cwd: "sub", env: { MARKER: marker } };
	const script = (task: string) => `return await runs.run("review", ${JSON.stringify({ agent: "reviewer", task, acceptance: { level: "verified", verify: [verify] }, output })});`;
	const toolResults: string[] = [];
	const faux = fauxProvider({ provider: "launch-approval", models: [{ id: "local" }], tokensPerSecond: 100_000 });
	const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
		const last = context.messages.at(-1)!;
		const text = JSON.stringify(last.content);
		const background = text.includes("background review");
		if (last.role === "user" && (background || text.includes("foreground review"))) {
			return fauxAssistantMessage(fauxToolCall("subagent", { async: background, options: { script: script(background ? "Review in the background" : "Review now") } }), { stopReason: "toolUse" });
		}
		if (last.role === "toolResult") toolResults.push((last.content as Array<{ type: string; text?: string }>).flatMap((block) => block.type === "text" ? [block.text!] : []).join("\n"));
		return fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 8 }, () => respond));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [registerSubagentExtension, (pi) => {
				pi.registerProvider(faux.provider);
				pi.on("tool_call", (event) => {
					if (event.toolName !== "subagent_launch") return;
					launches.push(event.input);
					return { block: true, reason: "Reviewer launches need approval." };
				});
				pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (event: Completion & { runId?: string }) => {
					if (event.runId) completions.set(event.runId, event);
					completed?.();
				});
			}],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, modelRuntime, model: faux.getModel("local"), sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
		await session.bindExtensions({});

		// The async workflow starts its child after the subagent call has returned.
		await session.prompt("Run the background review.");
		assert.equal(launches.length, 1);
		const { workflowRunId, ...launch } = launches[0]!;
		assert.deepEqual(launch, {
			key: "review", agent: "reviewer", task: "Review in the background", cwd: root,
			commands: [{ command: verify.command, cwd: path.join(root, "sub"), env: { MARKER: marker } }],
			output,
		});
		const backgroundRunId = String(workflowRunId);
		while (!completions.has(backgroundRunId)) await new Promise<void>((resolve) => { completed = resolve; });
		assert.equal(completions.get(backgroundRunId)!.success, false);
		assert.match(completions.get(backgroundRunId)!.error!, refusal);

		await session.prompt("Run the foreground review.");
		assert.equal(launches.length, 2);
		assert.equal(launches[1]!.task, "Review now");
		assert.match(toolResults.at(-1)!, refusal);
		assert.equal(fs.existsSync(marker), false);
		assert.equal(fs.existsSync(output), false);
	} finally {
		if (session) {
			await (session.extensionRunner as any).emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
