import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildExternalCliPrompt, runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { clearExternalCliPreflightCacheForTests, resolveExternalCliSpawn } from "../../src/runs/shared/external-cli-preflight.ts";
import { resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { PI_SUBAGENT_EXTENSION_BINDINGS_ENV } from "../../src/runs/shared/extension-bindings.ts";
import { writeNodeCommand, writeNpmNodeShim } from "../support/node-command.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-cli-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("external CLI runner", () => {
	it("clears ambient extension bindings from the external process", async () => {
		const dir = tempDir();
		const previous = process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV];
		process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = '{"shepherd.dispatch/1":{"role":"coder"}}';
		try {
			const result = await runExternalCli({
				command: process.execPath,
				args: ["-e", `process.stdout.write(process.env.${PI_SUBAGENT_EXTENSION_BINDINGS_ENV} ?? "unset")`],
				cwd: dir,
				prompt: "x",
				asyncDir: dir,
				stepIndex: 0,
			});
			assert.equal(result.exitCode, 0);
			assert.equal(result.output, "unset");
		} finally {
			if (previous === undefined) delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV];
			else process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = previous;
		}
	});

	it("does not pass inherited Git repository routing variables to the external process", async () => {
		const dir = tempDir();
		const previous = { GIT_DIR: process.env.GIT_DIR, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME };
		process.env.GIT_DIR = "/outer/repo/.git";
		process.env.GIT_AUTHOR_NAME = "Kept Author";
		try {
			const result = await runExternalCli({
				command: process.execPath,
				args: ["-e", "process.stdout.write(JSON.stringify({ dir: process.env.GIT_DIR ?? null, author: process.env.GIT_AUTHOR_NAME ?? null }))"],
				cwd: dir,
				prompt: "x",
				asyncDir: dir,
				stepIndex: 0,
			});
			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.output), { dir: null, author: "Kept Author" });
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

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

	it("keeps supervisor-shaped stdout inert when supervisor support is unsupported", async () => {
		const dir = tempDir();
		const spoofed = JSON.stringify({ type: "contact_supervisor", reason: "need_decision", message: "Approve this" });
		const result = await runExternalCli({ command: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(spoofed)})`], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 0 });
		const runner = resolveExternalCliRunnerStatus({ command: process.execPath });

		assert.equal(result.exitCode, 0);
		assert.equal(result.output, spoofed);
		assert.equal(runner.capabilities.supervisor, "unsupported");
		assert.match(runner.unsupportedReasons.supervisor, /no trusted supervisor event transport/);
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

	it("parses the complete bounded stream separately from bounded raw logs and display tails", async () => {
		const dir = tempDir();
		let terminal = "";
		const result = await runExternalCli({
			command: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(100000)+'\\nFINAL:trusted result\\n')"],
			cwd: dir,
			prompt: "x",
			asyncDir: dir,
			stepIndex: 8,
			limits: { stdoutLogBytes: 32 },
			parser: {
				parseLine(line) { if (line.startsWith("FINAL:")) terminal = line.slice(6); return undefined; },
				finish() { return terminal ? { state: "completed", output: terminal } : undefined; },
			},
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted result");
		assert.equal(fs.statSync(result.externalProcess.stdoutPath).size, 32);
		assert.equal(result.externalProcess.stdoutTruncated, true);
		assert.equal(result.externalProcess.stdoutBytes, 100022);
	});

	it("allows parser and log limits to narrow but not widen code-owned bounds", () => {
		const dir = tempDir();
		assert.throws(() => runExternalCli({
			command: process.execPath,
			cwd: dir,
			prompt: "x",
			asyncDir: dir,
			stepIndex: 20,
			limits: { stdoutLogBytes: 9 * 1024 * 1024 },
		}), /stdoutLogBytes may only narrow/);
	});

	it("fails closed on malformed, oversized, or missing parser terminal state", async () => {
		const dir = tempDir();
		const malformed = await runExternalCli({
			command: process.execPath, args: ["-e", "process.stdout.write('bad\\n')"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 9,
			parser: { parseLine() { throw new Error("malformed event"); }, finish() { return undefined; } },
		});
		assert.equal(malformed.exitCode, 1);
		assert.match(malformed.error ?? "", /malformed event/);

		const oversized = await runExternalCli({
			command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(128))"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 10,
			limits: { parserLineBytes: 64 },
			parser: { parseLine() { return undefined; }, finish() { return { state: "completed" }; } },
		});
		assert.equal(oversized.exitCode, 1);
		assert.match(oversized.error ?? "", /line exceeded/);

		let settleTimer: NodeJS.Timeout | undefined;
		try {
			const unterminated = await Promise.race([
				runExternalCli({
					command: process.execPath,
					args: ["-e", "process.stdout.write('x'.repeat(128));setInterval(()=>{},1000)"],
					cwd: dir,
					prompt: "x",
					asyncDir: dir,
					stepIndex: 16,
					limits: { parserLineBytes: 64 },
					parser: { parseLine() { return undefined; }, finish() { return { state: "completed" }; } },
				}),
				new Promise<never>((_, reject) => { settleTimer = setTimeout(() => reject(new Error("unterminated oversized line did not fail promptly")), 10_000); }),
			]);
			assert.equal(unterminated.exitCode, 1);
			assert.match(unterminated.error ?? "", /line exceeded/);
		} finally {
			if (settleTimer) clearTimeout(settleTimer);
		}

		const missing = await runExternalCli({
			command: process.execPath, args: ["-e", "process.stdout.write('event\\n')"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 11,
			parser: { parseLine() { return undefined; }, finish() { return undefined; } },
		});
		assert.equal(missing.exitCode, 1);
		assert.match(missing.error ?? "", /did not produce a terminal state/);
	});

	it("coalesces parser progress and flushes the terminal update", async () => {
		const dir = tempDir();
		const updates: number[] = [];
		let count = 0;
		const result = await runExternalCli({
			command: process.execPath, args: ["-e", "process.stdout.write(Array.from({length:20},(_,i)=>String(i)).join('\\n')+'\\n')"], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 12,
			parser: {
				parseLine() { count++; return { phase: "streaming", eventCount: count }; },
				finish() { return { state: "completed", output: "done" }; },
			},
			onParserProgress: (progress) => updates.push(progress.eventCount),
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(updates, [20]);
	});

	it("passes only adapter-allowed environment keys", async () => {
		const dir = tempDir();
		const previousSecret = process.env.UNRELATED_SECRET;
		const previousBinding = process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV];
		process.env.UNRELATED_SECRET = "hidden";
		process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = "hidden-binding";
		try {
			const result = await runExternalCli({
				command: process.execPath,
				args: ["-e", `process.stdout.write(JSON.stringify({allowed:process.env.ALLOWED_VALUE,secret:process.env.UNRELATED_SECRET,binding:process.env.${PI_SUBAGENT_EXTENSION_BINDINGS_ENV}}))`],
				cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 13,
				environment: { allowlist: ["ALLOWED_VALUE", PI_SUBAGENT_EXTENSION_BINDINGS_ENV], values: { ALLOWED_VALUE: "yes", [PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: "still-hidden" } },
			});
			assert.deepEqual(JSON.parse(result.output), { allowed: "yes" });
		} finally {
			if (previousSecret === undefined) delete process.env.UNRELATED_SECRET; else process.env.UNRELATED_SECRET = previousSecret;
			if (previousBinding === undefined) delete process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV]; else process.env[PI_SUBAGENT_EXTENSION_BINDINGS_ENV] = previousBinding;
		}
	});

	it("caches launch preflight and invalidates it after a launch failure", async () => {
		const dir = tempDir();
		const countPath = path.join(dir, "count.log");
		const failPath = path.join(dir, "fail-once");
		const scriptPath = path.join(dir, "preflight-cli.cjs");
		fs.writeFileSync(scriptPath, `
const fs=require('fs'); fs.appendFileSync(${JSON.stringify(countPath)}, 'x');
if(process.argv[2]==='--version'){console.log('v1');process.exit(0)}
if(process.argv[2]==='--help'){console.log('safe-help');process.exit(0)}
if(fs.existsSync(${JSON.stringify(failPath)})){fs.rmSync(${JSON.stringify(failPath)});console.error('launch failed');process.exit(2)}
process.stdout.write('ok');`);
		const preflight = { id: "test-one-shot", versionArgs: [scriptPath, "--version"], helpArgs: [scriptPath, "--help"], validate: (value: { version: string; help: string }) => { assert.equal(value.version, "v1"); assert.match(value.help, /safe-help/); } };
		const run = (stepIndex: number) => runExternalCli({ command: process.execPath, args: [scriptPath], cwd: dir, prompt: "x", asyncDir: dir, stepIndex, preflight });
		assert.equal((await run(14)).preflight?.cacheHit, false);
		assert.equal((await run(15)).preflight?.cacheHit, true);
		assert.equal(fs.readFileSync(countPath, "utf-8").length, 4);
		fs.writeFileSync(failPath, "1");
		assert.equal((await run(16)).exitCode, 2);
		assert.equal((await run(17)).preflight?.cacheHit, false);
		assert.equal(fs.readFileSync(countPath, "utf-8").length, 8);
	});

	it("bounds launch preflight probes", async () => {
		const dir = tempDir();
		const scriptPath = path.join(dir, "hanging-preflight-cli.cjs");
		fs.writeFileSync(scriptPath, `
if(process.argv[2]==='--version') setInterval(()=>{}, 1000);
if(process.argv[2]==='--help'){console.log('safe-help');process.exit(0)}
process.stdout.write('ok');`);

		const timedOut = await runExternalCli({
			command: process.execPath,
			args: [scriptPath],
			cwd: dir,
			prompt: "x",
			asyncDir: dir,
			stepIndex: 21,
			preflight: { id: "hanging", versionArgs: [scriptPath, "--version"], helpArgs: [scriptPath, "--help"], probeTimeoutMs: 25 },
		});
		assert.equal(timedOut.exitCode, 1);
		assert.match(timedOut.error ?? "", /version preflight failed|ETIMEDOUT|timed out/i);

		const widened = await runExternalCli({
			command: process.execPath,
			args: [scriptPath],
			cwd: dir,
			prompt: "x",
			asyncDir: dir,
			stepIndex: 22,
			preflight: { id: "wide-timeout", versionArgs: [scriptPath, "--version"], helpArgs: [scriptPath, "--help"], probeTimeoutMs: 6_000 },
		});
		assert.equal(widened.exitCode, 1);
		assert.match(widened.error ?? "", /probeTimeoutMs may only narrow/);
	});

	it("does not probe an external binary while resolving status metadata", () => {
		const dir = tempDir();
		const marker = path.join(dir, "probed");
		const command = writeNodeCommand(dir, "cold-cli", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`);
		resolveExternalCliRunnerStatus({ command });
		assert.equal(fs.existsSync(marker), false);
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
		const preflighted = await runExternalCli({
			command: "missing-preflight-cli", cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 19,
			preflight: { id: "missing", versionArgs: ["--version"], helpArgs: ["--help"] },
			environment: { allowlist: ["PATH"] },
		});
		assert.equal(preflighted.exitCode, 1);
		assert.match(preflighted.error ?? "", /binary 'missing-preflight-cli' was not found on PATH/);
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

	it("terminates descendants in the owned process group on stop", { skip: process.platform === "win32" ? "POSIX process-group assertion" : undefined }, async () => {
		const dir = tempDir();
		const descendantPath = path.join(dir, "descendant.pid");
		let stop: (() => void) | undefined;
		const script = `const {spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(descendantPath)},String(c.pid));setInterval(()=>{},1000)`;
		const pending = runExternalCli({ command: process.execPath, args: ["-e", script], cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 18, registerStop: (handler) => { stop = handler; } });
		const deadline = Date.now() + 2_000;
		while (!fs.existsSync(descendantPath)) {
			if (Date.now() > deadline) throw new Error("descendant did not start");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const descendantPid = Number(fs.readFileSync(descendantPath, "utf-8"));
		stop?.();
		const result = await pending;
		assert.equal(result.stopped, true);
		const status = spawnSync("ps", ["-p", String(descendantPid), "-o", "stat="], { encoding: "utf-8" }).stdout.trim();
		assert.ok(!status || status.startsWith("Z"), `descendant ${descendantPid} remained active (${status})`);
	});
});

describe("external CLI launch of Windows batch files", () => {
	const windowsOnly = { skip: process.platform === "win32" ? undefined : "spawns a real .cmd shim" };
	const hostileArgs = ['^ & | < > % ! "', "back\\slash\\", "line one\nline two", "%PATH% !PATH!"];

	function shimFixture(): { bin: string; shim: string; script: string } {
		const root = path.join(tempDir(), "my tools");
		const bin = path.join(root, "bin");
		const script = path.join(root, "lib", "cli.js");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.dirname(script));
		fs.writeFileSync(script, "");
		return { bin, shim: writeNpmNodeShim(bin, "tool", "..\\lib\\cli.js"), script };
	}

	it("runs an npm Node shim's script with Node and the original arguments", () => {
		const { bin, shim, script } = shimFixture();
		assert.deepEqual(resolveExternalCliSpawn(shim, hostileArgs, {}, "win32"), { command: process.execPath, args: [script, ...hostileArgs] });
		assert.deepEqual(resolveExternalCliSpawn("tool.cmd", hostileArgs, { PATH: bin }, "win32"), { command: process.execPath, args: [script, ...hostileArgs] });
		assert.deepEqual(resolveExternalCliSpawn("tool", [], { Path: bin, PATHEXT: ".cmd" }, "win32"), { command: process.execPath, args: [script] });
		fs.writeFileSync(path.join(bin, "node.exe"), "");
		assert.equal(resolveExternalCliSpawn(shim, [], {}, "win32").command, path.join(bin, "node.exe"));
		assert.deepEqual(resolveExternalCliSpawn(shim, ["x"], {}, "linux"), { command: shim, args: ["x"] });
	});

	it("rejects batch wrappers that are not npm Node shims", () => {
		const { bin, shim } = shimFixture();
		const shimText = fs.readFileSync(shim, "utf-8");
		const wrappers = {
			"handwritten.cmd": "@echo off\r\nnode \"%~dp0\\..\\lib\\cli.js\" %*\r\n",
			"shim.bat": shimText,
			"missing.cmd": shimText.replace("..\\lib\\cli.js", "..\\lib\\gone.js"),
			"chained.cmd": shimText.replace("..\\lib\\cli.js", "..\\lib\\cli.js\" & \"%dp0%\\..\\lib\\cli.js"),
			"slashed.cmd": shimText.replace("..\\lib\\cli.js", "../lib/cli.js"),
		};
		for (const [name, text] of Object.entries(wrappers)) {
			fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
			assert.throws(() => resolveExternalCliSpawn(name, [], { PATH: bin }, "win32"), (error: Error) => {
				assert.match(error.message, /batch wrapper that cannot run without a shell/);
				assert.doesNotMatch(error.message, /dp0|ECHO/);
				return true;
			}, name);
		}
		assert.throws(() => resolveExternalCliSpawn("absent.bat", [], { PATH: bin }, "win32"), /binary 'absent.bat' was not found on PATH/);
	});

	it("resolves a shim found through a PATH symlink from the symlink's directory", { skip: process.platform === "win32" ? "file symlinks need elevated rights on Windows" : undefined }, () => {
		const root = tempDir();
		const [real, links] = [path.join(root, "real"), path.join(root, "links")];
		for (const directory of [real, links]) {
			fs.mkdirSync(directory);
			fs.writeFileSync(path.join(directory, "cli.js"), "");
		}
		fs.symlinkSync(writeNpmNodeShim(real, "tool", "cli.js"), path.join(links, "tool.cmd"));
		fs.writeFileSync(path.join(links, "node.exe"), "");
		assert.deepEqual(resolveExternalCliSpawn("tool", [], { PATH: links, PATHEXT: ".cmd" }, "win32"), { command: path.join(links, "node.exe"), args: [path.join(links, "cli.js")] });
	});

	it("launches an npm shim from PATH and by absolute path with preflight, passing arguments literally", windowsOnly, async () => {
		const dir = path.join(tempDir(), "dir with spaces");
		fs.mkdirSync(dir);
		const argvPath = path.join(dir, "argv.json");
		const marker = path.join(dir, "injected");
		const command = writeNodeCommand(dir, "argv-cli", `
const args = process.argv.slice(2);
if (args[0] === "--version") { process.stdout.write("argv-cli 1.0"); process.exit(0); }
if (args[0] === "--help") { process.stdout.write("help"); process.exit(0); }
require("fs").writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));
`);
		const args = [...hostileArgs, `& type nul > "${marker}"`];
		const launches = [
			{ command: "argv-cli" },
			{ command, preflight: { id: "argv-cli", versionArgs: ["--version"], helpArgs: ["--help"] } },
		];
		// The child inherits the parent environment, whose Windows key is usually `Path`.
		const previousPath = process.env.PATH;
		process.env.PATH = `${dir}${path.delimiter}${previousPath}`;
		try {
			for (const [stepIndex, launch] of launches.entries()) {
				fs.rmSync(argvPath, { force: true });
				const result = await runExternalCli({ ...launch, args, cwd: dir, prompt: "x", asyncDir: dir, stepIndex });
				assert.equal(result.exitCode, 0, result.error);
				assert.deepEqual(JSON.parse(fs.readFileSync(argvPath, "utf-8")), args);
			}
		} finally {
			process.env.PATH = previousPath;
		}
		assert.equal(fs.existsSync(marker), false);
	});

	it("refuses to run an unsupported batch wrapper", windowsOnly, async () => {
		const dir = tempDir();
		const marker = path.join(dir, "ran");
		const command = path.join(dir, "wrapper.cmd");
		fs.writeFileSync(command, `@echo off\r\ntype nul > "${marker}"\r\n`);
		const result = await runExternalCli({ command, cwd: dir, prompt: "x", asyncDir: dir, stepIndex: 0 });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /batch wrapper that cannot run without a shell/);
		assert.equal(fs.existsSync(marker), false);
	});
});
