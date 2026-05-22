import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureSingleOutputSnapshot,
	finalizeSingleOutput,
	formatSavedOutputReference,
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
});

describe("injectSingleOutputInstruction", () => {
	it("appends output instruction with resolved path", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md");
		assert.match(output, /Write your findings to: \/tmp\/report.md/);
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
