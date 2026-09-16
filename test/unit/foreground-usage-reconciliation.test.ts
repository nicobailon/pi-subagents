import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentMessage, AssistantMessage, Usage } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import type {
	ChildSessionEvent,
	ChildSessionFactory,
} from "../../src/runs/shared/child-session.ts";

const CHILD_MODEL = "mock/test-model";

function leafAgent(): AgentConfig {
	return {
		name: "leaf",
		description: "Read-only leaf",
		tools: ["read"],
		model: CHILD_MODEL,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		systemPrompt: "Inspect only.",
		source: "builtin",
		filePath: path.join(os.tmpdir(), "leaf.md"),
	};
}

function turnUsage(input: number, output: number, costTotal: number): Usage {
	return {
		input,
		output,
		cacheRead: 10,
		cacheWrite: 5,
		totalTokens: input + output + 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function assistantTurn(text: string, usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: CHILD_MODEL,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Fake in-process child: `prompt()` emits the same lifecycle events the real
 * session would, but the live `message_end` event may carry no usage (as seen
 * with some providers) while the persisted `messages` do.
 */
function fakeChildSessionFactory(input: {
	eventUsage?: Usage;
	history?: Usage[];
	finalUsage: Usage;
}): ChildSessionFactory {
	return {
		async create() {
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			const messages: AssistantMessage[] = (input.history ?? []).map((usage) =>
				assistantTurn("earlier turn", usage),
			);
			const emit = (event: ChildSessionEvent) => {
				for (const listener of [...listeners]) listener(event);
			};
			return {
				sessionId: "test-child-session",
				sessionFile: undefined,
				modelId: CHILD_MODEL,
				get messages(): readonly AgentMessage[] {
					return messages;
				},
				subscribe: (listener: (event: ChildSessionEvent) => void) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				steer: async () => {},
				followUp: async () => {},
				abort: async () => {},
				dispose: async () => {},
				async prompt() {
					emit({ type: "agent_start" });
					const baseMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Inspection complete." }],
						model: CHILD_MODEL,
						stopReason: "stop",
					};
					emit({
						type: "message_end",
						message: input.eventUsage !== undefined ? { ...baseMessage, usage: input.eventUsage } : baseMessage,
					});
					messages.push(assistantTurn("Inspection complete.", input.finalUsage));
					emit({ type: "agent_end" });
					emit({ type: "agent_settled" });
				},
			};
		},
		async dispose() {},
	};
}

function runLeaf(factory: ChildSessionFactory, runId: string) {
	return runSync(os.tmpdir(), [leafAgent()], "leaf", "Inspect and report.", {
		runId,
		availableModels: [],
		modelOverride: CHILD_MODEL,
		modelOverrideFromParent: true,
		childSessionFactory: factory,
	});
}

describe("foreground usage reconciliation", () => {
	it("adopts session-message usage when live events carry none", async () => {
		const result = await runLeaf(
			fakeChildSessionFactory({ finalUsage: turnUsage(100, 50, 0.001) }),
			"usage-reconcile-test",
		);
		assert.equal(result.exitCode, 0, result.error ?? "run failed");
		assert.deepEqual(result.usage, {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: 0.001,
			turns: 1,
		});
	});

	it("keeps live event usage when events already report it", async () => {
		const usage = turnUsage(100, 50, 0.001);
		const result = await runLeaf(
			fakeChildSessionFactory({ eventUsage: usage, finalUsage: usage }),
			"usage-events-test",
		);
		assert.equal(result.exitCode, 0, result.error ?? "run failed");
		assert.deepEqual(result.usage, {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: 0.001,
			turns: 1,
		});
	});

	it("excludes history inherited before the prompt", async () => {
		const result = await runLeaf(
			fakeChildSessionFactory({
				history: [turnUsage(1000, 500, 0.05)],
				finalUsage: turnUsage(100, 50, 0.001),
			}),
			"usage-history-test",
		);
		assert.equal(result.exitCode, 0, result.error ?? "run failed");
		assert.deepEqual(result.usage, {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			cost: 0.001,
			turns: 1,
		});
	});
});
