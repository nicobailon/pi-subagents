import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOrchestratorContext,
	type OrchestratorContext,
	type OrchestratorContextDeps,
	type WorktreeBlockResult,
} from "../../src/orchestrator/orchestrator-context.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@orch-worktree.example.com"]);
	git(repoDir, ["config", "user.name", "Orch Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf-8");
	fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function cleanupRepo(repoDir: string): void {
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

/**
 * Creates a minimal mock ExtensionContext that satisfies the createOrchestratorContext needs.
 */
function createMockExtensionContext(cwd: string): ExtensionContext {
	return {
		cwd,
		model: { provider: "test-provider" },
		modelRegistry: { getAvailable: () => [] },
		sessionManager: null as unknown as ExtensionContext["sessionManager"],
		hasUI: false,
	} as ExtensionContext;
}

/**
 * Creates a dummy execute function that writes a file in the agent's cwd.
 * This simulates what a real subagent run would do — it makes file changes
 * in the worktree that we can later diff.
 */
function createDummyExecute() {
	return async (
		_id: string,
		params: { cwd?: string; agent?: string; task?: string },
		_signal: AbortSignal,
		_onUpdate: ((r: AgentToolResult<unknown>) => void) | undefined,
		_ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {
		const cwd = params.cwd ?? _ctx.cwd;
		// Simulate agent creating/editing a file
		const outDir = path.join(cwd, "generated");
		fs.mkdirSync(outDir, { recursive: true });
		const filename = `output-${params.agent ?? "unknown"}.txt`;
		fs.writeFileSync(path.join(outDir, filename), `Task: ${params.task ?? "none"}\n`, "utf-8");

		return {
			content: [{ type: "text", text: `Created ${path.join(outDir, filename)}` }],
			details: {
				mode: "single",
				results: [{
					agent: params.agent ?? "unknown",
					task: params.task ?? "",
					exitCode: 0,
					output: `Created ${path.join(outDir, filename)}`,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				}],
			},
			isError: false,
		};
	};
}

describe("orchestrator worktree", () => {
	it("runInWorktree creates a worktree, runs agents, captures diff", async () => {
		const repoDir = createRepo("pi-orch-wt-basic-");
		const chainDir = path.join(repoDir, ".pi-orch-runs", "test-run");
		fs.mkdirSync(chainDir, { recursive: true });

		const ctx = createMockExtensionContext(repoDir);
		const deps: OrchestratorContextDeps = {
			execute: createDummyExecute(),
			ctx,
			chainDir,
			runId: "test-run",
			cwd: repoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);
		const patchPath = path.join(chainDir, "test.patch");

		const result = await orchCtx.runInWorktree(patchPath, async (wt) => {
			assert.ok(fs.existsSync(wt.worktreePath), "worktree path should exist");
			assert.ok(wt.worktreePath !== repoDir, "worktree should not be the original repo dir");
			assert.equal(wt.patchPath, patchPath, "wt.patchPath should match user-provided path");

			await wt.runAgent({ agent: "worker", task: "Add foo feature" });
			await wt.runAgent({ agent: "reviewer", task: "Review and fix" });

			return { count: 2 };
		});

		assert.equal(result.count, 2);
		assert.equal(result.patchPath, patchPath, "result.patchPath should match");
		assert.ok(result.filesChanged > 0, "should have at least one file changed");
		assert.ok(result.patch.length > 0, "patch should not be empty");
		assert.ok(result.diffStat.length > 0, "diffStat should not be empty");

		cleanupRepo(repoDir);
	});

	it("runInWorktree cleans up worktree even when callback throws", async () => {
		const repoDir = createRepo("pi-orch-wt-cleanup-");
		const chainDir = path.join(repoDir, ".pi-orch-runs", "test-cleanup");
		fs.mkdirSync(chainDir, { recursive: true });

		const ctx = createMockExtensionContext(repoDir);
		const deps: OrchestratorContextDeps = {
			execute: createDummyExecute(),
			ctx,
			chainDir,
			runId: "test-cleanup",
			cwd: repoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);
		const patchPath = path.join(chainDir, "changes.patch");

		let worktreePath: string | undefined;
		let errorThrown = false;

		try {
			await orchCtx.runInWorktree(patchPath, async (wt) => {
				worktreePath = wt.worktreePath;
				assert.equal(wt.patchPath, patchPath);
				await wt.runAgent({ agent: "worker", task: "Do something" });
				throw new Error("Intentional test error");
			});
		} catch (e) {
			errorThrown = true;
			assert.ok((e as Error).message.includes("Intentional test error"));
		}

		assert.ok(errorThrown, "error should have been thrown");
		assert.ok(worktreePath, "worktreePath should have been recorded");

		// Worktree should be cleaned up - the directory should not exist
		assert.ok(!fs.existsSync(worktreePath!), "worktree should be cleaned up after error");

		cleanupRepo(repoDir);
	});

	it("runInWorktree throws when working tree is not clean", async () => {
		const repoDir = createRepo("pi-orch-wt-dirty-");
		const chainDir = path.join(repoDir, ".pi-orch-runs", "test-dirty");
		fs.mkdirSync(chainDir, { recursive: true });

		// Make the working tree dirty
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "modified\n", "utf-8");

		const ctx = createMockExtensionContext(repoDir);
		const deps: OrchestratorContextDeps = {
			execute: createDummyExecute(),
			ctx,
			chainDir,
			runId: "test-dirty",
			cwd: repoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);
		const patchPath = path.join(chainDir, "dirty.patch");

		await assert.rejects(
			async () => {
				await orchCtx.runInWorktree(patchPath, async (wt) => {
					await wt.runAgent({ agent: "worker", task: "test" });
					return {};
				});
			},
			/clean.*working tree/i,
		);

		cleanupRepo(repoDir);
	});

	it("runInWorktree throws when not in a git repo", async () => {
		const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orch-wt-nonrepo-"));
		const chainDir = path.join(nonRepoDir, ".pi-orch-runs", "test-nonrepo");
		fs.mkdirSync(chainDir, { recursive: true });

		const ctx = createMockExtensionContext(nonRepoDir);
		const deps: OrchestratorContextDeps = {
			execute: createDummyExecute(),
			ctx,
			chainDir,
			runId: "test-nonrepo",
			cwd: nonRepoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);
		const patchPath = path.join(chainDir, "nonrepo.patch");

		await assert.rejects(
			async () => {
				await orchCtx.runInWorktree(patchPath, async (wt) => {
					await wt.runAgent({ agent: "worker", task: "test" });
					return {};
				});
			},
			/git repository/i,
		);

		cleanupRepo(nonRepoDir);
	});

	it("runInWorktree returns empty diff when no changes were made", async () => {
		const repoDir = createRepo("pi-orch-wt-empty-");
		const chainDir = path.join(repoDir, ".pi-orch-runs", "test-empty");
		fs.mkdirSync(chainDir, { recursive: true });

		const ctx = createMockExtensionContext(repoDir);
		const deps: OrchestratorContextDeps = {
			execute: async () => ({
				content: [{ type: "text", text: "no-op" }],
				details: {
					mode: "single",
					results: [{
						agent: "scout",
						task: "read only",
						exitCode: 0,
						output: "Nothing changed",
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					}],
				},
				isError: false,
			}),
			ctx,
			chainDir,
			runId: "test-empty",
			cwd: repoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);
		const patchPath = path.join(chainDir, "empty.patch");

		const result = await orchCtx.runInWorktree(patchPath, async (wt) => {
			assert.equal(wt.patchPath, patchPath);
			await wt.runAgent({ agent: "scout", task: "Just read, no edits" });
			return { done: true };
		});

		assert.equal(result.done, true);
		assert.equal(result.patchPath, patchPath);
		assert.equal(result.filesChanged, 0);
		assert.equal(result.insertions, 0);
		assert.equal(result.deletions, 0);

		cleanupRepo(repoDir);
	});

	it("runInWorktree resolves relative patchPath against cwd", async () => {
		const repoDir = createRepo("pi-orch-wt-relpath-");
		const chainDir = path.join(repoDir, ".pi-orch-runs", "test-relpath");
		fs.mkdirSync(chainDir, { recursive: true });

		const ctx = createMockExtensionContext(repoDir);
		const deps: OrchestratorContextDeps = {
			execute: createDummyExecute(),
			ctx,
			chainDir,
			runId: "test-relpath",
			cwd: repoDir,
			timeoutMs: 30000,
		};

		const orchCtx = createOrchestratorContext(deps);

		const result = await orchCtx.runInWorktree("my-relative.patch", async (wt) => {
			assert.ok(path.isAbsolute(wt.patchPath), "patchPath should be resolved to absolute");
			assert.ok(wt.patchPath.endsWith("my-relative.patch"), "patchPath should end with relative name");
			await wt.runAgent({ agent: "worker", task: "test" });
			return { ok: true };
		});

		assert.equal(result.ok, true);
		assert.ok(result.patchPath.endsWith("my-relative.patch"));
		assert.ok(fs.existsSync(path.join(repoDir, "my-relative.patch")), "patch file should exist at relative path");

		cleanupRepo(repoDir);
	});
});
