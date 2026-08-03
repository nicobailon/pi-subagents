import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildExternalCliPrompt, runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-cli-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("external CLI runner", () => {
	it("delivers the combined prompt only through stdin and preserves argv", async () => {
		const dir = tempDir();
		const prompt = buildExternalCliPrompt("Follow exactly.", "Review $HOME; echo nope");
		const result = await runExternalCli({
			command: process.execPath,
			args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:s})))", "argument with spaces", "$NOT_EXPANDED"],
			cwd: dir,
			prompt,
			asyncDir: dir,
			stepIndex: 0,
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.output), { argv: ["argument with spaces", "$NOT_EXPANDED"], stdin: prompt });
		assert.equal(fs.readFileSync(result.externalProcess.stdoutPath, "utf-8"), result.output);
	});

	it("flushes both full logs before returning while retaining a bounded stdout tail", async () => {
		const dir = tempDir();
		const stdout = "x".repeat(2 * 1024 * 1024) + "STDOUT_TAIL";
		const stderr = "y".repeat(2 * 1024 * 1024) + "STDERR_TAIL";
		const scriptPath = path.join(dir, "large-output.mjs");
		fs.writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)})`);
		const result = await runExternalCli({ command: process.execPath, args: [scriptPath], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 1 });
		assert.equal(result.exitCode, 0);
		assert.equal(result.output.length, 64 * 1024);
		assert.match(result.output, /STDOUT_TAIL$/);
		assert.equal(fs.readFileSync(result.externalProcess.stdoutPath, "utf-8"), stdout);
		assert.equal(fs.readFileSync(result.externalProcess.stderrPath, "utf-8"), stderr);
	});

	it("rejects when a log stream cannot be written", async () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, "external-2.stdout.log"));
		await assert.rejects(
			runExternalCli({ command: process.execPath, args: ["-e", "process.stdout.write('output')"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 2 }),
			/EISDIR|illegal operation on a directory/i,
		);
	});

	it("returns stderr for a nonzero exit", async () => {
		const dir = tempDir();
		const result = await runExternalCli({ command: process.execPath, args: ["-e", "console.error('specific failure');process.exit(7)"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 1 });
		assert.equal(result.exitCode, 7);
		assert.equal(result.error, "specific failure");
		assert.match(fs.readFileSync(result.externalProcess.stderrPath, "utf-8"), /specific failure/);
	});

	it("reports a missing executable without retrying", async () => {
		const dir = tempDir();
		const result = await runExternalCli({ command: path.join(dir, "does-not-exist"), cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 2 });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /ENOENT|not found/i);
	});

	it("terminates on timeout", async () => {
		const dir = tempDir();
		let timeout: (() => void) | undefined;
		const pending = runExternalCli({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 3, registerTimeout: (handler) => { timeout = handler; }, timeoutMessage: "timed out for test" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		timeout?.();
		const result = await pending;
		assert.equal(result.timedOut, true);
		assert.equal(result.error, "timed out for test");
	});

	it("terminates on stop", async () => {
		const dir = tempDir();
		let stop: (() => void) | undefined;
		const pending = runExternalCli({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 4, registerStop: (handler) => { stop = handler; }, stopMessage: "stopped for test" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		stop?.();
		const result = await pending;
		assert.equal(result.stopped, true);
		assert.equal(result.error, "stopped for test");
	});
});
