import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
	createBoundedByteTail,
	createBoundedLineReader,
	formatProtocolOutputLimit,
	MAX_CHILD_PENDING_LINE_BYTES,
	PI_AGGREGATE_EVENT_PROJECTOR,
	projectChildLifecycle,
	type ProtocolOutputLimit,
} from "../../src/runs/shared/child-protocol.ts";

describe("bounded child protocol reader", () => {
	it("reassembles fragmented lines and flushes a final unterminated line", () => {
		const lines: string[] = [];
		const reader = createBoundedLineReader({ maxPendingLineBytes: 100, onLine: (line) => lines.push(line), onLimit: () => assert.fail("unexpected limit") });
		reader.push('{"type":"message');
		reader.push('_end"}\n{"type":"agent_settled"}');
		reader.end();
		assert.deepEqual(lines, ['{"type":"message_end"}', '{"type":"agent_settled"}']);
	});

	it("preserves UTF-8 characters split across byte chunks", () => {
		const lines: string[] = [];
		const bytes = Buffer.from('{"text":"你好"}\n');
		const split = bytes.indexOf(Buffer.from("你")) + 1;
		const reader = createBoundedLineReader({ maxPendingLineBytes: 100, onLine: (line) => lines.push(line), onLimit: () => assert.fail("unexpected limit") });
		reader.push(bytes.subarray(0, split));
		reader.push(bytes.subarray(split));
		reader.end();
		assert.deepEqual(lines, ['{"text":"你好"}']);
	});

	it("accepts Pi-sized image payload lines by default", () => {
		const lines: string[] = [];
		const reader = createBoundedLineReader({ onLine: (line) => lines.push(line), onLimit: () => assert.fail("unexpected limit") });
		const imageSizedLine = "x".repeat(5 * 1024 * 1024);
		reader.push(imageSizedLine);
		reader.push("\n");
		reader.end();
		assert.equal(MAX_CHILD_PENDING_LINE_BYTES, 16 * 1024 * 1024);
		assert.equal(lines.length, 1);
		assert.equal(lines[0]?.length, imageSizedLine.length);
	});

	it("projects an oversized turn_end aggregate and resumes at the next record", () => {
		const lines: string[] = [];
		const reader = createBoundedLineReader({
			maxPendingLineBytes: 64,
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: (line) => lines.push(line),
			onLimit: () => assert.fail("redundant aggregate must not fail"),
		});
		const aggregate = JSON.stringify({ type: "turn_end", toolResults: ["x".repeat(256)] });
		const settled = JSON.stringify({ type: "agent_settled" });
		const bytes = Buffer.from(`${aggregate}\n${settled}\n`);
		for (let offset = 0; offset < bytes.length; offset += 37) reader.push(bytes.subarray(offset, offset + 37));
		reader.end();
		assert.deepEqual(lines, ['{"type":"turn_end"}', settled]);
		assert.equal(reader.exceeded(), false);
	});

	it("projects oversized agent_end aggregates without losing retry lifecycle metadata", () => {
		for (const willRetry of [true, false]) {
			const lines: string[] = [];
			const reader = createBoundedLineReader({
				maxPendingLineBytes: 64,
				oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
				onLine: (line) => lines.push(line),
				onLimit: () => assert.fail("valid agent_end aggregate must not fail"),
			});
			reader.push(`${JSON.stringify({ type: "agent_end", messages: ["x".repeat(256)], willRetry })}\n`);
			reader.end();
			assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ type: "agent_end", willRetry }]);
		}
	});

	it("projects oversized compaction_end aggregates without losing retry lifecycle metadata", () => {
		const lines: string[] = [];
		const reader = createBoundedLineReader({
			maxPendingLineBytes: 64,
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: (line) => lines.push(line),
			onLimit: () => assert.fail("valid compaction_end aggregate must not fail"),
		});
		reader.push(`${JSON.stringify({ type: "compaction_end", result: { summary: "x".repeat(256) }, willRetry: true })}\n`);
		reader.end();
		assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ type: "compaction_end", willRetry: true }]);
	});

	it("fails closed when an oversized agent_end aggregate lacks lifecycle metadata", () => {
		let failure: ProtocolOutputLimit | undefined;
		const reader = createBoundedLineReader({
			maxPendingLineBytes: 64,
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: () => assert.fail("malformed aggregate must not emit"),
			onLimit: (limit) => { failure = limit; },
		});
		reader.push(`${JSON.stringify({ type: "agent_end", messages: ["x".repeat(256)] })}\n`);
		reader.end();
		assert.equal(reader.exceeded(), true);
		assert.equal(failure?.code, "protocol_output_limit");
	});

	it("fails closed for malformed or truncated oversized turn_end aggregates", () => {
		for (const aggregate of [
			`{"type":"turn_end","toolResults":["${"x".repeat(256)}"`,
			`{"type":"turn_end","toolResults":[${"x".repeat(256)}]}`,
		]) {
			let failure: ProtocolOutputLimit | undefined;
			const reader = createBoundedLineReader({
				maxPendingLineBytes: 64,
				oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
				onLine: () => assert.fail("invalid turn_end must not emit"),
				onLimit: (limit) => { failure = limit; },
			});
			reader.push(aggregate);
			reader.end();
			assert.equal(reader.exceeded(), true);
			assert.equal(failure?.code, "protocol_output_limit");
		}
	});

	it("fails closed when malformed agent_end content carries an apparent willRetry tail", () => {
		let failure: ProtocolOutputLimit | undefined;
		const reader = createBoundedLineReader({
			maxPendingLineBytes: 64,
			oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
			onLine: () => assert.fail("invalid agent_end must not emit"),
			onLimit: (limit) => { failure = limit; },
		});
		reader.push(`{"type":"agent_end","messages":[${"x".repeat(256)}],"willRetry":true}\n`);
		reader.end();
		assert.equal(reader.exceeded(), true);
		assert.equal(failure?.code, "protocol_output_limit");
	});

	it("uses only trustworthy top-level lifecycle fields in syntactically valid JSON", () => {
		for (const aggregate of [
			JSON.stringify({ type: "agent_end", messages: [{ willRetry: true, data: "x".repeat(256) }] }),
			`{"type":"agent_end","messages":["${"x".repeat(256)}"],"willRetry":"false"}`,
			`{"type":"turn_end","toolResults":["${"x".repeat(256)}"],"t\\u0079pe":"other"}`,
			`{"type":"turn_end","toolResults":["${"x".repeat(256)}",]}`,
		]) {
			const reader = createBoundedLineReader({
				maxPendingLineBytes: 64,
				oversizedLineProjector: PI_AGGREGATE_EVENT_PROJECTOR,
				onLine: () => assert.fail("untrustworthy lifecycle metadata must not emit"),
				onLimit: () => {},
			});
			reader.push(`${aggregate}\n`);
			reader.end();
			assert.equal(reader.exceeded(), true);
		}
	});

	it("stops buffering an oversized line and returns bounded diagnostics", () => {
		let failure: ProtocolOutputLimit | undefined;
		const reader = createBoundedLineReader({ maxPendingLineBytes: 8, onLine: () => assert.fail("oversized line must not emit"), onLimit: (limit) => { failure = limit; } });
		reader.push("prefix-");
		reader.push("oversized-tail");
		reader.push("ignored");
		reader.end();
		assert.equal(reader.exceeded(), true);
		assert.equal(failure?.code, "protocol_output_limit");
		assert.equal(failure?.limitBytes, 8);
		assert.equal(failure?.observedBytes, 21);
		assert.match(failure?.diagnosticPrefix ?? "", /^prefix-/);
		assert.match(failure?.diagnosticTail ?? "", /tail$/);
		assert.match(formatProtocolOutputLimit(failure!), /protocol_output_limit.*exceeded 8 bytes/);
	});
});

describe("bounded child stderr tail", () => {
	it("keeps only the configured UTF-8-safe byte tail", () => {
		const tail = createBoundedByteTail(8);
		const bytes = Buffer.from("old-你好-tail");
		tail.push(bytes.subarray(0, 7));
		tail.push(bytes.subarray(7));
		assert.ok(tail.byteLength() <= 8);
		assert.equal(tail.text(), "好-tail");
	});
});

describe("child lifecycle projection", () => {
	it("cancels legacy drain for retries and starts it when settled", () => {
		assert.equal(projectChildLifecycle({ type: "message_end" }, true), "start-drain");
		assert.equal(projectChildLifecycle({ type: "agent_end", willRetry: true }), "cancel-drain");
		assert.equal(projectChildLifecycle({ type: "agent_end", willRetry: false }), "none");
		assert.equal(projectChildLifecycle({ type: "agent_settled" }), "start-drain");
		assert.equal(projectChildLifecycle({ type: "tool_execution_start" }), "none");
	});

	it("ignores settlement from a compaction attempt that will retry", () => {
		const state = { compactionRetryActive: false };
		assert.equal(projectChildLifecycle({ type: "compaction_end", willRetry: true }, false, state), "cancel-drain");
		assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, state), "none");
		assert.equal(projectChildLifecycle({ type: "agent_start" }, false, state), "none");
		assert.equal(projectChildLifecycle({ type: "agent_settled" }, false, state), "start-drain");
	});
});
