import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { executeWorkflowHostCommand, normalizeWorkflowHostCommandParams } from "../../src/workflows/host-command.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function commandFor(root: string, source: string): string {
	const script = path.join(root, `command-${Math.random().toString(16).slice(2)}.cjs`);
	fs.writeFileSync(script, source, "utf8");
	return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

describe("workflow host commands", () => {
	it("validates the narrow command shape", () => {
		assert.deepEqual(normalizeWorkflowHostCommandParams({ kind: "command", command: "npm test", timeoutMs: 1000, output: "reports/test.log", role: "ci", provider: "local" }), {
			kind: "command",
			command: "npm test",
			timeoutMs: 1000,
			output: "reports/test.log",
			role: "ci",
			provider: "local",
		});
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "http", command: "true", timeoutMs: 1000 }), /kind must be 'command'/);
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "command", command: "true" }), /timeoutMs/);
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "command", command: "true", timeoutMs: 1000, output: "../outside.log" }), /relative path/);
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "command", command: "true", timeoutMs: 86_400_001 }), /integer from 1/);
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "command", command: "true", timeoutMs: 1000, output: path.resolve("outside.log") }), /relative path/);
		assert.throws(() => normalizeWorkflowHostCommandParams({ kind: "command", command: "true", timeoutMs: 1000, provider: "bad\nprovider" }), /single-line/);
	});

	it("runs without stdin and saves bounded command evidence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-command-"));
		roots.push(root);
		const outputPath = path.join(root, "reports", "command.log");
		const result = await executeWorkflowHostCommand({
			key: "unit-tests",
			params: { kind: "command", command: commandFor(root, `process.stdout.write("passed\\n"); process.stderr.write("warning\\n");`), timeoutMs: 5000, output: "reports/command.log" },
			cwd: root,
			defaultOutputPath: path.join(root, "fallback.log"),
			signal: new AbortController().signal,
		});
		assert.equal(result.ok, true);
		assert.equal(result.state, "passed");
		assert.equal(result.exitCode, 0);
		assert.match(result.stdout, /passed/);
		assert.match(result.stderr, /warning/);
		assert.equal(result.outputPath, outputPath);
		assert.match(fs.readFileSync(outputPath, "utf8"), /passed/);
	});

	it("returns failed and timed-out command evidence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-command-failure-"));
		roots.push(root);
		const failed = await executeWorkflowHostCommand({
			key: "failed",
			params: { kind: "command", command: commandFor(root, `process.stderr.write("bad\\n"); process.exit(3);`), timeoutMs: 5000 },
			cwd: root,
			defaultOutputPath: path.join(root, "failed.log"),
			signal: new AbortController().signal,
		});
		assert.equal(failed.state, "failed");
		assert.equal(failed.exitCode, 3);
		assert.match(failed.error ?? "", /code 3/);

		const timedOut = await executeWorkflowHostCommand({
			key: "timeout",
			params: { kind: "command", command: commandFor(root, `setTimeout(() => {}, 10000);`), timeoutMs: 20 },
			cwd: root,
			defaultOutputPath: path.join(root, "timeout.log"),
			signal: new AbortController().signal,
		});
		assert.equal(timedOut.state, "timed-out");
		assert.match(timedOut.error ?? "", /timed out/);
	});

	it("rejects symlinked output parents before creating outside directories", { skip: process.platform === "win32" ? "symlink permissions vary on Windows" : undefined }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-command-symlink-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-command-outside-"));
		roots.push(root, outside);
		fs.symlinkSync(outside, path.join(root, "link-out"), "dir");

		await assert.rejects(
			executeWorkflowHostCommand({
				key: "symlink-output",
				params: { kind: "command", command: commandFor(root, `process.stdout.write("unused");`), timeoutMs: 5000, output: "link-out/sub/report.log" },
				cwd: root,
				defaultOutputPath: path.join(root, "fallback.log"),
				signal: new AbortController().signal,
			}),
			/resolves outside the workflow cwd/,
		);
		assert.equal(fs.existsSync(path.join(outside, "sub")), false);
	});

	it("stops the owned process tree when the workflow aborts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-command-abort-"));
		roots.push(root);
		const readyPath = path.join(root, "ready");
		const leakedPath = path.join(root, "leaked");
		const command = commandFor(root, `
			const { spawn } = require("node:child_process");
			const fs = require("node:fs");
			fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
			spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(leakedPath)}, "leaked"), 400)}`)}], { stdio: "ignore" });
			setTimeout(() => {}, 10000);
		`);
		const controller = new AbortController();
		const pending = executeWorkflowHostCommand({
			key: "abort",
			params: { kind: "command", command, timeoutMs: 5000 },
			cwd: root,
			defaultOutputPath: path.join(root, "abort.log"),
			signal: controller.signal,
		});
		for (let attempt = 0; attempt < 100 && !fs.existsSync(readyPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(readyPath), true);
		controller.abort();
		assert.equal((await pending).state, "stopped");
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(fs.existsSync(leakedPath), false);
	});
});
