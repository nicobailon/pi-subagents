import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
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
});
