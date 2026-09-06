import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Type } from "typebox";
import { registerMainWatchdog } from "../../src/watchdog/register-main.ts";
import { createMainWatchdogReview } from "../../src/watchdog/review.ts";

// Same opt-in installed-SDK convention as readonly-session-evidence.test.ts.
// Real AgentSession + ExtensionRunner + ModelRuntime, with HTTP replaced only at fetch.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
it("native Pi delivers a yielded question and continues without a reply action or forced review", {
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
	const continuation = "I will keep the original bounded scope and continue.";
	const evidence = "The original task bounded the edit.";
	function response(tool?: { name: string; arguments: Record<string, unknown> }, text = "Done."): Response {
		const delta = tool ? { tool_calls: [{ index: 0, id: `call-${hostCalls}-${reviewerCalls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { content: text };
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
				assert.equal(reviewerCalls, 1, "asking yields without another provider call or forced review");
				return response({ name: "watchdog_ask", arguments: { question, evidence } });
			}
			hostCalls++;
			if (hostCalls === 1) return response({ name: "fixture_edit", arguments: {} });
			if (hostCalls === 2) return response();
			assert.equal(hostCalls, 3, "one automatic continuation, no question loop");
			assert.equal(boundaryReturns, 1, "agent_end returned before the orchestrator continuation");
			for (const text of [question, evidence]) assert.ok(JSON.stringify(body.messages).includes(text), "native steer carries question and evidence");
			return response(undefined, continuation);
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
			}],
		});
		await resourceLoader.reload();
		const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
		({ session } = await pi.createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model: modelRuntime.getModel("baseten", "watchdog-test"), sessionManager: pi.SessionManager.inMemory(cwd), noTools: "builtin" }));
		await session.bindExtensions({});
		await session.prompt("Make one original bounded edit.");
		assert.equal(beforeStarts, 1, "queued native continuation is not a new user prompt epoch");
		assert.equal(reviewInputs.length, 1, "ordinary unchanged-evidence gate skips the continuation boundary");
		assert.equal(hostCalls, 3);
		assert.equal(boundaryReturns, 2);
		assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "after");
		assert.equal(runtime!.getSnapshot().failedReviews, 0);
		assert.ok(session.messages.some((message: any) => message.customType === "subagent_watchdog_clarification" && message.display));
		assert.ok(session.messages.some((message: any) => message.role === "assistant" && message.content.some((part: any) => part.text === continuation)));
		console.log(`Actual Pi ${pi.VERSION}: visible question delivered after yield; orchestrator continued; no reply action or forced review.`);
	} finally {
		runtime?.dispose();
		session?.dispose();
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});
