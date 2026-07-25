import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	finalizeProcessTerminal,
	processTerminalPath,
	writeProcessTerminalCandidate,
} from "../../src/runs/background/process-terminal.ts";

test("process-terminal proof requires the matching runner instance and writer close records", () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-terminal-"));
	try {
		writeProcessTerminalCandidate(asyncDir, {
			version: 1,
			runId: "run-1",
			runnerProcessInstanceId: "runner-1",
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
