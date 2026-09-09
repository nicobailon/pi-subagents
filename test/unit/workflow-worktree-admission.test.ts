import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { preflightWorkflowWorktrees } from "../../src/runs/foreground/subagent-executor.ts";

it("rechecks effective relative sources after changes without applying fresh defaults to retained resumes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-admission-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	assert.equal(spawnSync("git", ["init", repo]).status, 0);
	// Admission deliberately does not resolve HEAD: base refs remain allocation-time checks.
	fs.mkdirSync(path.join(repo, ".pi", "subagents"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".pi", "subagents", "runtime.json"), "{}");
	const signal = new AbortController().signal;
	const calls = [{ key: "a", params: { agent: "worker", task: "Inspect" } }, { key: "b", params: { agent: "worker", task: "Inspect", cwd: "./repo" } }];
	try {
		await preflightWorkflowWorktrees({ ctxCwd: root, workflowDefaults: { cwd: "repo", worktree: true }, calls, signal });
		fs.writeFileSync(path.join(repo, "untracked.txt"), "dirty");
		await assert.rejects(preflightWorkflowWorktrees({ ctxCwd: root, workflowDefaults: { cwd: "repo", worktree: true }, calls, signal }), /a.*b.*clean git working tree/);
		await preflightWorkflowWorktrees({ ctxCwd: root, workflowDefaults: { worktree: true }, calls: [
			{ key: "retained", params: { resume: "original-run", task: "Continue" } },
		], signal });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
