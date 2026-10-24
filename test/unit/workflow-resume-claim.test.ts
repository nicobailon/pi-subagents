import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { currentBootId } from "../../src/runs/background/boot-id.ts";
import { claimWorkflowResume, readWorkflowResumeClaim, releaseWorkflowResumeClaim, workflowResumeClaimState } from "../../src/workflows/workflow-resume-claim.ts";

describe("workflow resume claim", () => {
	const withRun = (body: (asyncDir: string, files: () => string[]) => void) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-claim-"));
		const asyncDir = path.join(root, "source");
		fs.mkdirSync(asyncDir);
		try {
			body(asyncDir, () => fs.readdirSync(asyncDir).sort());
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
	const writeClaim = (asyncDir: string, generation: number, claim: Record<string, unknown> | string) => fs.writeFileSync(path.join(asyncDir, `resumed-by.${generation}.json`), typeof claim === "string" ? claim : JSON.stringify(claim));
	const readGeneration = (asyncDir: string, generation: number) => JSON.parse(fs.readFileSync(path.join(asyncDir, `resumed-by.${generation}.json`), "utf-8")) as Record<string, unknown>;
	const foreignClaim = { version: 1, pid: 4242, claimedAt: 1, newRunId: "first-run", trigger: "auto" };

	it("makes the first claimant the owner and writes its whole claim", () => {
		withRun((asyncDir, files) => {
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse", now: 5 }), { kind: "owner" });
			const claim = readWorkflowResumeClaim(asyncDir);
			assert.equal(claim?.pid, process.pid);
			assert.equal(claim?.bootId, currentBootId());
			assert.deepEqual({ version: claim?.version, claimedAt: claim?.claimedAt, newRunId: claim?.newRunId, trigger: claim?.trigger }, { version: 1, claimedAt: 5, newRunId: "new-run", trigger: "reuse" });
			assert.deepEqual(files(), ["resumed-by.1.json"], "no temporary file is left");
			// This process still holds it, so another claimant is refused.
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "other-run", trigger: "manual" }), { kind: "busy", pid: process.pid });
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "busy", pid: process.pid, newRunId: "new-run" });
			// The same new run claiming again (a resume that pre-claimed) still owns it.
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse" }), { kind: "owner" });
			assert.deepEqual(files(), ["resumed-by.1.json"]);
		});
	});

	it("refuses while the claimant may be alive and supersedes a dead claim without moving it", () => {
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, 1, foreignClaim);
			for (const liveness of ["alive", "unknown"] as const) {
				assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => liveness }), { kind: "busy", pid: 4242 });
				assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => liveness }), { kind: "busy", pid: 4242, newRunId: "first-run" });
			}
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => "dead" }), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "owner" });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "second-run");
			assert.deepEqual(files(), ["resumed-by.1.json", "resumed-by.2.json"]);
			assert.deepEqual(readGeneration(asyncDir, 1), foreignClaim, "the dead claim stays where it was");
		});
	});

	it("gives exactly one owner when two takers supersede the same dead claim at once", () => {
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, 1, foreignClaim);
			let inner: ReturnType<typeof claimWorkflowResume> | undefined;
			// Taker B judges claim 1 dead; while it does, taker A supersedes it completely.
			const outer = claimWorkflowResume(asyncDir, { newRunId: "taker-b", trigger: "manual", liveness: () => {
				inner ??= claimWorkflowResume(asyncDir, { newRunId: "taker-a", trigger: "manual", liveness: () => "dead" });
				return "dead";
			} });
			assert.deepEqual(inner, { kind: "owner" });
			assert.deepEqual(outer, { kind: "busy", pid: process.pid });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "taker-a");
			assert.deepEqual(files(), ["resumed-by.1.json", "resumed-by.2.json"]);
		});
	});

	it("reports a claim whose new run started as resumed, whatever its claimant", () => {
		withRun((asyncDir) => {
			writeClaim(asyncDir, 1, foreignClaim);
			fs.mkdirSync(path.join(path.dirname(asyncDir), "first-run"));
			fs.writeFileSync(path.join(path.dirname(asyncDir), "first-run", "status.json"), "{}");
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "resumed", newRunId: "first-run" });
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => "dead" }), { kind: "resumed", newRunId: "first-run" });
		});
	});

	it("supersedes this process's claim that no runtime holds, and a corrupt claim", () => {
		withRun((asyncDir) => {
			writeClaim(asyncDir, 1, { ...foreignClaim, pid: process.pid, ...(currentBootId() ? { bootId: currentBootId() } : {}) });
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "auto" }), { kind: "owner" });
		});
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, 1, "{not json");
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "auto" }), { kind: "owner" });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "second-run");
			assert.deepEqual(files(), ["resumed-by.1.json", "resumed-by.2.json"]);
		});
	});

	it("fails closed when the current claim cannot be read", () => {
		withRun((asyncDir, files) => {
			// A directory in the claim's place: reading it fails with EISDIR, not ENOENT.
			fs.mkdirSync(path.join(asyncDir, "resumed-by.1.json"));
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "busy", pid: 0 });
			assert.equal(workflowResumeClaimState(asyncDir).kind, "busy");
			assert.deepEqual(files(), ["resumed-by.1.json"]);
		});
	});

	it("releases only this process's own current claim", () => {
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, 1, foreignClaim);
			releaseWorkflowResumeClaim(asyncDir, "first-run");
			assert.deepEqual(files(), ["resumed-by.1.json"], "another process's claim is never moved");
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse", liveness: () => "dead" }), { kind: "owner" });
			releaseWorkflowResumeClaim(asyncDir, "other-run");
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "new-run");
			releaseWorkflowResumeClaim(asyncDir, "new-run");
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "first-run");
			assert.deepEqual(files().map((name) => name.replace(/released-.*/, "released-*")), ["resumed-by.1.json", "resumed-by.2.json.released-*"]);
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "next-run", trigger: "manual", liveness: () => "dead" }), { kind: "owner" });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "next-run");
		});
	});
});
