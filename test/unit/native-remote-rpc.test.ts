import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	NativeRemoteJsonlDecoder,
	encodeNativeRemoteRpcRecord,
	validateNativeRemoteHandshake,
	writeNativeRemoteRpcRecordSync,
} from "../../src/runs/shared/native-remote-rpc.ts";
import { collectRemoteGitEvidence } from "../../src/runs/shared/remote-native-host.ts";

describe("native remote Pi RPC framing", () => {
	it("decodes fragmented UTF-8 and preserves Unicode separators inside JSON strings", () => {
		const decoder = new NativeRemoteJsonlDecoder();
		const bytes = Buffer.from('{"type":"event","text":"a b c 😀"}\n', "utf8");
		const split = bytes.indexOf(Buffer.from("😀")) + 2;
		assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
		assert.deepEqual(decoder.push(bytes.subarray(split)), [{ type: "event", text: "a b c 😀" }]);
		decoder.end();
	});

	it("accepts CRLF but rejects malformed, empty, oversized, and truncated frames", () => {
		const crlf = new NativeRemoteJsonlDecoder();
		assert.deepEqual(crlf.push(Buffer.from('{"ok":true}\r\n')), [{ ok: true }]);
		crlf.end();
		assert.throws(() => new NativeRemoteJsonlDecoder().push(Buffer.from("\n")), /empty JSONL frame/u);
		assert.throws(() => new NativeRemoteJsonlDecoder().push(Buffer.from("nope\n")), /malformed JSON/u);
		assert.throws(() => new NativeRemoteJsonlDecoder(3).push(Buffer.from("1234")), /exceeded 3 bytes/u);
		const truncated = new NativeRemoteJsonlDecoder();
		truncated.push(Buffer.from('{"ok":'));
		assert.throws(() => truncated.end(), /truncated JSONL frame/u);
	});

	it("bounds outbound records and emits exactly one LF", () => {
		assert.equal(encodeNativeRemoteRpcRecord({ type: "abort", id: "1" }).toString(), '{"type":"abort","id":"1"}\n');
	});

	it("completes raw fd-1 records across EINTR and partial writes", () => {
		const chunks: Buffer[] = []; let calls = 0;
		writeNativeRemoteRpcRecordSync({ type: "response", id: "x" }, (fd, buffer, offset, length) => {
			assert.equal(fd, 1); calls++;
			if (calls === 1) throw Object.assign(new Error("interrupted"), { code: "EINTR" });
			const written = Math.min(3, length); chunks.push(Buffer.from(buffer.subarray(offset, offset + written))); return written;
		});
		assert.equal(Buffer.concat(chunks).toString(), '{"type":"response","id":"x"}\n'); assert.ok(calls > chunks.length);
	});

	it("rejects zero or invalid raw-writer progress instead of truncating a frame", () => {
		assert.throws(() => writeNativeRemoteRpcRecordSync({ ok: true }, () => 0), /invalid progress \(0 bytes\)/u);
		assert.throws(() => writeNativeRemoteRpcRecordSync({ ok: true }, (_fd, _buffer, _offset, length) => length + 1), /invalid progress/u);
	});
});

describe("native remote Pi handshake", () => {
	const ready = {
		type: "pi-subagents-ready" as const,
		protocol: 1,
		packageVersion: "0.67.0",
		piVersion: "0.85.0",
		capabilities: ["settlement", "steer", "follow-up", "abort", "supervision"],
		cwd: "/srv/project",
		model: "anthropic/claude",
		tools: ["read", "grep"],
	};

	it("requires exact package/protocol compatibility and requested capabilities", () => {
		assert.equal(validateNativeRemoteHandshake(ready, { packageVersion: "0.67.0", requiredCapabilities: ["supervision"] }).cwd, "/srv/project");
		assert.throws(() => validateNativeRemoteHandshake({ ...ready, protocol: 2 }, { packageVersion: "0.67.0", requiredCapabilities: [] }), /Incompatible remote native protocol/u);
		assert.throws(() => validateNativeRemoteHandshake({ ...ready, packageVersion: "0.66.0" }, { packageVersion: "0.67.0", requiredCapabilities: [] }), /Incompatible remote pi-subagents version/u);
		assert.throws(() => validateNativeRemoteHandshake({ ...ready, piVersion: "0.80.9" }, { packageVersion: "0.67.0", requiredCapabilities: [] }), /requires Pi >= 0.81.0/u);
		assert.throws(() => validateNativeRemoteHandshake(ready, { packageVersion: "0.67.0", requiredCapabilities: ["structured-output"] }), /lacks required capabilities: structured-output/u);
	});
});

describe("remote Git evidence", () => {
	it("retains full head and dirty state on a detached HEAD", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-git-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
			fs.writeFileSync(path.join(cwd, "file.txt"), "one"); execFileSync("git", ["add", "file.txt"], { cwd }); execFileSync("git", ["commit", "-qm", "one"], { cwd }); execFileSync("git", ["checkout", "--detach", "-q"], { cwd });
			fs.writeFileSync(path.join(cwd, "file.txt"), "two");
			const evidence = collectRemoteGitEvidence(cwd);
			assert.match(String(evidence.head), /^[0-9a-f]{40}$/u); assert.equal(evidence.branch, undefined); assert.equal(evidence.dirty, true);
		} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
	});
});
