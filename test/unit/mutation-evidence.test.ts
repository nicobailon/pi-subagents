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

	it("does not invoke repository fsmonitor while collecting mutation evidence", () => {
		withRepo((repo) => {
			const marker = path.join(repo, "fsmonitor-invoked");
			const hook = path.join(repo, "fsmonitor-hook.cjs");
			fs.writeFileSync(hook, `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "invoked\\n");\n`, "utf-8");
			git(repo, ["config", "core.fsmonitor", `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`]);
			git(repo, ["status", "--short"]);
			assert.equal(fs.existsSync(marker), true);
			fs.rmSync(marker);
			fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty before child\n", "utf-8");

			const snapshot = snapshotTrackedMutations(repo);
			fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty after child\n", "utf-8");
			const evidence = collectTrackedMutationEvidence(snapshot, repo);

			assert.equal(snapshot.unavailable, undefined);
			assert.equal(evidence.attemptedMutation, true);
			assert.equal(fs.existsSync(marker), false);
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

	it("classifies dirty timeouts with a missing requested report as recovery-needed", () => {
		const changedFiles = Array.from({ length: 25 }, (_, index) => `src/file-${String(index + 1).padStart(2, "0")}.ts`);
		const summary = buildTimeoutRecoverySummary({
			termination: "timed-out",
			evidence: {
				source: "tracked-files",
				trackedOnly: true,
				changedFiles,
				attemptedMutation: true,
			},
			requiredOutputMissing: true,
		});

		assert.equal(summary.changedFiles.length, 20);
		assert.deepEqual(summary.changedFiles.slice(0, 2), ["src/file-01.ts", "src/file-02.ts"]);
		assert.equal(summary.truncated, true);
		assert.match(summary.message, /\.\.\. \(5 more\)/);
		assert.doesNotMatch(summary.message, /src\/file-25\.ts/);
		assert.equal(summary.recoveryNeeded, true);
		assert.equal(summary.reason, "timed-out-with-dirty-worktree");
		assert.equal(summary.reportStatus, "missing");
		assert.match(summary.message, /Recovery needed/i);
		assert.match(summary.message, /requested report: missing/i);
		assert.match(summary.message, /review (?:the )?diff and artifacts before resuming/i);
		assert.match(summary.message, /dependent stages/i);
	});
});
