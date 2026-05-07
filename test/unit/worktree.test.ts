import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	resolveExpectedWorktreeAgentCwd,
	type WorktreeSetup,
} from "../../src/runs/shared/worktree.ts";

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
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf-8");
	fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function cleanupRepo(repoDir: string): void {
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

function createHookScript(_repoDir: string, fileName: string, source: string): string {
	const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-hook-script-"));
	const hookPath = path.join(hooksDir, fileName);
	fs.writeFileSync(hookPath, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

const hookScriptSkip = process.platform === "win32"
	? "Hook script execution differs on Windows CI environments."
	: undefined;

describe("worktree", () => {
	it("createWorktrees returns expected structure", () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "structure", 2);
			assert.equal(setup.worktrees.length, 2);
			assert.equal(setup.cwd, git(repoDir, ["rev-parse", "--show-toplevel"]));
			for (let i = 0; i < setup.worktrees.length; i++) {
				const worktree = setup.worktrees[i]!;
				assert.equal(worktree.branch, `pi-parallel-structure-${i}`);
				assert.equal(worktree.index, i);
				assert.equal(worktree.agentCwd, worktree.path);
				assert.equal(worktree.nodeModulesLinked, false);
				assert.deepEqual(worktree.syntheticPaths, []);
				assert.ok(fs.existsSync(worktree.path), `worktree path missing: ${worktree.path}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees maps subdirectory cwd to each agentCwd", () => {
		const repoDir = createRepo("pi-worktree-subdir-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(nestedDir, "subdir", 1);
			assert.equal(setup.worktrees[0]!.agentCwd, path.join(setup.worktrees[0]!.path, "packages", "app"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("previews expected worktree agent cwd for repository subdirectories", () => {
		const repoDir = createRepo("pi-worktree-preview-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		try {
			assert.equal(
				resolveExpectedWorktreeAgentCwd(nestedDir, "preview", 2),
				path.join(os.tmpdir(), "pi-worktree-preview-2", "packages", "app"),
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees can create worktrees under a custom root", () => {
		const repoDir = createRepo("pi-worktree-custom-root-");
		const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-root-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "custom-root", 1, { worktreeRoot });
			assert.equal(path.dirname(setup.worktrees[0]!.path), worktreeRoot);
			assert.ok(fs.existsSync(setup.worktrees[0]!.path));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
			fs.rmSync(worktreeRoot, { recursive: true, force: true });
		}
	});

	it("cleanupWorktrees keeps worktrees when the setup is marked keepWorktrees", () => {
		const repoDir = createRepo("pi-worktree-keep-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "keep", 1, { keepWorktrees: true });
			const worktreePath = setup.worktrees[0]!.path;
			cleanupWorktrees(setup);
			assert.equal(fs.existsSync(worktreePath), true, "worktree should remain for manual review");
		} finally {
			if (setup) {
				cleanupWorktrees({ ...setup, keepWorktrees: false });
			}
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees rejects dirty repositories", () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		try {
			fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
			assert.throws(
				() => createWorktrees(repoDir, "dirty", 1),
				/worktree isolation requires a clean git working tree/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("findWorktreeTaskCwdConflict allows omitted or matching task cwd values", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[
					{ agent: "worker-a" },
					{ agent: "worker-b", cwd: sharedCwd },
				],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict treats relative task cwd values as relative to the shared cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[{ agent: "worker-a", cwd: "." }],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict returns the first conflicting task cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		const conflict = findWorktreeTaskCwdConflict(
			[
				{ agent: "worker-a", cwd: sharedCwd },
				{ agent: "worker-b", cwd: path.join(sharedCwd, "packages", "app") },
			],
			sharedCwd,
		);
		assert.deepEqual(conflict, {
			index: 1,
			agent: "worker-b",
			cwd: path.join(sharedCwd, "packages", "app"),
		});
	});

	it("diffWorktrees captures committed, modified, and new files without staging the node_modules symlink", () => {
		const repoDir = createRepo("pi-worktree-diff-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "diff", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.ts"), "export const committed = true;\n", "utf-8");
			git(worktree.path, ["add", "committed.ts"]);
			git(worktree.path, ["commit", "-m", "committed change"]);
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "modified\n", "utf-8");
			fs.writeFileSync(path.join(worktree.path, "new-file.ts"), "export const added = true;\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "worktree-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			assert.equal(diffs.length, 1);
			assert.equal(diffs[0]!.agent, "agent-a");
			assert.equal(diffs[0]!.filesChanged, 3, `expected 3 files, got ${diffs[0]!.filesChanged}`);
			assert.ok(diffs[0]!.insertions > 0, "expected insertions > 0");
			assert.ok(fs.existsSync(diffs[0]!.patchPath), "expected patch file to exist");

			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /committed\.ts/);
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);

			const summary = formatWorktreeDiffSummary(diffs);
			assert.match(summary, /=== Worktree Changes ===/);
			assert.match(summary, /Full patches:/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees removes worktrees and branches", () => {
		const repoDir = createRepo("pi-worktree-cleanup-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "cleanup", 2);
			const worktreePaths = setup.worktrees.map((worktree) => worktree.path);
			const branches = setup.worktrees.map((worktree) => worktree.branch);
			cleanupWorktrees(setup);
			setup = undefined;

			for (const worktreePath of worktreePaths) {
				assert.equal(fs.existsSync(worktreePath), false, `worktree path still exists: ${worktreePath}`);
			}
			for (const branch of branches) {
				const branchResult = git(repoDir, ["branch", "--list", branch]);
				assert.equal(branchResult.trim(), "", `branch still exists: ${branch}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees creates node_modules symlink when node_modules exists", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-node-modules-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "node-modules", 1);
			const symlinkPath = path.join(setup.worktrees[0]!.path, "node_modules");
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, true);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, ["node_modules"]);
			assert.ok(fs.existsSync(symlinkPath), "node_modules link should exist");
			assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true, "node_modules should be a symlink");
			assert.equal(fs.realpathSync(symlinkPath), fs.realpathSync(nodeModulesDir));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees preserves a tracked node_modules symlink", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-tracked-node-modules-");
		const vendorDir = path.join(repoDir, "vendor-modules");
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.writeFileSync(path.join(vendorDir, "fixture.txt"), "fixture\n", "utf-8");
		fs.symlinkSync("vendor-modules", path.join(repoDir, "node_modules"));
		git(repoDir, ["add", "vendor-modules", "-f", "node_modules"]);
		git(repoDir, ["commit", "-m", "track node_modules symlink"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "tracked-node-modules", 1);
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, false);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, []);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "tracked-node-modules-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);
			assert.equal(fs.lstatSync(path.join(setup.worktrees[0]!.path, "node_modules")).isSymbolicLink(), true);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs a repo-relative worktree setup hook and records synthetic paths", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-relative-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.mkdirSync(path.join(payload.worktreePath, ".venv"), { recursive: true });
fs.writeFileSync(path.join(payload.worktreePath, ".venv", "pyvenv.cfg"), "home=/tmp\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".venv"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-relative", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			assert.ok(setup.worktrees[0]!.syntheticPaths.includes(".venv"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs an absolute worktree setup hook path", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-absolute", 1, {
				setupHook: { hookPath },
			});
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("rejects bare command names for worktree setup hooks", () => {
		const repoDir = createRepo("pi-worktree-hook-bare-");
		try {
			assert.throws(
				() => createWorktrees(repoDir, "hook-bare", 1, { setupHook: { hookPath: "node" } }),
				/worktree setup hook must be an absolute path or a repo-relative path/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects tracked synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-tracked-");
		const hookPath = createHookScript(repoDir, "tracked-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["tracked.txt"] }));
`);
		const runId = `hook-tracked-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/cannot mark tracked paths as synthetic/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects absolute synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-synthetic-");
		const hookPath = createHookScript(repoDir, "absolute-path-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [payload.worktreePath + "/.venv"] }));
`);
		const runId = `hook-absolute-synthetic-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/synthetic path must be relative/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("excludes hook-created synthetic files from captured patch output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-diff-");
		const hookPath = createHookScript(repoDir, "setup-copy-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.writeFileSync(path.join(payload.worktreePath, ".env.local"), "TOKEN=secret\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".env.local"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-diff", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified-by-agent\n", "utf-8");
			const diffs = diffWorktrees(setup, ["agent-a"], path.join(repoDir, "artifacts", "hook-diff"));
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /\.env\.local/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleans up created worktrees when a later hook setup fails", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-cleanup-");
		const runId = `hook-cleanup-${Date.now().toString(36)}`;
		const hookPath = createHookScript(repoDir, "flaky-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
if (payload.index === 1) {
	console.error("intentional failure");
	process.exit(1);
}
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 2, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/worktree setup hook failed with exit code 1/i,
			);
			const branchList = git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]);
			assert.equal(branchList.trim(), "", "temporary branches should be cleaned up after setup failure");
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("fails when the hook exceeds the configured timeout", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-timeout-");
		const hookPath = createHookScript(repoDir, "slow-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
setTimeout(() => {
	process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
}, 1000);
`);
		const runId = `hook-timeout-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, {
					setupHook: { hookPath: path.relative(repoDir, hookPath), timeoutMs: 50 },
				}),
				/timed out/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});
});
