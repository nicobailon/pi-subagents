import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { decodeSessionRoots, encodeSessionRoots } from "../../src/inspectors/herdr/session-roots-codec.ts";
import { formatShellCommand } from "../../src/inspectors/herdr/shell-command.ts";

describe("session roots codec", () => {
	it("round-trips an empty array, plain paths, and paths with spaces/quotes", () => {
		for (const roots of [[], ["/tmp/a"], ["C:\\Users\\a b\\.pi", "D:\\work"], ['has "quotes"', "has\\backslashes\\"]]) {
			assert.deepEqual(decodeSessionRoots(encodeSessionRoots(roots)), roots);
		}
	});

	it("still accepts raw JSON for backward compatibility with unpatched callers", () => {
		assert.deepEqual(decodeSessionRoots(JSON.stringify(["/tmp/a", "/tmp/b"])), ["/tmp/a", "/tmp/b"]);
		assert.deepEqual(decodeSessionRoots(JSON.stringify([])), []);
	});

	it("rejects malformed input from either encoding", () => {
		assert.throws(() => decodeSessionRoots("not base64 and not json"), /base64-encoded or raw JSON array of strings/);
		assert.throws(() => decodeSessionRoots(Buffer.from(JSON.stringify({ not: "an array" })).toString("base64")), /base64-encoded or raw JSON array of strings/);
		assert.throws(() => decodeSessionRoots(Buffer.from(JSON.stringify([1, 2])).toString("base64")), /base64-encoded or raw JSON array of strings/);
	});

	it("produces plain-ASCII base64 output with no quote, backslash, or space characters for a shell to mangle", () => {
		const encoded = encodeSessionRoots(["C:\\Users\\a b\\.pi\\sessions", 'contains "quotes"', "D:\\work"]);
		assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	});

	// This is the actual regression: Windows PowerShell has no backslash-escape for
	// embedded double quotes (only `` `" `` or `""`), so shellQuote's win32 branch
	// (which escapes `"` as `\"`) corrupts any argument containing a literal `"` -
	// exactly what `JSON.stringify(sessionRoots)` produces. Spawn real powershell.exe
	// to prove the old approach breaks and the new approach survives.
	describe("end-to-end through real powershell.exe", { skip: process.platform !== "win32" }, () => {
		function echoArgvCommand(sessionRootsArg: string): string {
			const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)));";
			return formatShellCommand(process.execPath, ["-e", script, "--", "--session-roots", sessionRootsArg], "win32");
		}

		function runThroughPowerShell(command: string): string[] {
			return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf-8" }));
		}

		it("mangles a raw JSON.stringify payload (documents the bug this PR fixes)", () => {
			const sessionRoots = ["C:\\Users\\sgerashe\\.pi\\sessions", "D:\\work\\proj"];
			const rawJson = JSON.stringify(sessionRoots);
			const argv = runThroughPowerShell(echoArgvCommand(rawJson));
			const received = argv[argv.indexOf("--session-roots") + 1];
			assert.notEqual(received, rawJson, "expected PowerShell to corrupt the unescaped JSON payload");
			assert.throws(() => JSON.parse(received ?? ""), /Unexpected token/, "corrupted payload should no longer be valid JSON");
		});

		it("survives base64 encoding byte-for-byte", () => {
			const sessionRoots = ["C:\\Users\\sgerashe\\.pi\\sessions", "D:\\work\\proj", 'C:\\has "quotes"\\dir'];
			const encoded = encodeSessionRoots(sessionRoots);
			const argv = runThroughPowerShell(echoArgvCommand(encoded));
			const received = argv[argv.indexOf("--session-roots") + 1];
			assert.equal(received, encoded);
			assert.deepEqual(decodeSessionRoots(received ?? ""), sessionRoots);
		});
	});
});
