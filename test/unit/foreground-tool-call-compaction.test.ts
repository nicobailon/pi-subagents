import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForegroundResult, extractToolArgsPreview } from "../../src/shared/utils.ts";
import { formatToolCall } from "../../src/shared/formatters.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgentConfigs } from "../support/helpers.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

describe("foreground tool-call compaction", () => {
	it("publishes only the latest successful progress update", async () => {
		const updates: AgentProgress[] = [];
		let listener: ((event: ChildSessionEvent) => void) | undefined;
		const toolCall = (id: string, message: string, isError = false) => {
			listener?.({ type: "tool_execution_start", toolName: "contact_supervisor", toolCallId: id, args: { reason: "progress_update", message } });
			listener?.({ type: "message_end", message: { role: "toolResult", toolName: "contact_supervisor", toolCallId: id, ...(isError ? { isError: true } : {}), content: [] } });
		};
		const session: ChildSession = {
			subscribe(callback) { listener = callback; return () => {}; },
			async prompt() {
				toolCall("first", "[1/3] First");
				toolCall("second", "[2/3] Second");
				toolCall("failed", "failed update", true);
				listener?.({ type: "tool_execution_start", toolName: "read", toolCallId: "normal", args: { path: "x" } });
				listener?.({ type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "normal", content: [] } });
				listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: {} } });
			},
			async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
			messages: [], sessionId: "progress-test", modelId: "mock/test-model",
		};
		const factory: ChildSessionFactory = { async create() { return session; }, async dispose() {}, async disposeForParent() {} };
		await runSync(process.cwd(), makeAgentConfigs(["worker"]), "worker", "test progress", {
			childSessionFactory: factory,
			onUpdate: (update) => {
				const progress = update.details.progress?.[0];
				if (progress) updates.push(progress);
			},
		});
		assert.equal(updates.at(-1)?.progressText, "[2/3] Second");
		assert.ok(updates.at(-1)?.progressUpdatedAt);
		assert.ok(updates.some((update) => update.progressText === "[1/3] First"));
	});
	it("stores compact tool-call summaries instead of raw message payloads", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [{
				role: "assistant",
				content: [{
					type: "toolCall",
					name: "write",
					arguments: {
						path: "/tmp/report.md",
						content: "x".repeat(50_000),
					},
				}],
			}],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.messages, undefined);
		assert.deepEqual(result.toolCalls, [{
			text: "write /tmp/report.md",
			expandedText: "write /tmp/report.md",
		}]);
	});

	it("keeps expanded generic tool-call previews bounded", () => {
		const collapsed = formatToolCall("custom", { payload: "x".repeat(500) });
		const expanded = formatToolCall("custom", { payload: "x".repeat(500) }, true);

		assert.ok(expanded.length > collapsed.length);
		assert.ok(expanded.length < 200);
	});

	it("does not keep an empty toolCalls array after compaction", () => {
		const result = compactForegroundResult({
			agent: "tester",
			task: "run checks",
			exitCode: 0,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});

		assert.equal(result.toolCalls, undefined);
	});

	it("keeps live tool argument previews on one terminal line", () => {
		const preview = extractToolArgsPreview({
			command: "set +e\r\n\t\x1b[31mrun\x1b[0m \x1b]0;title\x07now\u0000",
		});

		assert.equal(preview, "set +e run now");
		assert.doesNotMatch(preview, /[\r\n\t\x1b]/);
	});

	it("keeps completed bash tool-call previews on one terminal line", () => {
		const preview = formatToolCall("bash", { command: "first\n\x1b[32msecond\x1b[0m" });

		assert.equal(preview, "$ first second");
		assert.doesNotMatch(preview, /[\r\n\t\x1b]/);
	});

	it("does not split surrogate pairs when truncating previews", () => {
		const preview = extractToolArgsPreview({ command: "😀".repeat(31) });

		assert.equal(preview, `${"😀".repeat(28)}...`);
		assert.doesNotMatch(preview, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
		assert.equal(extractToolArgsPreview({ command: `safe\ud800tail\udc00end` }), "safe tail end");
	});

	it("normalizes fallback argument keys before display", () => {
		const preview = extractToolArgsPreview({ "bad\r\n\t\x1b[31mkey\x1b[0m\u0000": "value" });

		assert.equal(preview, "bad key=value");
		assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/);
	});

	it("discards terminal string payloads while preserving readable suffixes", () => {
		for (const control of ["\x1b]0;title\x07", "\x1bPpayload\x1b\\", "\x9d0;title\x9c"]) {
			assert.equal(extractToolArgsPreview({ command: `before${control}after` }), "before after");
		}
	});

	it("formats array-based web search previews clearly", () => {
		assert.equal(
			extractToolArgsPreview({
				queries: ["Chrome native messaging manifest path macOS", "Chromium native messaging path macOS"],
				workflow: "none",
			}),
			"Chrome native messaging manifest path macOS (+1 more)",
		);
	});

	it("formats fetch_content urls clearly", () => {
		assert.equal(
			extractToolArgsPreview({
				urls: ["https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging", "https://example.com/backup"],
			}),
			"https://developer.chrome.com/docs/extensions/develop/conc...",
		);
	});

	it("falls back to generic array previews", () => {
		assert.equal(
			extractToolArgsPreview({ ids: ["run-a", "run-b", "run-c"] }),
			"ids=run-a (+2 more)",
		);
	});
});
