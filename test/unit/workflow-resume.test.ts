import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { currentBootId } from "../../src/runs/background/boot-id.ts";
import { writeWorkflowLaunchRecord, type WorkflowLaunchRecord } from "../../src/workflows/workflow-launch-record.ts";
import { readWorkflowResumeClaim } from "../../src/workflows/workflow-resume-claim.ts";
import { manualWorkflowResumeRefusalText, prepareWorkflowResume } from "../../src/workflows/workflow-resume.ts";
import { workflowScriptDigest } from "../../src/workflows/workflow-reuse.ts";

const SCRIPT = "return args;";
const scriptLaunch: WorkflowLaunchRecord = { version: 1, source: "script", params: { workflowScript: SCRIPT, args: { n: 1 }, cwd: "/repo" }, scriptDigest: workflowScriptDigest(SCRIPT) };
const relaunch = (runId: string) => `Relaunch it by hand with options: { reuseFrom: "${runId}" }.`;

describe("prepareWorkflowResume", () => {
	const withRoot = (body: (root: string, writeRun: (runId: string, options?: { stopCause?: string; attempt?: number; state?: string; launch?: WorkflowLaunchRecord | string | null; ceiling?: unknown }) => void) => void) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-resume-"));
		try {
			body(root, (runId, options = {}) => {
				const asyncDir = path.join(root, runId);
				fs.mkdirSync(asyncDir, { recursive: true });
				const stopCause = options.stopCause === undefined ? "runtime-replaced" : options.stopCause;
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
					runId, sessionId: "session", mode: "workflow", state: options.state ?? "failed", startedAt: 1, endedAt: 2, cwd: "/repo",
					...(options.ceiling ? { admissionCapabilityCeiling: options.ceiling } : {}),
					workflow: { trace: [], emits: [], console: [], scriptDigest: workflowScriptDigest(SCRIPT), ...(stopCause ? { stopCause } : {}), ...(options.attempt !== undefined ? { resumeOrigin: { sourceRunId: "older", attempt: options.attempt } } : {}) },
				}));
				const launch = options.launch === undefined ? scriptLaunch : options.launch;
				if (typeof launch === "string") fs.writeFileSync(path.join(asyncDir, "launch.json"), launch);
				else if (launch) writeWorkflowLaunchRecord(asyncDir, launch);
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
	const prepare = (root: string, runId: string, trigger: "auto" | "manual" = "manual", currentSessionId = "session") => prepareWorkflowResume({ asyncDirRoot: root, sourceRunId: runId, trigger, now: 10, currentSessionId });

	it("claims the run and builds the relaunch from the saved launch", () => {
		withRoot((root, writeRun) => {
			const ceiling = { version: 1, allowedAgents: ["echo"], sources: ["test"] };
			writeRun("source", { ceiling });
			const prepared = prepare(root, "source");
			assert.equal(prepared.ok, true);
			if (!prepared.ok) return;
			assert.deepEqual(prepared.prepared.params, { workflowScript: SCRIPT, args: { n: 1 }, cwd: "/repo", async: true, reuseFrom: "source", capabilityCeiling: ceiling });
			assert.deepEqual(prepared.prepared.resumeOrigin, { sourceRunId: "source", attempt: 0 });
			assert.equal(prepared.prepared.expectedScriptDigest, workflowScriptDigest(SCRIPT));
			const claim = readWorkflowResumeClaim(path.join(root, "source"));
			assert.deepEqual({ newRunId: claim?.newRunId, trigger: claim?.trigger, claimedAt: claim?.claimedAt }, { newRunId: prepared.prepared.newRunId, trigger: "manual", claimedAt: 10 });
		});
	});

	it("counts only resumes that followed Pi exits, and caps them for auto-resume only", () => {
		withRoot((root, writeRun) => {
			const attemptOf = (runId: string, trigger: "auto" | "manual" = "manual") => {
				const prepared = prepare(root, runId, trigger);
				return prepared.ok ? prepared.prepared.resumeOrigin.attempt : prepared;
			};
			writeRun("exited", { stopCause: "owner-exited", attempt: 1 });
			assert.equal(attemptOf("exited"), 2);
			writeRun("replaced", { stopCause: "runtime-replaced", attempt: 1 });
			assert.equal(attemptOf("replaced"), 1);
			writeRun("replaced-at-cap", { stopCause: "runtime-replaced", attempt: 3 });
			assert.equal(attemptOf("replaced-at-cap", "auto"), 3);
			writeRun("exited-at-cap", { stopCause: "owner-exited", attempt: 3 });
			assert.deepEqual(attemptOf("exited-at-cap", "auto"), { ok: false, code: "attempts", reason: "3 resumes already followed Pi exits", byHand: 'Resume by hand: subagent({ action: "resume", id: "exited-at-cap" })' });
			assert.equal(readWorkflowResumeClaim(path.join(root, "exited-at-cap")), undefined, "a refused auto-resume takes no claim");
			assert.equal(attemptOf("exited-at-cap", "manual"), 4);
		});
	});

	it("refuses a run that cannot be relaunched from its saved launch", () => {
		withRoot((root, writeRun) => {
			const cases: Array<[string, Parameters<typeof writeRun>[1], string, string]> = [
				["completed", { stopCause: "", state: "complete" }, "not-interrupted", "not interrupted; pass message to revive one of its children"],
				["missing", { launch: null }, "launch-missing", "launch.json is missing (the run started before launches were saved)"],
				["invalid", { launch: "{bad" }, "launch-invalid", "launch.json is invalid: not valid JSON: "],
				["structured", { launch: { version: 1, source: "structured", scriptDigest: "d" } }, "structured", "launched from tasks/chain; resume it by hand"],
				["edited", { launch: { ...scriptLaunch, params: { ...scriptLaunch.params, workflowScript: "return 2;" } } }, "launch-invalid", "launch.json is invalid: its script does not match its scriptDigest"],
			];
			for (const [runId, options, code, reason] of cases) {
				writeRun(runId, options);
				const prepared = prepare(root, runId);
				assert.equal(prepared.ok, false, runId);
				if (prepared.ok) continue;
				assert.equal(prepared.code, code, runId);
				assert.ok(prepared.reason.startsWith(reason), `${runId}: ${prepared.reason}`);
				assert.equal(prepared.byHand, code === "not-interrupted" ? "" : relaunch(runId), runId);
				assert.equal(readWorkflowResumeClaim(path.join(root, runId)), undefined, `${runId} takes no claim`);
			}
			assert.equal(manualWorkflowResumeRefusalText("missing", { reason: "launch.json is missing (the run started before launches were saved)", byHand: relaunch("missing") }),
				`Cannot resume workflow 'missing': launch.json is missing (the run started before launches were saved). Relaunch it by hand with options: { reuseFrom: "missing" }.`);
			assert.equal(manualWorkflowResumeRefusalText("x", { reason: "capacity refused: full", byHand: 'Resume by hand: subagent({ action: "resume", id: "x" })' }), "Cannot resume workflow 'x': capacity refused: full.");
			assert.equal(manualWorkflowResumeRefusalText("x", { reason: "capacity refused: 1/1 used.", byHand: "" }), "Cannot resume workflow 'x': capacity refused: 1/1 used.");
		});
	});

	it("refuses a run another session started, and writes nothing into it", () => {
		withRoot((root, writeRun) => {
			writeRun("foreign");
			const before = fs.readdirSync(path.join(root, "foreign")).sort();
			for (const trigger of ["manual", "auto"] as const) {
				assert.deepEqual(prepare(root, "foreign", trigger, "other-session"), { ok: false, code: "not-owned", reason: "it was started in another session; reopen that session to resume it", byHand: "" });
			}
			assert.deepEqual(fs.readdirSync(path.join(root, "foreign")).sort(), before);
		});
	});

	it("maps a held or completed claim to its refusal", () => {
		withRoot((root, writeRun) => {
			// The test runner's parent process is alive, so its claim is held.
			writeRun("held");
			fs.writeFileSync(path.join(root, "held", "resumed-by.1.json"), JSON.stringify({ version: 1, pid: process.ppid, ...(currentBootId() ? { bootId: currentBootId() } : {}), claimedAt: 1, newRunId: "pending-run", trigger: "auto" }));
			assert.deepEqual(prepare(root, "held"), { ok: false, code: "claim-busy", reason: `being resumed by pid ${process.ppid}`, byHand: "" });
			writeRun("done");
			fs.writeFileSync(path.join(root, "done", "resumed-by.1.json"), JSON.stringify({ version: 1, pid: process.ppid, claimedAt: 1, newRunId: "next-run", trigger: "manual" }));
			fs.mkdirSync(path.join(root, "next-run"));
			fs.writeFileSync(path.join(root, "next-run", "status.json"), "{}");
			assert.deepEqual(prepare(root, "done"), { ok: false, code: "claim-resumed", reason: "resumed as next-run; wait on it or stop it", byHand: "" });
		});
	});
});
