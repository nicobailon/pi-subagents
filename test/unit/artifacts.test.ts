import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	getArtifactsDir,
	getProjectArtifactPackagingWarning,
	getChainRunsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
} from "../../src/shared/artifacts.ts";
import { CHAIN_RUNS_DIR } from "../../src/shared/types.ts";

describe("project-local artifact paths", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function packageDir(packageJson: object, ignore?: { name: ".npmignore" | ".gitignore"; content: string }): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-artifacts-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(packageJson), "utf-8");
		if (ignore) fs.writeFileSync(path.join(dir, ignore.name), ignore.content, "utf-8");
		return dir;
	}

	it("warns only when package settings can include project artifacts", () => {
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "unsafe" })) ?? "", /\.npmignore/);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "gitignored" }, { name: ".gitignore", content: ".pi/subagents/\n" })), undefined);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "globignored" }, { name: ".npmignore", content: "**/.pi/subagents/**\n" })), undefined);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "classignored" }, { name: ".npmignore", content: "[.]pi/subagents/**\n" })), undefined);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "explicit-files-over-ignore", files: [".pi/subagents/**"] }, { name: ".npmignore", content: ".pi/subagents/\n" })) ?? "", /artifactDir/);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "restricted", files: ["src/**"] })), undefined);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "malformed-pattern", files: ["[z-a]"] })), undefined);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "broad", files: ["**/*"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "root-wildcard", files: ["*"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "included", files: [".pi/subagents/**"] })) ?? "", /artifactDir/);
		assert.equal(getProjectArtifactPackagingWarning(packageDir({ name: "excluded-after-include", files: [".pi/subagents/**", "!.pi/subagents/**"] })), undefined);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "artifacts-included", files: [".pi/subagents/artifacts/**"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "artifacts-directory-included", files: [".pi/subagents/artifacts"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "dynamic-input-included", files: [".pi/subagents/artifacts/*_input.md"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "dynamic-output-included", files: [".pi/subagents/artifacts/*_output.md"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "dynamic-jsonl-included", files: [".pi/subagents/artifacts/*.jsonl"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "dynamic-meta-included", files: [".pi/subagents/artifacts/*_meta.json"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "progress-included", files: [".pi/subagents/artifacts/progress/**"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "outputs-included", files: [".pi/subagents/artifacts/outputs/**"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "nested-output-included", files: [".pi/subagents/artifacts/outputs/*/*.md"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "chain-runs-included", files: [".pi/subagents/chain-runs/**"] })) ?? "", /artifactDir/);
		assert.match(getProjectArtifactPackagingWarning(packageDir({ name: "chain-runs-directory-included", files: [".pi/subagents/chain-runs"] })) ?? "", /artifactDir/);
	});

	it("places generated subagent files under .pi/subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi/subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi/subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi/subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi/subagents", "artifacts"));
	});

	it("routes chain scratch files according to the artifact preference", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getChainRunsDir(cwd), getProjectChainRunsDir(cwd));
		assert.equal(getChainRunsDir(cwd, "project"), getProjectChainRunsDir(cwd));
		assert.equal(getChainRunsDir(cwd, "session"), CHAIN_RUNS_DIR);
		assert.equal(getChainRunsDir(cwd, "temp"), CHAIN_RUNS_DIR);
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});
});
