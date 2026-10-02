import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { requestAsyncStop } from "../../src/runs/background/control-channel.ts";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import type { RunEntry } from "../../src/runs/shared/run-history.ts";
import { createFakeChildSessions } from "../support/fake-child-session.ts";

// Integration coverage for the run-history wiring at the runner's terminal
// publication: these tests run the real async runner with fake child sessions
// and read the history file back, which the pure-mapper tests cannot cover.
// The launch filter (only children that actually dispatched a child session
// get a row) matters because stopRunner(), timeoutRunner(), fail-fast, and
// usage-budget skips all relabel never-launched steps to terminal statuses.

let previousAgentDir: string | undefined;
let agentDir: string;

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-history-agent-"));
	fs.chmodSync(agentDir, 0o700);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

function readHistoryRows(): RunEntry[] {
	const historyPath = path.join(agentDir, "run-history.jsonl");
	if (!fs.existsSync(historyPath)) return [];
	return fs.readFileSync(historyPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RunEntry);
}

function baseConfig(root: string, id: string, steps: SubagentRunConfig["steps"]): SubagentRunConfig {
	const asyncDir = path.join(root, `${id}-async`);
	fs.mkdirSync(asyncDir, { recursive: true });
	return {
		id, steps, resultPath: path.join(root, `${id}-result.json`), cwd: root,
		asyncDir, sessionId: `session-${id}`, artifactConfig: { enabled: false }, share: false,
		placeholder: "{previous}",
	};
}

describe("async runner run-history rows", () => {
	it("records no rows when a stop is queued before a two-step chain starts (0 sessions)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-stop-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		const fake = createFakeChildSessions(() => queue);
		try {
			const config = baseConfig(root, "stop-before-start", [
				{ agent: "stop-a1", task: "first" },
				{ agent: "stop-a2", task: "second" },
			]);
			requestAsyncStop(config.asyncDir, { source: "test" });
			await runSubagent(config, fake.factory);
			assert.equal(fake.sessions.length, 0, "no child session may be created");
			const rows = readHistoryRows();
			assert.equal(rows.filter((row) => row.agent === "stop-a1" || row.agent === "stop-a2").length, 0,
				"never-launched steps must not get history rows, even though stopRunner relabels them to stopped");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("records a row only for the fail-fast child that ran, not for its skipped sibling", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-failfast-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, "pending-ff-first.json"), JSON.stringify({ matchArgIncludes: "ff-first", output: "boom", exitCode: 1 }));
		fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ output: "ok" }));
		const fake = createFakeChildSessions(() => queue);
		try {
			await runSubagent(baseConfig(root, "fail-fast-skip", [
				{ parallel: [{ agent: "ff-first", task: "runs and fails" }, { agent: "ff-second", task: "skipped sibling" }], concurrency: 1, failFast: true },
			]), fake.factory);
			assert.equal(fake.sessions.length, 1, "only the first child launches under concurrency 1 + fail-fast");
			const rows = readHistoryRows();
			assert.equal(rows.filter((row) => row.agent === "ff-second").length, 0,
				"the fail-fast skipped child (failed/exitCode -1/skipped, startedAt set) must not get a row");
			const first = rows.filter((row) => row.agent === "ff-first");
			assert.equal(first.length, 1, "the child that really ran gets exactly one row");
			assert.equal(first[0]?.status, "error");
			assert.equal(first[0]?.outcome, "failed");
			assert.equal(first[0]?.exit, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still records one row per launched step for a normally completing chain", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-history-chain-"));
		const queue = path.join(root, "queue");
		fs.mkdirSync(queue, { recursive: true });
		fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ output: "ok" }));
		const fake = createFakeChildSessions(() => queue);
		try {
			await runSubagent(baseConfig(root, "chain-ok", [
				{ agent: "chain-a1", task: "first" },
				{ agent: "chain-a2", task: "second" },
			]), fake.factory);
			assert.equal(fake.sessions.length, 2);
			const rows = readHistoryRows();
			const a1 = rows.filter((row) => row.agent === "chain-a1");
			const a2 = rows.filter((row) => row.agent === "chain-a2");
			assert.equal(a1.length, 1);
			assert.equal(a2.length, 1);
			assert.equal(a1[0]?.status, "ok");
			assert.equal(a1[0]?.outcome, "completed");
			assert.ok(!("exit" in (a1[0] ?? {})), "successful rows omit exit");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
