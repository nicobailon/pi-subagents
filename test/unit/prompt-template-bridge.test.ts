import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	registerPromptTemplateDelegationBridge,
	type PromptTemplateBridgeEvents,
} from "../../src/slash/prompt-template-bridge.ts";

class FakeEvents implements PromptTemplateBridgeEvents {
	private handlers = new Map<string, Array<(data: unknown) => void>>();

	on(event: string, handler: (data: unknown) => void): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const current = this.handlers.get(event) ?? [];
			this.handlers.set(event, current.filter((h) => h !== handler));
		};
	}

	emit(event: string, data: unknown): void {
		const list = this.handlers.get(event) ?? [];
		for (const handler of [...list]) handler(data);
	}
}

function once(events: FakeEvents, event: string): Promise<unknown> {
	return new Promise((resolve) => {
		const unsubscribe = events.on(event, (payload) => {
			unsubscribe();
			resolve(payload);
		});
	});
}

describe("prompt-template delegation bridge", () => {
	it("emits started/update/response on successful request", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, _request, _signal, _ctx, onUpdate) => {
				executeCalls++;
				onUpdate({
					details: {
						results: [{ agent: "worker", model: "openai/gpt-5-mini" }],
						progress: [{
							index: 0,
							agent: "worker",
							currentTool: "read",
							currentToolArgs: "src/extension/index.ts",
							recentOutput: ["line 1"],
							recentTools: [{ tool: "read", args: '{"path":"src/extension/index.ts"}' }],
							toolCount: 1,
							durationMs: 10,
							tokens: 42,
						}],
					},
				});
				return {
					details: {
						results: [{ messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }],
					},
				};
			},
		});

		const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
		const updatePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT);
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r1",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const started = await startedPromise as { requestId: string };
		assert.equal(started.requestId, "r1");

		const update = await updatePromise as {
			requestId: string;
			currentTool?: string;
			toolCount?: number;
			recentOutputLines?: string[];
			recentTools?: Array<{ tool: string; args: string }>;
			model?: string;
			taskProgress?: Array<{ model?: string }>;
		};
		assert.equal(update.requestId, "r1");
		assert.equal(update.currentTool, "read");
		assert.equal(update.toolCount, 1);
		assert.deepEqual(update.recentOutputLines, ["line 1"]);
		assert.deepEqual(update.recentTools, [{ tool: "read", args: '{"path":"src/extension/index.ts"}' }]);
		assert.equal(update.model, "openai/gpt-5-mini");
		assert.equal(update.taskProgress?.[0]?.model, "openai/gpt-5-mini");

		const response = await responsePromise as { requestId: string; isError: boolean; messages: unknown[] };
		assert.equal(response.requestId, "r1");
		assert.equal(response.isError, false);
		assert.equal(Array.isArray(response.messages), true);
		assert.equal(executeCalls, 1);

		bridge.dispose();
	});

	it("rebuilds compact tool-call summaries into delegated response messages", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => ({
				details: {
					results: [{
						finalOutput: "finished",
						toolCalls: [
							{ text: "write src/output.md", expandedText: "write src/output.md" },
							{ text: "edit src/output.md", expandedText: "edit src/output.md" },
						],
					}],
				},
			}),
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r-compact-tools",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { messages: Array<{ role?: string; content?: Array<{ type?: string; name?: string; text?: string }> }> };
		assert.equal(response.messages.length, 1);
		assert.equal(response.messages[0]?.role, "assistant");
		assert.deepEqual(
			response.messages[0]?.content?.filter((part) => part.type === "toolCall").map((part) => part.name),
			["write", "edit"],
		);
		assert.equal(response.messages[0]?.content?.some((part) => part.type === "text" && part.text === "finished"), true);

		bridge.dispose();
	});

	it("filters malformed recent output entries in updates", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, _request, _signal, _ctx, onUpdate) => {
				onUpdate({
					details: {
						results: [{ agent: "worker", model: "openai/gpt-5-mini" }],
						progress: [{
							index: 0,
							agent: "worker",
							recentOutput: ["line 1", 123 as unknown as string],
						}],
					},
				});
				return { details: { results: [{ messages: [] }] } };
			},
		});

		const updatePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT);
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r-malformed-output",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const update = await updatePromise as {
			recentOutput?: string;
			recentOutputLines?: string[];
			taskProgress?: Array<{ recentOutput?: string; recentOutputLines?: string[] }>;
		};
		assert.equal(update.recentOutput, undefined);
		assert.deepEqual(update.recentOutputLines, ["line 1"]);
		assert.equal(update.taskProgress?.[0]?.recentOutput, undefined);
		assert.deepEqual(update.taskProgress?.[0]?.recentOutputLines, ["line 1"]);

		await responsePromise;
		bridge.dispose();
	});

	it("returns structured error when no active context", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => null,
			execute: async () => ({ details: { results: [{ messages: [] }] } }),
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r2",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { isError: boolean; errorText?: string };
		assert.equal(response.isError, true);
		assert.match(response.errorText ?? "", /No active extension context/);

		bridge.dispose();
	});

	it("accepts requests when delegated cwd differs from active context", async () => {
		const events = new FakeEvents();
		let executeCwd: string | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/actual" }),
			execute: async (_requestId, request) => {
				executeCwd = request.cwd;
				return { details: { results: [{ messages: [] }] } };
			},
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r3",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { isError: boolean; errorText?: string };
		assert.equal(response.isError, false);
		assert.equal(executeCwd, "/repo");

		bridge.dispose();
	});

	it("applies pending cancel when cancel arrives before request", async () => {
		const events = new FakeEvents();
		let executeCalls = 0;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => {
				executeCalls++;
				return { details: { results: [{ messages: [] }] } };
			},
		});

		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r4" });
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r4",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as { isError: boolean; errorText?: string };
		assert.equal(response.isError, true);
		assert.equal(response.errorText, "Delegated prompt cancelled.");
		assert.equal(executeCalls, 0);

		bridge.dispose();
	});

	it("cancels in-flight delegated execution", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, _request, signal) =>
				await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});

		const startedPromise = once(events, PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT);
		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);

		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r5",
			agent: "worker",
			task: "do work",
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		await startedPromise;
		events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, { requestId: "r5" });

		const response = await responsePromise as { isError: boolean; errorText?: string };
		assert.equal(response.isError, true);
		assert.match(response.errorText ?? "", /aborted/i);

		bridge.dispose();
	});

	it("accepts tasks payloads and emits parallelResults", async () => {
		const events = new FakeEvents();
		let executeTasks: Array<{ agent: string; task: string; model?: string; cwd?: string }> | undefined;
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async (_requestId, request) => {
				executeTasks = request.tasks;
				return {
					details: {
						results: [
							{ agent: "worker-a", messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }], exitCode: 0 },
							{ agent: "worker-b", messages: [], exitCode: 1, error: "failed" },
						],
					},
				};
			},
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r6",
			tasks: [
				{ agent: "worker-a", task: "A", model: "openai/gpt-5", cwd: "/repo/a" },
				{ agent: "worker-b", task: "B", model: "anthropic/claude-sonnet-4-20250514", cwd: "/repo/b" },
			],
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as {
			isError: boolean;
			parallelResults?: Array<{ agent: string; isError: boolean; errorText?: string }>;
		};
		assert.equal(Array.isArray(executeTasks), true);
		assert.equal(executeTasks?.length, 2);
		assert.equal(executeTasks?.[0]?.model, "openai/gpt-5");
		assert.equal(executeTasks?.[1]?.model, "anthropic/claude-sonnet-4-20250514");
		assert.equal(executeTasks?.[0]?.cwd, "/repo/a");
		assert.equal(executeTasks?.[1]?.cwd, "/repo/b");
		assert.equal(response.isError, false);
		assert.equal(response.parallelResults?.[0]?.agent, "worker-a");
		assert.equal(response.parallelResults?.[0]?.isError, false);
		assert.equal(response.parallelResults?.[1]?.agent, "worker-b");
		assert.equal(response.parallelResults?.[1]?.isError, true);
		assert.equal(response.parallelResults?.[1]?.errorText, "failed");

		bridge.dispose();
	});

	it("marks missing parallel task results as errors", async () => {
		const events = new FakeEvents();
		const bridge = registerPromptTemplateDelegationBridge({
			events,
			getContext: () => ({ cwd: "/repo" }),
			execute: async () => ({
				details: {
					results: [{ agent: "worker-a", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], exitCode: 0 }],
				},
			}),
		});

		const responsePromise = once(events, PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT);
		events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, {
			requestId: "r7",
			tasks: [
				{ agent: "worker-a", task: "A" },
				{ agent: "worker-b", task: "B" },
			],
			context: "fresh",
			model: "openai/gpt-5",
			cwd: "/repo",
		});

		const response = await responsePromise as {
			isError: boolean;
			parallelResults?: Array<{ agent: string; isError: boolean; errorText?: string }>;
		};
		assert.equal(response.isError, false);
		assert.equal(response.parallelResults?.[0]?.isError, false);
		assert.equal(response.parallelResults?.[1]?.agent, "worker-b");
		assert.equal(response.parallelResults?.[1]?.isError, true);
		assert.match(response.parallelResults?.[1]?.errorText ?? "", /missing result/i);

		bridge.dispose();
	});
});
