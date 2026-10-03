import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	__testables,
	buildWorktreeCleanupPlan,
	createWorktreeCleanupPlan,
	formatWorktreeCleanupPlan,
	type BuildWorktreeCleanupPlanInput,
	type WorktreeCleanupPlan,
} from "../../src/runs/shared/worktree-cleanup-plan.ts";
import { DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS } from "../../src/runs/background/active-run-index.ts";
import { cleanupWorktrees, createWorktrees, type WorktreeSetup } from "../../src/runs/shared/worktree.ts";
import { applyReviewedCleanupPlan, loadReviewedCleanupPlan } from "../../src/runs/shared/worktree-cleanup-apply.ts";
import { protectRetainedWorktreeForResume, readParallelHandoffManifest, writeParallelHandoffGroup } from "../../src/runs/shared/parallel-handoff.ts";
import { withRepositoryWorktreeLock } from "../../src/runs/shared/worktree-lock.ts";

async function cleanupFixture(run: (fixture: { repo: string; baseDir: string; setup: WorktreeSetup; manifestPath: string; planId: string }) => Promise<void>): Promise<void> {
	const repo = createRepo("pi-cleanup-apply-");
	const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-apply-base-"));
	let setup: WorktreeSetup | undefined;
	try {
		setup = await createWorktrees(repo, "apply", 1, { baseDir });
		const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
		writeManifest({ repo, manifestPath, setup });
		const { plan } = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" });
		await run({ repo, baseDir, setup, manifestPath, planId: plan.planId });
	} finally { removeGeneratedWorktrees(repo, setup); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(baseDir, { recursive: true, force: true }); }
}

function interruptCleanup(repo: string, planId: string, boundary: "after-intent" | "after-git" | "intent-write-failure"): void {
	const moduleUrl = new URL("../../src/runs/shared/worktree-cleanup-apply.ts", import.meta.url).href;
	const source = `
		import fs from 'node:fs';
		import { syncBuiltinESMExports } from 'node:module';
		import { applyReviewedCleanupPlan } from ${JSON.stringify(moduleUrl)};
		const rename = fs.renameSync;
		let injected = false;
		fs.renameSync = (from, to) => {
			if (String(to).endsWith('receipt.json')) {
				const entries = JSON.parse(fs.readFileSync(from, 'utf8')).entries;
				const boundary = ${JSON.stringify(boundary)};
				if (boundary === 'after-git' && entries.some(item => item.state === 'removed')) process.exit(73);
				if (boundary === 'after-intent' && entries.some(item => item.state === 'removing')) {
					rename(from, to);
					process.exit(72);
				}
				if (boundary === 'intent-write-failure' && !injected && entries.some(item => item.state === 'removing')) {
					injected = true;
					throw new Error('fixture: removal intent write failed');
				}
			}
			return rename(from, to);
		};
		syncBuiltinESMExports();
		await applyReviewedCleanupPlan({ ...JSON.parse(process.argv[1]), foregroundRunOwnership: () => 'terminal' });
	`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, JSON.stringify({ repo, planId, authorized: true })], { encoding: "utf-8", timeout: 30_000 });
	assert.equal(child.status, boundary === "after-git" ? 73 : boundary === "after-intent" ? 72 : 0, child.error?.message || child.stderr);
}

describe("reviewed cleanup apply", () => {
	it("removes the reviewed tree, retains its branch, records ownership facts and refuses replay", () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		const args = { repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" as const };
		const applied = await applyReviewedCleanupPlan(args);
		assert.equal(applied.receipt.state, "complete");
		assert.equal(applied.receipt.entries[0]?.state, "removed");
		assert.equal(fs.existsSync(setup.worktrees[0]!.path), false);
		assert.ok(git(repo, ["branch", "--list", setup.worktrees[0]!.branch]));
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.equal(manifest.groups[0].cleanup.tasks[0].worktreeRemoved, true);
		assert.equal(manifest.groups[0].cleanup.tasks[0].branchRemoved, false);
		assert.equal(manifest.createdAt, 1);
		assert.equal((await applyReviewedCleanupPlan(args)).reused, true);
	}));

	it("records removal for a relative handoff worktree path", () => cleanupFixture(async ({ repo, baseDir, setup, manifestPath }) => {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.groups[0].cleanup.tasks[0].path = path.relative(path.dirname(manifestPath), setup.worktrees[0]!.path);
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const { plan } = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" });
		const result = await applyReviewedCleanupPlan({ repo, planId: plan.planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.receipt.state, "complete");
		assert.equal(fs.existsSync(setup.worktrees[0]!.path), false);
		assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).groups[0].cleanup.tasks[0].worktreeRemoved, true);
	}));

	it("carries allocation-time base proof through pending handoff and preserved cleanup", () => cleanupFixture(async ({ repo, setup, manifestPath }) => {
		const recordedBaseDir = fs.realpathSync.native(path.dirname(setup.worktrees[0]!.path));
		assert.equal(setup.worktrees[0]!.recordedBaseDir, recordedBaseDir);
		const handoff = { manifestPath, runId: "cleanup-run", mode: "parallel" as const, source: "foreground" as const, cwd: repo, stepIndex: 0, flatStartIndex: 0, setup, diffs: [], results: [] };
		writeParallelHandoffGroup(handoff);
		assert.equal(readParallelHandoffManifest(manifestPath)!.groups[0]!.cleanup.tasks[0]!.recordedBaseDir, recordedBaseDir);
		const cleanup = cleanupWorktrees(setup, { kind: "preserve", cleanupBlocker: "fixture: retain pending worktree" });
		assert.equal(cleanup.tasks[0]!.recordedBaseDir, recordedBaseDir);
		writeParallelHandoffGroup({ ...handoff, cleanup });
		assert.equal(readParallelHandoffManifest(manifestPath)!.groups[0]!.cleanup.tasks[0]!.recordedBaseDir, recordedBaseDir);
	}));

	for (const beforePlanning of [true, false]) it(`keeps a worktree redirected through a symlinked ancestor before planning: ${beforePlanning}`, () => cleanupFixture(async ({ repo, baseDir, setup, manifestPath, planId }) => {
		const tree = setup.worktrees[0]!;
		const originalBase = fs.realpathSync.native(path.dirname(tree.path));
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.equal(tree.recordedBaseDir, originalBase);
		assert.equal(manifest.groups[0].cleanup.tasks[0].recordedBaseDir, originalBase);
		if (!beforePlanning) planId = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" }).plan.planId;
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-redirect-"));
		const redirectedBase = path.join(outside, "moved");
		fs.renameSync(originalBase, redirectedBase);
		try {
			fs.symlinkSync(redirectedBase, originalBase, process.platform === "win32" ? "junction" : "dir");
			if (beforePlanning) {
				const { plan } = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" });
				assert.notEqual(plan.entries[0]?.decision, "remove");
				assert.match(plan.entries[0]?.reasons.join(" ") ?? "", /creation|recorded base/i);
				assert.equal(plan.entries[0]?.preconditions.recordedBaseDir, originalBase);
				planId = plan.planId;
			}
			const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
			assert.ok(result.receipt.entries.every((entry) => entry.state !== "removing" && entry.state !== "removed"));
			assert.ok(fs.existsSync(path.join(redirectedBase, path.basename(tree.path))));
			assert.match(git(repo, ["worktree", "list", "--porcelain"]), new RegExp(tree.branch));
			assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).groups[0].cleanup.tasks[0].worktreeRemoved, false);
		} finally {
			if (fs.existsSync(originalBase)) fs.unlinkSync(originalBase);
			fs.renameSync(redirectedBase, originalBase);
			fs.rmSync(outside, { recursive: true, force: true });
		}
	}));

	for (const beforePlanning of [true, false]) for (const malformed of ["negative-index", "missing-patch"] as const) it(`keeps malformed handoff ${malformed} before planning: ${beforePlanning}`, () => cleanupFixture(async ({ repo, baseDir, setup, manifestPath, planId }) => {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		if (malformed === "negative-index") manifest.groups[0].children[0].index = -1;
		else delete manifest.groups[0].children[0].patch;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		if (beforePlanning) {
			const { plan } = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" });
			assert.notEqual(plan.entries[0]?.decision, "remove");
			assert.match(plan.warnings?.join(" ") ?? "", /invalid.*handoff|malformed/i);
			planId = plan.planId;
		}
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.ok(result.receipt.entries.every((entry) => entry.state !== "removing" && entry.state !== "removed"));
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
		assert.equal(fs.readFileSync(manifestPath, "utf-8"), JSON.stringify(manifest));
	}));

	for (const beforePlanning of [true, false]) it(`keeps a handoff without creation-base proof before planning: ${beforePlanning}`, () => cleanupFixture(async ({ repo, baseDir, setup, manifestPath, planId }) => {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		delete manifest.groups[0].cleanup.tasks[0].recordedBaseDir;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		if (beforePlanning) {
			const { plan } = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, foregroundRunOwnership: () => "terminal" });
			assert.notEqual(plan.entries[0]?.decision, "remove");
			assert.match(plan.entries[0]?.reasons.join(" ") ?? "", /creation.*base/i);
			planId = plan.planId;
		}
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.ok(result.receipt.entries.every((entry) => entry.state !== "removing" && entry.state !== "removed"));
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
	}));

	for (const drift of ["dirty", "ignored", "locked", "branch", "missing-artifact", "active"] as const) it(`keeps a reviewed tree after ${drift} drift`, () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		const tree = setup.worktrees[0]!;
		if (drift === "dirty") fs.writeFileSync(path.join(tree.path, "new.txt"), "valuable");
		if (drift === "ignored") {
			fs.writeFileSync(path.join(tree.path, ".gitignore"), "secret.env\n");
			git(tree.path, ["add", ".gitignore"]); git(tree.path, ["commit", "-m", "ignore secret"]);
			fs.writeFileSync(path.join(tree.path, "secret.env"), "fixture-value");
		}
		if (drift === "locked") git(repo, ["worktree", "lock", tree.path]);
		if (drift === "branch") { fs.writeFileSync(path.join(tree.path, "tracked.txt"), "changed"); git(tree.path, ["commit", "-am", "new work"]); }
		if (drift === "missing-artifact") fs.rmSync(manifestPath);
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => drift === "active" ? "active" : "terminal" });
		assert.equal(result.receipt.state, "partial");
		assert.ok(fs.existsSync(tree.path));
		if (drift === "locked") git(repo, ["worktree", "unlock", tree.path]);
	}));
	it("keeps a retained native session dependency without any Git drift", () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		const sessionPath = path.join(repo, "retained-session.jsonl");
		fs.writeFileSync(sessionPath, "fixture session");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.groups[0].children[0].sessionPath = sessionPath;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.receipt.entries[0]?.state, "kept");
		assert.match(result.receipt.entries[0]!.reason, /recorded session dependency/);
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
	}));

	for (const recreated of [false, true]) it(`reconciles journaled removal facts without deleting a recreated path: ${recreated}`, () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		const args = { repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" as const };
		const applied = await applyReviewedCleanupPlan(args);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.groups[0].cleanup.tasks[0].worktreeRemoved = false;
		manifest.groups[0].children[0].summary = "later evidence";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		applied.receipt.state = "applying";
		fs.writeFileSync(applied.receiptPath, JSON.stringify(applied.receipt));
		const tree = setup.worktrees[0]!;
		if (recreated) git(repo, ["worktree", "add", tree.path, tree.branch]);
		const result = await applyReviewedCleanupPlan(args);
		assert.equal(result.reused, true);
		assert.equal(result.receipt.state, "applying");
		const current = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.equal(current.groups[0].cleanup.tasks[0].worktreeRemoved, !recreated);
		assert.equal(current.groups[0].children[0].summary, "later evidence");
		assert.equal(fs.existsSync(tree.path), recreated);
	}));

	it("repairs an exit after Git removal but before the completed receipt is published", () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		interruptCleanup(repo, planId, "after-git");
		assert.equal(fs.existsSync(setup.worktrees[0]!.path), false);
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.equal(manifest.groups[0].cleanup.tasks[0].worktreeRemoved, false);
		manifest.groups[0].children[0].summary = "later evidence";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const args = { repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" as const };
		const repaired = await applyReviewedCleanupPlan(args);
		assert.equal(repaired.reused, true);
		assert.equal(repaired.receipt.state, "applying");
		assert.equal(repaired.receipt.entries.length, 1);
		assert.equal(repaired.receipt.entries[0]!.state, "removed");
		const current = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		assert.equal(current.groups[0].cleanup.tasks[0].worktreeRemoved, true);
		assert.equal(current.groups[0].children[0].summary, "later evidence");
		assert.ok(git(repo, ["show-ref", "--verify", `refs/heads/${setup.worktrees[0]!.branch}`]));
		assert.equal((await applyReviewedCleanupPlan(args)).receipt.entries.length, 1);
	}));

	for (const drift of ["none", "recreated", "registered", "ownership"] as const) it(`reconciles an interrupted intent conservatively after ${drift}`, () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		interruptCleanup(repo, planId, drift === "recreated" || drift === "ownership" ? "after-git" : "after-intent");
		const tree = setup.worktrees[0]!;
		if (drift === "recreated") {
			git(repo, ["worktree", "add", tree.path, tree.branch]);
			fs.writeFileSync(path.join(tree.path, "later-user-file"), "keep me");
		}
		if (drift === "registered") {
			fs.rmSync(tree.path, { recursive: true });
			assert.ok(git(repo, ["worktree", "list", "--porcelain"]).includes(tree.branch));
		}
		const args = { repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" as const };
		if (drift === "ownership") {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			manifest.runId = "new-owner";
			const latest = JSON.stringify(manifest);
			fs.writeFileSync(manifestPath, latest);
			await assert.rejects(applyReviewedCleanupPlan(args), /ownership changed/);
			assert.equal(fs.readFileSync(manifestPath, "utf-8"), latest);
		} else {
			const result = await applyReviewedCleanupPlan(args);
			assert.equal(result.receipt.entries.length, 1);
			assert.equal(result.receipt.entries[0]!.state, "removing");
			assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).groups[0].cleanup.tasks[0].worktreeRemoved, false);
			assert.equal(fs.existsSync(tree.path), drift !== "registered");
			if (drift === "recreated") assert.equal(fs.readFileSync(path.join(tree.path, "later-user-file"), "utf-8"), "keep me");
		}
	}));

	it("does not remove a worktree when recording its intent fails", () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		interruptCleanup(repo, planId, "intent-write-failure");
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true });
		assert.equal(result.receipt.state, "partial");
		assert.match(result.receipt.error ?? "", /intent write failed/);
		assert.equal(result.receipt.entries.length, 1);
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
		assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).groups[0].cleanup.tasks[0].worktreeRemoved, false);
	}));

	it("rejects unauthorized, expired and altered plans without claiming them", () => cleanupFixture(async ({ repo, planId }) => {
		await assert.rejects(applyReviewedCleanupPlan({ repo, planId, authorized: false }), /authorization/);
		const plan = loadReviewedCleanupPlan(repo, planId);
		assert.throws(() => loadReviewedCleanupPlan(repo, planId, plan.expiresAt), /expired/);
		const file = path.join(repo, ".pi", "subagents", "cleanup-plans", `${planId}.json`);
		plan.entries[0]!.branch = "changed";
		fs.writeFileSync(file, JSON.stringify(plan));
		await assert.rejects(applyReviewedCleanupPlan({ repo, planId, authorized: true }), /invalid|hash/);
		assert.equal(fs.existsSync(file.replace(/\.json$/, ".claim")), false);
	}));

	it("cancels before admission without deleting or claiming a plan", () => cleanupFixture(async ({ repo, setup, planId }) => {
		const controller = new AbortController(); controller.abort();
		await assert.rejects(applyReviewedCleanupPlan({ repo, planId, authorized: true, signal: controller.signal }), /abort/i);
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
	}));

	it("publishes a retained resume blocker under the shared repository lock", () => cleanupFixture(async ({ repo, setup, manifestPath, planId }) => {
		const cwd = await protectRetainedWorktreeForResume(manifestPath, "cleanup-run", 0);
		assert.equal(cwd, setup.worktrees[0]!.path);
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.receipt.entries[0]?.state, "kept");
		assert.match(result.receipt.entries[0]!.reason, /retained child resume/);
	}));

	it("serializes two processes applying the same plan", () => cleanupFixture(async ({ repo, planId }) => {
		const moduleUrl = new URL("../../src/runs/shared/worktree-cleanup-apply.ts", import.meta.url).href;
		const source = `import { applyReviewedCleanupPlan } from ${JSON.stringify(moduleUrl)}; const result = await applyReviewedCleanupPlan({ ...JSON.parse(process.argv[1]), foregroundRunOwnership: () => 'terminal' }); console.log(JSON.stringify(result));`;
		const run = () => new Promise<{ reused: boolean; receipt: { entries: Array<{ state: string }> } }>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, JSON.stringify({ repo, planId, authorized: true })], { stdio: ["ignore", "pipe", "pipe"] });
			let output = "", errors = "";
			child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => errors += data);
			child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
		});
		const results = await Promise.all([run(), run()]);
		assert.deepEqual(results.map((result) => result.reused).sort(), [false, true]);
		assert.ok(results.every((result) => result.receipt.entries.filter((entry) => entry.state === "removed").length === 1));
	}));

	it("uses the same repository lock through a linked checkout", () => cleanupFixture(async ({ repo, setup }) => {
		await withRepositoryWorktreeLock(repo, async () => {
			await assert.rejects(withRepositoryWorktreeLock(setup.worktrees[0]!.path, () => {}, { waitMs: 0 }), /busy/);
		});
	}));

	it("keeps a single-use applying receipt after an interrupted owner", () => cleanupFixture(async ({ repo, setup, planId }) => {
		const plan = loadReviewedCleanupPlan(repo, planId);
		const claim = path.join(plan.repoRoot, ".pi", "subagents", "cleanup-plans", `${planId}.claim`);
		fs.mkdirSync(claim);
		fs.writeFileSync(path.join(claim, "receipt.json"), JSON.stringify({ version: 1, planId, repoRoot: plan.repoRoot, contentHash: plan.contentHash, state: "applying", startedAt: Date.now(), entries: [] }));
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.reused, true);
		assert.equal(result.receipt.state, "applying");
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
	}));

	it("records cancellation after the plan claim without attempting deletion", () => cleanupFixture(async ({ repo, setup, planId }) => {
		const controller = new AbortController();
		const result = await applyReviewedCleanupPlan({ repo, planId, authorized: true, signal: controller.signal,
			select: () => { controller.abort(); return new Set(); },
		});
		assert.equal(result.receipt.state, "partial");
		assert.match(result.receipt.error ?? "", /abort/i);
		assert.ok(fs.existsSync(setup.worktrees[0]!.path));
		assert.equal((await applyReviewedCleanupPlan({ repo, planId, authorized: true })).reused, true);
	}));

	it("recovers a proven dead repository-lock owner", { skip: process.platform !== "linux" ? "Linux process identity fixture" : undefined }, () => cleanupFixture(async ({ repo }) => {
		const url = new URL("../../src/runs/shared/worktree-lock.ts", import.meta.url).href;
		const source = `import { withRepositoryWorktreeLock } from ${JSON.stringify(url)}; await withRepositoryWorktreeLock(process.argv[1], async () => { console.log('owned'); setInterval(() => {}, 1000); await new Promise(() => {}); });`;
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, repo], { stdio: ["ignore", "pipe", "pipe"] });
		const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		try {
			await new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("lock fixture exited before ownership")));
			});
			await assert.rejects(withRepositoryWorktreeLock(repo, () => {}, { waitMs: 0 }), /busy/);
			child.kill("SIGKILL"); await exited;
			await withRepositoryWorktreeLock(repo, () => {});
		} finally { child.kill("SIGKILL"); await exited; }
	}));
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function createRepo(prefix: string): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repo, ["init"]);
	git(repo, ["config", "user.email", "cleanup-tests@example.com"]);
	git(repo, ["config", "user.name", "Cleanup Tests"]);
	fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n", "utf-8");
	git(repo, ["add", "tracked.txt"]);
	git(repo, ["commit", "-m", "initial"]);
	return repo;
}

function createHookScript(fileName: string, source: string): string {
	const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-hook-script-"));
	const hookPath = path.join(hooksDir, fileName);
	fs.writeFileSync(hookPath, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

const hookScriptSkip = process.platform === "win32"
	? "Hook script execution differs on Windows CI environments."
	: undefined;

function removeGeneratedWorktrees(repo: string, setup: WorktreeSetup | undefined): void {
	for (const worktree of setup?.worktrees ?? []) {
		try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree.path], { stdio: "ignore" }); } catch {}
		try { execFileSync("git", ["-C", repo, "branch", "-D", worktree.branch], { stdio: "ignore" }); } catch {}
	}
	try { execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch {}
}

function writeManifest(input: {
	repo: string;
	manifestPath: string;
	setup: WorktreeSetup;
	runId?: string;
	source?: "foreground" | "async";
	childStatus?: string;
	baseCommit?: string;
	preserved?: boolean;
	outputPath?: string;
	patch?: { path: string; changed: boolean; error?: string };
}): void {
	const worktree = input.setup.worktrees[0]!;
	const baseCommit = input.baseCommit ?? git(input.repo, ["rev-parse", "HEAD"]);
	const patch = input.patch ?? {
		path: path.join(path.dirname(input.manifestPath), "worktree.patch"),
		changed: false,
	};
	fs.mkdirSync(path.dirname(input.manifestPath), { recursive: true });
	fs.writeFileSync(input.manifestPath, JSON.stringify({
		version: 1,
		runId: input.runId ?? "cleanup-run",
		mode: "parallel",
		source: input.source ?? "foreground",
		cwd: input.repo,
		createdAt: 1,
		updatedAt: 1,
		groups: [{
			stepIndex: 0,
			baseCommit,
			repoRoot: input.repo,
			children: [{
				index: 0,
				taskIndex: worktree.index,
				agent: "worker",
				status: input.childStatus ?? "completed",
				summary: "done",
				...(input.outputPath ? { outputPath: input.outputPath } : {}),
				patch: {
					path: patch.path,
					branch: worktree.branch,
					changed: patch.changed,
					diffStat: "",
					filesChanged: patch.changed ? 1 : 0,
					insertions: patch.changed ? 1 : 0,
					deletions: 0,
					...(patch.error ? { error: patch.error } : {}),
				},
			}],
			cleanup: {
				state: "partial",
				pruned: false,
				tasks: [{
					index: worktree.index,
					path: worktree.path,
					branch: worktree.branch,
					recordedBaseDir: worktree.recordedBaseDir,
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: input.preserved ?? true,
				}],
			},
		}],
	}, null, 2), "utf-8");
	if (patch.changed) fs.writeFileSync(patch.path, execFileSync("git", ["-C", worktree.path, "diff", "--binary", baseCommit, "HEAD"], { encoding: "utf-8" }), "utf-8");
}

function entriesByPath(plan: WorktreeCleanupPlan): Map<string, WorktreeCleanupPlan["entries"][number]> {
	return new Map(plan.entries.map((entry) => [entry.path, entry]));
}

function buildPlan(input: BuildWorktreeCleanupPlanInput): WorktreeCleanupPlan {
	return buildWorktreeCleanupPlan({ ...input, foregroundRunOwnership: input.foregroundRunOwnership ?? (() => "terminal") });
}

describe("worktree cleanup plan", () => {
	it("prefers native realpath for Windows alias normalization and falls back when unavailable", () => {
		let fallbackCalls = 0;
		const nativePath = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\cleanup";
		assert.equal(
			__testables.realpathExisting(
				"C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cleanup",
				() => nativePath,
				() => { fallbackCalls++; return "fallback"; },
			),
			nativePath,
		);
		assert.equal(fallbackCalls, 0);
		assert.equal(
			__testables.realpathExisting(
				"C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cleanup",
				() => { throw new Error("native realpath unavailable"); },
				() => { fallbackCalls++; return "fallback"; },
			),
			"fallback",
		);
		assert.equal(fallbackCalls, 1);
	});

	it("builds and persists a deterministic metadata-backed plan without removing worktrees", async () => {
		const repo = createRepo("pi-cleanup-plan-safe-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "safe", 1, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			fs.mkdirSync(path.join(baseDir, "unrelated-directory"));

			const first = buildPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: "fixed-plan" });
			const second = buildPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: "another-plan" });
			assert.deepEqual(first.entries, second.entries);
			assert.equal(first.contentHash, second.contentHash);
			assert.equal(first.entries.length, 1);
			assert.equal(first.entries[0]?.decision, "remove");
			assert.equal(first.entries[0]?.state, "safe");
			assert.equal(first.entries[0]?.willDeleteBranch, false);
			assert.match(first.entries[0]?.preconditions.statusDigest ?? "", /^[0-9a-f]{64}$/);
			assert.equal(first.entries.some((entry) => entry.path.includes("unrelated-directory")), false);

			const created = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: "fixed-plan", foregroundRunOwnership: () => "terminal" });
			assert.equal(created.plan.planId, "fixed-plan");
			assert.ok(fs.existsSync(created.planPath));
			assert.match(formatWorktreeCleanupPlan(created), /Will remove[\s\S]*Local branches: all retained[\s\S]*Plan-only mode: no worktrees or branches were removed/);
			assert.ok(fs.existsSync(setup.worktrees[0]!.path));
			assert.notEqual(git(repo, ["branch", "--list", setup.worktrees[0]!.branch]), "");

			for (const childStatus of ["complete", "rejected"] as const) {
				writeManifest({ repo, manifestPath, setup, childStatus });
				const compatibilityPlan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: `${childStatus}-plan` });
				assert.equal(compatibilityPlan.entries[0]?.decision, "remove");
				assert.equal(compatibilityPlan.entries[0]?.state, "safe");
			}

			writeManifest({ repo, manifestPath, setup, childStatus: "detached" });
			const detachedPlan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: "detached-plan" });
			assert.equal(detachedPlan.entries[0]?.decision, "keep");
			assert.equal(detachedPlan.entries[0]?.state, "active");
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("keeps dirty and unowned worktrees out of the removable set", async () => {
		const repo = createRepo("pi-cleanup-plan-unknown-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "unknown", 2, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "dirty\n", "utf-8");

			const plan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 20_000, planId: "unknown-plan" });
			const entries = entriesByPath(plan);
			const dirty = entries.get(__testables.realpathExisting(setup.worktrees[0]!.path));
			const unowned = entries.get(__testables.realpathExisting(setup.worktrees[1]!.path));
			assert.equal(dirty?.decision, "keep");
			assert.equal(dirty?.state, "dirty");
			assert.match(dirty?.reasons.join(" ") ?? "", /uncommitted|untracked/i);
			assert.equal(unowned?.decision, "unknown");
			assert.equal(unowned?.state, "unknown");
			assert.match(unowned?.reasons.join(" ") ?? "", /no matching extension-owned/i);
			assert.ok(fs.existsSync(setup.worktrees[0]!.path));
			assert.ok(fs.existsSync(setup.worktrees[1]!.path));
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("keeps active async ownership and reports missing Git worktrees as stale", async () => {
		const repo = createRepo("pi-cleanup-plan-active-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "active", 1, { baseDir });
			const asyncDir = path.join(repo, ".pi", "subagents", "async", "active-run");
			const manifestPath = path.join(asyncDir, "handoff.json");
			writeManifest({ repo, manifestPath, setup, runId: "active-run", source: "async" });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "active-run", state: "running" }), "utf-8");
			fs.mkdirSync(path.join(path.dirname(asyncDir), ".active-runs"), { recursive: true });
			fs.writeFileSync(path.join(path.dirname(asyncDir), ".active-runs", path.basename(asyncDir)), "", "utf-8");
			const activePlan = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 30_000, planId: "active-plan" });
			assert.equal(activePlan.entries[0]?.state, "active");
			assert.equal(activePlan.entries[0]?.decision, "keep");

			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "active-run", state: "complete" }), "utf-8");
			fs.rmSync(setup.worktrees[0]!.path, { recursive: true, force: true });
			const stalePlan = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 30_000, planId: "stale-plan" });
			assert.equal(stalePlan.entries[0]?.state, "stale");
			assert.equal(stalePlan.entries[0]?.decision, "unknown");
			assert.match(stalePlan.entries[0]?.reasons.join(" ") ?? "", /not present in Git worktree state|missing from disk/i);
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("requires foreground ownership proof instead of inferring activity from the artifacts directory", async () => {
		const repo = createRepo("pi-cleanup-plan-foreground-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "foreground", 1, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup, runId: "foreground-run", source: "foreground" });
			const noProof = buildWorktreeCleanupPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 35_000, planId: "foreground-no-proof" });
			assert.equal(noProof.entries[0]?.state, "unknown");
			assert.equal(noProof.entries[0]?.decision, "unknown");
			assert.match(noProof.entries[0]?.reasons.join(" ") ?? "", /foreground owning-run state is not provably terminal/i);

			const active = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 35_000, planId: "foreground-active", foregroundRunOwnership: () => "active" });
			assert.equal(active.entries[0]?.state, "active");
			assert.equal(active.entries[0]?.decision, "keep");
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("requires a recorded patch or local target ancestry for committed divergence", async () => {
		const repo = createRepo("pi-cleanup-plan-divergence-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "divergence", 1, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "unmerged.txt"), "unmerged\n", "utf-8");
			git(worktree.path, ["add", "unmerged.txt"]);
			git(worktree.path, ["commit", "-m", "unmerged"]);

			const unmerged = buildPlan({ repo, worktreeBaseDir: baseDir, now: 40_000, planId: "unmerged-plan" });
			assert.equal(unmerged.entries[0]?.decision, "keep");
			assert.equal(unmerged.entries[0]?.state, "ineligible");
			assert.match(unmerged.entries[0]?.reasons.join(" ") ?? "", /neither preserved.*nor merged/i);

			const patchPath = path.join(repo, ".pi", "subagents", "artifacts", "divergence.patch");
			writeManifest({ repo, manifestPath, setup, patch: { path: patchPath, changed: true } });
			const captured = buildPlan({ repo, worktreeBaseDir: baseDir, now: 40_000, planId: "captured-plan" });
			assert.equal(captured.entries[0]?.decision, "remove");
			assert.equal(captured.entries[0]?.state, "safe");
			assert.equal(captured.entries[0]?.willDeleteBranch, false);
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("does not let trusted external diff hide cleanup-plan divergence", { skip: hookScriptSkip }, async () => {
		const repo = createRepo("pi-cleanup-plan-external-diff-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		const externalDiffPath = createHookScript("external-diff-plan.mjs", "process.exit(0);");
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "external-diff", 1, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "unmerged.txt"), "unmerged\n", "utf-8");
			git(worktree.path, ["add", "unmerged.txt"]);
			git(worktree.path, ["commit", "-m", "unmerged"]);
			git(repo, ["config", "diff.external", externalDiffPath]);
			git(repo, ["config", "diff.trustExitCode", "true"]);

			const plan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 40_000, planId: "external-diff-plan" });
			assert.equal(plan.entries[0]?.decision, "keep");
			assert.equal(plan.entries[0]?.state, "ineligible");
			assert.match(plan.entries[0]?.reasons.join(" ") ?? "", /neither preserved.*nor merged/i);
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("keeps stale markers, pending captures, and inconsistent cleanup metadata non-removable", async () => {
		const repo = createRepo("pi-cleanup-plan-stale-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "stale", 1, { baseDir });
			const asyncDir = path.join(repo, ".pi", "subagents", "async", "stale-run");
			const manifestPath = path.join(asyncDir, "handoff.json");
			writeManifest({ repo, manifestPath, setup, runId: "stale-run", source: "async" });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "stale-run", state: "complete" }), "utf-8");
			const markerPath = path.join(path.dirname(asyncDir), ".active-runs", path.basename(asyncDir));
			fs.mkdirSync(path.dirname(markerPath), { recursive: true });
			fs.writeFileSync(markerPath, "", "utf-8");
			fs.utimesSync(markerPath, new Date(0), new Date(0));
			const stale = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS + 1, planId: "stale-marker-plan" });
			assert.equal(stale.entries[0]?.state, "stale");
			assert.equal(stale.entries[0]?.decision, "unknown");

			fs.rmSync(markerPath, { force: true });
			writeManifest({ repo, manifestPath, setup, source: "foreground" });
			fs.rmSync(path.join(asyncDir, "status.json"), { force: true });
			const pending = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { groups: Array<{ children: Array<{ taskIndex: number }>; cleanup: { state: string; tasks: Array<{ reason?: string }> } }> };
			pending.groups[0]!.cleanup.tasks[0]!.reason = "cleanup pending durable handoff capture";
			fs.writeFileSync(manifestPath, JSON.stringify(pending), "utf-8");
			const pendingPlan = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 50_000, planId: "pending-capture-plan" });
			assert.equal(pendingPlan.entries[0]?.state, "ineligible");
			assert.equal(pendingPlan.entries[0]?.decision, "keep");

			pending.groups[0]!.cleanup.tasks[0]!.reason = undefined;
			pending.groups[0]!.cleanup.state = "complete";
			fs.writeFileSync(manifestPath, JSON.stringify(pending), "utf-8");
			const inconsistent = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 50_000, planId: "inconsistent-cleanup-plan" });
			assert.equal(inconsistent.entries[0]?.state, "unknown");
			assert.equal(inconsistent.entries[0]?.decision, "unknown");

			pending.groups[0]!.cleanup.state = "partial";
			pending.groups[0]!.children.push({ taskIndex: pending.groups[0]!.children[0]!.taskIndex });
			fs.writeFileSync(manifestPath, JSON.stringify(pending), "utf-8");
			const duplicateChild = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 50_000, planId: "duplicate-child-plan" });
			assert.equal(duplicateChild.entries[0]?.state, "unknown");
			assert.match(duplicateChild.entries[0]?.reasons.join(" ") ?? "", /no matching extension-owned/i);

			writeManifest({ repo, manifestPath, setup, source: "foreground", outputPath: path.join(repo, "missing-output.json") });
			const missingReport = buildPlan({ repo, handoffPath: manifestPath, worktreeBaseDir: baseDir, now: 50_000, planId: "missing-report-plan" });
			assert.equal(missingReport.entries[0]?.state, "unknown");
			assert.match(missingReport.entries[0]?.reasons.join(" ") ?? "", /durable handoff path is missing/i);
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("treats nested project directory as cleanup containment root", async () => {
		const repo = createRepo("pi-cleanup-plan-nested-root-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-nested-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = await createWorktrees(repo, "nested-root", 1, { baseDir });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			const plan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 60_000, planId: "nested-root-plan" });
			assert.equal(plan.baseDirs[0], path.join(baseDir, path.basename(repo)));
			assert.equal(plan.entries[0]?.decision, "remove");
			assert.equal(plan.entries[0]?.state, "safe");
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("uses git toplevel parent as default cleanup root when input.repo is a subdirectory", async () => {
		const repo = createRepo("pi-cleanup-plan-subdir-root-");
		const previous = process.env.PI_SUBAGENTS_WORKTREE_DIR;
		delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
		let setup: WorktreeSetup | undefined;
		try {
			fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
			setup = await createWorktrees(repo, "from-subdir", 1, { provider: "native" });
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup });
			const plan = buildPlan({ repo: path.join(repo, "packages", "app"), now: 61_500, planId: "subdir-root-plan" });
			const realRepo = __testables.realpathExisting(repo);
			assert.equal(plan.baseDirs[0], path.join(path.dirname(realRepo), "worktrees", path.basename(realRepo)));
			const entry = entriesByPath(plan).get(__testables.realpathExisting(setup.worktrees[0]!.path)) ?? plan.entries[0];
			assert.equal(entry?.decision, "remove");
			assert.equal(entry?.state, "safe");
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_WORKTREE_DIR;
			else process.env.PI_SUBAGENTS_WORKTREE_DIR = previous;
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("marks flat dedicatedRoot leaves ineligible", () => {
		const repo = createRepo("pi-cleanup-plan-flat-leaf-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-flat-base-"));
		const worktreePath = path.join(baseDir, "pi-worktree-flat-0");
		const branch = "pi-parallel-flat-0";
		let setup: WorktreeSetup | undefined;
		try {
			git(repo, ["worktree", "add", "-b", branch, worktreePath]);
			setup = {
				cwd: repo,
				worktrees: [{
					path: worktreePath,
					agentCwd: worktreePath,
					branch,
					index: 0,
					nodeModulesLinked: false,
					syntheticPaths: [],
				}],
				baseCommit: git(repo, ["rev-parse", "HEAD"]),
			};
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup, preserved: true });
			const plan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 62_000, planId: "flat-leaf-plan" });
			const entry = entriesByPath(plan).get(__testables.realpathExisting(worktreePath)) ?? plan.entries[0];
			assert.equal(entry?.decision, "keep");
			assert.equal(entry?.state, "ineligible");
			assert.match(entry?.reasons.join(" ") ?? "", /outside configured base directory|outside the project worktree directory/i);
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});

	it("marks checkout-internal worktrees ineligible when base is the repos parent", () => {
		const repo = createRepo("pi-cleanup-plan-checkout-internal-");
		const worktreePath = path.join(repo, "pi-worktree-internal-0");
		const branch = "pi-parallel-internal-0";
		let setup: WorktreeSetup | undefined;
		try {
			git(repo, ["worktree", "add", "-b", branch, worktreePath]);
			setup = {
				cwd: repo,
				worktrees: [{
					path: worktreePath,
					agentCwd: worktreePath,
					branch,
					index: 0,
					nodeModulesLinked: false,
					syntheticPaths: [],
				}],
				baseCommit: git(repo, ["rev-parse", "HEAD"]),
			};
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup, preserved: true });
			const plan = buildPlan({ repo, worktreeBaseDir: path.dirname(repo), now: 63_000, planId: "checkout-internal-plan" });
			const entry = entriesByPath(plan).get(__testables.realpathExisting(worktreePath)) ?? plan.entries[0];
			assert.equal(entry?.decision, "keep");
			assert.equal(entry?.state, "ineligible");
			assert.notEqual(entry?.decision, "remove");
		} finally {
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("keeps a worktree whose project directory resolves into Pi extensions", () => {
		const repo = createRepo("pi-cleanup-plan-extension-project-");
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-home-"));
		const agentDir = path.join(tempHome, ".pi", "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		const baseDir = path.join(tempHome, "worktree-root");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		const projectDir = path.join(baseDir, path.basename(repo));
		const worktreePath = path.join(projectDir, "pi-worktree-extension-project-0");
		const branch = "pi-parallel-extension-project-0";
		let setup: WorktreeSetup | undefined;
		try {
			fs.mkdirSync(extensionsDir, { recursive: true });
			fs.mkdirSync(baseDir, { recursive: true });
			fs.symlinkSync(extensionsDir, projectDir, process.platform === "win32" ? "junction" : "dir");
			process.env.PI_CODING_AGENT_DIR = agentDir;
			process.env.HOME = tempHome;
			process.env.USERPROFILE = tempHome;

			git(repo, ["worktree", "add", "-b", branch, worktreePath]);
			setup = {
				cwd: repo,
				worktrees: [{ path: worktreePath, agentCwd: worktreePath, branch, index: 0, nodeModulesLinked: false, syntheticPaths: [] }],
				baseCommit: git(repo, ["rev-parse", "HEAD"]),
			};
			const manifestPath = path.join(repo, ".pi", "subagents", "artifacts", "handoff.json");
			writeManifest({ repo, manifestPath, setup, preserved: true });
			const plan = buildPlan({ repo, worktreeBaseDir: baseDir, now: 64_000, planId: "extension-project-plan" });
			const entry = entriesByPath(plan).get(__testables.realpathExisting(worktreePath)) ?? plan.entries[0];
			assert.equal(entry?.decision, "keep");
			assert.equal(entry?.state, "ineligible");
			assert.match(entry?.reasons.join(" ") ?? "", /Pi extensions directory/i);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			removeGeneratedWorktrees(repo, setup);
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(baseDir, { recursive: true, force: true });
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("rejects empty cleanup worktree base directory", () => {
		const repo = createRepo("pi-cleanup-plan-empty-base-");
		try {
			assert.throws(
				() => buildWorktreeCleanupPlan({ repo, worktreeBaseDir: "   " }),
				/worktree base directory cannot be empty/,
			);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
