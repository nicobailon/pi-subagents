import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTimeoutRecoverySummary, collectTrackedMutationEvidence, snapshotTrackedMutations } from "../../src/runs/shared/mutation-evidence.ts";
import { evaluateCompletionMutationGuard } from "../../src/runs/shared/completion-guard.ts";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function withRepo(run: (repo: string) => void): void {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-mutation-evidence-"));
	try {
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test User"]);
		fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf-8");
		git(repo, ["add", "tracked.txt"]);
		git(repo, ["commit", "-m", "base"]);
		run(repo);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
}

describe("tracked mutation evidence", () => {
	it("detects edits to a tracked file that was already dirty at child start", () => {
		withRepo((repo) => {
			fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before child\n", "utf-8");
			const snapshot = snapshotTrackedMutations(repo);

			fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty after child\n", "utf-8");
			fs.writeFileSync(path.join(repo, "untracked.txt"), "ignored by evidence\n", "utf-8");
			const evidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(evidence.attemptedMutation, true);
			assert.deepEqual(evidence.changedFiles, ["tracked.txt"]);
		});
	});

	it("detects a child reverting a tracked file that was dirty at child start", () => {
		withRepo((repo) => {
			fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before child\n", "utf-8");
			const snapshot = snapshotTrackedMutations(repo);

			fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf-8");
			const evidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(evidence.attemptedMutation, true);
			assert.deepEqual(evidence.changedFiles, ["tracked.txt"]);
		});
	});

	it("detects staged edits to a tracked file that was already staged dirty at child start", () => {
		withRepo((repo) => {
			fs.writeFileSync(path.join(repo, "tracked.txt"), "staged before child\n", "utf-8");
			git(repo, ["add", "tracked.txt"]);
			const snapshot = snapshotTrackedMutations(repo);

			fs.writeFileSync(path.join(repo, "tracked.txt"), "staged after child\n", "utf-8");
			git(repo, ["add", "tracked.txt"]);
			const evidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(evidence.attemptedMutation, true);
			assert.deepEqual(evidence.changedFiles, ["tracked.txt"]);
		});
	});

	it("distinguishes unchanged and changed tracked diffs that exceed the fast buffer", () => {
		withRepo((repo) => {
			const largeBefore = `${"before\n".repeat(180_000)}before-tail\n`;
			const largeAfter = `${"after\n".repeat(180_000)}after-tail\n`;
			fs.writeFileSync(path.join(repo, "tracked.txt"), largeBefore, "utf-8");
			const snapshot = snapshotTrackedMutations(repo);
			const unchangedEvidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(unchangedEvidence.attemptedMutation, false);
			assert.deepEqual(unchangedEvidence.changedFiles, []);

			fs.writeFileSync(path.join(repo, "tracked.txt"), largeAfter, "utf-8");
			const evidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(evidence.attemptedMutation, true);
			assert.deepEqual(evidence.changedFiles, ["tracked.txt"]);
		});
	});

	it("uses tracked evidence as completion guard mutation proof", () => {
		const guard = evaluateCompletionMutationGuard({
			agent: "worker",
			task: "Implement the requested fix.",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Implemented." }] }],
			tools: ["edit"],
			mutationEvidence: {
				source: "tracked-files",
				trackedOnly: true,
				changedFiles: ["tracked.txt"],
				attemptedMutation: true,
			},
		});

		assert.equal(guard.expectedMutation, true);
		assert.equal(guard.attemptedMutation, true);
		assert.equal(guard.triggered, false);
	});

	it("formats bounded timeout recovery data", () => {
		const summary = buildTimeoutRecoverySummary({
			termination: "timed-out",
			evidence: {
				source: "tracked-files",
				trackedOnly: true,
				changedFiles: ["tracked.txt"],
				attemptedMutation: true,
			},
			currentTool: "edit",
			currentPath: "tracked.txt",
			sessionFile: "session.jsonl",
		});

		assert.deepEqual(summary.changedFiles, ["tracked.txt"]);
		assert.match(summary.message, /termination: timed-out/);
		assert.match(summary.message, /changed tracked files: tracked\.txt/);
		assert.match(summary.message, /active tool: edit/);
	});
});
