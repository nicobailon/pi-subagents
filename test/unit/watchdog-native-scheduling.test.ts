import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Type } from "typebox";
import { registerMainWatchdog } from "../../src/watchdog/register-main.ts";
import { createMainWatchdogReview } from "../../src/watchdog/review.ts";
import { handleWatchdogToolAction } from "../../src/watchdog/tool-actions.ts";

// Same opt-in installed-SDK convention as readonly-session-evidence.test.ts.
// Real AgentSession + ExtensionRunner + ModelRuntime, with HTTP replaced only at fetch.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
it("native Pi returns the boundary hook before answering and automatically reviews a no-edit reply once", {
	skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to an installed real Pi SDK root",
	timeout: 30_000,
}, async () => {
	const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
	assert.match(entry, /\/dist\/index\.js$/);
	const pi = await import(entry);
	assert.equal(pi.__piSubagentsTestShim, undefined);
	const cwd = mkdtempSync(join(tmpdir(), "watchdog-native-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let session: any;
	let runtime: ReturnType<typeof registerMainWatchdog> | undefined;
	let context: any;
	let boundaryReturns = 0;
	let beforeStarts = 0;
	let hostCalls = 0;
	let reviewerCalls = 0;
	const reviewInputs: string[] = [];
	const question = "Which original scope applies?";
	const reply = "Keep the original bounded scope.";
	const evidence = "The original task bounded the edit.";
	function response(tool?: { name: string; arguments: Record<string, unknown> }): Response {
		const delta = tool ? { tool_calls: [{ index: 0, id: `call-${hostCalls}-${reviewerCalls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: "Done." };
		const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "watchdog-test", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false }, subagents: { watchdog: { enabled: true, clarification: true, lsp: { enabled: false }, guidance: { watchdogMd: false } } } }));
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { baseten: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "watchdog-test", name: "watchdog-test", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
		execFileSync("git", ["init", "-q", cwd]);
		writeFileSync(join(cwd, ".gitignore"), "agent/\n");
		writeFileSync(join(cwd, "marker.txt"), "before");
		execFileSync("git", ["-C", cwd, "add", "marker.txt", ".gitignore"]);
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			assert.equal(url, "https://synthetic.invalid/v1/chat/completions", "no network or auxiliary HTTP allowed");
			const body = JSON.parse(String(init?.body));
			if (body.tools?.some((tool: any) => tool.function.name === "watchdog_warn")) {
				reviewerCalls++;
				if (reviewerCalls === 1) return response({ name: "watchdog_ask", arguments: { question, evidence } });
				if (reviewerCalls === 2) {
					assert.equal(body.tools.some((tool: any) => tool.function.name === "watchdog_ask"), false);
					return response({ name: "watchdog_warn", arguments: { severity: "concern", confidence: "high", summary: "Verify the bounded edit", evidence: "Reply confirms the original scope.", recommendedAction: "Check the edit remains bounded." } });
				}
				assert.equal(reviewerCalls, 3, "only normal post-warning reviewer completion remains");
				return response();
			}
			hostCalls++;
			if (hostCalls === 1) return response({ name: "fixture_edit", arguments: {} });
			if (hostCalls === 2) return response();
			if (hostCalls === 3) {
				assert.equal(boundaryReturns, 1, "agent_end returned before the orchestrator answer");
				assert.ok(JSON.stringify(body.messages).includes(question), "native steer carries the question");
				return response({ name: "subagent", arguments: { action: "watchdog.reply", id: runtime!.getSnapshot().clarification!.id, message: reply } });
			}
			assert.ok(hostCalls <= 5, "no question/reply or warning loop");
			return response();
		};
		const settingsManager = pi.SettingsManager.create(cwd, agentDir);
		const resourceLoader = new pi.DefaultResourceLoader({
			cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(api: any) => {
				api.on("before_agent_start", (_event: any, ctx: any) => { context = ctx; beforeStarts++; });
				api.on("agent_end", (_event: any, ctx: any) => { context = ctx; });
				const review = createMainWatchdogReview(() => context);
				runtime = registerMainWatchdog(api, { review: async (request) => {
					reviewInputs.push(request.delta);
					return review(request);
				} });
				api.on("agent_end", () => { boundaryReturns++; });
				api.registerTool({ name: "fixture_edit", label: "Fixture edit", description: "Change the isolated test marker", parameters: Type.Object({}), async execute() {
					writeFileSync(join(cwd, "marker.txt"), "after");
					return { content: [{ type: "text", text: "Original bounded edit completed." }], details: {} };
				} });
				api.registerTool({ name: "subagent", label: "Watchdog reply", description: "Reply by exact ID", parameters: Type.Object({ action: Type.String(), id: Type.String(), message: Type.String() }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
					const result = handleWatchdogToolAction(params.action, params, ctx, runtime);
					assert.equal(result.isError, undefined);
					assert.equal(reviewInputs.length, 1, "reply is only a receipt");
					assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "after");
					return result;
				} });
			}],
		});
		await resourceLoader.reload();
		const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelRuntime.getModel("baseten", "watchdog-test"), sessionManager: pi.SessionManager.inMemory(cwd), noTools: "builtin" }));
		await session.bindExtensions({});
		await session.prompt("Make one original bounded edit.");
		assert.equal(beforeStarts, 1, "queued native continuation is not a new user prompt epoch");
		assert.equal(reviewInputs.length, 2, "one initial review and one fresh Q/A review");
		assert.ok(reviewInputs[1]!.startsWith(reviewInputs[0]!));
		for (const text of [question, evidence, reply]) assert.ok(reviewInputs[1]!.includes(text));
		assert.equal(runtime!.getSnapshot().failedReviews, 0);
		assert.ok(session.messages.some((message: any) => message.customType === "subagent_watchdog_warning"));
		console.log(`Actual Pi ${pi.VERSION}: hook returned before automatic reply; one no-edit Q/A review; warning reached transcript.`);
	} finally {
		runtime?.dispose();
		session?.dispose();
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});
