import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	buildWorktreeNaming,
	normalizeWorktreeBaseRef,
	normalizeWorktreeBranchPrefix,
	resolveExpectedWorktreeAgentCwd,
	resolveWorktreeProvider,
	sanitizeWorktreePathComponent,
	shouldDeferWorktreeCwd,
	WorktreeSetupError,
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
	// Match Git's canonical top-level path for macOS symlinked temp roots.
	return fs.realpathSync(repoDir);
}

function cleanupRepo(repoDir: string, baseDir?: string): void {
	cleanupProjectWorktrees(repoDir, baseDir);
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

/** Removes only this repo's nested project folder; never the shared dedicated root. */
function cleanupProjectWorktrees(repoDir: string, baseDir?: string): void {
	const dedicatedRoot = baseDir ?? path.join(path.dirname(repoDir), "worktrees");
	try { fs.rmSync(path.join(dedicatedRoot, path.basename(repoDir)), { recursive: true, force: true }); } catch {}
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

// Unknown settlement intentionally poisons the process. Re-run only that case in
// an awaited real child so subsequent tests retain normal mutation admission.
async function runPoisonCaseInChild(name: string): Promise<boolean> {
	if (process.env.PI_WORKTREE_POISON_CASE === name) return false;
	await promisify(execFile)(process.execPath, [
		"--experimental-strip-types", "--import", "./test/support/register-loader.mjs",
		"--test", `--test-name-pattern=${name}`, fileURLToPath(import.meta.url),
	], { env: { ...process.env, NODE_TEST_CONTEXT: undefined, PI_WORKTREE_POISON_CASE: name } });
	return true;
}

function assertRetainedHookFailure(error: unknown, message: RegExp): true {
	assert.ok(error instanceof WorktreeSetupError);
	assert.match(error.message, message);
	assert.match(error.message, /manual reconciliation required/i);
	assert.ok(error.snapshot.unknown);
	assert.equal(error.snapshot.cleanup?.state, "partial");
	assert.equal(error.snapshot.cleanup?.pruned, false);
	const worktree = error.snapshot.setup.worktrees[0]!;
	assert.ok(worktree);
	assert.equal(error.snapshot.attempts[0]?.validated, true);
	assert.equal(fs.existsSync(worktree.path), true);
	assert.equal(git(worktree.path, ["branch", "--show-current"]), worktree.branch);
	assert.equal(fs.readFileSync(path.join(worktree.path, "tracked.txt"), "utf-8"), "initial\n");
	assert.throws(() => cleanupWorktrees(error.snapshot.setup, { kind: "setup-rollback" }), /Worktree mutation blocked/i);
	assert.equal(fs.existsSync(worktree.path), true);
	return true;
}

describe("worktree", () => {
	it("createWorktrees returns expected structure", async () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "structure", 2, { provider: "native" });
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

	it("reports attempted ownership before spawn and only validated worktrees after allocation", async () => {
		const repoDir = createRepo("pi-worktree-before-create-");
		let setup: WorktreeSetup | undefined;
		let attemptedPath: string | undefined;
		let validated: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "before-create", 1, {
				provider: "native",
				onProgress: (snapshot) => {
					const attempt = snapshot.attempts[0];
					if (attempt && !attempt.command?.pid && !attempt.validated) {
						attemptedPath = attempt.path;
						assert.ok(attemptedPath);
						assert.equal(fs.existsSync(attemptedPath), false);
						assert.equal(attempt.branch, "pi-subagents/task-before-creat-s0-t0");
						assert.deepEqual(snapshot.setup.worktrees, []);
					}
					if (snapshot.setup.worktrees.length) {
						assert.equal(attempt?.validated, true);
						validated = snapshot.setup;
					}
				},
			});
			assert.equal(attemptedPath, setup.worktrees[0]?.path);
			assert.equal(validated?.baseCommit, setup.baseCommit);
			assert.equal(validated?.worktrees[0]?.path, setup.worktrees[0]?.path);
			assert.equal(fs.existsSync(setup.worktrees[0]!.path), true);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("compensates a rejected ready publication without retaining command output in snapshots", async () => {
		const repoDir = createRepo("pi-worktree-ready-rejected-");
		try {
			await assert.rejects(() => createWorktrees(repoDir, "ready-rejected", 1, {
				provider: "native",
				onProgress: (snapshot) => {
					if (snapshot.command?.result) {
						assert.equal("stdout" in snapshot.command.result, false);
						assert.equal("stderr" in snapshot.command.result, false);
					}
					if (snapshot.phase === "ready") throw new Error("ready publication rejected");
				},
			}), (error: unknown) => {
				assert.ok(error instanceof WorktreeSetupError);
				assert.match(error.message, /ready publication rejected/);
				assert.equal(error.snapshot.cleanup?.state, "complete");
				assert.equal(error.snapshot.cleanup.tasks.length, 1);
				const task = error.snapshot.cleanup.tasks[0]!;
				assert.equal(task.worktreeRemoved, true);
				assert.equal(task.branchRemoved, true);
				assert.equal(fs.existsSync(task.path), false);
				assert.equal(git(repoDir, ["branch", "--list", task.branch]), "");
				return true;
			});
		} finally { cleanupRepo(repoDir); }
	});

	it("records Worktrunk ownership and uses its returned path", async () => {
		try { resolveWorktreeProvider("worktrunk"); } catch { return; }
		const repoDir = createRepo("pi-worktree-worktrunk-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "worktrunk-s0", 1, {
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

	it("rejects Worktrunk responses that point at the source checkout", { skip: worktrunkShimSkip }, async () => {
		if (await runPoisonCaseInChild("rejects Worktrunk responses that point at the source checkout")) return;
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
			const originalHead = git(repoDir, ["rev-parse", "HEAD"]);
			process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
			process.env.Path = `${fakeBin}${path.delimiter}${previousWindowsPath ?? previousPath ?? ""}`;
			process.env.PATHEXT = [".CMD", ".EXE", ".BAT", previousPathExt ?? ""].filter(Boolean).join(path.delimiter);
			await assert.rejects(
				() => createWorktrees(repoDir, "source-path", 1, { provider: "worktrunk" }),
				(error: unknown) => {
					assert.ok(error instanceof WorktreeSetupError);
					assert.match(error.message, /source checkout path/i);
					assert.match(error.message, /manual reconciliation required/i);
					assert.ok(error.snapshot.unknown);
					assert.deepEqual(error.snapshot.setup.worktrees, []);
					assert.equal(error.snapshot.attempts[0]?.validated, false);
					assert.equal(error.snapshot.attempts[0]?.branch, "pi-subagents/task-source-path-s0-t0");
					assert.equal(error.snapshot.cleanup?.pruned, false);
					return true;
				},
			);
			// Invalid output grants no authority to restore or delete source state.
			assert.equal(git(repoDir, ["branch", "--show-current"]), "pi-subagents/task-source-path-s0-t0");
			assert.equal(git(repoDir, ["rev-parse", "HEAD"]), originalHead);
			assert.equal(fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf-8"), "initial\n");
			await assert.rejects(() => createWorktrees(repoDir, "after-unknown", 1, { provider: "native" }), /unknown|manual reconciliation/i);
			assert.equal(git(repoDir, ["branch", "--list", "pi-subagents/task-after-unknow-s0-t0"]), "");
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

	it("falls back to native only when Worktrunk capability probing fails", async () => {
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
			await assert.rejects(() => createWorktrees(repoDir, "provider-fallback", 1, { baseDir: " " }), /cannot be empty/i);
			setup = await createWorktrees(repoDir, "provider-fallback", 1);
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

	it("createWorktrees maps subdirectory cwd to each agentCwd", async () => {
		const repoDir = createRepo("pi-worktree-subdir-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(nestedDir, "subdir", 1);
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
			const repoRoot = git(nestedDir, ["rev-parse", "--show-toplevel"]);
			assert.equal(
				resolveExpectedWorktreeAgentCwd(nestedDir, "preview", 2),
				path.join(
					path.dirname(repoRoot),
					"worktrees",
					path.basename(repoRoot),
					"pi-worktree-preview-2",
					"packages",
					"app",
				),
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("creates worktrees under a configured base directory", async () => {
		const repoDir = createRepo("pi-worktree-base-dir-");
		const baseDir = path.join(os.tmpdir(), `pi-worktree-base-${Date.now().toString(36)}`, "nested");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "base-dir", 1, { baseDir });
			assert.equal(
				setup.worktrees[0]!.path,
				path.join(baseDir, path.basename(repoDir), "pi-worktree-base-dir-0"),
			);
			assert.ok(fs.existsSync(baseDir), "configured base directory should be created");
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir, baseDir);
		}
	});

	it("rejects worktree base directories inside Pi extensions", async () => {
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
			await assert.rejects(
				() => createWorktrees(repoDir, "extension-dir", 1, { baseDir: extensionsDir }),
				/worktree base directory cannot be inside Pi extensions directory/i,
			);
			await assert.rejects(
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

	it("rejects symlinked worktree base directories inside Pi extensions", async () => {
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
			await assert.rejects(
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

	it("rejects a final project directory inside Pi extensions", async () => {
		const sourceRepo = createRepo("pi-worktree-extension-project-");
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-home-"));
		const repoDir = path.join(tempHome, "extensions");
		const agentDir = path.join(tempHome, ".pi", "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		try {
			fs.renameSync(sourceRepo, repoDir);
			fs.mkdirSync(extensionsDir, { recursive: true });
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;

			await assert.rejects(
				() => createWorktrees(repoDir, "extension-project", 1, { provider: "native", baseDir: agentDir }),
				/worktree path cannot be inside Pi extensions directory/i,
			);
			assert.throws(
				() => resolveExpectedWorktreeAgentCwd(repoDir, "extension-project", 0, agentDir),
				/worktree path cannot be inside Pi extensions directory/i,
			);
			assert.deepEqual(git(repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")), [`worktree ${git(repoDir, ["rev-parse", "--show-toplevel"])}`]);
			assert.deepEqual(fs.readdirSync(extensionsDir), []);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			cleanupRepo(repoDir);
			cleanupRepo(sourceRepo);
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("rejects a project directory symlink into Pi extensions", async () => {
		const repoDir = createRepo("pi-worktree-extension-project-symlink-");
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-home-"));
		const agentDir = path.join(tempHome, ".pi", "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		const baseDir = path.join(tempHome, "worktree-root");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		try {
			fs.mkdirSync(extensionsDir, { recursive: true });
			fs.mkdirSync(baseDir, { recursive: true });
			fs.symlinkSync(extensionsDir, path.join(baseDir, path.basename(repoDir)), process.platform === "win32" ? "junction" : "dir");
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;

			await assert.rejects(
				() => createWorktrees(repoDir, "extension-project-symlink", 1, { provider: "native", baseDir }),
				/worktree path cannot be inside Pi extensions directory/i,
			);
			assert.throws(
				() => resolveExpectedWorktreeAgentCwd(repoDir, "extension-project-symlink", 0, baseDir),
				/worktree path cannot be inside Pi extensions directory/i,
			);
			assert.deepEqual(git(repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")), [`worktree ${git(repoDir, ["rev-parse", "--show-toplevel"])}`]);
			assert.deepEqual(fs.readdirSync(extensionsDir), []);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			cleanupRepo(repoDir, baseDir);
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("uses PI_SUBAGENTS_WORKTREE_DIR when no base directory is configured", async () => {
		const repoDir = createRepo("pi-worktree-env-base-dir-");
		const previous = process.env.PI_SUBAGENTS_WORKTREE_DIR;
		const baseDir = path.join(os.tmpdir(), `pi-worktree-env-base-${Date.now().toString(36)}`);
		let setup: WorktreeSetup | undefined;
		try {
			process.env.PI_SUBAGENTS_WORKTREE_DIR = baseDir;
			setup = await createWorktrees(repoDir, "env-base-dir", 1);
			assert.equal(
				setup.worktrees[0]!.path,
				path.join(baseDir, path.basename(repoDir), "pi-worktree-env-base-dir-0"),
			);
		} finally {
			if (setup) cleanupWorktrees(setup);
			if (previous === undefined) {
				delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
			} else {
				process.env.PI_SUBAGENTS_WORKTREE_DIR = previous;
			}
			cleanupRepo(repoDir, baseDir);
		}
	});

	it("rejects empty worktree base directory", async () => {
		const repoDir = createRepo("pi-worktree-empty-base-");
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, "empty-base", 1, { baseDir: "   " }),
				/worktree base directory cannot be empty/,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects worktree paths that would land inside the repository checkout", async () => {
		const repoDir = createRepo("pi-worktree-inside-");
		const repoParent = path.dirname(repoDir);
		const leakedLeaf = "pi-worktree-inside-0";
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, "inside", 1, { baseDir: repoParent }),
				/inside the repository/i,
			);
			assert.throws(
				() => resolveExpectedWorktreeAgentCwd(repoDir, "inside", 0, repoParent),
				/inside the repository/i,
			);

			const porcelain = git(repoDir, ["worktree", "list", "--porcelain"]);
			const worktreeLines = porcelain.split("\n").filter((line) => line.startsWith("worktree "));
			assert.deepEqual(worktreeLines, [`worktree ${git(repoDir, ["rev-parse", "--show-toplevel"])}`]);
			assert.equal(fs.existsSync(path.join(repoDir, leakedLeaf)), false);
			assert.equal(fs.existsSync(path.join(repoParent, leakedLeaf)), false);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects worktree paths that are direct children of the repository parent", async () => {
		const repoDir = createRepo("pi-worktree-parent-child-");
		const repoParent = path.dirname(repoDir);
		const dedicatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-parent-child-root-"));
		const projectDir = path.join(dedicatedRoot, path.basename(repoDir));
		const leakedLeaf = path.join(repoParent, "pi-worktree-parent-child-0");
		try {
			fs.symlinkSync(repoParent, projectDir, process.platform === "win32" ? "junction" : "dir");
			await assert.rejects(
				() => createWorktrees(repoDir, "parent-child", 1, { baseDir: dedicatedRoot }),
				/direct child of the repository parent/i,
			);
			assert.throws(
				() => resolveExpectedWorktreeAgentCwd(repoDir, "parent-child", 0, dedicatedRoot),
				/direct child of the repository parent/i,
			);

			const porcelain = git(repoDir, ["worktree", "list", "--porcelain"]);
			const worktreeLines = porcelain.split("\n").filter((line) => line.startsWith("worktree "));
			assert.deepEqual(worktreeLines, [`worktree ${git(repoDir, ["rev-parse", "--show-toplevel"])}`]);
			assert.equal(fs.existsSync(leakedLeaf), false);
		} finally {
			try { fs.rmSync(leakedLeaf, { recursive: true, force: true }); } catch {}
			fs.rmSync(dedicatedRoot, { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("does not mkdir inside the checkout when rejecting unsafe locations", async () => {
		const repoDir = createRepo("pi-worktree-no-mkdir-inside-");
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, "inside-self", 1, { baseDir: repoDir }),
				/inside the repository/i,
			);
			assert.throws(
				() => resolveExpectedWorktreeAgentCwd(repoDir, "inside-self", 0, repoDir),
				/inside the repository/i,
			);
			assert.equal(fs.existsSync(path.join(repoDir, path.basename(repoDir))), false);

			await assert.rejects(
				() => createWorktrees(repoDir, "rel-worktrees", 1, { baseDir: "worktrees" }),
				/inside the repository/i,
			);
			assert.equal(fs.existsSync(path.join(repoDir, "worktrees")), false);
			assert.equal(fs.existsSync(path.join(repoDir, "worktrees", path.basename(repoDir))), false);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees rejects dirty repositories before resolving the requested base ref", async () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		try {
			fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
			await assert.rejects(
				() => createWorktrees(repoDir, "dirty", 1, { baseRef: "unsafe..ref" }),
				/worktree isolation requires a clean git working tree/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("allocates from baseRef while preserving source HEAD and propagating baseCommit to hooks and diffs", { skip: hookScriptSkip }, async () => {
		const repoDir = createRepo("pi-worktree-base-ref-");
		const firstCommit = git(repoDir, ["rev-parse", "HEAD"]);
		git(repoDir, ["branch", "release"]);
		fs.writeFileSync(path.join(repoDir, "tracked.txt"), "second\n", "utf-8");
		git(repoDir, ["add", "tracked.txt"]);
		git(repoDir, ["commit", "-m", "second commit"]);
		const sourceHead = git(repoDir, ["rev-parse", "HEAD"]);
		const hookPath = createHookScript(repoDir, "base-ref-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.writeFileSync(payload.worktreePath + "/.base-commit", payload.baseCommit + "\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".base-commit"] }));
`);
	let setup: WorktreeSetup | undefined;
	try {
		setup = await createWorktrees(repoDir, "base-ref", 1, {
			provider: "native",
			baseRef: "release",
			setupHook: { hookPath: path.relative(repoDir, hookPath) },
		});
		const worktree = setup.worktrees[0]!;
		assert.equal(setup.baseCommit, firstCommit);
		assert.equal(git(worktree.path, ["rev-parse", "HEAD"]), firstCommit);
		assert.equal(git(repoDir, ["rev-parse", "HEAD"]), sourceHead);
		assert.equal(fs.readFileSync(path.join(worktree.path, ".base-commit"), "utf-8").trim(), firstCommit);
		fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "agent change\n", "utf-8");
		const diffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "base-ref"));
		assert.equal(diffs[0]?.error, undefined);
		assert.match(fs.readFileSync(diffs[0]!.patchPath, "utf-8"), /tracked\.txt/);
	} finally {
		if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
		cleanupRepo(repoDir);
	}
	});

	it("rejects unsafe and unresolved base refs before allocation", async () => {
		const repoDir = createRepo("pi-worktree-invalid-base-ref-");
		try {
			for (const baseRef of ["unsafe..ref", "branch name", "HEAD^{tree}", "@", "a".repeat(40), "a".repeat(64)] as const) {
				await assert.rejects(() => createWorktrees(repoDir, `invalid-${baseRef.length}`, 1, { provider: "native", baseRef }), /baseRef.*HEAD.*named ref.*40\/64-character commit IDs.*revision expressions.*unsupported/);
			}
			git(repoDir, ["tag", "tree-object", "HEAD^{tree}"]);
			await assert.rejects(() => createWorktrees(repoDir, "invalid-tree", 1, { provider: "native", baseRef: "tree-object" }), /could not be resolved to a commit/i);
			await assert.rejects(() => createWorktrees(repoDir, "invalid-missing", 1, { provider: "native", baseRef: "refs/heads/missing" }), /could not be resolved to a commit/i);
			assert.equal(git(repoDir, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees ignores pi-subagents runtime artifacts in the source checkout", async () => {
		const repoDir = createRepo("pi-worktree-runtime-artifacts-");
		let setup: WorktreeSetup | undefined;
		try {
			fs.mkdirSync(path.join(repoDir, ".pi/subagents", "missions"), { recursive: true });
			fs.writeFileSync(path.join(repoDir, ".pi/subagents", "missions", "mission.json"), "{}\n", "utf-8");
			setup = await createWorktrees(repoDir, "runtime-artifacts", 1);
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

	it("diffWorktrees captures committed, modified, and new files without staging the node_modules symlink", async () => {
		const repoDir = createRepo("pi-worktree-diff-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, `diff-${process.pid}`, 1);
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

	it("captures applyable patches despite external diffs and display configuration", { skip: hookScriptSkip }, async () => {
		const repoDir = createRepo("pi-worktree-diff-external-");
		const externalDiffPath = createHookScript(repoDir, "external-diff.mjs", `
process.stdout.write("corrupt external diff output\\n");
`);
		let setup: WorktreeSetup | undefined;
		try {
			git(repoDir, ["config", "diff.external", externalDiffPath]);
			git(repoDir, ["config", "color.ui", "always"]);
			git(repoDir, ["config", "diff.noprefix", "true"]);
			git(repoDir, ["config", "diff.linePrefix", "corrupt display prefix "]);
			git(repoDir, ["config", "diff.relative", "true"]);
			setup = await createWorktrees(repoDir, "diff-external", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "external-safe\n", "utf-8");

			const diffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "external"));
			assert.equal(diffs[0]?.error, undefined);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /^diff --git a\/tracked\.txt b\/tracked\.txt/m);
			assert.doesNotMatch(patch, /corrupt external diff output|corrupt display prefix|\u001b/);
			assert.equal(git(worktree.path, ["apply", "--check", "--cached", "--reverse", diffs[0]!.patchPath]), "");
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("includes binary data in captured patches", async () => {
		const repoDir = createRepo("pi-worktree-diff-binary-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "diff-binary", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "binary.dat"), Buffer.from([0, 1, 2, 255, 0, 3]));

			const diffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "binary"));
			assert.equal(diffs[0]?.error, undefined);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /GIT binary patch/);
			assert.equal(git(worktree.path, ["apply", "--check", "--cached", "--reverse", diffs[0]!.patchPath]), "");
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees removes worktrees and branches", async () => {
		const repoDir = createRepo("pi-worktree-cleanup-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "cleanup", 2);
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

	it("preserves dirty worktrees when no patch was captured", async () => {
		const repoDir = createRepo("pi-worktree-uncaptured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "uncaptured", 1);
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

	it("preserves committed branch work when no patch was captured", async () => {
		const repoDir = createRepo("pi-worktree-committed-uncaptured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "committed-uncaptured", 1);
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

	it("does not let trusted external diff hide uncaptured committed work during cleanup", { skip: hookScriptSkip }, async () => {
		const repoDir = createRepo("pi-worktree-cleanup-external-diff-");
		const externalDiffPath = createHookScript(repoDir, "external-diff-clean.mjs", "process.exit(0);");
		let setup: WorktreeSetup | undefined;
		try {
			git(repoDir, ["config", "diff.external", externalDiffPath]);
			git(repoDir, ["config", "diff.trustExitCode", "true"]);
			setup = await createWorktrees(repoDir, "cleanup-external-diff", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.txt"), "unlanded work\n", "utf-8");
			git(worktree.path, ["add", "committed.txt"]);
			git(worktree.path, ["commit", "-m", "unlanded work"]);

			const cleanup = cleanupWorktrees(setup);
			assert.equal(cleanup.state, "partial");
			assert.equal(cleanup.tasks[0]?.preserved, true);
			assert.match(cleanup.tasks[0]?.reason ?? "", /not represented by a captured handoff patch/);
			assert.equal(fs.existsSync(worktree.path), true);
			assert.notEqual(git(repoDir, ["branch", "--list", worktree.branch]), "");
		} finally {
			if (setup) cleanupWorktrees(setup, { kind: "setup-rollback" });
			cleanupRepo(repoDir);
		}
	});

	it("removes dirty worktrees only after their captured patch is recorded in the handoff manifest", async () => {
		const repoDir = createRepo("pi-worktree-captured-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "captured", 1);
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
			fs.writeFileSync(diffs[0]!.patchPath, "corrupt patch\n", "utf-8");
			const invalidPatch = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath });
			assert.equal(invalidPatch.state, "partial");
			assert.match(invalidPatch.tasks[0]?.reason ?? "", /failed validation/);
			assert.equal(fs.existsSync(worktreePath), true);

			const validatedDiffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "captured"));
			fs.writeFileSync(path.join(worktreePath, "late.txt"), "late\n", "utf-8");
			const stalePatch = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: validatedDiffs, handoffManifestPath });
			assert.equal(stalePatch.state, "partial");
			assert.match(stalePatch.tasks[0]?.reason ?? "", /does not match current worktree changes/);
			assert.equal(fs.existsSync(worktreePath), true);

			const currentDiffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "artifacts", "captured"));
			const cleanup = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: currentDiffs, handoffManifestPath });
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
	}, async () => {
		const repoDir = createRepo("pi-worktree-node-modules-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "node-modules", 1);
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
	}, async () => {
		const repoDir = createRepo("pi-worktree-tracked-node-modules-");
		const vendorDir = path.join(repoDir, "vendor-modules");
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.writeFileSync(path.join(vendorDir, "fixture.txt"), "fixture\n", "utf-8");
		fs.symlinkSync("vendor-modules", path.join(repoDir, "node_modules"));
		git(repoDir, ["add", "vendor-modules", "-f", "node_modules"]);
		git(repoDir, ["commit", "-m", "track node_modules symlink"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, `tracked-node-modules-${process.pid}`, 1);
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

	it("runs a repo-relative worktree setup hook and records synthetic paths", { skip: hookScriptSkip }, async () => {
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
			setup = await createWorktrees(repoDir, "hook-relative", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			assert.ok(setup.worktrees[0]!.syntheticPaths.includes(".venv"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs an absolute worktree setup hook path", { skip: hookScriptSkip }, async () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repoDir, "hook-absolute", 1, {
				setupHook: { hookPath },
			});
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("rejects bare command names for worktree setup hooks", async () => {
		const repoDir = createRepo("pi-worktree-hook-bare-");
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, "hook-bare", 1, { setupHook: { hookPath: "node" } }),
				/worktree setup hook must be an absolute path or a repo-relative path/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects tracked synthetic paths from hook output", { skip: hookScriptSkip }, async () => {
		if (await runPoisonCaseInChild("rejects tracked synthetic paths from hook output")) return;
		const repoDir = createRepo("pi-worktree-hook-tracked-");
		const hookPath = createHookScript(repoDir, "tracked-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["tracked.txt"] }));
`);
		const runId = `hook-tracked-${Date.now().toString(36)}`;
		let retained: WorktreeSetup | undefined;
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				(error: unknown) => {
					assert.ok(error instanceof WorktreeSetupError);
					retained = error.snapshot.setup;
					return assertRetainedHookFailure(error, /cannot mark tracked paths as synthetic/i);
				},
			);
		} finally {
			for (const worktree of retained?.worktrees ?? []) fs.rmSync(worktree.path, { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("rejects absolute synthetic paths from hook output", { skip: hookScriptSkip }, async () => {
		if (await runPoisonCaseInChild("rejects absolute synthetic paths from hook output")) return;
		const repoDir = createRepo("pi-worktree-hook-absolute-synthetic-");
		const hookPath = createHookScript(repoDir, "absolute-path-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [payload.worktreePath + "/.venv"] }));
`);
		const runId = `hook-absolute-synthetic-${Date.now().toString(36)}`;
		let retained: WorktreeSetup | undefined;
		try {
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				(error: unknown) => {
					assert.ok(error instanceof WorktreeSetupError);
					retained = error.snapshot.setup;
					return assertRetainedHookFailure(error, /synthetic path must be relative/i);
				},
			);
		} finally {
			for (const worktree of retained?.worktrees ?? []) fs.rmSync(worktree.path, { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("excludes hook-created synthetic files from captured patch output", { skip: hookScriptSkip }, async () => {
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
			setup = await createWorktrees(repoDir, `hook-diff-${process.pid}`, 1, {
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

	it("retains created worktrees when a later hook failure has unknown settlement", { skip: hookScriptSkip }, async () => {
		if (await runPoisonCaseInChild("retains created worktrees when a later hook failure has unknown settlement")) return;
		const repoDir = createRepo("pi-worktree-hook-cleanup-");
		const runId = `hook-cleanup-${Date.now().toString(36)}`;
		let retained: WorktreeSetup | undefined;
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
			await assert.rejects(
				() => createWorktrees(repoDir, runId, 2, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				(error: unknown) => {
					assert.ok(error instanceof WorktreeSetupError);
					retained = error.snapshot.setup;
					assertRetainedHookFailure(error, /worktree setup hook failed/i);
					assert.equal(error.snapshot.attempts[1]?.hookCommand?.result?.status, 1);
					assert.equal(error.snapshot.setup.worktrees.length, 2);
					for (const worktree of error.snapshot.setup.worktrees) {
						assert.equal(fs.existsSync(worktree.path), true);
						assert.equal(git(worktree.path, ["branch", "--show-current"]), worktree.branch);
					}
					return true;
				},
			);
			await assert.rejects(() => createWorktrees(repoDir, "after-hook-failure", 1, { provider: "native" }), /Worktree mutation blocked/i);
		} finally {
			for (const worktree of retained?.worktrees ?? []) fs.rmSync(worktree.path, { recursive: true, force: true });
			cleanupRepo(repoDir);
		}
	});

	it("fails when the hook exceeds the configured timeout", { skip: hookScriptSkip }, async () => {
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
			await assert.rejects(
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
