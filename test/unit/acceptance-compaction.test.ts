import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AgentSessionEvent, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runSingleStepInner } from "../../src/runs/background/subagent-runner.ts";
import { formatAcceptancePrompt, resolveEffectiveAcceptance } from "../../src/runs/shared/acceptance.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";

// Uses the existing isolated SDK fixture; never install dependencies or call a provider.
const sdkRoot = process.env.PI_SUBAGENTS_NATIVE_SDK;
for (const host of ["foreground", "runner"] as const) {
	for (const [systemPromptMode, structured] of [["append", false], ["replace", false], ["append", true], ["replace", true]] as const) {
		it(`exact acceptance survives actual SDK split-turn compaction: ${host}/${systemPromptMode}/${structured ? "structured" : "fenced"}`, { skip: !sdkRoot && "Set PI_SUBAGENTS_NATIVE_SDK to the isolated 0.85.1 SDK root" }, async () => {
			const entry = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))"], { cwd: sdkRoot, encoding: "utf8" }).trim();
			const pi: PiCodingAgentModule = await import(entry);
			assert.equal(pi.VERSION, "0.85.1");
			const cwd = mkdtempSync(join(tmpdir(), "acceptance-compaction-"));
			const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
			const oldDir = process.env.PI_CODING_AGENT_DIR;
			const oldFetch = globalThis.fetch;
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 32 } }));
			writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { baseten: { baseUrl: "https://synthetic.invalid/v1", apiKey: "fixture-key", models: [{ id: "acceptance", name: "acceptance", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
			writeFileSync(join(cwd, "marker.txt"), "WORK_EVIDENCE");
			const task = "UNIQUE_TASK read marker.txt once and report evidence.";
			const explicit = { level: "checked" as const, criteria: [{ id: "read-marker", must: "Read the marker exactly once" }], evidence: ["commands-run" as const, "no-staged-files" as const] };
			const acceptance = resolveEffectiveAcceptance({ explicit, task, agentName: "reader", mode: "single" });
			const structuredOutput = structured ? createStructuredOutputRuntime({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, cwd, { acceptanceReport: "optional" }) : undefined;
			const protocol = formatAcceptancePrompt(acceptance, { structuredOutput: structured });
			const report = { criteriaSatisfied: [{ id: "read-marker", status: "satisfied", evidence: "WORK_EVIDENCE" }], changedFiles: [], testsAddedOrUpdated: [], residualRisks: ["none"], commandsRun: [{ command: "read marker.txt", result: "passed", summary: "WORK_EVIDENCE" }], noStagedFiles: true };
			const requests: any[] = [];
			const preparations: SessionBeforeCompactEvent["preparation"][] = [];
			const events: AgentSessionEvent[] = [];
			let prompts = 0;
			let creates = 0;
			let reads = 0;
			let summaries = 0;
			globalThis.fetch = async (input, init) => {
				assert.equal(input instanceof Request ? input.url : String(input), "https://synthetic.invalid/v1/chat/completions");
				const body = JSON.parse(String(init?.body)); requests.push(body);
				assert.ok(requests.length <= 3, "no extra request or correction turn");
				const summary = !body.tools?.length;
				let delta: unknown;
				let finish = "stop";
				let tokens = 10;
				if (summary) {
					summaries++;
					// Deliberately lossy model output: real SDK summary generation/rebuild remains intact.
					delta = { content: "The marker was read. Finish the work." };
				} else if (reads++ === 0) {
					delta = { content: "Inspecting the marker for evidence. ".repeat(12), tool_calls: [{ index: 0, id: "read-once", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "marker.txt" }) } }] };
					finish = "tool_calls"; tokens = 127000;
				} else {
					const system = body.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => m.content).join("\n");
					delta = { content: system.includes(protocol) ? `Completed.\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\`` : "Completed the read. Validation passed; no staged files." };
					if (structured) {
						delta = { tool_calls: [{ index: 0, id: "final-output", type: "function", function: { name: "structured_output", arguments: JSON.stringify({ value: { ok: true }, ...(system.includes(protocol) ? { acceptanceReport: report } : {}) }) } }] };
						finish = "tool_calls";
					}
				}
				const chunk = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "acceptance", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: tokens, completion_tokens: 1, total_tokens: tokens + 1 } };
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
			};
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...pi, createAgentSession: async (options) => {
				const result = await pi.createAgentSession(options);
				assert.deepEqual(result.session.settingsManager.getCompactionSettings(), { enabled: true, reserveTokens: 2048, keepRecentTokens: 32 });
				result.session.subscribe((event) => events.push(event));
				return result;
			} }) });
			const observedFactory = { ...factory, async create(launch: Parameters<typeof factory.create>[0]) {
				creates++;
				const child = await factory.create({ ...launch, hooks: [...launch.hooks, (api) => {
					api.on("session_before_compact", (event) => { preparations.push(event.preparation); });
				}] });
				const prompt = child.prompt.bind(child);
				child.prompt = (text) => { prompts++; return prompt(text); };
				return child;
			} };
			const agent: AgentConfig = { name: "reader", description: "Read marker", source: "project", filePath: join(cwd, "reader.md"), model: "baseten/acceptance", systemPrompt: "Read only.", systemPromptMode, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], extensions: [], allowNestedSubagents: false };
			try {
				const result = host === "foreground"
					? await runSync(cwd, [agent], agent.name, task, { acceptance: explicit, structuredOutput, waitToolEnabled: false, childSessionFactory: observedFactory })
					: await runSingleStepInner({ ...agent, agent: agent.name, task, context: "fresh", effectiveAcceptance: acceptance, structuredOutput, modelCandidates: [agent.model!], waitToolEnabled: false }, { cwd, id: "compact-runner", flatIndex: 0, flatStepCount: 1, previousOutput: "", placeholder: "{previous}", outputFile: join(cwd, "output.log"), sessionEnabled: false, childSessions: observedFactory });
				assert.equal(result.exitCode, 0, `${result.error}; ${JSON.stringify(events.filter((e) => e.type.includes("compact") || (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason === "error")))}`);
				assert.equal(result.acceptance?.status, "checked");
				if (structured) assert.deepEqual(result.structuredOutput, { ok: true });
				assert.equal(creates, 1); assert.equal(prompts, 1, "no replay or correction prompt");
				assert.equal(summaries, 1);
				assert.equal(preparations.length, 1);
				assert.ok(preparations[0]);
				assert.equal(preparations[0].isSplitTurn, true);
				assert.ok(JSON.stringify(preparations[0].turnPrefixMessages).includes("UNIQUE_TASK"));
				assert.equal(events.filter((e) => e.type === "tool_execution_end" && e.toolName === "read").length, 1);
				assert.equal(events.filter((e) => e.type === "compaction_end" && e.result).length, 1);
				assert.ok(events.some((e) => e.type === "compaction_end" && e.reason === "threshold" && e.willRetry === false));
				const normal = requests.filter((r) => r.tools?.length);
				assert.equal(normal.length, 2, "one tool request and one terminal request");
				assert.ok(!JSON.stringify(normal[0].messages.filter((m: any) => m.role === "user")).includes("Acceptance Contract"), "protocol is moved, not duplicated into user history");
				for (const request of normal) {
					const system = request.messages.filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => m.content).join("\n");
					assert.equal(system.split(protocol).length - 1, 1, "verbatim contract exactly once in durable resources");
				}
				const retained = JSON.stringify(normal[1].messages.filter((m: any) => m.role !== "system" && m.role !== "developer"));
				assert.ok(!retained.includes("UNIQUE_TASK"), "actual SDK removed original user task");
				assert.ok(!retained.includes("acceptance-report"), "lossy conversation no longer contains envelope");
				assert.ok(retained.includes("WORK_EVIDENCE"), "tool evidence survives");
			} finally {
				await factory.dispose(); globalThis.fetch = oldFetch;
				if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	}
}
