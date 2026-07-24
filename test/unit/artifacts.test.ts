import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CHAIN_RUNS_DIR } from "../../src/shared/types.ts";
import {
	appendJsonl,
	cleanupOldArtifacts,
	ensureArtifactsDir,
	getArtifactsDir,
	getChainRunsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
	writeArtifact,
	writeMetadata,
} from "../../src/shared/artifacts.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .pi-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});

	it("routes chain runs with the configured artifact preference", () => {
		const cwd = path.join("tmp", "repo");
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getChainRunsDir(sessionFile, cwd, "project"), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getChainRunsDir(sessionFile, cwd, "session"), path.join("tmp", "sessions", "subagent-chain-runs"));
		assert.equal(getChainRunsDir(null, cwd, "session"), CHAIN_RUNS_DIR);
		assert.equal(getChainRunsDir(sessionFile, cwd, "temp"), CHAIN_RUNS_DIR);
	});

	it("writes private artifacts atomically where required", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
		const dir = path.join(root, "artifacts");
		try {
			ensureArtifactsDir(dir);
			const outputPath = path.join(dir, "output.md");
			const metadataPath = path.join(dir, "metadata.json");
			const jsonlPath = path.join(dir, "events.jsonl");
			writeArtifact(outputPath, "output");
			writeMetadata(metadataPath, { complete: true });
			appendJsonl(jsonlPath, JSON.stringify({ event: 1 }));

			assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
			for (const file of [outputPath, metadataPath, jsonlPath]) {
				assert.equal(fs.statSync(file).mode & 0o777, 0o600);
			}
			assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, "utf-8")), { complete: true });
			assert.equal(fs.readFileSync(jsonlPath, "utf-8"), '{"event":1}\n');
			assert.deepEqual(fs.readdirSync(dir).sort(), ["events.jsonl", "metadata.json", "output.md"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink as the artifact directory", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
		try {
			const target = path.join(root, "target");
			const link = path.join(root, "artifacts");
			fs.mkdirSync(target);
			fs.symlinkSync(target, link);
			assert.throws(() => ensureArtifactsDir(link), /must not contain a symlink/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink artifact parent", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
		try {
			const outside = path.join(root, "outside");
			const parent = path.join(root, ".pi-subagents");
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, parent);
			assert.throws(() => ensureArtifactsDir(path.join(parent, "artifacts")), /must not contain a symlink/);
			assert.equal(fs.existsSync(path.join(outside, "artifacts")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlink in any artifact path ancestor", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-ancestor-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-outside-"));
		try {
			fs.mkdirSync(path.join(outside, "existing"));
			fs.symlinkSync(outside, path.join(root, "link"), "dir");
			const escaped = path.join(root, "link", "existing", "artifacts");
			assert.throws(() => ensureArtifactsDir(escaped), /must not contain a symlink/);
			assert.equal(fs.existsSync(path.join(outside, "existing", "artifacts")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("does not clean through a symlink artifact root", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
		try {
			const outside = path.join(root, "outside");
			const link = path.join(root, "artifacts");
			fs.mkdirSync(outside);
			const sentinel = path.join(outside, "sentinel.txt");
			fs.writeFileSync(sentinel, "keep");
			fs.utimesSync(sentinel, new Date(0), new Date(0));
			fs.symlinkSync(outside, link);
			cleanupOldArtifacts(link, 0);
			assert.equal(fs.readFileSync(sentinel, "utf-8"), "keep");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to follow a symlink artifact file", { skip: process.platform === "win32" }, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-"));
		try {
			const target = path.join(root, "target.txt");
			const link = path.join(root, "output.md");
			fs.writeFileSync(target, "keep");
			fs.symlinkSync(target, link);
			assert.throws(() => writeArtifact(link, "replace"), /must not be a symlink/);
			assert.equal(fs.readFileSync(target, "utf-8"), "keep");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
