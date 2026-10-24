import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { currentBootId } from "../../src/runs/background/boot-id.ts";
import { currentPidNamespaceScope } from "../../src/runs/background/pid-namespace.ts";
import { claimWorkflowResume, describeWorkflowResume, readWorkflowResumeClaim, recordWorkflowResumeRefusal, releaseWorkflowResumeClaim, workflowResumeClaimState } from "../../src/workflows/workflow-resume-claim.ts";
import { writeWorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { claimedWorkflowRunRefusal } from "../../src/workflows/workflow-reuse.ts";

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
			// Written as claimWorkflowResume writes this process's claim: with its boot id and, on Linux, its pid namespace.
			writeClaim(asyncDir, 1, { ...foreignClaim, pid: process.pid, ...(currentBootId() ? { bootId: currentBootId() } : {}), ...(currentPidNamespaceScope() ? { pidNamespaceScope: currentPidNamespaceScope() } : {}) });
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
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "unreadable" });
			assert.deepEqual(workflowResumeClaimState(asyncDir), { kind: "unreadable" });
			assert.deepEqual(files(), ["resumed-by.1.json"]);
			assert.equal(claimedWorkflowRunRefusal("run-1", { kind: "unreadable" }, false), "Workflow run 'run-1' has a resume claim that cannot be read; wait or remove it.");
			assert.equal(claimedWorkflowRunRefusal("run-1", { kind: "unreadable" }, true), "options.reuseFrom: workflow run 'run-1' has a resume claim that cannot be read; wait or remove it.");
		});
	});

	it("judges a claim with this pid in another pid namespace by its liveness, not as this process's own", () => {
		withRun((asyncDir) => {
			writeClaim(asyncDir, 1, { ...foreignClaim, pid: process.pid, ...(currentBootId() ? { bootId: currentBootId() } : {}), pidNamespaceScope: "pid:[another-container]" });
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: () => "alive" }), { kind: "busy", pid: process.pid, newRunId: "first-run" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "alive" }), { kind: "busy", pid: process.pid });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "second-run", trigger: "manual", liveness: () => "dead" }), { kind: "owner" });
		});
	});

	it("releases only this process's own current claim, and a released claim blocks nothing", () => {
		withRun((asyncDir, files) => {
			writeClaim(asyncDir, 1, foreignClaim);
			releaseWorkflowResumeClaim(asyncDir, "first-run");
			assert.deepEqual(files(), ["resumed-by.1.json"], "another process's claim is never moved");
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "new-run", trigger: "reuse", liveness: () => "dead" }), { kind: "owner" });
			releaseWorkflowResumeClaim(asyncDir, "other-run");
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "new-run");
			releaseWorkflowResumeClaim(asyncDir, "new-run");
			assert.deepEqual(files().map((name) => name.replace(/released-.*/, "released-*")), ["resumed-by.1.json", "resumed-by.2.json.released-*"]);
			// Claim 1 is below the released top, so it is not judged again even if its pid is now in use.
			const probed: string[] = [];
			const alive = (claim: { newRunId: string }) => { probed.push(claim.newRunId); return "alive" as const; };
			assert.equal(readWorkflowResumeClaim(asyncDir), undefined);
			assert.deepEqual(workflowResumeClaimState(asyncDir, { liveness: alive }), { kind: "none" });
			assert.deepEqual(claimWorkflowResume(asyncDir, { newRunId: "next-run", trigger: "manual", liveness: alive }), { kind: "owner" });
			assert.deepEqual(probed, []);
			assert.equal(readWorkflowResumeClaim(asyncDir)?.newRunId, "next-run");
			assert.deepEqual(files().map((name) => name.replace(/released-.*/, "released-*")), ["resumed-by.1.json", "resumed-by.2.json.released-*", "resumed-by.3.json"]);
		});
	});

	it("describes what happens next to the run in the notice-line order", () => {
		const byHand = 'Resume by hand: subagent({ action: "resume", id: "source" })';
		const relaunch = 'Relaunch it by hand with options: { reuseFrom: "source" }.';
		const describe = (setUp: (asyncDir: string) => void) => {
			let line = "";
			withRun((asyncDir) => { setUp(asyncDir); line = describeWorkflowResume(asyncDir, "source"); });
			return line;
		};
		const refusal = { reason: "launch failed: no slot.", byHand };
		// A refusal with no claim, or one recorded for the current claim's run.
		assert.equal(describe((dir) => recordWorkflowResumeRefusal(dir, refusal)), `Not auto-resumed: launch failed: no slot. ${byHand}`);
		assert.equal(describe((dir) => recordWorkflowResumeRefusal(dir, { reason: "it is not interrupted", byHand: "" })), "Not auto-resumed: it is not interrupted.");
		assert.equal(describe((dir) => { writeClaim(dir, 1, { ...foreignClaim, newRunId: "failed-run" }); recordWorkflowResumeRefusal(dir, { ...refusal, newRunId: "failed-run" }); }), `Not auto-resumed: launch failed: no slot. ${byHand}`);
		// A refusal from an earlier attempt does not hide a later claim.
		assert.equal(describe((dir) => { recordWorkflowResumeRefusal(dir, { ...refusal, newRunId: "failed-run" }); writeClaim(dir, 2, { ...foreignClaim, newRunId: "later-run", trigger: "manual" }); }), "Resumed as later-run.");
		assert.equal(describe((dir) => writeClaim(dir, 1, foreignClaim)), "Auto-resumed as first-run.");
		assert.equal(describe((dir) => writeClaim(dir, 1, { ...foreignClaim, trigger: "manual" })), "Resumed as first-run.");
		assert.equal(describe((dir) => writeClaim(dir, 1, { ...foreignClaim, trigger: "reuse" })), "Relaunched as first-run.");
		// No claim (a released top is none): by hand, by id only when the saved launch can be resumed.
		const script = { version: 1, source: "script", params: { workflowScript: "return 1;" }, scriptDigest: "digest" } as const;
		assert.equal(describe((dir) => writeWorkflowLaunchRecord(dir, script)), byHand);
		assert.equal(describe((dir) => { writeWorkflowLaunchRecord(dir, script); claimWorkflowResume(dir, { newRunId: "given-back", trigger: "auto" }); releaseWorkflowResumeClaim(dir, "given-back"); }), byHand);
		assert.equal(describe(() => {}), relaunch);
		assert.equal(describe((dir) => writeWorkflowLaunchRecord(dir, { version: 1, source: "structured", scriptDigest: "digest" })), relaunch);
		assert.equal(describe((dir) => fs.writeFileSync(path.join(dir, "launch.json"), "{")), relaunch);
	});
});
