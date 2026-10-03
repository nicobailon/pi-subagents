import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { enforceWorktreeRetainCount, type WorktreeCountReport } from "../../src/runs/background/worktree-count-policy.ts";
import { createWorktreeCountManager } from "../../src/runs/background/worktree-count-manager.ts";
import { listOwnedWorktreeInventory } from "../../src/runs/shared/worktree-cleanup-plan.ts";
import { withRepositoryWorktreeLock } from "../../src/runs/shared/worktree-lock.ts";
import { protectRetainedWorktreeForResume } from "../../src/runs/shared/parallel-handoff.ts";
import { loadConfig, saveConfig, getConfigPath } from "../../src/extension/config.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(count: number, run: (args: { repo: string; worktreeBaseDir: string; paths: string[]; manifests: string[] }) => Promise<void>): Promise<void> {
	const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-count-")));
	const repo = path.join(temp, "repo");
	const worktreeBaseDir = path.join(temp, "trees");
	fs.mkdirSync(repo);
	git(repo, "init"); git(repo, "config", "user.name", "Retention Test"); git(repo, "config", "user.email", "retention@example.com");
	fs.writeFileSync(path.join(repo, "base.txt"), "base");
	git(repo, "add", "base.txt"); git(repo, "commit", "-m", "initial");
	const base = git(repo, "rev-parse", "HEAD");
	const paths: string[] = [], manifests: string[] = [];
	try {
		for (let i = 0; i < count; i++) {
			const tree = path.join(worktreeBaseDir, "repo", `tree-${i}`);
			const branch = `retention-${i}`;
			git(repo, "worktree", "add", "-b", branch, tree);
			paths.push(tree);
			const handoff = path.join(repo, ".pi", "subagents", "artifacts", "handoffs", `run-${i}.json`);
			fs.mkdirSync(path.dirname(handoff), { recursive: true });
			const patch = path.join(path.dirname(handoff), `run-${i}.patch`);
			fs.writeFileSync(handoff, JSON.stringify({ version: 1, runId: `run-${i}`, mode: "single", source: "foreground", cwd: repo, createdAt: 100 + i, updatedAt: 100 + i, groups: [{ stepIndex: 0, repoRoot: repo, baseCommit: base,
				children: [{ index: 0, taskIndex: 0, agent: "fixture", status: "completed", summary: "done", patch: { path: patch, branch, changed: false, diffStat: "", filesChanged: 0, insertions: 0, deletions: 0 } }],
				cleanup: { state: "partial", pruned: false, tasks: [{ index: 0, path: tree, branch, worktreeRemoved: false, branchRemoved: false, preserved: true }] },
			}] }));
			manifests.push(handoff);
		}
		await run({ repo, worktreeBaseDir, paths, manifests });
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

describe("count retention policy", () => {
	it("removes only the oldest eligible excess and leaves branches", () => fixture(4, async (input) => {
		// Mutable evidence must not make the oldest run look newest.
		const old = JSON.parse(fs.readFileSync(input.manifests[0]!, "utf-8")); old.updatedAt = Date.now(); fs.writeFileSync(input.manifests[0]!, JSON.stringify(old));
		const result = await enforceWorktreeRetainCount({ ...input, limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.removed, 2); assert.equal(result.retained, 2); assert.equal(result.state, "cleaned");
		assert.equal(fs.existsSync(input.paths[0]!), false); assert.equal(fs.existsSync(input.paths[1]!), false); assert.ok(fs.existsSync(input.paths[2]!));
		assert.ok(git(input.repo, "branch", "--list", "retention-0"));
	}));
	it("counts protected trees but retains overflow when too few are eligible", () => fixture(4, async (input) => {
		for (const tree of input.paths.slice(0, 3)) fs.writeFileSync(path.join(tree, "valuable.txt"), "keep");
		const result = await enforceWorktreeRetainCount({ ...input, limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.before, 4); assert.equal(result.removed, 1); assert.equal(result.retained, 3); assert.equal(result.state, "protected");
		assert.equal(fs.existsSync(input.paths[3]!), false); assert.ok(fs.existsSync(input.paths[0]!));
	}));
	it("does no per-tree Git inspection or plan writes below the limit", () => fixture(1, async (input) => {
		fs.writeFileSync(path.join(input.paths[0]!, "valuable.txt"), "keep");
		const result = await enforceWorktreeRetainCount({ ...input, limit: 15, authorized: true, foregroundRunOwnership: () => { throw new Error("terminal inspection must not run below the limit"); } });
		assert.equal(result.state, "below-limit");
		assert.equal(fs.existsSync(path.join(input.repo, ".pi", "subagents", "cleanup-plans")), false);
	}));
	it("excludes unowned and duplicate ownership and keeps unknown foreground proof", () => fixture(2, async (input) => {
		fs.copyFileSync(input.manifests[0]!, path.join(path.dirname(input.manifests[0]!), "duplicate.json"));
		git(input.repo, "worktree", "add", "-b", "unowned", path.join(input.worktreeBaseDir, "repo", "unowned"));
		assert.equal(listOwnedWorktreeInventory(input).owned.length, 1);
		const result = await enforceWorktreeRetainCount({ ...input, limit: 1, authorized: true });
		assert.equal(result.removed, 0);
		assert.ok(input.paths.every((tree) => fs.existsSync(tree)));
	}));
	it("defers rather than reporting an exact count for capped discovery", () => fixture(1, async (input) => {
		for (let i = 0; i < 256; i++) fs.writeFileSync(path.join(path.dirname(input.manifests[0]!), `empty-${i}.json`), JSON.stringify({ version: 1, groups: [] }));
		const result = await enforceWorktreeRetainCount({ ...input, limit: 1, authorized: true });
		assert.equal(result.state, "deferred"); assert.equal(result.countExact, false); assert.equal(result.removed, 0);
	}));
	for (const source of ["discovered", "listed"] as const) it(`defers all removal for an unreadable ${source} handoff`, () => fixture(4, async (input) => {
		let unreadable = input.manifests[3]!;
		if (source === "listed") {
			const observed = path.join(input.worktreeBaseDir, "observed-handoff.json");
			fs.renameSync(unreadable, observed);
			input.manifests[3] = unreadable = observed;
		}
		const originalRead = fs.readFileSync;
		fs.readFileSync = ((file, ...args) => {
			if (String(file) === unreadable) throw Object.assign(new Error("fixture: handoff read denied"), { code: "EACCES" });
			return originalRead(file, ...args);
		}) as typeof fs.readFileSync;
		syncBuiltinESMExports();
		try {
			const result = await enforceWorktreeRetainCount({ ...input, ...(source === "listed" ? { handoffPaths: input.manifests } : {}), limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
			assert.equal(result.state, "deferred"); assert.equal(result.countExact, false); assert.equal(result.removed, 0);
			assert.ok(result.warnings.some((warning) => warning.includes(unreadable) && warning.includes("fixture: handoff read denied")));
			assert.ok(input.paths.every((tree) => fs.existsSync(tree)));
			assert.equal(fs.existsSync(path.join(input.repo, ".pi", "subagents", "cleanup-plans")), false);
		} finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
	}));
	it("defers all removal for invalid discovered handoff JSON", () => fixture(4, async (input) => {
		fs.writeFileSync(input.manifests[3]!, "{");
		const result = await enforceWorktreeRetainCount({ ...input, limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.state, "deferred"); assert.equal(result.countExact, false); assert.equal(result.removed, 0);
		assert.ok(result.warnings.some((warning) => warning.includes(input.manifests[3]!) && warning.includes("failed to read")));
		assert.ok(input.paths.every((tree) => fs.existsSync(tree)));
	}));
	it("defers all removal for a missing listed handoff", () => fixture(4, async (input) => {
		fs.rmSync(input.manifests[3]!);
		const result = await enforceWorktreeRetainCount({ ...input, handoffPaths: input.manifests, limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
		assert.equal(result.state, "deferred"); assert.equal(result.countExact, false); assert.equal(result.removed, 0);
		assert.ok(result.warnings.some((warning) => warning.includes(input.manifests[3]!) && warning.includes("not found")));
		assert.ok(input.paths.every((tree) => fs.existsSync(tree)));
	}));
	for (const drift of ["invalid", "missing"] as const) it(`defers a planned batch when another handoff becomes ${drift} before the locked recount`, () => fixture(4, async (input) => {
		let cleanup: Promise<WorktreeCountReport> | undefined;
		await withRepositoryWorktreeLock(input.repo, () => {
			cleanup = enforceWorktreeRetainCount({ ...input, limit: 2, authorized: true, foregroundRunOwnership: () => "terminal" });
			// The oldest candidates have valid metadata; only the later owner changes.
			if (drift === "missing") fs.rmSync(input.manifests[3]!);
			else fs.writeFileSync(input.manifests[3]!, "{");
		});
		const result = await cleanup!;
		assert.equal(result.before, 4);
		assert.equal(result.state, "deferred"); assert.equal(result.countExact, false); assert.equal(result.removed, 0);
		assert.ok(result.warnings.some((warning) => warning.includes(input.manifests[3]!) && warning.includes(drift === "missing" ? "not found" : "failed to read")));
		assert.ok(input.paths.every((tree) => fs.existsSync(tree)));
		assert.ok(result.receiptPath);
		const receipt = JSON.parse(fs.readFileSync(result.receiptPath, "utf-8"));
		assert.equal(receipt.entries.length, 2);
		assert.ok(receipt.entries.every((entry: { state: string }) => entry.state === "kept"));
	}));
	it("requires explicit automatic discard authority before inventory", async () => {
		await assert.rejects(enforceWorktreeRetainCount({ repo: "missing", limit: 15, authorized: false }), /authorization/);
	});
	it("executes the real worker without blocking the parent's event loop", () => fixture(4, async (input) => {
		let resolveReport: (report: WorktreeCountReport) => void;
		const finished = new Promise<WorktreeCountReport>((resolve) => resolveReport = resolve);
		const manager = createWorktreeCountManager({ config: { worktreeRetainCount: 2, worktreeBaseDir: input.worktreeBaseDir, authorityPolicy: { discardWorktree: "auto" } }, coalesceMs: 0,
			terminalForegroundRunIds: () => ["run-0", "run-1", "run-2", "run-3"],
			report: (result) => { if ("removed" in result) resolveReport(result); else assert.fail(JSON.stringify(result)); },
		});
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		const timeout = setTimeout(() => resolveReport({ ...fakeReport, state: "deferred" }), 10_000);
		try {
			manager.request(input.repo);
			const report = await finished;
			assert.equal(report.removed, 2); assert.equal(report.retained, 2);
			assert.ok(ticks >= 3, "parent timers continue while worker inspects Git");
		} finally { clearInterval(timer); clearTimeout(timeout); manager.stop(); }
	}));
	it("keeps the worker lock alive through an admitted Git removal when stopped", { skip: process.platform === "win32" ? "POSIX Git fault-injection wrapper" : undefined, timeout: 20_000 }, () => fixture(3, async (input) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-count-cancellation-"));
		const marker = path.join(root, "started"), release = path.join(root, "release");
		const actualGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
		const previousPath = process.env.PATH;
		const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
		const until = async (check: () => boolean): Promise<void> => {
			const deadline = Date.now() + 8_000;
			while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for maintenance cancellation"); await pause(20); }
		};
		let workerPid: number | undefined;
		const manager = createWorktreeCountManager({ config: { worktreeRetainCount: 1, worktreeBaseDir: input.worktreeBaseDir, authorityPolicy: { discardWorktree: "auto" } }, coalesceMs: 0,
			resolveRepo: async () => input.repo, terminalForegroundRunIds: () => ["run-0", "run-1", "run-2"], report: () => {},
		});
		try {
			fs.writeFileSync(path.join(root, "git"), `#!/usr/bin/env node\nconst fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
const run=()=>{const result=cp.spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'});process.exit(result.status??1);};
if(args.includes('worktree')&&args.includes('remove')){
 fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
 const wait=()=>{if(!fs.existsSync(${JSON.stringify(release)}))return setTimeout(wait,20);run();};wait();
}else run();\n`, { mode: 0o755 });
			process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
			manager.request(input.repo);
			await until(() => fs.existsSync(marker));
			const lock = path.join(input.repo, ".git", "pi-subagents-worktree.lock");
			workerPid = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf-8")).pid;
			manager.stop();
			await pause(100);
			assert.ok(alive(workerPid!), "worker owner must stay alive while Git can still remove the tree");
			await assert.rejects(withRepositoryWorktreeLock(input.repo, () => assert.fail("lock released before Git settled"), { waitMs: 0 }), /busy/);
			fs.writeFileSync(release, "go");
			await until(() => !alive(workerPid!));
			assert.equal(fs.existsSync(input.paths[0]!), false);
			assert.ok(fs.existsSync(input.paths[1]!));
			assert.ok(fs.existsSync(input.paths[2]!));
			assert.equal(await protectRetainedWorktreeForResume(input.manifests[1]!, "run-1", 0), input.paths[1]);
			assert.equal(fs.existsSync(lock), false);
		} finally {
			manager.stop();
			if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
			fs.writeFileSync(release, "go");
			if (workerPid) await until(() => !alive(workerPid!));
			fs.rmSync(root, { recursive: true, force: true });
		}
	}));
});

const pause = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fakeReport: WorktreeCountReport = { repoRoot: "/fixture", countExact: true, limit: 15, before: 0, retained: 0, removed: 0, state: "below-limit", warnings: [] };
describe("parent maintenance queue", () => {
	it("does no resolution, worker or confirmation work by default", async () => {
		const manager = createWorktreeCountManager({ config: {}, resolveRepo: async () => { throw new Error("unexpected I/O"); }, run: async () => { throw new Error("unexpected worker"); } });
		manager.request("missing"); await pause(); manager.stop();
	});
	it("coalesces duplicate settlement events and cancels queued work on reload", async () => {
		let runs = 0;
		const manager = createWorktreeCountManager({ config: { worktreeRetainCount: 15, authorityPolicy: { discardWorktree: "auto" } }, coalesceMs: 5, resolveRepo: async () => "/fixture", run: async () => { runs++; return fakeReport; } });
		manager.request("first", "a.json"); manager.request("alias", "b.json"); manager.request("first", "a.json");
		await pause(30); assert.equal(runs, 1);
		manager.request("first"); await Promise.resolve(); manager.stop(); await pause(20); assert.equal(runs, 1);
	});
	it("coalesces events arriving during a worker and never runs two jobs for one repo", async () => {
		const releases: Array<(report: WorktreeCountReport) => void> = [];
		let runs = 0, signal: AbortSignal | undefined;
		const manager = createWorktreeCountManager({ config: { worktreeRetainCount: 15, authorityPolicy: { discardWorktree: "auto" } }, coalesceMs: 1, resolveRepo: async () => "/fixture", run: (_request, abort) => { runs++; signal = abort; return new Promise((resolve) => releases.push(resolve)); } });
		manager.request("first"); await pause(15);
		manager.request("first"); manager.request("alias"); await pause(15); assert.equal(runs, 1);
		releases[0]!(fakeReport); await pause(15); assert.equal(runs, 2);
		manager.stop(); assert.equal(signal?.aborted, true); releases[1]!(fakeReport);
	});
	for (const policy of ["confirm", "forbid"] as const) it(`reports ${policy} authority once without opening a background prompt`, async () => {
		const reports: unknown[] = [];
		const manager = createWorktreeCountManager({ config: { worktreeRetainCount: 15, authorityPolicy: { discardWorktree: policy } }, report: (result) => reports.push(result), resolveRepo: async () => { throw new Error("unexpected I/O"); } });
		manager.request("first"); manager.request("second"); await pause(); manager.stop(); assert.equal(reports.length, 1);
	});
});

describe("worktreeRetainCount validation", () => {
	it("accepts an omitted limit and positive safe integer, rejects invalid explicit values", () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-retention-config-"));
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			saveConfig({}); assert.equal(loadConfig().worktreeRetainCount, undefined);
			saveConfig({ worktreeRetainCount: 15 }); assert.equal(loadConfig().worktreeRetainCount, 15);
			for (const value of [0, -1, 1.5, "15", null, Number.MAX_SAFE_INTEGER + 1]) {
				fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreeRetainCount: value }));
				assert.throws(() => loadConfig(), /worktreeRetainCount.*positive safe integer/);
			}
		} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; fs.rmSync(root, { recursive: true, force: true }); }
	});
});
