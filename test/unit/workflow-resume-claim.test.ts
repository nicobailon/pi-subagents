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
	const writeClaim = (asyncDir: string, claim: Record<string, unknown> | string) => fs.writeFileSync(path.join(asyncDir, "resumed-by.json"), typeof claim === "string" ? claim : JSON.stringify(claim));
	const foreignClaim = { version: 1, pid: 4242, claimedAt: 1, newRunId: "first-run", trigger: "auto" };

	it("makes the first claimant the owner and writes its whole claim", () => {
		withRun((asyncDir, files) => {
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse", now: 5 }), { kind: "owner" });
			const claim = readWorkflowResumeClaim(asyncDir);
			assert.equal(claim?.pid, process.pid);
			assert.equal(claim?.bootId, currentBootId());
			assert.deepEqual({ version: claim?.version, claimedAt: claim?.claimedAt, newRunId: claim?.newRunId, trigger: claim?.trigger }, { version: 1, claimedAt: 5, newRunId: "new-run", trigger: "reuse" });
			assert.deepEqual(files(), ["resumed-by.json"], "no temporary file is left");
			// This process still holds it, so another claimant is refused.
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "other-run", trigger: "manual" }), { kind: "busy", pid: process.pid });
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "busy", pid: process.pid, newRunId: "new-run" });
			// The same new run claiming again (a resume that pre-claimed) still owns it.
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse" }), { kind: "owner" });
		});
	});

	it("refuses while the claimant may be alive and takes over once it is dead", () => {
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, foreignClaim);
			for (const liveness of ["alive", "unknown"] as const) {
				assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => liveness }), { kind: "busy", pid: 4242 });
				assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => liveness }), { kind: "busy", pid: 4242, newRunId: "first-run" });
			}
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => "dead" }), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "owner" });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "second-run");
			const stale = files().filter((name) => name.startsWith("resumed-by.json.stale-"));
			assert.equal(stale.length, 1);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(asyncDir, stale[0]!), "utf-8")), foreignClaim);
		});
	});

	it("reports a claim whose new run started as resumed, whatever its claimant", () => {
		withRun((asyncDir) => {
			writeClaim(asyncDir, foreignClaim);
			fs.mkdirSync(path.join(path.dirname(asyncDir), "first-run"));
			fs.writeFileSync(path.join(path.dirname(asyncDir), "first-run", "status.json"), "{}");
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "resumed", newRunId: "first-run" });
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => "dead" }), { kind: "resumed", newRunId: "first-run" });
		});
	});

	it("takes over this process's claim that no runtime holds, and a corrupt claim", () => {
		withRun((asyncDir) => {
			writeClaim(asyncDir, { ...foreignClaim, pid: process.pid, ...(currentBootId() ? { bootId: currentBootId() } : {}) });
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "auto" }), { kind: "owner" });
		});
		withRun((asyncDir) => {
			writeClaim(asyncDir, "{not json");
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "auto" }), { kind: "owner" });
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "second-run");
		});
	});

	it("releases only a claim for the same new run", () => {
		withRun((asyncDir, files) => {
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse" }), { kind: "owner" });
			releaseWorkflowResumeClaim(asyncDir, "other-run");
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "new-run");
			releaseWorkflowResumeClaim(asyncDir, "new-run");
			assert.equal(readWorkflowResumeClaim(asyncDir), undefined);
			assert.equal(files().filter((name) => name.startsWith("resumed-by.json.released-")).length, 1);
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "next-run", trigger: "manual" }), { kind: "owner" });
		});
	});
});
