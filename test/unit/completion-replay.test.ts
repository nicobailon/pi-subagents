import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readCompletionArchive, readCompletionReplay, writeCompletionArchive } from "../../src/runs/background/completion-replay.ts";
import { collectWaitCompletions, recordWaitCompletion } from "../../src/runs/background/wait-completions.ts";
import type { AsyncRunSummary } from "../../src/runs/background/async-status.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function makeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: "session-a",
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}

describe("completion replay", () => {
	it("surfaces a consumed completion after in-memory watcher state is lost", () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-replay-"));
		try {
			const now = Date.now();
			recordWaitCompletion(makeState(), "run-a", {
				agent: "worker",
				mode: "single",
				state: "complete",
				success: true,
				results: [{ agent: "worker", success: true, outputState: "present", output: "finished output" }],
			}, now, 60_000, { resultsDir, sessionId: "session-a" });

			const replay = readCompletionReplay(resultsDir, "run-a", { sessionId: "session-a", now: now + 1 });
			assert.equal(replay?.version, 1);
			assert.equal(replay?.completion.archivePath, replay?.archivePath);
			assert.equal(readCompletionArchive(replay!.archivePath)?.entries[0]?.text, "[worker]\nfinished output");

			const terminal = [{ id: "run-a", sessionId: "session-a" }] as AsyncRunSummary[];
			const completions = collectWaitCompletions(terminal, makeState(), resultsDir);
			assert.equal(completions?.[0]?.runId, "run-a");
			assert.equal(completions?.[0]?.results?.[0]?.agent, "worker");
			assert.equal(completions?.[0]?.archivePath, replay?.archivePath);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("prefers saved outputs and bounds fallback output tails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-completion-archive-"));
		try {
			const savedOutput = path.join(root, "saved-output.md");
			fs.writeFileSync(savedOutput, "saved", "utf-8");
			const archivePath = writeCompletionArchive(root, "run-b", {
				results: [
					{ agent: "saved", output: "duplicate text", artifactPaths: { outputPath: savedOutput } },
					{ agent: "fallback", output: `start-${"x".repeat(70 * 1024)}-tail` },
				],
			}, Date.now());
			const archive = readCompletionArchive(archivePath);
			assert.deepEqual(archive?.entries[0], { agent: "saved", source: "output-artifact", path: savedOutput });
			const fallback = archive?.entries[1];
			assert.equal(fallback?.source, "result-tail");
			assert.equal(fallback?.truncated, true);
			assert.ok(Buffer.byteLength(fallback?.text ?? "", "utf-8") <= 64 * 1024);
			assert.match(fallback?.text ?? "", /-tail$/);
			assert.equal((fallback?.text ?? "").includes("duplicate text"), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
