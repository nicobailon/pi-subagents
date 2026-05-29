import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadRunsForAgent, recordRun, type RunEntry } from "../../src/runs/shared/run-history.ts";

const SRC = fileURLToPath(new URL("../../src/runs/shared/run-history.ts", import.meta.url));

function freshAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runhist-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function historyLines(dir: string): RunEntry[] {
	const raw = fs.readFileSync(path.join(dir, "run-history.jsonl"), "utf-8");
	return raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as RunEntry);
}

describe("recordRun v2 fields", () => {
	it("writes the new fields when provided", () => {
		const dir = freshAgentDir();
		recordRun("a", "task", 0, 12, { model: "openai-codex/gpt-5.3-codex", cwd: "/tmp/x", tool_calls: 7 });
		const [entry] = historyLines(dir);
		assert.equal(entry.model, "openai-codex/gpt-5.3-codex");
		assert.equal(entry.cwd, "/tmp/x");
		assert.equal(entry.tool_calls, 7);
		assert.equal(entry.status, "ok");
		assert.equal(entry.duration, 12);
	});

	it("omits new fields when not provided", () => {
		const dir = freshAgentDir();
		recordRun("a", "task", 0, 12);
		const [entry] = historyLines(dir);
		assert.equal("model" in entry, false);
		assert.equal("cwd" in entry, false);
		assert.equal("tool_calls" in entry, false);
		assert.equal("error_excerpt" in entry, false);
	});

	it("preserves tool_calls: 0 (not dropped by truthiness)", () => {
		const dir = freshAgentDir();
		recordRun("a", "task", 0, 1, { tool_calls: 0 });
		const [entry] = historyLines(dir);
		assert.equal("tool_calls" in entry, true);
		assert.equal(entry.tool_calls, 0);
	});

	it("records error_excerpt on failure, truncated to 300 chars", () => {
		const dir = freshAgentDir();
		const long = "x".repeat(500);
		recordRun("a", "task", 1, 1, { error_excerpt: long });
		const [entry] = historyLines(dir);
		assert.equal(entry.status, "error");
		assert.equal(entry.exit, 1);
		assert.equal(entry.error_excerpt?.length, 300);
	});
});

describe("loadRunsForAgent forward-compat", () => {
	it("parses v2-shaped entries (incl. unknown fields) without throwing, filtered by agent", () => {
		const dir = freshAgentDir();
		const histPath = path.join(dir, "run-history.jsonl");
		const v2 = { agent: "z", task: "t", ts: 1, status: "ok", duration: 1, model: "m", cwd: "/c", tool_calls: 3, error_excerpt: "e", futureField: { nested: true } };
		const other = { agent: "other", task: "t2", ts: 2, status: "ok", duration: 1 };
		fs.writeFileSync(histPath, `${JSON.stringify(v2)}\n${JSON.stringify(other)}\n`);
		const runs = loadRunsForAgent("z");
		assert.equal(runs.length, 1);
		assert.equal(runs[0].agent, "z");
		assert.equal(runs[0].model, "m");
		assert.equal(runs[0].tool_calls, 3);
	});
});

describe("rotation on the write path", () => {
	it("trims to ROTATE_KEEP and keeps the newest entry", () => {
		const dir = freshAgentDir();
		const histPath = path.join(dir, "run-history.jsonl");
		const seed = Array.from({ length: 1200 }, (_, i) => JSON.stringify({ agent: "a", task: `seed${i}`, ts: i, status: "ok", duration: 1 })).join("\n");
		fs.writeFileSync(histPath, `${seed}\n`);
		recordRun("a", "newest", 0, 1, { tool_calls: 1 });
		const lines = historyLines(dir);
		assert.equal(lines.length, 1000);
		assert.equal(lines[lines.length - 1].task, "newest");
	});
});

describe("multi-process storm (lock-free append + atomic-rename rotation)", () => {
	// The hard invariants the contract guarantees: never corrupt, never double-write,
	// bounded size, rotation fires under concurrency. Dropping an append during the
	// rare rotate window is permitted, so we do NOT assert that every write survives.
	it("never corrupts or double-writes across many concurrent processes", async () => {
		const dir = freshAgentDir();
		const histPath = path.join(dir, "run-history.jsonl");
		const childFile = path.join(dir, "writer.ts");
		const PROCS = 16;
		const PER_PROC = 150;
		fs.writeFileSync(childFile, `
const [srcUrl, agentDir, tag, n] = process.argv.slice(2);
process.env.PI_CODING_AGENT_DIR = agentDir;
const { recordRun } = await import(srcUrl);
for (let i = 0; i < Number(n); i++) recordRun("storm", tag + ":" + i, 0, 1, { tool_calls: 0 });
`);

		// Run children with the same TS-execution mechanism as the test runner.
		// Whitelist the TS-loader flags from the parent's execArgv (handling both
		// --flag=value and space-form --flag value) instead of hardcoding one flag
		// that drifts on rename, or inheriting all of execArgv (which would leak
		// --test*/--inspect*/profiler flags into 16 children).
		const TS_BOOL_FLAGS = new Set(["--experimental-strip-types", "--experimental-transform-types"]);
		const TS_VALUE_FLAGS = new Set(["--import", "--loader", "--experimental-loader", "--require", "-r"]);
		const childExecArgv: string[] = [];
		for (let i = 0; i < process.execArgv.length; i++) {
			const arg = process.execArgv[i]!;
			const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
			if (TS_BOOL_FLAGS.has(name)) {
				childExecArgv.push(arg);
			} else if (TS_VALUE_FLAGS.has(name)) {
				childExecArgv.push(arg);
				if (!arg.includes("=") && i + 1 < process.execArgv.length) childExecArgv.push(process.execArgv[++i]!);
			}
		}
		const procs = Array.from({ length: PROCS }, (_, k) => new Promise<void>((resolve, reject) => {
			const p = spawn(process.execPath, [...childExecArgv, childFile, pathToFileURL(SRC).href, dir, `p${k}`, String(PER_PROC)], { stdio: "ignore" });
			p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child p${k} exited ${code}`))));
			p.on("error", reject);
		}));
		await Promise.all(procs);

		const lines = fs.readFileSync(histPath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
		// (1) no corruption: every line is valid JSON
		const entries = lines.map((l) => JSON.parse(l) as RunEntry);
		// (2) no double-write: markers in the file are unique (this is the codex
		//     double-enter failure mode — it cannot happen with lock-free appends)
		const markers = entries.map((e) => e.task);
		assert.equal(new Set(markers).size, markers.length, "duplicate entry detected");
		// (3) rotation fired and stayed bounded; never jammed to empty
		const total = PROCS * PER_PROC;
		assert.ok(entries.length < total, `rotation never fired: ${entries.length} >= ${total}`);
		// Module-private rotation constants: ROTATE_KEEP=1000, ROTATE_READ_THRESHOLD=1200.
		// The file is trimmed to 1000 and can transiently exceed 1200 by at most one append
		// per concurrent process before a rotate completes.
		assert.ok(entries.length >= 1000 && entries.length <= 1200 + PROCS, `unexpected count ${entries.length}`);
	});
});
