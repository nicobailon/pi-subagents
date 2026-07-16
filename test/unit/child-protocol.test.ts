import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
	createBoundedByteCapture,
	createBoundedByteTail,
	createBoundedLineReader,
	formatProtocolOutputLimit,
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

describe("bounded child stderr capture", () => {
	it("retains both head and tail within the configured byte bound", () => {
		const capture = createBoundedByteCapture(64);
		capture.push(`HEAD:${"x".repeat(100)}`);
		capture.push(":TAIL");
		assert.equal(capture.truncated(), true);
		assert.ok(capture.byteLength() <= 64);
		assert.ok(Buffer.byteLength(capture.text()) <= 64);
		assert.match(capture.text(), /^HEAD:/);
		assert.match(capture.text(), /:TAIL$/);
		assert.match(capture.text(), /stderr truncated/);
	});

	it("keeps split UTF-8 head and tail evidence valid and bounded", () => {
		const capture = createBoundedByteCapture(48);
		const bytes = Buffer.from(`始${"界".repeat(40)}终`);
		for (let index = 0; index < bytes.length; index += 2) capture.push(bytes.subarray(index, index + 2));
		const text = capture.text();
		assert.ok(capture.byteLength() <= 48);
		assert.ok(Buffer.byteLength(text) <= 48);
		assert.equal(text.includes("�"), false);
		assert.match(text, /^始/);
		assert.match(text, /终$/);
	});
});

describe("bounded byte tail", () => {
	it("retains tail-only behavior for non-diagnostic stdout fallback", () => {
		const tail = createBoundedByteTail(8);
		tail.push("old-你好-tail");
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
});
