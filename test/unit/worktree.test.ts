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
	buildWorktreeNaming,
	normalizeWorktreeBranchPrefix,
	resolveExpectedWorktreeAgentCwd,
	resolveWorktreeProvider,
	sanitizeWorktreePathComponent,
	shouldDeferWorktreeCwd,
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
const worktrunkShimSkip = process.platform === "win32"
	? "Windows Terminal installs a wt.exe app alias that can outrank test command shims."
	: undefined;

describe("worktree", () => {
	it("createWorktrees returns expected structure", () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "structure", 2, { provider: "native" });
			assert.equal(setup.worktrees.length, 2);
			assert.equal(setup.cwd, git(repoDir, ["rev-parse", "--show-toplevel"]));
			for (let i = 0; i < setup.worktrees.length; i++) {
				const worktree = setup.worktrees[i]!;
				assert.equal(worktree.branch, `pi-subagents/task-structure-s0-t${i}`);
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

	it("invokes beforeCreate with deterministic ownership metadata before creating worktrees", () => {
		const repoDir = createRepo("pi-worktree-before-create-");
		let setup: WorktreeSetup | undefined;
		let planned: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "before-create", 1, {
				provider: "native",
				beforeCreate: (candidate) => {
					planned = candidate;
					assert.equal(fs.existsSync(candidate.worktrees[0]!.path), false);
					assert.equal(candidate.worktrees[0]!.branch, "pi-subagents/task-before-creat-s0-t0");
				},
			});
			assert.equal(planned?.baseCommit, setup.baseCommit);
			assert.equal(planned?.worktrees[0]?.path, setup.worktrees[0]?.path);
			assert.equal(fs.existsSync(setup.worktrees[0]!.path), true);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("records Worktrunk ownership and uses its returned path", () => {
		try { resolveWorktreeProvider("worktrunk"); } catch { return; }
		const repoDir = createRepo("pi-worktree-worktrunk-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "worktrunk-s0", 1, {
				provider: "worktrunk",
				agents: ["worker"],
				labels: ["Review API"],
				tasks: ["Review API behavior"],
				branchPrefix: "pi-test/",
			});
			const worktree = setup.worktrees[0]!;
			assert.equal(worktree.provider, "worktrunk");
			assert.equal(worktree.branch, "pi-test/Review-API-1f1a55a7-worktrunk-s0-t0");
			assert.equal(worktree.naming?.requestedBranch, worktree.branch);
			assert.ok(fs.existsSync(worktree.path));
			assert.notEqual(worktree.path, resolveExpectedWorktreeAgentCwd(repoDir, "worktrunk-s0", 0));
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("rejects Worktrunk responses that point at the source checkout", { skip: worktrunkShimSkip }, () => {
		const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-fake-source-wt-"));
		const fakeScript = path.join(fakeBin, "wt.cjs");
		const fakeWt = path.join(fakeBin, process.platform === "win32" ? "wt.cmd" : "wt");
		fs.writeFileSync(fakeScript, `const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("wt v0.75.0"); process.exit(0); }
if (args[0] === "switch" && args[1] === "--help") { console.log("--create --base --no-cd --no-hooks --format"); process.exit(0); }
const repo = args[args.indexOf("-C") + 1];
const branch = args[args.indexOf("--create") + 1];
const base = args[args.indexOf("--base") + 1];
const result = spawnSync("git", ["-C", repo, "checkout", "-b", branch], { encoding: "utf-8" });
if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }
console.log(JSON.stringify({ action: "created", branch, path: repo, created_branch: true, base_branch: base }));
`, "utf-8");
		if (process.platform === "win32") fs.writeFileSync(fakeWt, `@echo off\r\n"${process.execPath}" "%~dp0wt.cjs" %*\r\n`, "utf-8");
		else {
			fs.writeFileSync(fakeWt, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, "utf-8");
			fs.chmodSync(fakeWt, 0o755);
		}
		const previousPath = process.env.PATH;
		const previousWindowsPath = process.env.Path;
		const previousPathExt = process.env.PATHEXT;
		const repoDir = createRepo("pi-worktree-source-wt-");
		try {
			const originalBranch = git(repoDir, ["branch", "--show-current"]);
			process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
			process.env.Path = `${fakeBin}${path.delimiter}${previousWindowsPath ?? previousPath ?? ""}`;
			process.env.PATHEXT = [".CMD", ".EXE", ".BAT", previousPathExt ?? ""].filter(Boolean).join(path.delimiter);
			assert.throws(
				() => createWorktrees(repoDir, "source-path", 1, { provider: "worktrunk" }),
				/source checkout path/i,
			);
			assert.equal(git(repoDir, ["branch", "--show-current"]), originalBranch);
			assert.equal(git(repoDir, ["branch", "--list", "pi-subagents/task-source-path-s0-t0"]), "");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousWindowsPath === undefined) delete process.env.Path;
			else process.env.Path = previousWindowsPath;
			if (previousPathExt === undefined) delete process.env.PATHEXT;
			else process.env.PATHEXT = previousPathExt;
			cleanupRepo(repoDir);
			fs.rmSync(fakeBin, { recursive: true, force: true });
		}
	});

	it("falls back to native only when Worktrunk capability probing fails", () => {
		const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-fake-wt-"));
		const fakeWt = path.join(fakeBin, process.platform === "win32" ? "wt.cmd" : "wt");
		fs.writeFileSync(fakeWt, process.platform === "win32" ? "@echo not-worktrunk\r\n" : "#!/bin/sh\nprintf 'not-worktrunk\\n'\n", "utf-8");
		if (process.platform !== "win32") fs.chmodSync(fakeWt, 0o755);
		const previousPath = process.env.PATH;
		const previousWindowsPath = process.env.Path;
		const previousPathExt = process.env.PATHEXT;
		const repoDir = createRepo("pi-worktree-provider-fallback-");
		let setup: WorktreeSetup | undefined;
		try {
			process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
			process.env.Path = `${fakeBin}${path.delimiter}${previousWindowsPath ?? previousPath ?? ""}`;
			process.env.PATHEXT = [".CMD", ".EXE", ".BAT", previousPathExt ?? ""].filter(Boolean).join(path.delimiter);
			assert.equal(resolveWorktreeProvider(undefined), "native");
			assert.equal(shouldDeferWorktreeCwd(undefined), true);
			assert.equal(resolveWorktreeProvider(undefined, " "), "native");
			assert.equal(shouldDeferWorktreeCwd(undefined, " "), false);
			assert.throws(() => createWorktrees(repoDir, "provider-fallback", 1, { baseDir: " " }), /cannot be empty/i);
			setup = createWorktrees(repoDir, "provider-fallback", 1);
			assert.equal(setup.worktrees[0]?.provider, "native");
			assert.throws(() => resolveWorktreeProvider("worktrunk"), /Worktrunk provider is unavailable/i);
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousWindowsPath === undefined) delete process.env.Path;
			else process.env.Path = previousWindowsPath;
			if (previousPathExt === undefined) delete process.env.PATHEXT;
			else process.env.PATHEXT = previousPathExt;
			cleanupRepo(repoDir);
			fs.rmSync(fakeBin, { recursive: true, force: true });
		}
	});

	it("sanitizes readable names and validates provider branch namespaces", () => {
		const naming = buildWorktreeNaming({
			runId: "run-s3",
			index: 4,
			agent: "worker",
			task: "Fix: API / paths",
			branchPrefix: "pi-custom",
		});
		assert.equal(naming.requestedBranch, "pi-custom/worker-Fix-API-paths-17ad7139-run-s3-t4");
		assert.equal(naming.branchPrefix, "pi-custom/");
		assert.equal(sanitizeWorktreePathComponent("..."), "task");
		assert.ok(Buffer.byteLength(sanitizeWorktreePathComponent("é".repeat(200)), "utf-8") <= 96);
		assert.equal(buildWorktreeNaming({ runId: "run", index: 0, agent: "worker", task: "Fix\nAPI" }).label, "worker-Fix API");
		assert.equal(normalizeWorktreeBranchPrefix("pi-custom/"), "pi-custom/");
		assert.throws(() => normalizeWorktreeBranchPrefix("../unsafe"), /invalid/i);
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

	it("creates worktrees under a configured base directory", () => {
		const repoDir = createRepo("pi-worktree-base-dir-");
		const baseDir = path.join(os.tmpdir(), `pi-worktree-base-${Date.now().toString(36)}`, "nested");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "base-dir", 1, { baseDir });
			assert.equal(setup.worktrees[0]!.path, path.join(baseDir, "pi-worktree-base-dir-0"));
			assert.ok(fs.existsSync(baseDir), "configured base directory should be created");
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
			fs.rmSync(path.dirname(baseDir), { recursive: true, force: true });
		}
	});

	it("rejects worktree base directories inside Pi extensions", () => {
		const repoDir = createRepo("pi-worktree-extension-dir-");
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-home-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const extensionsDir = path.join(tempHome, ".pi", "agent", "extensions");
		try {
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;
			delete process.env.PI_CODING_AGENT_DIR;
			assert.throws(
				() => createWorktrees(repoDir, "extension-dir", 1, { baseDir: extensionsDir }),
				/worktree base directory cannot be inside Pi extensions directory/i,
			);
			assert.throws(
				() => createWorktrees(repoDir, "extension-subdir", 1, { baseDir: path.join(extensionsDir, "checkout") }),
				/worktree base directory cannot be inside Pi extensions directory/i,
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			cleanupRepo(repoDir);
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("rejects symlinked worktree base directories inside Pi extensions", () => {
		const repoDir = createRepo("pi-worktree-extension-symlink-");
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-home-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const extensionsDir = path.join(tempHome, ".pi", "agent", "extensions");
		const aliasDir = path.join(tempHome, "extension-alias");
		try {
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;
			delete process.env.PI_CODING_AGENT_DIR;
			fs.mkdirSync(extensionsDir, { recursive: true });
			fs.symlinkSync(extensionsDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
			assert.throws(
				() => createWorktrees(repoDir, "extension-symlink", 1, { baseDir: path.join(aliasDir, "checkout") }),
				/worktree base directory cannot be inside Pi extensions directory/i,
			);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			cleanupRepo(repoDir);
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("uses PI_SUBAGENTS_WORKTREE_DIR when no base directory is configured", () => {
		const repoDir = createRepo("pi-worktree-env-base-dir-");
		const previous = process.env.PI_SUBAGENTS_WORKTREE_DIR;
		const baseDir = path.join(os.tmpdir(), `pi-worktree-env-base-${Date.now().toString(36)}`);
		let setup: WorktreeSetup | undefined;
		try {
			process.env.PI_SUBAGENTS_WORKTREE_DIR = baseDir;
			setup = createWorktrees(repoDir, "env-base-dir", 1);
			assert.equal(setup.worktrees[0]!.path, path.join(baseDir, "pi-worktree-env-base-dir-0"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			if (previous === undefined) {
				delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
			} else {
				process.env.PI_SUBAGENTS_WORKTREE_DIR = previous;
			}
			cleanupRepo(repoDir);
			fs.rmSync(baseDir, { recursive: true, force: true });
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

	it("createWorktrees ignores pi-subagents runtime artifacts in the source checkout", () => {
		const repoDir = createRepo("pi-worktree-runtime-artifacts-");
		let setup: WorktreeSetup | undefined;
		try {
			fs.mkdirSync(path.join(repoDir, ".pi/subagents", "missions"), { recursive: true });
			fs.writeFileSync(path.join(repoDir, ".pi/subagents", "missions", "mission.json"), "{}\n", "utf-8");
			setup = createWorktrees(repoDir, "runtime-artifacts", 1);
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
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
			setup = createWorktrees(repoDir, `diff-${process.pid}`, 1);
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
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
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
			const cleanup = cleanupWorktrees(setup);
			setup = undefined;
			assert.equal(cleanup.state, "complete");
			assert.equal(cleanup.pruned, true);
			assert.equal(cleanup.tasks.length, 2);
			assert.ok(cleanup.tasks.every((task) => task.worktreeRemoved && task.branchRemoved));

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

	it("preserves dirty worktrees when no patch was captured", () => {
		const repoDir = createRepo("pi-worktree-uncaptured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "uncaptured", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "uncaptured\n", "utf-8");

			const cleanup = cleanupWorktrees(setup);
			assert.equal(cleanup.state, "partial");
			assert.equal(cleanup.tasks[0]?.preserved, true);
			assert.match(cleanup.tasks[0]?.reason ?? "", /not represented by a captured handoff patch/);
			assert.equal(fs.existsSync(worktree.path), true);
			assert.notEqual(git(repoDir, ["branch", "--list", worktree.branch]), "");

			const unconfirmed = cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "policy" } });
			assert.equal(unconfirmed.state, "partial");
			assert.match(unconfirmed.tasks[0]?.reason ?? "", /confirmation/);
			const discarded = cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "confirmed" } });
			assert.equal(discarded.state, "complete");
			setup = undefined;
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("preserves committed branch work when no patch was captured", () => {
		const repoDir = createRepo("pi-worktree-committed-uncaptured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "committed-uncaptured", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.txt"), "unlanded commit\n", "utf-8");
			git(worktree.path, ["add", "committed.txt"]);
			git(worktree.path, ["commit", "-m", "unlanded work"]);
			assert.equal(git(worktree.path, ["status", "--porcelain"]), "");

			const cleanup = cleanupWorktrees(setup);
			assert.equal(cleanup.state, "partial");
			assert.equal(cleanup.tasks[0]?.preserved, true);
			assert.equal(fs.existsSync(worktree.path), true);

			cleanupWorktrees(setup, { kind: "discard", authorization: { kind: "confirmed" } });
			setup = undefined;
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("removes dirty worktrees only after their captured patch is recorded in the handoff manifest", () => {
		const repoDir = createRepo("pi-worktree-captured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "captured", 1);
			const worktreePath = setup.worktrees[0]!.path;
			fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "captured\n", "utf-8");
			const diffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "captured"));
			assert.equal(diffs[0]?.error, undefined);
			assert.ok(fs.statSync(diffs[0]!.patchPath).size > 0);

			const withoutManifest = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs });
			assert.equal(withoutManifest.state, "partial");
			assert.equal(fs.existsSync(worktreePath), true);

			const handoffManifestPath = path.join(repoDir, "artifacts", "handoff.json");
			fs.writeFileSync(handoffManifestPath, JSON.stringify({
				version: 1,
				groups: [{ children: [{ patch: { path: diffs[0]!.patchPath } }] }],
			}), "utf-8");
			const cleanup = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath });
			assert.equal(cleanup.state, "complete");
			assert.equal(fs.existsSync(worktreePath), false);
			setup = undefined;
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
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
			setup = createWorktrees(repoDir, `tracked-node-modules-${process.pid}`, 1);
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, false);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, []);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "tracked-node-modules-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);
			assert.equal(fs.lstatSync(path.join(setup.worktrees[0]!.path, "node_modules")).isSymbolicLink(), true);
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
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
			setup = createWorktrees(repoDir, `hook-diff-${process.pid}`, 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified-by-agent\n", "utf-8");
			const diffs = diffWorktrees(setup, ["agent-a"], path.join(repoDir, "artifacts", "hook-diff"));
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /\.env\.local/);
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
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
			const branchList = git(repoDir, ["branch", "--list", "pi-subagents/task-hook-cleanup-s0-t*"]);
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

describe("manifest-backed worktree discard", () => {
	it("keeps incomplete cleanup actionable with exact manual Git commands", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-discard-manifest-"));
		try {
			const manifestPath = path.join(root, "handoff.json");
			const worktreePath = path.join(root, "preserved-worktree");
			fs.mkdirSync(worktreePath);
			fs.writeFileSync(manifestPath, JSON.stringify({
				version: 1,
				runId: "discard-run",
				mode: "parallel",
				source: "foreground",
				cwd: root,
				createdAt: 1,
				updatedAt: 1,
				groups: [{
					stepIndex: 0,
					baseCommit: "deadbeef",
					repoRoot: root,
					children: [],
					cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: worktreePath, branch: "pi-parallel-discard", worktreeRemoved: false, branchRemoved: false, preserved: true }] },
				}],
			}), "utf-8");
			const { discardPreservedWorktrees } = await import("../../src/runs/shared/parallel-handoff.ts");
			const discarded = discardPreservedWorktrees(manifestPath, { kind: "confirmed" });
			assert.match(discarded.text, /git -C .* worktree remove --force/);
			assert.match(discarded.text, /branch -D/);
			assert.equal(discarded.manifest.groups[0]?.cleanup.state, "partial");
			assert.equal(discarded.manifest.groups[0]?.cleanup.tasks[0]?.preserved, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
