import * as fs from "node:fs";
import * as path from "node:path";
import { registerNativeSupervisorClient } from "../../src/intercom/native-supervisor-channel.ts";
import { childSupervisorMetadata } from "../../src/runs/shared/child-runtime-config.ts";
import type { ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { events } from "./helpers.ts";

/** Script the model only: use the real child supervisor tool in the detached runner. */
export default function askingChildSessionFactory(): ChildSessionFactory {
	return {
		async create(input) {
			const tools = new Map<string, { execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown> }>();
			registerNativeSupervisorClient({
				getAllTools: () => [...tools.keys()].map(name => ({ name })),
				registerTool: (tool: { name: string; execute(id: string, params: unknown, signal?: AbortSignal): Promise<unknown> }) => tools.set(tool.name, tool),
			} as never, childSupervisorMetadata(input.runtime));
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			const messages: any[] = [];
			const controller = new AbortController();
			const emit = (event: ChildSessionEvent) => {
				if (event.type === "message_end") messages.push(event.message);
				for (const listener of listeners) listener(event);
			};
			return {
				sessionId: `asking-${input.runtime.runId}`,
				sessionFile: input.storage.kind === "file" ? input.storage.sessionFile : undefined,
				modelId: undefined,
				messages,
				subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
				async prompt() {
					const partial = "Verified finding before the decision";
					// A tool-use turn must not arm the runner's final-assistant drain timer.
					emit({ type: "message_end", message: {
						role: "assistant", model: "mock/test-model", stopReason: "toolUse",
						content: [{ type: "text", text: partial }, { type: "toolCall", id: "decision", name: "contact_supervisor", arguments: { reason: "need_decision", message: "Choose the next approach" } }],
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					} });
					emit(events.toolStart("contact_supervisor", { reason: "need_decision", message: "Choose the next approach" }));
					let error: string | undefined;
					let reply: unknown;
					try {
						reply = await tools.get("contact_supervisor")!.execute("decision", { reason: "need_decision", message: "Choose the next approach" }, controller.signal);
					} catch (failure) {
						error = failure instanceof Error ? failure.message : String(failure);
					}
					fs.writeFileSync(path.join(input.cwd, `${input.runtime.runId}-ask.json`), JSON.stringify({ pid: process.pid, error, reply, partial }));
					emit(events.toolEnd("contact_supervisor"));
					emit(events.assistantMessage(error ? `BLOCKED: ${error}\nPartial results: ${partial}` : "Finished after the supervisor replied"));
					emit({ type: "agent_end", willRetry: false });
					emit({ type: "agent_settled" });
				},
				async steer() {},
				async followUp() {},
				async abort() { controller.abort(); },
				async dispose() { controller.abort(); },
			};
		},
		async dispose() {},
	};
}
