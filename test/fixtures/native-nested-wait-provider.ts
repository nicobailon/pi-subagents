import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only the model is scripted: delegation, wait, read, sessions, and runners are native. */
export default function (pi: ExtensionAPI) {
	pi.on("tool_execution_update", (event, ctx) => {
		if (event.toolName === "bg_wait" && ctx.model?.id.startsWith("arm-")) {
			fs.writeFileSync(`${process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT}.${ctx.model.id}.release`, "ready");
		}
	});
	pi.registerProvider("nested-wait-fixture", {
		baseUrl: "http://unused.invalid", apiKey: "fixture", api: "openai-completions",
		models: ["reviewer", "arm-a", "arm-b", "persona"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 })),
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const output: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], stopReason: "stop", timestamp: Date.now(),
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				try {
					// Deliberately never inspect tool-result details: the model only gets content.
					const results = context.messages.filter((message) => message.role === "toolResult");
					const textOf = (message: { content: Array<{ type: string; text?: string }> }) => message.content.map((part) => part.text ?? "").join("\n");
					const failed = results.find((message) => message.isError);
					if (failed) throw new Error(`Native fixture tool failed: ${textOf(failed)}`);
					const spawned = results.filter((message) => message.toolName === "subagent");
					const waits = results.filter((message) => message.toolName === "bg_wait");
					const reads = results.filter((message) => message.toolName === "read");
					const call = (name: string, args: ToolCall["arguments"], index = 0) => ({ type: "toolCall" as const, id: `${name}_${results.length}_${index}`, name, arguments: args });
					if (model.id === "persona") {
						const arm = context.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n").match(/arm-[ab]/)?.[0];
						if (!arm) throw new Error("Persona task omitted its owning arm");
						const release = `${process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT}.${arm}.release`;
						const deadline = Date.now() + 10000;
						while (!fs.existsSync(release)) {
							options?.signal?.throwIfAborted();
							if (Date.now() > deadline) throw new Error("Owned wait never observed its active persona");
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
						output.content = [{ type: "text", text: "PERSONA_EVIDENCE" }];
					} else if (!spawned.length) {
						output.content = model.id === "reviewer"
							? [call("subagent", { workflowScript: 'return await runs.all([{key:"a",agent:"arm-a",task:"Review A"},{key:"b",agent:"arm-b",task:"Review B"}]);', async: true })]
							: Array.from({ length: model.id === "arm-a" ? 2 : 1 }, (_, index) => call("subagent", { agent: "persona", task: `Inspect the assigned code for ${model.id}`, async: true }, index));
					} else if (!waits.length || (model.id === "arm-b" && waits.length === 1)) {
						const id = textOf(spawned[0]!).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/)?.[0];
						if (!id) throw new Error("Launch result did not expose its run id");
						output.content = [call("bg_wait", model.id === "arm-b" ? { id: waits.length ? id.slice(0, 8) : id, timeoutMs: 20000 } : { all: true, timeoutMs: 20000 })];
					} else if (!reads.length) {
						const references = [...new Set(waits.flatMap((wait) => [...textOf(wait).matchAll(/^Result \[[^\]]+\]: (.+)$/gm)].map((match) => match[1]!)))];
						if (references.length !== (model.id === "arm-a" ? 2 : 1)) throw new Error(`Missing result references for ${model.id}: ${waits.map(textOf).join("\n")}`);
						output.content = references.map((reference, index) => call("read", { path: reference }, index));
					} else {
						const evidence = reads.map(textOf).join("\n");
						const expected = model.id === "reviewer" ? ["CONSUMED_arm-a: PERSONA_EVIDENCE", "CONSUMED_arm-b: PERSONA_EVIDENCE"] : ["PERSONA_EVIDENCE"];
						if (!expected.every((value) => evidence.includes(value))) throw new Error(`Missing consumed findings for ${model.id}: ${evidence.slice(0, 4000)}`);
						output.content = [{ type: "text", text: `CONSUMED_${model.id}: PERSONA_EVIDENCE` }];
					}
					output.stopReason = output.content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
					fs.appendFileSync(process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT!, JSON.stringify({ model: model.id, content: output.content }) + "\n");
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
