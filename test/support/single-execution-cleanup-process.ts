// Synthetic owned-file/event fixture only: no producer, detached child, SDK or CLI is launched.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SingleExecutionCleanup } from "./single-execution-cleanup.ts";
import { createEventBus } from "./helpers.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT as START, SUBAGENT_PROCESS_TERMINAL_EVENT as TERMINAL } from "../../src/shared/types.ts";
import { initializeProcessTerminal, writeProcessTerminalCandidate, finalizeProcessTerminal } from "../../src/runs/background/process-terminal.ts";

const mode = process.argv[2];
assert.ok(["failure", "success", "ordinary"].includes(mode));
const root = process.env.PI_SUBAGENTS_TEMP_ROOT!;
assert.ok(path.isAbsolute(root));
const dir = path.join(root, "synthetic-run");
fs.mkdirSync(dir);
const id = "synthetic-run", instance = "synthetic-runner", pid = 123;
initializeProcessTerminal(dir, id, instance);
fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, pid, processTerminal: { version: 1, state: "pending", runId: id, runnerProcessInstanceId: instance } }));
writeProcessTerminalCandidate(dir, { version: 1, runId: id, runnerProcessInstanceId: instance, writers: {}, expectedWriters: { "0": 0 } });
if (mode !== "ordinary") {
	const events = createEventBus();
	const cleanup = new SingleExecutionCleanup(events, 10);
	events.emit(START, { id, asyncDir: dir, pid });
	cleanup.expect(id, dir);
	if (mode === "success") {
		events.emit(TERMINAL, finalizeProcessTerminal(dir, id, { processInstanceId: instance, closeObservedAt: Date.now(), exitCode: 0, signal: null }));
		await cleanup.settle();
		cleanup.assertSettled();
	} else {
		await assert.rejects(cleanup.settle(), /process-terminal settlement deadline/);
		assert.equal(cleanup.observing, false);
	}
}
console.log(JSON.stringify({ mode, root, dir, pid: process.pid, producersLaunched: 0 }));
