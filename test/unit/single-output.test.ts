import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
	captureSingleOutputSnapshot,
	extractChildWrittenOutput,
	finalizeSingleOutput,
	formatSavedOutputReference,
	injectOutputPathSystemPrompt,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutput,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../../src/runs/shared/single-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("normalizeSingleOutputOverride", () => {
	it("treats boolean and string false as disabled output", () => {
		assert.equal(normalizeSingleOutputOverride(false, "default.md"), false);
		assert.equal(normalizeSingleOutputOverride("false", "default.md"), false);
	});

	it("treats boolean and string true as the configured default output", () => {
		assert.equal(normalizeSingleOutputOverride(true, "default.md"), "default.md");
		assert.equal(normalizeSingleOutputOverride("true", "default.md"), "default.md");
		assert.equal(normalizeSingleOutputOverride("true", undefined), undefined);
	});

	it("passes explicit non-empty output paths through", () => {
		assert.equal(normalizeSingleOutputOverride("reports/out.md", "default.md"), "reports/out.md");
		assert.equal(normalizeSingleOutputOverride("", "default.md"), undefined);
		assert.equal(normalizeSingleOutputOverride(undefined, "default.md"), undefined);
	});
});

describe("resolveSingleOutputPath", () => {
	it("does not resolve disabled or boolean-like output values", () => {
		assert.equal(resolveSingleOutputPath(false, "/repo"), undefined);
		assert.equal(resolveSingleOutputPath("false", "/repo"), undefined);
		assert.equal(resolveSingleOutputPath(true, "/repo"), undefined);
		assert.equal(resolveSingleOutputPath("true", "/repo"), undefined);
	});

	it("keeps absolute paths unchanged", () => {
		const absolutePath = path.join(os.tmpdir(), "pi-subagents-abs", "report.md");
		const resolved = resolveSingleOutputPath(absolutePath, "/repo", "/override");
		assert.equal(resolved, absolutePath);
	});

	it("resolves relative paths against requested cwd", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested");
		assert.equal(resolved, path.resolve("/requested", "reviews/report.md"));
	});

	it("resolves relative paths against runtime cwd when requested cwd is absent", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime");
		assert.equal(resolved, path.resolve("/runtime", "reviews/report.md"));
	});

	it("resolves relative requested cwd from runtime cwd before resolving output", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "nested/work");
		assert.equal(resolved, path.resolve("/runtime", "nested/work", "reviews/report.md"));
	});

	it("resolves relative output paths against an explicit artifact base", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested", "/repo/.pi-subagents/artifacts/outputs/run-1");
		assert.equal(resolved, path.resolve("/repo/.pi-subagents/artifacts/outputs/run-1", "reviews/report.md"));
	});
});

describe("injectSingleOutputInstruction", () => {
	it("appends direct-write instructions for mutation-capable agents", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md", { tools: ["read", "write"] });
		assert.match(output, /Write your findings to exactly this path: \/tmp\/report.md/);
		assert.match(output, /This path is authoritative for this run\./);
		assert.match(output, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("tells read-only agents to return the artifact for runtime persistence", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md", { tools: ["read", "grep", "find", "ls"] });
		assert.match(output, /Return the complete artifact in your final response\./);
		assert.match(output, /runtime will persist it to exactly this path: \/tmp\/report\.md/);
		assert.match(output, /Do not call contact_supervisor merely because no write-capable tool is available\./);
		assert.doesNotMatch(output, /Write your findings to exactly this path/);
	});
});

describe("injectOutputPathSystemPrompt", () => {
	it("adds the authoritative runtime output path to the system prompt", () => {
		const output = injectOutputPathSystemPrompt("Output format (`old.md`):", "/tmp/new.md");
		assert.match(output, /^Output format \(`old\.md`\):/);
		assert.match(output, /Runtime output path override:/);
		assert.match(output, /Write your findings to exactly this path: \/tmp\/new\.md/);
		assert.match(output, /Ignore any other output filename or output path mentioned elsewhere/);
	});

	it("uses runtime-persistence instructions in read-only system prompts", () => {
		const output = injectOutputPathSystemPrompt("Analyze only", "/tmp/new.md", { tools: ["read"] });
		assert.match(output, /Return the complete artifact in your final response\./);
		assert.match(output, /runtime will persist it to exactly this path: \/tmp\/new\.md/);
		assert.doesNotMatch(output, /Write your findings to exactly this path/);
	});

	it("leaves prompts unchanged when no output path is active", () => {
		assert.equal(injectOutputPathSystemPrompt("Base prompt", undefined), "Base prompt");
	});
});

describe("resolveSingleOutput", () => {
	it("keeps agent-written file content when the file changed during the run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.writeFileSync(outputPath, "real file content", "utf-8");

		const result = resolveSingleOutput(outputPath, "receipt text", before);
		assert.equal(result.fullOutput, "real file content");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting the assistant output when the file was not changed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");

		fs.writeFileSync(outputPath, "stale content", "utf-8");
		const before = captureSingleOutputSnapshot(outputPath);
		const result = resolveSingleOutput(outputPath, "fresh assistant output", before);

		assert.equal(result.fullOutput, "fresh assistant output");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("preserves read errors from changed output paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.mkdirSync(outputPath);
		const result = resolveSingleOutput(outputPath, "fallback output", before);

		assert.equal(result.fullOutput, "fallback output");
		assert.equal(result.savedPath, undefined);
		assert.match(result.saveError ?? "", /Failed to read changed output file/);
	});
});

describe("extractChildWrittenOutput", () => {
	const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const toolCall = (id: string, name: string, args: Record<string, unknown>): Message => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "test",
		provider: "test",
		model: "mock/test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	});
	const toolResult = (id: string, isError = false): Message => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "write",
		content: [{ type: "text", text: isError ? "write failed" : "ok" }],
		isError,
		timestamp: 0,
	});
	const completedWrite = (id: string, writePath: string, content: string): Message[] => [
		toolCall(id, "write", { path: writePath, content }),
		toolResult(id),
	];

	it("returns the last successfully written content for the configured path", () => {
		const messages = [
			...completedWrite("w1", "/tmp/out.md", "draft"),
			...completedWrite("w2", "/tmp/other.md", "unrelated"),
			...completedWrite("w3", "/tmp/out.md", "final report"),
		];
		assert.equal(extractChildWrittenOutput(messages, "/tmp/out.md", "/repo"), "final report");
	});

	it("ignores write calls whose tool result failed", () => {
		const failedOnly = [toolCall("w1", "write", { path: "/tmp/out.md", content: "never landed" }), toolResult("w1", true)];
		assert.equal(extractChildWrittenOutput(failedOnly, "/tmp/out.md", "/repo"), undefined);

		const failedAfterSuccess = [
			...completedWrite("w1", "/tmp/out.md", "landed"),
			toolCall("w2", "write", { path: "/tmp/out.md", content: "never landed" }),
			toolResult("w2", true),
		];
		assert.equal(extractChildWrittenOutput(failedAfterSuccess, "/tmp/out.md", "/repo"), "landed");
	});

	it("ignores write calls with no confirmed successful tool result", () => {
		const missingResult = [toolCall("w1", "write", { path: "/tmp/out.md", content: "unconfirmed" })];
		assert.equal(extractChildWrittenOutput(missingResult, "/tmp/out.md", "/repo"), undefined);

		const missingStatus = [
			toolCall("w1", "write", { path: "/tmp/out.md", content: "unconfirmed" }),
			{ role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: "unknown" }], timestamp: 0 } as Message,
		];
		assert.equal(extractChildWrittenOutput(missingStatus, "/tmp/out.md", "/repo"), undefined);
	});

	it("resolves relative write paths against the child cwd", () => {
		const messages = completedWrite("w1", "reports/out.md", "relative content");
		assert.equal(extractChildWrittenOutput(messages, "/repo/reports/out.md", "/repo"), "relative content");
		assert.equal(extractChildWrittenOutput(messages, "/elsewhere/reports/out.md", "/repo"), undefined);
	});

	it("matches configured output paths case-insensitively on Windows", { skip: process.platform !== "win32" ? "Windows path comparison" : undefined }, () => {
		const writePath = path.join("C:\\Repo", "Reports", "Output.md");
		const configuredPath = writePath.toLowerCase();
		assert.equal(extractChildWrittenOutput(completedWrite("w1", writePath, "Windows report"), configuredPath, "C:\\Repo"), "Windows report");
	});

	it("ignores non-write tools and missing arguments", () => {
		const messages = [
			toolCall("e1", "edit", { path: "/tmp/out.md", oldText: "a", newText: "b" }),
			toolResult("e1"),
			toolCall("w1", "write", { path: "/tmp/out.md" }),
			toolResult("w1"),
		];
		assert.equal(extractChildWrittenOutput(messages, "/tmp/out.md", "/repo"), undefined);
		assert.equal(extractChildWrittenOutput(undefined, "/tmp/out.md", "/repo"), undefined);
		assert.equal(extractChildWrittenOutput(messages, undefined, "/repo"), undefined);
	});
});

describe("formatSavedOutputReference", () => {
	it("includes absolute path, human-readable size, and line count", () => {
		const reportPath = path.join(os.tmpdir(), "report.md");
		const ref = formatSavedOutputReference(reportPath, "line 1\nline 2");
		assert.equal(ref.path, path.resolve(reportPath));
		assert.equal(ref.bytes, Buffer.byteLength("line 1\nline 2", "utf-8"));
		assert.equal(ref.lines, 2);
		assert.equal(ref.message, `Output saved to: ${ref.path} (13 B, 2 lines). Read this file if needed.`);
	});

	it("formats larger byte sizes in KB", () => {
		const ref = formatSavedOutputReference("/tmp/large.md", "a".repeat(49_357));
		assert.match(ref.message, /\(48\.2 KB, 1 line\)/);
	});
});

describe("validateFileOnlyOutputMode", () => {
	it("requires an output path for file-only mode", () => {
		assert.match(validateFileOnlyOutputMode("file-only", undefined, "Single run") ?? "", /Single run sets outputMode: "file-only"/);
		assert.equal(validateFileOnlyOutputMode("file-only", "/tmp/report.md", "Single run"), undefined);
		assert.equal(validateFileOnlyOutputMode("inline", undefined, "Single run"), undefined);
	});
});

describe("finalizeSingleOutput", () => {
	it("formats saved-path messaging around the already-resolved output", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			truncatedOutput: "[TRUNCATED]\nline 1",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 0,
		});

		assert.match(result.displayOutput, /^\[TRUNCATED\]\nline 1/);
		assert.match(result.displayOutput, /Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("returns only the saved-output reference in file-only mode", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			outputMode: "file-only",
			exitCode: 0,
		});

		assert.doesNotMatch(result.displayOutput, /line 1/);
		assert.match(result.displayOutput, /^Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("does not add save messaging on failed runs", () => {
		const result = finalizeSingleOutput({
			fullOutput: "full output",
			truncatedOutput: "truncated output",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 1,
		});

		assert.equal(result.displayOutput, "truncated output");
	});
});
