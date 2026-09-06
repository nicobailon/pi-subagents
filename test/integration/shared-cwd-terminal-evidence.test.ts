import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { channel } from "node:diagnostics_channel";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ASYNC_DIR, RESULTS_DIR, observeSharedCwdRunner } from "../support/async-execution-fixture.ts";

// Synthetic lifecycle only: no runner, providers, polling, or Windows control.
test("shared-cwd failure artifact preserves correlated allowlisted lifecycle once", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-evidence-"));
	const previous = process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
	process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR = path.join(root, "artifacts");
	const id = `terminal-evidence-${process.pid}`;
	const runDir = path.join(ASYNC_DIR, id);
	const resultFile = path.join(RESULTS_DIR, `${id}.json`);
	const observer = observeSharedCwdRunner(id);
	const secret = "DO_NOT_PERSIST_TASK_RESULT_OR_SECRET";
	try {
		fs.mkdirSync(runDir, { recursive: true });
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const proc = new ChildProcess();
		proc.pid = process.pid;
		observer.launch(() => {
			channel("child_process").publish({ process: proc });
			observer.emit("subagent:async-started", { id, pid: proc.pid, task: secret });
			proc.emit("spawn");
			proc.emit("exit", 0, null);
			proc.emit("close", 0, null);
			return { content: [], isError: false, details: { asyncId: id } };
		});
		const proof = { runId: id, runnerProcessInstanceId: "instance-1906", state: "pending", task: secret };
		fs.writeFileSync(path.join(runDir, "process-terminal.json"), JSON.stringify(proof));
		fs.writeFileSync(path.join(runDir, "process-terminal-candidate.json"), JSON.stringify({ ...proof, writers: { "0": [], "1": [] }, expectedWriters: { "0": 0, "1": 0 } }));
		fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ ...proof, state: "complete", result: secret }));
		fs.writeFileSync(resultFile, JSON.stringify({ runId: id, output: secret }));
		fs.writeFileSync(path.join(runDir, "events.jsonl"), JSON.stringify({ ...proof, type: "subagent.run.completed", output: secret }) + "\n");
		fs.writeFileSync(path.join(runDir, "runner.stderr.log"), `${secret}\n#1906 phase=dispose-return invocation=2 ts=123 pid=${proc.pid}\n#1906 phase=exit invocation=0 ts=124 pid=${proc.pid}\n#1906 phase=exit invocation=0 ts=124 pid=${proc.pid + 1}\n`);
		fs.writeFileSync(path.join(runDir, "runner.stdout.log"), secret);
		observer.marks.waitStartedAt = Date.now();
		const diagnostics: string[] = [];
		observer.reportFailure((message) => diagnostics.push(message));
		const artifact = path.join(root, "artifacts", "shared-cwd-terminal.json");
		const text = fs.readFileSync(artifact, "utf8");
		assert.ok(Buffer.byteLength(text) <= 65536);
		assert.equal(text.includes(secret), false);
		assert.equal(diagnostics[0], `#1906 ${text}`);
		const evidence = JSON.parse(text);
		assert.equal(evidence.pid, process.pid);
		assert.equal(evidence.correlatedProcesses, 1);
		assert.deepEqual(evidence.processEvents[0].map((event: { type: string }) => event.type), ["spawn", "exit", "close"]);
		const files = evidence.snapshot.files;
		assert.equal(files.find((file: { name: string }) => file.name === "status.json").state, "complete");
		assert.equal(files.find((file: { name: string }) => file.name === "process-terminal.json").runnerProcessInstanceId, "instance-1906");
		assert.deepEqual(files.find((file: { name: string }) => file.name === "process-terminal-candidate.json").writers, [{ index: "0", count: 0, expected: 0 }, { index: "1", count: 0, expected: 0 }]);
		const journal = files.find((file: { name: string }) => file.name === "events.jsonl");
		assert.equal(journal.terminalPresentInRead, false);
		assert.equal(journal.parseErrors, 0);
		assert.equal(journal.lifecycle[0].type, "subagent.run.completed");
		assert.deepEqual(files.find((file: { name: string }) => file.name === "runner.stderr.log").phases, [
			{ phase: "dispose-return", invocation: 2, ts: 123, pid: process.pid },
			{ phase: "exit", invocation: 0, ts: 124, pid: process.pid },
		]);
		fs.rmSync(runDir, { recursive: true, force: true });
		fs.rmSync(resultFile, { force: true });
		observer.snapshot = () => { throw new Error("must not capture again"); };
		observer.reportFailure((message) => diagnostics.push(message));
		assert.equal(diagnostics.length, 1);
		assert.equal(fs.readFileSync(artifact, "utf8"), text, "artifact survives fixture cleanup");
		assert.deepEqual(fs.readdirSync(path.dirname(artifact)), ["shared-cwd-terminal.json"]);
	} finally {
		observer.dispose();
		if (previous === undefined) delete process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
		else process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR = previous;
		fs.rmSync(runDir, { recursive: true, force: true });
		fs.rmSync(resultFile, { force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("shared-cwd evidence is failure-only and write errors retain safe log evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-evidence-"));
	const previous = process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
	const destination = path.join(root, "artifacts");
	process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR = destination;
	const observer = observeSharedCwdRunner("terminal-evidence-no-run");
	try {
		observer.snapshot = () => { throw new Error("raw secret error"); };
		observer.summary();
		observer.dispose();
		assert.equal(fs.existsSync(destination), false, "success does not create artifacts or snapshot");
		const diagnostics: string[] = [];
		observer.reportFailure((message) => diagnostics.push(message));
		assert.deepEqual(diagnostics, ["#1906 failure snapshot unavailable (contents withheld)"]);
		assert.equal(fs.existsSync(destination), false);

		fs.writeFileSync(destination, "not a directory");
		const failedWrite = observeSharedCwdRunner("terminal-evidence-no-run");
		failedWrite.reportFailure((message) => diagnostics.push(message));
		assert.match(diagnostics[1]!, /^#1906 \{"id":"terminal-evidence-no-run"/);
		assert.equal(diagnostics[2], "#1906 failure artifact unavailable (contents withheld)");
		assert.equal(diagnostics.join("\n").includes("raw secret error"), false);
		failedWrite.dispose();

		delete process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
		const logOnly = observeSharedCwdRunner("terminal-evidence-no-run");
		logOnly.reportFailure((message) => diagnostics.push(message));
		assert.equal(diagnostics.length, 4, "unconfigured local failures remain log-only");
		logOnly.dispose();
	} finally {
		observer.dispose();
		if (previous === undefined) delete process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
		else process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
