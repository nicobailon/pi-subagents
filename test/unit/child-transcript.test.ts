import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createChildTranscriptWriter, CHILD_TRANSCRIPT_ARTIFACT_VERSION } from "../../src/shared/child-transcript.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "child-transcript-test-"));
}

function readRecords(file: string): Record<string, unknown>[] {
	return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createChildTranscriptWriter", () => {
	it("writes a versioned initial user message record with run metadata", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "out", "run-1_worker_transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "run-1",
			agent: "worker",
			childIndex: 0,
			cwd: "/repo",
		});
		writer.writeInitialUserMessage("do the thing");

		assert.equal(writer.getError(), undefined);
		const records = readRecords(transcriptPath);
		assert.equal(records.length, 1);
		const record = records[0]!;
		assert.equal(record.version, CHILD_TRANSCRIPT_ARTIFACT_VERSION);
		assert.equal(record.recordType, "message");
		assert.equal(record.source, "foreground");
		assert.equal(record.runId, "run-1");
		assert.equal(record.agent, "worker");
		assert.equal(record.childIndex, 0);
		assert.equal(record.cwd, "/repo");
		assert.equal(record.sourceEventType, "initial_prompt");
		assert.equal(record.role, "user");
		assert.equal(record.text, "do the thing");
		assert.equal(typeof record.ts, "number");
		assert.equal(typeof record.timestamp, "string");
	});

	it("omits childIndex when not provided", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "run_transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "async",
			runId: "run-2",
			agent: "reviewer",
			cwd: "/repo",
		});
		writer.writeInitialUserMessage("review it");
		const record = readRecords(transcriptPath)[0]!;
		assert.equal(Object.prototype.hasOwnProperty.call(record, "childIndex"), false);
		assert.equal(record.source, "async");
	});

	it("writes message records for message_end and tool_result_end events", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "async",
			runId: "run-3",
			agent: "worker",
			childIndex: 1,
			cwd: "/repo",
		});
		writer.writeChildEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "all done" }],
				model: "gpt-5.5",
				stopReason: "end_turn",
				usage: { input: 10, output: 5, cost: { total: 0.01 } },
			},
		});
		writer.writeChildEvent({
			type: "tool_result_end",
			message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
		});

		const records = readRecords(transcriptPath);
		assert.equal(records.length, 2);
		assert.equal(records[0]!.recordType, "message");
		assert.equal(records[0]!.sourceEventType, "message_end");
		assert.equal(records[0]!.role, "assistant");
		assert.equal(records[0]!.text, "all done");
		assert.equal(records[0]!.model, "gpt-5.5");
		assert.equal(records[0]!.stopReason, "end_turn");
		assert.deepEqual(records[0]!.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
		assert.equal(records[1]!.recordType, "message");
		assert.equal(records[1]!.sourceEventType, "tool_result_end");
		assert.equal(records[1]!.role, "toolResult");
	});

	it("writes tool_start and tool_end records and ignores unhandled event types", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "run-4",
			agent: "worker",
			cwd: "/repo",
		});
		writer.writeChildEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
		writer.writeChildEvent({ type: "tool_execution_start", toolName: "read" });
		writer.writeChildEvent({ type: "tool_execution_end", toolName: "bash" });
		writer.writeChildEvent({ type: "some_unhandled_event" });

		const records = readRecords(transcriptPath);
		assert.equal(records.length, 3);
		assert.equal(records[0]!.recordType, "tool_start");
		assert.equal(records[0]!.sourceEventType, "tool_execution_start");
		assert.equal(records[0]!.toolName, "bash");
		assert.equal(typeof records[0]!.argsPreview, "string");
		assert.ok(String(records[0]!.argsPreview).length > 0);
		assert.equal(records[1]!.recordType, "tool_start");
		assert.equal(Object.prototype.hasOwnProperty.call(records[1]!, "argsPreview"), false);
		assert.equal(records[2]!.recordType, "tool_end");
		assert.equal(records[2]!.toolName, "bash");
	});

	it("skips blank stdout/stderr lines and splits multi-line stderr text", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "async",
			runId: "run-5",
			agent: "worker",
			cwd: "/repo",
		});
		writer.writeStdoutLine("first line");
		writer.writeStdoutLine("   ");
		writer.writeStderrText("warn one\nwarn two\n\n");

		const records = readRecords(transcriptPath);
		assert.equal(records.length, 3);
		assert.equal(records[0]!.recordType, "stdout");
		assert.equal(records[0]!.text, "first line");
		assert.equal(records[1]!.recordType, "stderr");
		assert.equal(records[1]!.text, "warn one");
		assert.equal(records[2]!.recordType, "stderr");
		assert.equal(records[2]!.text, "warn two");
	});

	it("truncates after the byte cap and stops writing further records without erroring", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "run-6",
			agent: "worker",
			cwd: "/repo",
			maxBytes: 900,
		});
		writer.writeInitialUserMessage("seed record that fits within the cap");
		// This single line exceeds the remaining budget and triggers truncation.
		writer.writeStdoutLine("x".repeat(5_000));
		// Further writes must be no-ops.
		writer.writeStdoutLine("after truncation");

		assert.equal(writer.getError(), undefined);
		const records = readRecords(transcriptPath);
		const types = records.map((r) => r.recordType);
		assert.ok(types.includes("message"), "seed message should be present");
		assert.ok(types.includes("truncated"), "a truncated marker should be recorded");
		assert.ok(!types.includes("stdout"), "no stdout records should be written once truncated");
	});

	it("reserves space for a truncation marker before accepting another record", () => {
		const dir = tmpDir();
		const transcriptPath = path.join(dir, "transcript.jsonl");
		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "r",
			agent: "a",
			cwd: "/repo",
			maxBytes: 420,
		});
		writer.writeStdoutLine("a");
		writer.writeStdoutLine("b");
		writer.writeStdoutLine("after truncation");

		assert.equal(writer.getError(), undefined);
		const records = readRecords(transcriptPath);
		assert.deepEqual(records.map((record) => record.recordType), ["stdout", "truncated"]);
		assert.equal(records[0]!.text, "a");
		assert.equal(records[1]!.maxBytes, 420);
		assert.ok(fs.statSync(transcriptPath).size <= 420);
	});

	it("reports an init error and drops subsequent writes when the transcript path cannot be created", () => {
		const dir = tmpDir();
		// Precreate a regular file where a directory is expected so mkdirSync fails deterministically.
		const blocker = path.join(dir, "blocker-file");
		fs.writeFileSync(blocker, "blocks the transcript dir", "utf-8");
		const transcriptPath = path.join(blocker, "transcript.jsonl");

		const writer = createChildTranscriptWriter({
			transcriptPath,
			source: "foreground",
			runId: "run-7",
			agent: "worker",
			cwd: "/repo",
		});
		writer.writeInitialUserMessage("should not be written");

		const error = writer.getError();
		assert.ok(typeof error === "string" && error.length > 0, "an init error should be reported");
		assert.ok(error.includes(transcriptPath) || error.includes("blocker-file"), "error should reference the transcript path");
		assert.equal(fs.existsSync(transcriptPath), false);
	});
});
