import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import { formatToolCall } from "../../src/shared/formatters.ts";
import {
	boundStreamedRecentOutput,
	boundStreamedRecentTools,
	boundStreamedToolCalls,
	MAX_STREAMED_OUTPUT_LINE_CHARS,
	MAX_STREAMED_RECENT_TOOLS,
	MAX_STREAMED_TOOL_CALLS,
} from "../../src/shared/utils.ts";

describe("streamed progress snapshot bounds", () => {
	it("keeps only the most recent tool-history entries and clones them", () => {
		const recentTools = Array.from({ length: MAX_STREAMED_RECENT_TOOLS + 40 }, (_, i) => ({
			tool: "read",
			args: `file-${i}.ts`,
			endMs: i,
		}));
		const bounded = boundStreamedRecentTools(recentTools);
		assert.equal(bounded.length, MAX_STREAMED_RECENT_TOOLS);
		// most-recent retained (chronological)
		assert.equal(bounded.at(-1)?.endMs, recentTools.at(-1)?.endMs);
		assert.equal(bounded[0]?.endMs, recentTools.at(-MAX_STREAMED_RECENT_TOOLS)?.endMs);
		// cloned, not aliased
		bounded[0]!.args = "mutated";
		assert.notEqual(recentTools.at(-MAX_STREAMED_RECENT_TOOLS)?.args, "mutated");
	});

	it("truncates long recent-output lines but leaves short lines intact", () => {
		const shortLine = "ok";
		const longLine = "x".repeat(MAX_STREAMED_OUTPUT_LINE_CHARS + 5000);
		const bounded = boundStreamedRecentOutput([shortLine, longLine]);
		assert.equal(bounded[0], shortLine);
		assert.ok(bounded[1]!.length < longLine.length);
		assert.ok(bounded[1]!.startsWith("x".repeat(MAX_STREAMED_OUTPUT_LINE_CHARS)));
		assert.match(bounded[1]!, /\[truncated\]$/);
	});

	it("prefers an existing toolCalls summary and caps it", () => {
		const toolCalls = Array.from({ length: MAX_STREAMED_TOOL_CALLS + 20 }, (_, i) => ({
			text: `read(${i})`,
			expandedText: `read(file-${i}.ts)`,
		}));
		const bounded = boundStreamedToolCalls({ toolCalls, messages: undefined });
		assert.equal(bounded?.length, MAX_STREAMED_TOOL_CALLS);
		assert.equal(bounded?.at(-1)?.text, toolCalls.at(-1)?.text);
	});

	it("derives tool-call summaries from messages when none are present", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] },
			{ role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { pattern: "foo" } }] },
			{ role: "user", content: [{ type: "text", text: "ignored" }] },
		] as never;
		const bounded = boundStreamedToolCalls({ toolCalls: undefined, messages });
		assert.equal(bounded?.length, 2);
		assert.match(bounded![0]!.text, /read/);
		assert.match(bounded![1]!.text, /grep/);
	});

	it("returns undefined when there are no tool calls", () => {
		assert.equal(boundStreamedToolCalls({ toolCalls: [], messages: [] as never }), undefined);
		assert.equal(boundStreamedToolCalls({ toolCalls: undefined, messages: undefined }), undefined);
	});

	it("derives the same chronological summaries as formatting the full history", () => {
		const call = (i: number) => ({ type: "toolCall", name: i % 2 ? "read" : "grep", arguments: { path: `file-${i}.ts` } });
		const expected = (calls: Array<ReturnType<typeof call>>) => calls.slice(-MAX_STREAMED_TOOL_CALLS)
			.map((part) => ({ text: formatToolCall(part.name, part.arguments), expandedText: formatToolCall(part.name, part.arguments, true) }));
		for (const total of [1, MAX_STREAMED_TOOL_CALLS - 1, MAX_STREAMED_TOOL_CALLS, MAX_STREAMED_TOOL_CALLS + 7]) {
			// Three calls per assistant message so the cutoff can fall inside a message, with other roles and text parts interleaved.
			const calls = Array.from({ length: total }, (_, i) => call(i));
			const messages: unknown[] = [];
			for (let i = 0; i < calls.length; i += 3) {
				messages.push({ role: "user", content: [{ type: "text", text: `user ${i}` }] });
				messages.push({ role: "assistant", content: [{ type: "text", text: "thinking" }, ...calls.slice(i, i + 3)] });
				messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [], isError: false });
			}
			assert.deepEqual(boundStreamedToolCalls({ toolCalls: undefined, messages: messages as never }), expected(calls), `total=${total}`);
		}
	});

	it("does not read arguments of tool calls older than the streamed bound", () => {
		const read = new Set<number>();
		const messages = Array.from({ length: 200 }, (_, i) => ({
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", get arguments() { read.add(i); return { command: `echo ${i}` }; } }],
		}));
		const bounded = boundStreamedToolCalls({ toolCalls: undefined, messages: messages as never });
		assert.equal(bounded?.length, MAX_STREAMED_TOOL_CALLS);
		assert.match(bounded!.at(-1)!.text, /echo 199/);
		assert.deepEqual([...read].sort((a, b) => a - b), Array.from({ length: MAX_STREAMED_TOOL_CALLS }, (_, i) => 200 - MAX_STREAMED_TOOL_CALLS + i));
	});

	it("bounds a pathological running snapshot", () => {
		// Simulates a long, deep nested fan-out: many tool calls + long output lines.
		const recentTools = Array.from({ length: 5000 }, (_, i) => ({ tool: "read", args: `services/pkg/file-${i}.ts`, endMs: i }));
		const recentOutput = Array.from({ length: 50 }, () => "y".repeat(60_000));
		const snapshot = {
			recentTools: boundStreamedRecentTools(recentTools),
			recentOutput: boundStreamedRecentOutput(recentOutput),
		};
		const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
		assert.ok(bytes < 256 * 1024, `bounded snapshot should be small, was ${bytes} bytes`);
	});
});
