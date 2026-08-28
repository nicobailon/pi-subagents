import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { createWorktrees, type WorktreeSetup } from "../../src/runs/shared/worktree.ts";

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
					worktreeRemoved: false,
					branchRemoved: false,
					preserved: input.preserved ?? true,
				}],
			},
		}],
	}, null, 2), "utf-8");
	if (patch.changed) fs.writeFileSync(patch.path, "captured patch\n", "utf-8");
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

	it("builds and persists a deterministic metadata-backed plan without removing worktrees", () => {
		const repo = createRepo("pi-cleanup-plan-safe-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "safe", 1, { baseDir });
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
			assert.equal(first.entries[0]?.willDeleteBranch, true);
			assert.match(first.entries[0]?.preconditions.statusDigest ?? "", /^[0-9a-f]{64}$/);
			assert.equal(first.entries.some((entry) => entry.path.includes("unrelated-directory")), false);

			const created = createWorktreeCleanupPlan({ repo, worktreeBaseDir: baseDir, now: 10_000, planId: "fixed-plan", foregroundRunOwnership: () => "terminal" });
			assert.equal(created.plan.planId, "fixed-plan");
			assert.ok(fs.existsSync(created.planPath));
			assert.match(formatWorktreeCleanupPlan(created), /Will remove[\s\S]*Will delete local branches[\s\S]*Plan-only mode: no worktrees or branches were removed/);
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

	it("keeps dirty and unowned worktrees out of the removable set", () => {
		const repo = createRepo("pi-cleanup-plan-unknown-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "unknown", 2, { baseDir });
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

	it("keeps active async ownership and reports missing Git worktrees as stale", () => {
		const repo = createRepo("pi-cleanup-plan-active-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "active", 1, { baseDir });
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

	it("requires foreground ownership proof instead of inferring activity from the artifacts directory", () => {
		const repo = createRepo("pi-cleanup-plan-foreground-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "foreground", 1, { baseDir });
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

	it("requires a recorded patch or local target ancestry for committed divergence", () => {
		const repo = createRepo("pi-cleanup-plan-divergence-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "divergence", 1, { baseDir });
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

	it("keeps stale markers, pending captures, and inconsistent cleanup metadata non-removable", () => {
		const repo = createRepo("pi-cleanup-plan-stale-");
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cleanup-plan-base-"));
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repo, "stale", 1, { baseDir });
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
});
