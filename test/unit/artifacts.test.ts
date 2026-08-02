import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	getArtifactsDir,
	getChainRunsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
} from "../../src/shared/artifacts.ts";
import { CHAIN_RUNS_DIR } from "../../src/shared/types.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .pi-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
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
