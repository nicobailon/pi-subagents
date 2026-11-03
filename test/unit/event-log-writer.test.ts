import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventLogWriter } from "../../src/runs/foreground/event-log-writer.ts";

function harness(options: { existingBytes?: number; limitBytes?: number; warnBytes?: number } = {}) {
	const lines: string[] = [];
	const warnings: string[] = [];
	let bytes = options.existingBytes ?? 0;
	const writer = createEventLogWriter({
		eventsPath: "run/events.jsonl",
		runId: "run-1",
		onWarn: (message) => warnings.push(message),
		now: () => 1_000,
		sizeOf: () => bytes,
		appendLine: (_filePath, line) => {
			bytes += Buffer.byteLength(line, "utf-8");
			lines.push(line);
		},
		...(options.limitBytes !== undefined ? { limitBytes: options.limitBytes } : {}),
		...(options.warnBytes !== undefined ? { warnBytes: options.warnBytes } : {}),
	});
	return { writer, lines, warnings, bytes: () => bytes };
}

it("writes the event with the run id and keeps byte accounting honest", () => {
	const { writer, lines, bytes } = harness();
	assert.equal(writer.append({ type: "subagent.child-status" }), true);
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]!).runId, "run-1");
	assert.equal(JSON.parse(lines[0]!).ts, 1_000);
	assert.equal(writer.bytesUsed, bytes());
	assert.equal(writer.capped, false);
	assert.equal(writer.warned, false);
});

it("writes one warn line past the warn threshold and keeps writing", () => {
	const { writer, lines, warnings, bytes } = harness({ warnBytes: 120, limitBytes: 10_000 });
	for (let index = 0; index < 8; index += 1) writer.append({ type: "subagent.workflow.trace", trace: [index] });
	const warnLines = lines.filter((line) => line.includes("subagent.workflow.event_log_warn"));
	assert.equal(warnLines.length, 1);
	assert.equal(warnings.length, 1);
	assert.equal(writer.warned, true);
	assert.equal(writer.capped, false);
	// Every real event still landed: the warn line is a signal, not a stop.
	assert.equal(lines.filter((line) => line.includes("subagent.workflow.trace")).length, 8);
	// The warn line is journal bytes like any other, so the count must include it.
	assert.equal(writer.bytesUsed, bytes());
});

it("counts the warn line so a threshold-crossing journal cannot overshoot the hard cap", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-writer-warn-"));
	try {
		const eventsPath = path.join(root, "events.jsonl");
		// Small thresholds so the crossing, the warn line and the cap all happen in one test.
		const writer = createEventLogWriter({ eventsPath, runId: "run-warn", warnBytes: 120, limitBytes: 600, onWarn: () => undefined });
		for (let index = 0; index < 40; index += 1) writer.append({ type: "subagent.workflow.trace", trace: [index] });
		assert.equal(writer.capped, true);
		const onDisk = fs.statSync(eventsPath).size;
		assert.equal(writer.bytesUsed, onDisk, "accounting must match the journal, warn and capped lines included");
		const written = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(written.filter((line) => line.type === "subagent.workflow.event_log_warn").length, 1);
		assert.equal(written.filter((line) => line.type === "subagent.workflow.event_log_capped").length, 1);
		// Only the capped marker may sit past the limit; a missing warn line used to buy one more event.
		const markerBytes = Buffer.byteLength(`${fs.readFileSync(eventsPath, "utf-8").trim().split("\n").at(-1)}\n`, "utf-8");
		assert.ok(onDisk - markerBytes <= 600, `the cap admits its own marker only: ${onDisk} - ${markerBytes} > 600`);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("stops at the hard cap and records a single capped marker", () => {
	const { writer, lines, warnings } = harness({ warnBytes: 1, limitBytes: 400 });
	let written = 0;
	for (let index = 0; index < 40; index += 1) if (writer.append({ type: "subagent.workflow.trace", trace: [index] })) written += 1;
	assert.equal(writer.capped, true);
	const cappedLines = lines.filter((line) => line.includes("subagent.workflow.event_log_capped"));
	assert.equal(cappedLines.length, 1);
	assert.ok(written < 40, "the cap must actually suppress events");
	assert.equal(writer.bytesUsed <= 400 + Buffer.byteLength(cappedLines[0]!), true);
	assert.ok(warnings.some((message) => message.includes("cap")));
	// Nothing is written once capped, including further marker attempts.
	const before = lines.length;
	writer.append({ type: "late" });
	assert.equal(lines.length, before);
});

it("reserves the warn line so an accepted event never lands past the hard cap", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-writer-reserve-"));
	try {
		const eventsPath = path.join(root, "events.jsonl");
		// 105 + 105 still fits 300, but not next to the 126-byte warn line the second event triggers.
		// Without the reservation the warn line and the event land together at 340 bytes while the
		// event is still reported as accepted.
		const writer = createEventLogWriter({ eventsPath, runId: "run-reserve", warnBytes: 120, limitBytes: 300, onWarn: () => undefined });
		const overshoots: number[] = [];
		for (let index = 0; index < 20; index += 1) {
			const accepted = writer.append({ type: "subagent.workflow.trace", pad: "x".repeat(10), index });
			const size = fs.statSync(eventsPath).size;
			if (accepted && size > 300) overshoots.push(size);
		}
		assert.deepEqual(overshoots, [], "the event that crosses the warn line must fit under the cap next to it");
		assert.equal(writer.capped, true);
		assert.equal(writer.warned, false, "the warn line could not fit, so the cap wins");
		assert.equal(writer.bytesUsed, fs.statSync(eventsPath).size);
		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines.map((line) => line.type), ["subagent.workflow.trace", "subagent.workflow.event_log_capped"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("writes the warn line when it fits with the event that crosses it, then caps", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-writer-fits-"));
	try {
		const eventsPath = path.join(root, "events.jsonl");
		const writer = createEventLogWriter({ eventsPath, runId: "run-fits", warnBytes: 120, limitBytes: 400, onWarn: () => undefined });
		const overshoots: number[] = [];
		for (let index = 0; index < 20; index += 1) {
			const accepted = writer.append({ type: "subagent.workflow.trace", pad: "x".repeat(10), index });
			const size = fs.statSync(eventsPath).size;
			if (accepted && size > 400) overshoots.push(size);
		}
		assert.deepEqual(overshoots, []);
		assert.equal(writer.warned, true);
		assert.equal(writer.capped, true);
		assert.equal(writer.bytesUsed, fs.statSync(eventsPath).size);
		const lines = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines.filter((line) => line.type === "subagent.workflow.event_log_warn").length, 1);
		assert.equal(lines.filter((line) => line.type === "subagent.workflow.event_log_capped").length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("starts at zero when the journal does not exist yet", () => {
	const { writer } = harness();
	assert.equal(writer.bytesUsed, 0);
	writer.append({ type: "first" });
	assert.ok(writer.bytesUsed > 0);
});

it("counts bytes already on disk so a pre-existing journal is bounded too", () => {
	const { writer, lines } = harness({ existingBytes: 390, limitBytes: 400 });
	assert.equal(writer.append({ type: "subagent.workflow.trace", trace: [1, 2, 3] }), false);
	assert.equal(writer.capped, true);
	assert.equal(lines.filter((line) => line.includes("event_log_capped")).length, 1);
});

it("honors PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES and never lets warn exceed the cap", () => {
	const previous = process.env.PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES;
	try {
		process.env.PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES = "5000";
		const writer = createEventLogWriter({
			eventsPath: path.join(os.tmpdir(), "unused.jsonl"),
			warnBytes: 9_000,
			sizeOf: () => 0,
			appendLine: () => undefined,
		});
		assert.equal(writer.limitBytes, 5_000);
		assert.equal(writer.warnBytes, 5_000);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES;
		else process.env.PI_SUBAGENTS_EVENT_LOG_LIMIT_BYTES = previous;
	}
});

it("appends to a real journal file with the default fs seam", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-log-writer-"));
	try {
		const eventsPath = path.join(root, "events.jsonl");
		const writer = createEventLogWriter({ eventsPath, runId: "run-real" });
		assert.equal(writer.append({ type: "subagent.child-status" }), true);
		const written = fs.readFileSync(eventsPath, "utf-8").trim().split("\n");
		assert.equal(written.length, 1);
		assert.equal(JSON.parse(written[0]!).runId, "run-real");
		assert.equal(writer.bytesUsed, fs.statSync(eventsPath).size);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
