import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("nested-fixture", {
		baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
		models: ["reviewer", "arm-a", "arm-b", "persona"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 })),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				try {
					const scenario = process.env.PI_SUBAGENTS_NATIVE_SCENARIO ?? "normal";
					if (process.env.PI_SUBAGENTS_NATIVE_AUDIT) fs.appendFileSync(process.env.PI_SUBAGENTS_NATIVE_AUDIT, JSON.stringify({ phase: "request", model: model.id }) + "\n");
					const text = JSON.stringify(context.messages);
					const previous = context.messages.filter((message) => message.role === "assistant").length;
					if (model.id === "persona") {
						if (scenario === "direct-failure") throw new Error("PERSONA_FAILURE_EVIDENCE");
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(resolve, scenario === "normal" ? 1400 : 30000);
							if (scenario !== "direct-unresponsive-stop") options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Fixture aborted")); }, { once: true });
						});
						output.content = [{ type: "text", text: "PERSONA_EVIDENCE" }];
					} else if (previous === 0) {
						const args = model.id === "reviewer"
							? scenario.startsWith("direct-") ? { agent: "arm-a", task: "Review directly", async: true } : { workflowScript: 'const arms = await Promise.all([runs.run("arm-a", { agent: "arm-a", task: "Review A" }), runs.run("arm-b", { agent: "arm-b", task: "Review B" })]); return arms;', async: true }
							: { agent: "persona", task: `Find evidence for ${model.id}`, async: true };
						output.content = [{ type: "toolCall", id: `spawn_${model.id}`, name: "subagent", arguments: args }];
						output.stopReason = "toolUse";
					} else if (text.includes("Background work finished after your attempted final response.")) {
						if (!text.includes("PERSONA_EVIDENCE")) throw new Error(`Missing persona evidence in ${model.id} continuation`);
						output.content = [{ type: "text", text: `RECONCILED_${model.id}: PERSONA_EVIDENCE` }];
					} else {
						const failedTool = context.messages.find((message: any) => message.role === "toolResult" && message.isError);
						if (failedTool) throw new Error(`Fixture delegation failed: ${JSON.stringify(failedTool)}`);
						output.content = [{ type: "text", text: `PREMATURE_${model.id}: descendants still running` }];
					}
					if (process.env.PI_SUBAGENTS_NATIVE_AUDIT) fs.appendFileSync(path.resolve(process.env.PI_SUBAGENTS_NATIVE_AUDIT), JSON.stringify({ phase: "response", model: model.id, content: output.content }) + "\n");
					stream.push({ type: "start", partial: output });
					stream.push({ type: "done", reason: output.stopReason, message: output });
				} catch (error) {
					output.stopReason = options?.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error instanceof Error ? error.message : String(error);
					stream.push({ type: "error", reason: output.stopReason, error: output });
				}
				stream.end();
			})();
			return stream;
		},
	});
}
