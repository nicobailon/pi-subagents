import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

function writeScript(name: string, lines: string[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-close-grace-"));
	const script = path.join(dir, name);
	fs.writeFileSync(script, lines.join("\n"), { mode: 0o755 });
	return script;
}

function makeSilentLeakyScript(sleepSeconds: number): string {
	return writeScript("silent-leak.sh", [
		"#!/bin/bash",
		"set -eu",
		"echo done",
		`sleep ${sleepSeconds} &`,
		"disown || true",
		"exit 0",
	]);
}

function makeChattyLeakyScript(tickMs: number): string {
	return writeScript("chatty-leak.sh", [
		"#!/bin/bash",
		"set -eu",
		"echo start",
		`( while true; do echo tick; sleep ${(tickMs / 1000).toFixed(3)}; done ) &`,
		"disown || true",
		"exit 0",
	]);
}

interface RunResult {
	resolvedMs: number;
	exitCode: number | null;
	stdout: string;
}

function runWithGuard(script: string, idleMs: number, hardMs: number, maxWaitMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const child = spawn("bash", [script], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		const clearGuard = attachPostExitStdioGuard(child, { idleMs, hardMs });
		const hardStop = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch {}
			reject(new Error(`promise did not resolve within ${maxWaitMs}ms`));
		}, maxWaitMs);
		hardStop.unref?.();

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", () => {});
		child.on("close", (code) => {
			clearTimeout(hardStop);
			clearGuard();
			resolve({ resolvedMs: Date.now() - start, exitCode: code, stdout });
		});
		child.on("error", reject);
	});
}

describe("attachPostExitStdioGuard", () => {
	it("reports whether a termination signal was actually delivered", () => {
		assert.equal(trySignalChild({ kill: () => true }, "SIGTERM"), true);
		assert.equal(trySignalChild({ kill: () => false }, "SIGTERM"), false);
		assert.equal(trySignalChild({ kill: () => { throw new Error("gone"); } }, "SIGTERM"), false);
	});

	it("does not delay a clean exit", { skip: process.platform === "win32" ? "bash scripts unavailable on Windows" : undefined }, async () => {
		const script = writeScript("clean.sh", ["#!/bin/bash", "set -eu", "echo hello", "exit 0"]);
		const result = await runWithGuard(script, 2000, 8000, 5000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /hello/);
		assert.ok(result.resolvedMs < 500, `expected fast close, got ${result.resolvedMs}ms`);
	});

	it("cuts off a silent grandchild with the idle timer", { skip: process.platform === "win32" ? "bash scripts unavailable on Windows" : undefined }, async () => {
		const idleMs = 1500;
		const result = await runWithGuard(makeSilentLeakyScript(30), idleMs, 8000, 10000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /done/);
		assert.ok(result.resolvedMs >= idleMs, `resolved too early: ${result.resolvedMs}ms`);
		assert.ok(result.resolvedMs < idleMs + 2000, `expected idle cutoff, got ${result.resolvedMs}ms`);
	});

	it("cuts off a chatty grandchild with the hard timer", { skip: process.platform === "win32" ? "bash scripts unavailable on Windows" : undefined }, async () => {
		const hardMs = 2000;
		const result = await runWithGuard(makeChattyLeakyScript(200), 1000, hardMs, 10000);
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /start/);
		assert.ok(result.resolvedMs >= hardMs - 500, `resolved too early: ${result.resolvedMs}ms`);
		assert.ok(result.resolvedMs < hardMs + 2000, `expected hard cutoff, got ${result.resolvedMs}ms`);
	});
});
