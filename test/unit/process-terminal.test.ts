import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	finalizeProcessTerminal,
	processTerminalPath,
	readProcessTerminal,
	sanitizeProcessTerminal,
	writeProcessTerminalCandidate,
} from "../../src/runs/background/process-terminal.ts";

test("process-terminal proof requires the matching runner instance and writer close records", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "run-1",
			runnerProcessInstanceId: "runner-1",
			expectedWriters: { "0": 1 },
			writers: {
				"0": [{
					processInstanceId: "writer-1",
					kind: "pi-writer",
					attempt: 0,
					closeObservedAt: 10,
					exitCode: 0,
					signal: null,
				}],
			},
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-1", state: "complete", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "complete" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");

		const mismatch = finalizeProcessTerminal(asyncDir, "run-1", {
			processInstanceId: "runner-2",
			closeObservedAt: 20,
			exitCode: 0,
			signal: null,
		});
		assert.equal(mismatch.state, "unknown");
		assert.equal(mismatch.reason, "runner-instance-mismatch");

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		const observed = finalizeProcessTerminal(asyncDir, "run-1", {
			processInstanceId: "runner-1",
			closeObservedAt: 30,
			exitCode: 0,
			signal: null,
		});
		assert.equal(observed.state, "observed");
		assert.equal(observed.instances?.length, 2);
		assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")).processTerminal.state, "observed");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal rejects missing writer close evidence", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "run-missing-writer",
			runnerProcessInstanceId: "runner-missing-writer",
			expectedWriters: { "0": 1 },
			writers: { "0": [] },
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "run-missing-writer", state: "complete", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "complete" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const proof = finalizeProcessTerminal(asyncDir, "run-missing-writer", {
			processInstanceId: "runner-missing-writer",
			closeObservedAt: 40,
			exitCode: 1,
			signal: null,
		});
		assert.equal(proof.state, "unknown");
		assert.equal(proof.reason, "writer-close-unverified");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("malformed process-terminal sidecars project unknown instead of throwing", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		fs.writeFileSync(processTerminalPath(asyncDir), JSON.stringify({ version: 1, state: "bogus" }));
		const proof = readProcessTerminal(asyncDir, { runId: "malformed-run", runnerProcessInstanceId: "malformed-runner" });
		assert.equal(proof?.state, "unknown");
		assert.equal(proof?.reason, "proof-write-failed");
		assert.match(proof?.diagnostic ?? "", /Invalid process-terminal proof/);
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const finalized = finalizeProcessTerminal(asyncDir, "malformed-run", {
			processInstanceId: "malformed-runner",
			closeObservedAt: 10,
			exitCode: 1,
			signal: null,
		});
		assert.equal(finalized.state, "unknown");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal preserves stopped non-resumability and requires lease release acknowledgement", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "stopped-run",
			runnerProcessInstanceId: "stopped-runner",
			expectedWriters: { "0": 1 },
			writers: {
				"0": [{ processInstanceId: "stopped-writer", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }],
			},
			revivalLeaseToken: "lease-token",
			revivalLeaseReleaseAcknowledged: false,
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "stopped-run", state: "stopped", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "stopped" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const unverified = finalizeProcessTerminal(asyncDir, "stopped-run", { processInstanceId: "stopped-runner", closeObservedAt: 20, exitCode: 0, signal: null });
		assert.equal(unverified.state, "unknown");
		assert.equal(unverified.reason, "canonical-session-release-unverified");

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		const candidatePath = path.join(asyncDir, "process-terminal-candidate.json");
		const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
		candidate.revivalLeaseReleaseAcknowledged = true;
		delete candidate.revivalLeaseToken;
		fs.writeFileSync(candidatePath, JSON.stringify(candidate));
		const observed = finalizeProcessTerminal(asyncDir, "stopped-run", { processInstanceId: "stopped-runner", closeObservedAt: 30, exitCode: 0, signal: null });
		assert.equal(observed.state, "observed");
		assert.equal(observed.resumeDisposition, "non-resumable");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});


test("process-terminal rejects cross-run observed sidecars and inconsistent expected writer maps", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		fs.writeFileSync(processTerminalPath(asyncDir), JSON.stringify({
			version: 1,
			state: "observed",
			runId: "wrong-run",
			runnerProcessInstanceId: "runner-1",
			observedAt: 10,
			instances: [{ processInstanceId: "runner-1", kind: "runner", closeObservedAt: 10, exitCode: 0, signal: null }],
		}));
		const crossRun = finalizeProcessTerminal(asyncDir, "actual-run", { processInstanceId: "runner-1", closeObservedAt: 20, exitCode: 0, signal: null });
		assert.equal(crossRun.state, "unknown");
		assert.equal(crossRun.reason, "proof-write-failed");
		assert.match(crossRun.diagnostic ?? "", /wrong-run|expected/);

		fs.rmSync(processTerminalPath(asyncDir), { force: true });
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "actual-run",
			runnerProcessInstanceId: "runner-1",
			expectedWriters: { "0": 0 },
			writers: {
				"0": [{ processInstanceId: "unexpected-writer", kind: "pi-writer", attempt: 0, closeObservedAt: 10, exitCode: 0, signal: null }],
			},
		});
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "actual-run", state: "complete", lifecycleArtifactVersion: 3, steps: [{ agent: "worker", status: "complete" }] }));
		fs.writeFileSync(path.join(asyncDir, "events.jsonl"), "");
		const inconsistent = finalizeProcessTerminal(asyncDir, "actual-run", { processInstanceId: "runner-1", closeObservedAt: 30, exitCode: 0, signal: null });
		assert.equal(inconsistent.state, "unknown");
		assert.equal(inconsistent.reason, "writer-close-unverified");
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});

test("process-terminal sanitizes malformed status fallback proofs", () => {
	const malformed = readProcessTerminal("/no/such/dir", { runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" });
	assert.equal(malformed, undefined);
	const sanitized = sanitizeProcessTerminal({ version: 1, state: "bogus", runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }, { runId: "run-fallback", runnerProcessInstanceId: "runner-fallback" }, "status.json");
	assert.equal(sanitized?.state, "unknown");
	assert.equal(sanitized?.reason, "proof-write-failed");
});

test("process-terminal reports unknown when the runner candidate is unavailable", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		const proof = finalizeProcessTerminal(asyncDir, "run-2", {
			processInstanceId: "runner-2",
			closeObservedAt: 40,
			exitCode: 1,
			signal: null,
		});
		assert.deepEqual(proof, {
			version: 1,
			state: "unknown",
			runId: "run-2",
			runnerProcessInstanceId: "runner-2",
			reason: "runner-candidate-missing",
		});
	} finally {
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});
