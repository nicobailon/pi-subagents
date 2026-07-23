import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { readFleetTranscript, renderFleetTranscript } from "../../src/tui/fleet-transcript.ts";

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

function writeTranscript(root: string, records: Array<Record<string, unknown>>): string {
	const transcriptPath = path.join(root, "child-transcript.jsonl");
	fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
	return transcriptPath;
}

describe("Fleet inspector structured transcript", () => {
	it("projects assistant Markdown, compact tools, errors, and later supervisor messages", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-transcript-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "message", sourceEventType: "initial_prompt", role: "user", text: "large injected task", ts: 1 },
				{ recordType: "message", sourceEventType: "message_end", role: "user", text: "Task: large injected task", ts: 2 },
				{ recordType: "tool_start", toolName: "read", argsPreview: "src/tui/fleet.ts", argsPayload: JSON.stringify({ path: "src/tui/fleet.ts" }), ts: 3 },
				{ recordType: "tool_end", toolName: "read", ts: 4 },
				{ recordType: "message", role: "toolResult", text: "file contents", message: { toolName: "read", isError: false }, ts: 5 },
				{ recordType: "message", role: "assistant", model: "test-model", text: "## Result\n\n```ts\nconst answer = 42;\n```", ts: 6 },
				{ recordType: "tool_start", toolName: "write", argsPreview: "missing/file.ts", ts: 7 },
				{ recordType: "tool_end", toolName: "write", ts: 8 },
				{ recordType: "message", role: "toolResult", text: "Permission denied\nstack omitted", message: { toolName: "write", isError: true }, ts: 9 },
				{ recordType: "message", role: "user", text: "Continue without writing.", ts: 10 },
			]);

			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			assert.deepEqual(transcript.events.map((event) => event.kind), ["tool", "assistant", "tool", "user"]);
			assert.deepEqual(transcript.events[0], {
				kind: "tool",
				name: "read",
				args: "src/tui/fleet.ts",
				argsPayload: JSON.stringify({ path: "src/tui/fleet.ts" }),
				output: "file contents",
				outputTruncated: false,
				status: "complete",
				startedAt: 3,
				endedAt: 4,
				timestamp: 3,
			});
			assert.equal(transcript.events[2]?.kind, "tool");
			if (transcript.events[2]?.kind === "tool") {
				assert.equal(transcript.events[2].status, "error");
				assert.equal(transcript.events[2].error, "Permission denied");
			}

			const rendered = renderFleetTranscript(transcript, 48, theme as never, markdownTheme);
			assert.ok(rendered.some((line) => line.includes("✓ read") && line.includes("src/tui/fleet.ts")));
			assert.ok(rendered.some((line) => line.includes("Assistant") && line.includes("test-model")));
			assert.ok(rendered.some((line) => line.includes("Result")));
			assert.ok(rendered.some((line) => line.includes("const answer = 42;")));
			assert.ok(rendered.some((line) => line.includes("✗ write")));
			assert.ok(rendered.some((line) => line.includes("Permission denied")));
			assert.ok(rendered.some((line) => line.includes("Supervisor")));
			assert.ok(!rendered.some((line) => line.includes("large injected task")));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders compact bash output and expanded read/bash-style tool results", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-tool-render-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "tool_start", toolName: "bash", argsPreview: "npm test", argsPayload: JSON.stringify({ command: "npm test" }), ts: 1000 },
				{ recordType: "tool_end", toolName: "bash", ts: 2200 },
				{ recordType: "message", role: "toolResult", text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8", message: { toolName: "bash", isError: false }, ts: 2300 },
				{ recordType: "tool_start", toolName: "read", argsPreview: "src/a.ts", argsPayload: JSON.stringify({ path: "src/a.ts" }), ts: 2400 },
				{ recordType: "tool_end", toolName: "read", ts: 2500 },
				{ recordType: "message", role: "toolResult", text: "const answer: number = 42;", message: { toolName: "read", isError: false }, ts: 2600 },
			]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			const compact = renderFleetTranscript(transcript, 52, theme as never, markdownTheme);
			assert.ok(compact.some((line) => line.includes("line 8")));
			assert.ok(compact.some((line) => line.includes("earlier lines") && line.includes("x to expand")));
			assert.ok(compact.some((line) => line.includes("Took") && line.includes("1.2s")));
			assert.ok(compact.some((line) => line.includes("const answer: number = 42;") && line.includes("x to expand")));

			const expanded = renderFleetTranscript(transcript, 52, theme as never, markdownTheme, { expandedTools: true });
			assert.ok(expanded.some((line) => line.includes("$ npm test")));
			assert.ok(expanded.some((line) => line.includes("line 1")));
			assert.ok(expanded.some((line) => line.includes("read src/a.ts")));
			assert.ok(expanded.some((line) => line.includes("const answer: number = 42;")));
			assert.ok(expanded.some((line) => line.includes("x to collapse")));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps ANSI-styled tool output within the requested width", () => {
		const transcript = {
			path: "/trusted/transcript.jsonl",
			truncated: false,
			events: [{
				kind: "tool" as const,
				name: "bash",
				args: "printf red",
				output: "\x1b[31mred output that is deliberately wider than the viewport\x1b[0m",
				status: "complete" as const,
			}],
		};
		const rendered = renderFleetTranscript(transcript, 24, theme as never, markdownTheme, { expandedTools: true });
		for (const line of rendered) {
			assert.ok(visibleWidth(line) <= 24, `line exceeded width: ${JSON.stringify(line)}`);
		}
	});

	it("associates parallel same-name tool results by tool call id", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-parallel-tools-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "tool_start", toolCallId: "read-a", toolName: "read", argsPreview: "a.ts", ts: 1 },
				{ recordType: "tool_start", toolCallId: "read-b", toolName: "read", argsPreview: "b.ts", ts: 2 },
				{ recordType: "tool_end", toolCallId: "read-b", toolName: "read", ts: 3 },
				{ recordType: "tool_end", toolCallId: "read-a", toolName: "read", ts: 4 },
				{ recordType: "message", role: "toolResult", toolCallId: "read-a", toolName: "read", text: "contents-a", isError: false, ts: 5 },
				{ recordType: "message", role: "toolResult", toolCallId: "read-b", toolName: "read", text: "contents-b", isError: false, ts: 6 },
			]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			const tools = transcript.events.filter((event) => event.kind === "tool");
			assert.equal(tools.length, 2);
			assert.deepEqual(tools.map((tool) => ({ id: tool.toolCallId, args: tool.args, output: tool.output, endedAt: tool.endedAt })), [
				{ id: "read-a", args: "a.ts", output: "contents-a", endedAt: 4 },
				{ id: "read-b", args: "b.ts", output: "contents-b", endedAt: 3 },
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not attach an id-bearing result to another tool when its start was omitted", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-omitted-tool-start-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "tool_start", toolCallId: "read-a", toolName: "read", argsPreview: "a.ts" },
				{ recordType: "tool_start", toolCallId: "read-b", toolName: "read", argsPreview: "b.ts" },
				{ recordType: "message", role: "toolResult", toolCallId: "read-a", toolName: "read", text: "contents-a", isError: false },
				{ recordType: "message", role: "toolResult", toolCallId: "read-b", toolName: "read", text: "contents-b", isError: false },
			]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root], maxRecords: 3 });
			const tools = transcript.events.filter((event) => event.kind === "tool");
			assert.equal(transcript.truncated, true);
			assert.deepEqual(new Map(tools.map((tool) => [tool.toolCallId, tool.output])), new Map([
				["read-a", "contents-a"],
				["read-b", "contents-b"],
			]));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a complete final record without a newline and drops an incomplete append", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-final-record-"));
		try {
			const transcriptPath = path.join(root, "child-transcript.jsonl");
			fs.writeFileSync(transcriptPath, JSON.stringify({ recordType: "message", role: "assistant", text: "Complete final record" }), "utf-8");
			let transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			assert.ok(transcript.events.some((event) => event.kind === "assistant" && event.text === "Complete final record"));

			fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify({ recordType: "message", role: "assistant", text: "Complete first record" })}\n{"recordType":"message","role":"assistant","text":`,
				"utf-8",
			);
			transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			assert.deepEqual(transcript.events.map((event) => event.kind === "assistant" ? event.text : event.kind), ["Complete first record"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the first tool result authoritative when records arrive out of order", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-tool-order-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "tool_start", toolCallId: "bash-1", toolName: "bash", ts: 1 },
				{ recordType: "message", role: "toolResult", toolCallId: "bash-1", toolName: "bash", text: "command failed", isError: true, ts: 2 },
				{ recordType: "tool_end", toolCallId: "bash-1", toolName: "bash", isError: false, ts: 3 },
				{ recordType: "message", role: "toolResult", toolCallId: "bash-1", toolName: "bash", text: "late success", isError: false, ts: 4 },
			]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root] });
			const tool = transcript.events.find((event) => event.kind === "tool");
			assert.equal(tool?.kind, "tool");
			if (tool?.kind === "tool") {
				assert.equal(tool.status, "error");
				assert.equal(tool.error, "command failed");
				assert.equal(tool.output, "command failed");
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a later supervisor message when bounded tailing omits the preceding assistant record", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-transcript-tail-"));
		try {
			const transcriptPath = writeTranscript(root, [
				{ recordType: "message", role: "assistant", text: "Earlier response" },
				...Array.from({ length: 8 }, (_, index) => ({ recordType: "tool_start", toolName: "read", argsPreview: `file-${index}` })),
				{ recordType: "message", role: "user", text: "Use the narrower approach." },
			]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [root], maxRecords: 3 });
			assert.equal(transcript.truncated, true);
			assert.ok(transcript.events.some((event) => event.kind === "user" && event.text === "Use the narrower approach."));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses symlinked transcripts and parent-directory escapes", (context) => {
		const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-symlink-trusted-"));
		const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-symlink-outside-"));
		try {
			const outsideTranscript = writeTranscript(outsideRoot, [{ recordType: "message", role: "assistant", text: "secret" }]);
			try {
				fs.symlinkSync(outsideTranscript, path.join(trustedRoot, "transcript-link.jsonl"));
				fs.symlinkSync(outsideRoot, path.join(trustedRoot, "directory-link"), "dir");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EPERM" || code === "EACCES") {
					context.skip("symlink creation is unavailable");
					return;
				}
				throw error;
			}

			const directLink = readFleetTranscript(path.join(trustedRoot, "transcript-link.jsonl"), { trustedRoots: [trustedRoot] });
			assert.deepEqual(directLink.events, []);
			assert.match(directLink.warning ?? "", /refused a symlink/);

			const parentLink = readFleetTranscript(path.join(trustedRoot, "directory-link", path.basename(outsideTranscript)), { trustedRoots: [trustedRoot] });
			assert.deepEqual(parentLink.events, []);
			assert.match(parentLink.warning ?? "", /resolves outside trusted roots/);
		} finally {
			fs.rmSync(trustedRoot, { recursive: true, force: true });
			fs.rmSync(outsideRoot, { recursive: true, force: true });
		}
	});

	it("refuses transcript paths outside trusted roots", () => {
		const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-trusted-"));
		const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-outside-"));
		try {
			const transcriptPath = writeTranscript(outsideRoot, [{ recordType: "message", role: "assistant", text: "secret" }]);
			const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [trustedRoot] });
			assert.deepEqual(transcript.events, []);
			assert.match(transcript.warning ?? "", /outside trusted roots/);
		} finally {
			fs.rmSync(trustedRoot, { recursive: true, force: true });
			fs.rmSync(outsideRoot, { recursive: true, force: true });
		}
	});
});
