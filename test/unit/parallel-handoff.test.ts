import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	formatParallelHandoffReference,
	readParallelHandoffManifest,
	resolveParallelHandoffChild,
	writeParallelHandoffGroup,
	writePendingParallelHandoff,
} from "../../src/runs/shared/parallel-handoff.ts";
import type { ParallelHandoffManifest } from "../../src/shared/types.ts";
import type { WorktreeCleanupReport, WorktreeDiff, WorktreeSetup } from "../../src/runs/shared/worktree.ts";

function setup(repoRoot: string, baseCommit: string): WorktreeSetup {
	return { cwd: repoRoot, baseCommit, worktrees: [] };
}

function diff(dir: string, index: number, agent: string, changed: boolean): WorktreeDiff {
	const patchPath = path.join(dir, `task-${index}-${agent}.patch`);
	fs.mkdirSync(path.dirname(patchPath), { recursive: true });
	fs.writeFileSync(patchPath, changed ? "diff --git a/a b/a\n" : "", "utf-8");
	return {
		index,
		agent,
		branch: `branch-${index}`,
		diffStat: changed ? " a | 1 +" : "",
		filesChanged: changed ? 1 : 0,
		insertions: changed ? 1 : 0,
		deletions: 0,
		patchPath,
	};
}

function cleanup(state: "complete" | "partial" = "complete"): WorktreeCleanupReport {
	return {
		state,
		pruned: state === "complete",
		tasks: [{
			index: 0,
			path: "/tmp/worktree-0",
			branch: "branch-0",
			worktreeRemoved: true,
			branchRemoved: state === "complete",
			...(state === "partial" ? { errors: ["branch removal failed"] } : {}),
		}],
	};
}

describe("parallel handoff", () => {
	it("journals worktree ownership before child results exist", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-pending-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			const reference = writePendingParallelHandoff({
				manifestPath,
				runId: "run-pending",
				mode: "parallel",
				source: "foreground",
				cwd: "/repo",
				stepIndex: 0,
				flatStartIndex: 0,
				setup: {
					...setup("/repo", "base-1"),
					worktrees: [{ path: "/tmp/worktree-0", agentCwd: "/tmp/worktree-0", branch: "branch-0", index: 0, nodeModulesLinked: false, syntheticPaths: [] }],
				},
				laneBindings: [{ index: 0, taskIndex: 0, workflowKey: "writer", runId: "run-pending", lane: { version: 1, key: "writer", mode: "mutation" } }],
			});

			assert.equal(reference.childCount, 0);
			assert.equal(reference.cleanupState, "partial");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ParallelHandoffManifest;
			assert.equal(manifest.groups[0]?.cleanup.tasks[0]?.path, "/tmp/worktree-0");
			assert.equal(manifest.groups[0]?.cleanup.tasks[0]?.preserved, true);
			assert.deepEqual(manifest.groups[0]?.laneBindings?.[0], { index: 0, taskIndex: 0, workflowKey: "writer", runId: "run-pending", lane: { version: 1, key: "writer", mode: "mutation" } });
			assert.match(manifest.groups[0]?.cleanup.tasks[0]?.reason ?? "", /cleanup pending/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes and aggregates versioned worktree handoff groups", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			const first = writeParallelHandoffGroup({
				manifestPath,
				runId: "run-1",
				mode: "chain",
				source: "async",
				cwd: "/repo",
				stepIndex: 2,
				flatStartIndex: 3,
				setup: setup("/repo", "base-1"),
				diffs: [diff(dir, 0, "worker", true)],
				cleanup: cleanup(),
				results: [{
					agent: "worker",
					status: "completed",
					summary: "implemented",
					outputPath: "/artifacts/output.md",
					structuredOutput: { ok: true },
					structuredOutputPath: "/artifacts/structured.json",
					sessionPath: "/sessions/worker.jsonl",
				}],
				now: 100,
			});
			assert.deepEqual(first, {
				version: 1,
				path: manifestPath,
				groupCount: 1,
				childCount: 1,
				changedPatches: 1,
				cleanupState: "complete",
			});

			const second = writeParallelHandoffGroup({
				manifestPath,
				runId: "run-1",
				mode: "chain",
				source: "async",
				cwd: "/repo",
				stepIndex: 1,
				flatStartIndex: 1,
				setup: setup("/repo", "base-1"),
				diffs: [diff(dir, 1, "reviewer", false)],
				cleanup: cleanup("partial"),
				results: [{ agent: "reviewer", status: "failed", summary: "blocked" }],
				now: 200,
			});
			assert.equal(second.groupCount, 2);
			assert.equal(second.childCount, 2);
			assert.equal(second.changedPatches, 1);
			assert.equal(second.cleanupState, "partial");
			assert.match(formatParallelHandoffReference(second), /2 children, 1 changed patches, cleanup partial/);

			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ParallelHandoffManifest;
			assert.equal(manifest.createdAt, 100);
			assert.equal(manifest.updatedAt, 200);
			assert.deepEqual(manifest.groups.map((group) => group.stepIndex), [1, 2]);
			assert.equal(manifest.groups[0]!.children[0]!.index, 1);
			assert.equal(manifest.groups[1]!.children[0]!.index, 3);
			assert.deepEqual(manifest.groups[1]!.children[0]!.structuredOutput, { ok: true });
			assert.equal(manifest.groups[1]!.children[0]!.patch.changed, true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records missing diff artifacts instead of throwing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-missing-diff-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			const reference = writeParallelHandoffGroup({
				manifestPath,
				runId: "run-missing-diff",
				mode: "parallel",
				source: "foreground",
				cwd: "/repo",
				stepIndex: 0,
				flatStartIndex: 0,
				setup: {
					...setup("/repo", "base-1"),
					worktrees: [{ path: "/tmp/worktree-0", agentCwd: "/tmp/worktree-0", branch: "branch-0", index: 0, nodeModulesLinked: false, syntheticPaths: [] }],
				},
				diffs: [],
				cleanup: cleanup(),
				results: [{ agent: "bad/name agent", status: "completed", summary: "done" }],
			});
			assert.equal(reference.childCount, 1);
			assert.equal(reference.changedPatches, 0);
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ParallelHandoffManifest;
			const patch = manifest.groups[0]!.children[0]!.patch;
			assert.equal(patch.changed, false);
			assert.match(patch.error ?? "", /diff artifact unavailable/);
			assert.equal(path.basename(patch.path), "missing-diff-step-0-task-0-bad_name_agent.patch");
			assert.equal(fs.existsSync(patch.path), true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects reusing a manifest path for another run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-owner-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			const common = {
				manifestPath,
				mode: "parallel" as const,
				source: "foreground" as const,
				cwd: "/repo",
				stepIndex: 0,
				flatStartIndex: 0,
				setup: setup("/repo", "base-1"),
				diffs: [diff(dir, 0, "worker", false)],
				cleanup: cleanup(),
				results: [{ agent: "worker", status: "completed" as const, summary: "done" }],
			};
			writeParallelHandoffGroup({ ...common, runId: "run-1" });
			assert.throws(
				() => writeParallelHandoffGroup({ ...common, runId: "run-2" }),
				/belongs to a different run/,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips lane identity and resolves a workflow child to its manifest task", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-lane-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			const lane = { version: 1 as const, key: "writer", mode: "mutation" as const, sourceRef: "nicobailon/pi-subagents#1621", claims: ["src/shared/types.ts"], outputPaths: ["reports/lane.md"] };
			writeParallelHandoffGroup({
				manifestPath,
				runId: "workflow-run",
				mode: "single",
				source: "async",
				cwd: "/repo",
				stepIndex: 0,
				flatStartIndex: 3,
				setup: setup("/repo", "base-1"),
				diffs: [diff(dir, 0, "writer", false)],
				cleanup: cleanup(),
				results: [{ agent: "worker", status: "completed", summary: "done", workflowKey: "writer", runId: "child-run", lane }],
			});

			const manifest = readParallelHandoffManifest(manifestPath);
			assert.deepEqual(manifest?.groups[0]?.children[0]?.lane, lane);
			assert.equal(manifest?.groups[0]?.children[0]?.workflowKey, "writer");
			assert.equal(manifest?.groups[0]?.children[0]?.runId, "child-run");
			const match = resolveParallelHandoffChild({ manifestPath, runId: "workflow-run", workflowKey: "writer", childRunId: "child-run" });
			assert.equal(match?.child.taskIndex, 0);
			assert.equal(match?.child.index, 3);
			assert.equal(resolveParallelHandoffChild({ manifestPath, runId: "workflow-run", workflowKey: "missing" }), undefined);
			assert.throws(() => resolveParallelHandoffChild({ manifestPath, runId: "other-run", workflowKey: "writer" }), /belongs to run/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed when persisted lane identity does not match the workflow key", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-handoff-lane-invalid-"));
		try {
			const manifestPath = path.join(dir, "handoff.json");
			writeParallelHandoffGroup({
				manifestPath,
				runId: "workflow-run",
				mode: "single",
				source: "async",
				cwd: "/repo",
				stepIndex: 0,
				flatStartIndex: 0,
				setup: setup("/repo", "base-1"),
				diffs: [diff(dir, 0, "writer", false)],
				cleanup: cleanup(),
				results: [{ agent: "worker", status: "completed", summary: "done", workflowKey: "writer", lane: { version: 1, key: "writer" } }],
			});
			const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { groups: Array<{ children: Array<{ lane: { key: string } }> }> };
			raw.groups[0]!.children[0]!.lane.key = "other";
			fs.writeFileSync(manifestPath, JSON.stringify(raw), "utf-8");
			assert.throws(() => readParallelHandoffManifest(manifestPath), /does not match workflow key/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
