import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactForegroundResult, extractToolArgsPreview } from "../../src/shared/utils.ts";
import { formatToolCall } from "../../src/shared/formatters.ts";

describe("foreground tool-call compaction", () => {
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

	it("keeps tool argument previews on one physical terminal line", () => {
		const preview = extractToolArgsPreview({
			command: "set +e\r\n\t\x1b[31mrun\x1b[0m \x1b]0;title\x07now\u0000",
		});

		assert.equal(preview, "set +e run now");
		assert.doesNotMatch(preview, /[\r\n\t\x1b]/);
	});

	it("normalizes fallback argument keys before display", () => {
		const preview = extractToolArgsPreview({ "bad\r\n\t\x1b[31mkey\x1b[0m\u0000": "value" });

		assert.equal(preview, "bad key=value");
		assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/);
	});

	it("discards C1 terminal string payloads and preserves readable suffixes", () => {
		const strings = [
			["DCS", "\x90"],
			["SOS", "\x98"],
			["OSC", "\x9d"],
			["PM", "\x9e"],
			["APC", "\x9f"],
		] as const;
		const cases = [
			["OSC BEL", "\x9d0;title\x07"],
			...strings.flatMap(([name, introducer]) => [
				[`${name} C1 ST`, `${introducer}payload\x9c`],
				[`${name} ESC ST`, `${introducer}payload\x1b\\`],
			] as const),
		] as const;
		for (const [name, control] of cases) {
			const preview = extractToolArgsPreview({ command: `before${control}after` });
			assert.equal(preview, "before after", name);
			assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/, name);
		}
	});

	it("truncates canonical previews without malformed UTF-16", () => {
		const assertWellFormed = (value: string): void => assert.doesNotMatch(value, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
		const command = extractToolArgsPreview({ command: "😀".repeat(31) });
		const mcp = extractToolArgsPreview({ tool: "call", args: "😀".repeat(21) });

		assert.equal(command, `${"😀".repeat(28)}...`);
		assert.equal(command.length, 59);
		assert.equal(mcp, `call ${"😀".repeat(20)}`);
		assert.equal(mcp.length, 45);
		assertWellFormed(command);
		assertWellFormed(mcp);
		assert.equal(extractToolArgsPreview({ command: `safe\ud800tail\udc00end` }), "safe tail end");
		assert.equal(extractToolArgsPreview({ tool: "call", args: `safe\ud800tail\udc00end` }), "call safe tail end");
	});

	it("normalizes terminal strings in linear time before truncating previews", () => {
		const incompleteIntroducers = ["\x1b]", "\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x1b[", "\x9b"];
		for (const introducer of incompleteIntroducers) {
			const preview = extractToolArgsPreview({ command: introducer.repeat(2_048) });
			assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/);
		}
		assert.equal(extractToolArgsPreview({ command: "before\x1b]incomplete" }), "before");
		assert.equal(extractToolArgsPreview({ command: "before\x1bPincomplete" }), "before");
		assert.equal(extractToolArgsPreview({ command: "before\x1b[31" }), "before");

		const completeControls = [
			"\x1b[31m",
			"\x9b32m",
			"\x1b]0;title\x07",
			"\x1b]0;title\x1b\\",
			"\x1bPpayload\x1b\\",
			"\x1bXpayload\x1b\\",
			"\x1b^payload\x1b\\",
			"\x1b_payload\x1b\\",
		].join("");
		assert.equal(
			extractToolArgsPreview({ command: completeControls.repeat(1_024) + "meaningful-tail" }),
			"meaningful-tail",
		);

		const measureIncompleteOsc = (count: number): number => {
			const startedAt = performance.now();
			extractToolArgsPreview({ command: "\x1b]".repeat(count) });
			return performance.now() - startedAt;
		};
		measureIncompleteOsc(2_048);
		const smallMs = measureIncompleteOsc(16_384);
		const largeMs = measureIncompleteOsc(65_536);
		assert.ok(
			largeMs <= smallMs * 8 + 25,
			`normalization scaled superlinearly: 32KiB=${smallMs.toFixed(1)}ms, 128KiB=${largeMs.toFixed(1)}ms`,
		);
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
