import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resultFilesForSession } from "../../src/runs/background/result-files.ts";
import { enqueueChainAppendRequest } from "../../src/runs/background/chain-append.ts";
import { deliverStopRequest } from "../../src/runs/background/control-channel.ts";
import { type AsyncStatus, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { writeNodeCommand } from "../support/node-command.ts";

const tempDirs: string[] = [];
const activeProcesses = new Map<ChildProcess, Promise<unknown>>();
const processDrains: Array<() => Promise<void>> = [];

async function cleanupTestOwnership(primaryFailure?: unknown): Promise<void> {
	const drains = await Promise.allSettled(processDrains.splice(0).map((drain) => drain()));
	const failures = drains.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
	if (activeProcesses.size > 0) failures.push(new Error(`Test-owned processes did not close: ${[...activeProcesses.keys()].map((child) => child.pid ?? "unknown").join(", ")}`));
	if (failures.length > 0) throw new AggregateError(primaryFailure === undefined ? failures : [primaryFailure, ...failures], "Test-owned process cleanup did not drain");
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	const progressDir = path.join(TEMP_ROOT_DIR, "orca-progress");
	if (fs.existsSync(progressDir)) {
		for (const name of fs.readdirSync(progressDir)) {
			if (name.startsWith("orca-observer-external-")) fs.rmSync(path.join(progressDir, name), { force: true });
		}
	}
	if (primaryFailure !== undefined) throw primaryFailure;
}

afterEach(() => cleanupTestOwnership());

function trackProcess<T>(child: ChildProcess, closed: Promise<T>): Promise<T> {
	activeProcesses.set(child, closed);
	const remove = () => activeProcesses.delete(child);
	void closed.then(remove, remove);
	return closed;
}

function registerHelperDrain(release: () => void | Promise<void>, pidFile: string, exitedFile: string, closed: Promise<unknown>): void {
	processDrains.push(async () => {
		await release();
		let closeTimer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				closed,
				new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("Test-owned process did not close after release")), 5_000); }),
			]);
		} finally {
			if (closeTimer) clearTimeout(closeTimer);
		}
		if (fs.existsSync(pidFile)) {
			await waitForFile(exitedFile);
			assert.equal(fs.readFileSync(exitedFile, "utf-8"), "0");
			await waitForProcessExit(Number(fs.readFileSync(pidFile, "utf-8")));
		}
	});
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for helper process ${pid} to exit`);
}

function processIsActive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function waitForStatus(file: string, predicate: (status: AsyncStatus) => boolean, timeoutMs = 10_000): Promise<AsyncStatus> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(file)) {
			try {
				const status = JSON.parse(fs.readFileSync(file, "utf-8")) as AsyncStatus;
				if (predicate(status)) return status;
			} catch { /* Atomic status publication may be between renames. */ }
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for status predicate: ${file}`);
}

function startRunner(configPath: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
	const repo = path.resolve(import.meta.dirname, "../..");
	const child = spawn(process.execPath, [path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath], { cwd, env, stdio: "inherit", shell: false });
	return trackProcess(child, new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}));
}

function startRunnerWithStderr(configPath: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ exitCode: number | null; stderr: string }> {
	const repo = path.resolve(import.meta.dirname, "../..");
	const child = spawn(process.execPath, [path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
	return trackProcess(child, new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode) => resolve({ exitCode, stderr }));
	}));
}

function writeExternalConfig(dir: string, id: string, script: string, controlConfig: Record<string, unknown>, cwd = dir): { asyncDir: string; configPath: string } {
	const asyncDir = path.join(dir, "async");
	fs.mkdirSync(asyncDir);
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, JSON.stringify({
		id,
		sessionId: `session-${id}`,
		steps: [{ agent: "external", task: "Activity test", runner: { type: "external-cli", command: process.execPath, args: ["-e", script] }, inheritProjectContext: false, inheritSkills: false }],
		resultPath: path.join(dir, "result.json"), cwd, placeholder: "{previous}", artifactConfig: { enabled: false }, asyncDir, resultMode: "single", controlConfig,
	}));
	return { asyncDir, configPath };
}

const attentionControl = {
	enabled: true,
	needsAttentionAfterMs: 2_100,
	activeNoticeAfterMs: 999_999,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: ["needs_attention"],
	notifyChannels: ["event"],
};

async function createGitRepo(dir: string, dirty = false): Promise<string> {
	const gitDir = path.join(dir, "repo");
	fs.mkdirSync(gitDir);
	for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) {
		assert.equal(await runProcess("git", args, gitDir), 0);
	}
	fs.writeFileSync(path.join(gitDir, "tracked.txt"), "baseline\n");
	assert.equal(await runProcess("git", ["add", "tracked.txt"], gitDir), 0);
	assert.equal(await runProcess("git", ["commit", "-qm", "baseline"], gitDir), 0);
	if (dirty) fs.writeFileSync(path.join(gitDir, "tracked.txt"), "already dirty\n");
	return gitDir;
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
	const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, env });
	return trackProcess(child, new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	}));
}

describe("external CLI async lifecycle", () => {
	it("drains test-owned process ownership after an early failure", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-early-failure-"));
		tempDirs.push(dir);
		const helperPid = path.join(dir, "helper-pid");
		const helperExited = path.join(dir, "helper-exited");
		const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(helperPid)},String(process.pid));process.on('exit',code=>fs.writeFileSync(${JSON.stringify(helperExited)},String(code)));process.on('message',message=>{if(message==='release')process.exit(0)});setTimeout(()=>process.exit(2),5000);process.send('ready')`;
		const child = spawn(process.execPath, ["-e", script], { cwd: dir, stdio: ["ignore", "inherit", "inherit", "ipc"], shell: false });
		const closed = trackProcess(child, new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		}));
		const ready = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("message", (message) => message === "ready" ? resolve() : reject(new Error(`Unexpected helper message: ${String(message)}`)));
		});
		registerHelperDrain(() => new Promise<void>((resolve, reject) => {
			assert.equal(fs.existsSync(dir), true, "temp root must remain until its owner is released");
			child.send("release", (error) => error ? reject(error) : resolve());
		}), helperPid, helperExited, closed);
		await ready;

		const primaryFailure = new Error("injected failure after ownership registration");
		await assert.rejects(cleanupTestOwnership(primaryFailure), (error) => error === primaryFailure);
		assert.equal(activeProcesses.size, 0);
		assert.equal(fs.existsSync(dir), false);
	});

	it("aborts a blocked Git baseline before launching the external process", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-baseline-abort-"));
		tempDirs.push(dir);
		const gitDir = await createGitRepo(dir);
		const gitStarted = path.join(dir, "git-started");
		const releaseGit = path.join(dir, "release-git");
		const wrapperPid = path.join(dir, "wrapper-pid");
		const descendantPid = path.join(dir, "descendant-pid");
		const trace = path.join(dir, "git-trace.jsonl");
		const externalStarted = path.join(dir, "external-started");
		const hook = path.join(dir, "fsmonitor-hook.cjs");
		const descendant = path.join(dir, "fsmonitor-descendant.cjs");
		const descendantSource = `const fs=require('fs'),path=require('path'),release=${JSON.stringify(releaseGit)};fs.writeFileSync(${JSON.stringify(descendantPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(gitStarted)},'');let done=false,watcher,timer;const finish=()=>{if(done)return;done=true;watcher?.close();clearTimeout(timer);process.stdout.write('token\\0')};watcher=fs.watch(path.dirname(release),()=>{if(fs.existsSync(release))finish()});timer=setTimeout(finish,15000);if(fs.existsSync(release))finish()`;
		fs.writeFileSync(descendant, `${descendantSource}\n`, "utf-8");
		const hookSource = `const fs=require('fs'),{spawn}=require('child_process');fs.writeFileSync(${JSON.stringify(wrapperPid)},String(process.pid));const child=spawn(process.execPath,[${JSON.stringify(descendant)}],{cwd:process.cwd(),stdio:['ignore','pipe','inherit'],shell:false});child.stdout.pipe(process.stdout);child.once('error',error=>{throw error});child.once('close',code=>process.exit(code??1))`;
		fs.writeFileSync(hook, `${hookSource}\n`, "utf-8");
		const hookCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`;
		assert.equal(await runProcess("git", ["config", "core.fsmonitor", hookCommand], gitDir), 0);
		const configuredHook = spawnSync("git", ["config", "--get", "core.fsmonitor"], { cwd: gitDir, encoding: "utf-8" });
		assert.equal(configuredHook.status, 0);
		assert.equal(configuredHook.stdout.replace(/\r?\n$/, ""), hookCommand);
		const { asyncDir, configPath } = writeExternalConfig(dir, "external-baseline-abort", `require('fs').writeFileSync(${JSON.stringify(externalStarted)},'')`, attentionControl, gitDir);
		const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		config.deadlineAt = Date.now() + 60_000;
		fs.writeFileSync(configPath, JSON.stringify(config));
		const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."), { ...process.env, GIT_TRACE2_EVENT: trace });
		processDrains.push(async () => {
			const pids = [wrapperPid, descendantPid].filter(fs.existsSync).map((file) => Number(fs.readFileSync(file, "utf-8")));
			if (!pids.some(processIsActive)) return;
			fs.writeFileSync(releaseGit, "");
			await Promise.all(pids.map(waitForProcessExit));
		});
		await Promise.all([waitForFile(gitStarted, 30_000), waitForFile(wrapperPid, 30_000), waitForFile(descendantPid, 30_000)]);
		const stoppedAt = Date.now();
		deliverStopRequest({ asyncDir, source: "test" });
		let deadlineTimer: NodeJS.Timeout | undefined;
		const settlement = await Promise.race([runnerDone, new Promise<"deadline">((resolve) => { deadlineTimer = setTimeout(() => resolve("deadline"), 5_000); })]);
		if (deadlineTimer) clearTimeout(deadlineTimer);
		assert.notEqual(settlement, "deadline");
		assert.ok(Date.now() - stoppedAt < 5_000);
		assert.equal(fs.existsSync(externalStarted), false);
		await Promise.all([wrapperPid, descendantPid].map((file) => waitForProcessExit(Number(fs.readFileSync(file, "utf-8")))));
		assert.equal(fs.existsSync(releaseGit), false, "passing cleanup must come from production tree termination");
		const gitCommands = fs.readFileSync(trace, "utf-8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "start").map((event) => event.argv?.[1]);
		assert.ok(gitCommands.includes("rev-parse"));
		assert.ok(gitCommands.includes("status"));
	});

	it("fails closed when stopped Git baseline tree ownership cannot be verified", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-baseline-unknown-"));
		tempDirs.push(dir);
		const gitDir = await createGitRepo(dir);
		const gitStarted = path.join(dir, "git-started");
		const releaseGit = path.join(dir, "release-git");
		const helperPid = path.join(dir, "helper-pid");
		const externalStarted = path.join(dir, "external-started");
		const hook = path.join(dir, "fsmonitor-hook.cjs");
		const hookSource = `const fs=require('fs'),path=require('path'),release=${JSON.stringify(releaseGit)};fs.writeFileSync(${JSON.stringify(helperPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(gitStarted)},'');process.stdout.on('error',()=>{});let done=false,watcher;const finish=()=>{if(done)return;done=true;watcher?.close();process.stdout.write('token\\0')};watcher=fs.watch(path.dirname(release),()=>{if(fs.existsSync(release))finish()});if(fs.existsSync(release))finish()`;
		fs.writeFileSync(hook, `${hookSource}\n`, "utf-8");
		assert.equal(await runProcess("git", ["config", "core.fsmonitor", `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`], gitDir), 0);
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin);
		fs.writeFileSync(path.join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const { asyncDir, configPath } = writeExternalConfig(dir, "external-baseline-unknown", `require('fs').writeFileSync(${JSON.stringify(externalStarted)},'')`, attentionControl, gitDir);
		const runnerDone = startRunnerWithStderr(configPath, path.resolve(import.meta.dirname, "../.."), {
			...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
		});
		processDrains.push(async () => {
			if (!fs.existsSync(helperPid)) return;
			const pid = Number(fs.readFileSync(helperPid, "utf-8"));
			if (!processIsActive(pid)) return;
			fs.writeFileSync(releaseGit, "");
			await waitForProcessExit(pid);
		});
		await waitForFile(gitStarted, 30_000);
		deliverStopRequest({ asyncDir, source: "test" });
		const result = await runnerDone;
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /process tree settlement is unverified/i);
		assert.match(result.stderr, /ps exited with 1/i);
		assert.equal(fs.existsSync(externalStarted), false);
		assert.equal(fs.existsSync(releaseGit), false, "unknown-ownership failure must not need passing-path release");
	});

	it("settles a stopped periodic Git probe ownership failure without an unhandled rejection", { skip: process.platform === "win32" }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-periodic-unknown-"));
		tempDirs.push(dir);
		const gitDir = await createGitRepo(dir);
		const hookCalls = path.join(dir, "hook-calls");
		const periodicStarted = path.join(dir, "periodic-started");
		const releaseGit = path.join(dir, "release-git");
		const helperPid = path.join(dir, "helper-pid");
		const externalStarted = path.join(dir, "external-started");
		const hook = path.join(dir, "fsmonitor-hook.cjs");
		const hookSource = `const fs=require('fs'),path=require('path');const count=fs.existsSync(${JSON.stringify(hookCalls)})?Number(fs.readFileSync(${JSON.stringify(hookCalls)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(hookCalls)},String(count));if(count===1){process.stdout.write('token\\0')}else{const release=${JSON.stringify(releaseGit)};fs.writeFileSync(${JSON.stringify(helperPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(periodicStarted)},'');process.stdout.on('error',()=>{});let done=false,watcher;const finish=()=>{if(done)return;done=true;watcher?.close();process.stdout.write('token\\0')};watcher=fs.watch(path.dirname(release),()=>{if(fs.existsSync(release))finish()});if(fs.existsSync(release))finish()}`;
		fs.writeFileSync(hook, `${hookSource}\n`, "utf-8");
		assert.equal(await runProcess("git", ["config", "core.fsmonitor", `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}`], gitDir), 0);
		const fakeBin = path.join(dir, "bin");
		fs.mkdirSync(fakeBin);
		fs.writeFileSync(path.join(fakeBin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const externalScript = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(externalStarted)},'');setInterval(()=>{},1000)`;
		const { asyncDir, configPath } = writeExternalConfig(dir, "external-periodic-unknown", externalScript, attentionControl, gitDir);
		const runnerDone = startRunnerWithStderr(configPath, path.resolve(import.meta.dirname, "../.."), {
			...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
		});
		processDrains.push(async () => {
			if (!fs.existsSync(helperPid)) return;
			const pid = Number(fs.readFileSync(helperPid, "utf-8"));
			if (!processIsActive(pid)) return;
			fs.writeFileSync(releaseGit, "");
			await waitForProcessExit(pid);
		});
		await Promise.all([waitForFile(externalStarted, 30_000), waitForFile(periodicStarted, 30_000)]);
		deliverStopRequest({ asyncDir, source: "test" });
		const runner = await runnerDone;
		assert.equal(runner.exitCode, 0, runner.stderr);
		assert.doesNotMatch(runner.stderr, /triggerUncaughtException|UnhandledPromiseRejection/);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.equal(status.state, "failed");
		assert.match(status.error, /PROCESS_TREE_UNVERIFIED/);
		const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf-8"));
		assert.equal(result.state, "failed");
		assert.equal(result.success, false);
		assert.match(result.summary, /PROCESS_TREE_UNVERIFIED/);
		assert.equal(fs.existsSync(releaseGit), false, "unknown ownership must remain retained until test-owner cleanup");
	});

	it("reports unexpected Git fingerprint failures once", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-git-error-"));
		tempDirs.push(dir);
		const invalidCwd = path.join(dir, "missing");
		const { configPath } = writeExternalConfig(dir, "external-git-error", "process.stdout.write('unreachable')", attentionControl, invalidCwd);
		const result = await startRunnerWithStderr(configPath, path.resolve(import.meta.dirname, "../.."));
		assert.equal(result.exitCode, 0);
		assert.equal(result.stderr.match(/Git activity evidence unavailable/g)?.length, 1);
		assert.match(result.stderr, /check the cwd and Git installation/);
	});

	it("skips Git activity baselines when control is disabled", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-disabled-control-"));
		tempDirs.push(dir);
		const gitCalled = path.join(dir, "git-called");
		writeNodeCommand(dir, "git", `require('fs').writeFileSync(${JSON.stringify(gitCalled)},'')`);
		const { configPath } = writeExternalConfig(dir, "external-disabled-control", "process.stdout.write('done')", { enabled: false });
		const exitCode = await startRunner(configPath, path.resolve(import.meta.dirname, "../.."), { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
		assert.equal(exitCode, 0);
		assert.equal(fs.existsSync(gitCalled), false);
	});

	it("applies external idle attention to runtime-appended chain steps", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-appended-"));
		tempDirs.push(dir);
		const firstReady = path.join(dir, "first-ready");
		const releaseFirst = path.join(dir, "release-first");
		const appendedReady = path.join(dir, "appended-ready");
		const finish = path.join(dir, "finish");
		const firstScript = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(firstReady)},'');const hold=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFirst)})){clearInterval(hold);process.exit(0)}},10)`;
		const { asyncDir, configPath } = writeExternalConfig(dir, "external-appended", firstScript, attentionControl);
		const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		config.resultMode = "chain";
		fs.writeFileSync(configPath, JSON.stringify(config));
		const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."));
		await waitForFile(firstReady);
		const appendedScript = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(appendedReady)},'');const hold=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(hold);process.exit(0)}},10)`;
		enqueueChainAppendRequest({
			asyncDir,
			runId: "external-appended",
			steps: [{ agent: "appended", task: "Stay silent", runner: { type: "external-cli", command: process.execPath, args: ["-e", appendedScript] } }],
		});
		fs.writeFileSync(releaseFirst, "");
		await waitForFile(appendedReady);
		let attentionError: unknown;
		try {
			await waitForStatus(path.join(asyncDir, "status.json"), (status) => status.steps?.[1]?.activityState === "needs_attention", 7_000);
		} catch (error) {
			attentionError = error;
		}
		fs.writeFileSync(finish, "");
		assert.equal(await runnerDone, 0);
		if (attentionError) throw attentionError;
	});

	it("coalesces same-worktree cold Git probes across external fanout", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-probe-fanout-"));
		tempDirs.push(dir);
		const gitDir = await createGitRepo(dir);
		const calls = path.join(dir, "git-calls");
		const ready = [path.join(dir, "ready-0"), path.join(dir, "ready-1")];
		const finish = path.join(dir, "finish");
		const tasks = ready.map((marker, index) => ({
			agent: `external-${index}`,
			task: "Stay silent",
			runner: { type: "external-cli", command: process.execPath, args: ["-e", `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'');const hold=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(hold);process.exit(0)}},10)`] },
			inheritProjectContext: false,
			inheritSkills: false,
		}));
		const asyncDir = path.join(dir, "async");
		fs.mkdirSync(asyncDir);
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({ id: "external-probe-fanout", sessionId: "session-fanout", steps: [{ parallel: tasks }], resultPath: path.join(dir, "result.json"), cwd: gitDir, placeholder: "{previous}", artifactConfig: { enabled: false }, asyncDir, resultMode: "chain", controlConfig: attentionControl }));
		const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."), { ...process.env, GIT_TRACE2_EVENT: calls });
		await Promise.all(ready.map((file) => waitForFile(file)));
		fs.writeFileSync(path.join(gitDir, "tracked.txt"), "changed\n");
		await waitForStatus(path.join(asyncDir, "status.json"), (status) => status.steps?.length === 2 && status.steps.every((step) => Boolean(step.startedAt && step.lastActivityAt && step.lastActivityAt > step.startedAt)), 7_000);
		const gitCommands = fs.readFileSync(calls, "utf-8").trim().split("\n")
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "start" && (event.argv?.[1] === "rev-parse" || event.argv?.[1] === "status"));
		assert.deepEqual(gitCommands.map((event) => event.argv[1]).sort(), ["rev-parse", "rev-parse", "rev-parse", "status", "status", "status"]);
		fs.writeFileSync(finish, "");
		assert.equal(await runnerDone, 0);
	});

	for (const stream of ["stdout", "stderr"] as const) {
		it(`refreshes watchdog activity from external ${stream}`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-external-${stream}-activity-`));
			tempDirs.push(dir);
			const go = path.join(dir, "emit");
			const emitted = path.join(dir, "emitted");
			const finish = path.join(dir, "finish");
			const script = `const fs=require('fs');const go=${JSON.stringify(go)},emitted=${JSON.stringify(emitted)},finish=${JSON.stringify(finish)};const start=setInterval(()=>{if(!fs.existsSync(go))return;clearInterval(start);process.${stream}.write('activity');fs.writeFileSync(emitted,'');const hold=setInterval(()=>{if(fs.existsSync(finish)){clearInterval(hold);process.exit(0)}},10)},10)`;
			const { asyncDir, configPath } = writeExternalConfig(dir, `external-${stream}-activity`, script, { ...attentionControl, needsAttentionAfterMs: 999_999 });
			const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."));
			const statusPath = path.join(asyncDir, "status.json");
			const started = await waitForStatus(statusPath, (status) => status.steps?.[0]?.status === "running");
			fs.writeFileSync(go, "");
			await waitForFile(emitted);
			await waitForStatus(statusPath, (status) => status.steps?.[0]?.lastActivityAt > started.steps[0].startedAt);
			fs.writeFileSync(finish, "");
			assert.equal(await runnerDone, 0);
		});
	}

	for (const mutation of ["worktree", "commit"] as const) {
		it(`credits a newly observed external Git ${mutation} change once`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-subagents-external-git-${mutation}-`));
			tempDirs.push(dir);
			const gitDir = await createGitRepo(dir);
			const go = path.join(dir, "mutate");
			const mutated = path.join(dir, "mutated");
			const finish = path.join(dir, "finish");
			const mutationCode = mutation === "commit"
				? `fs.writeFileSync('tracked.txt','committed\\n');require('child_process').execFileSync('git',['add','tracked.txt']);require('child_process').execFileSync('git',['commit','-qm','child'])`
				: `fs.writeFileSync('tracked.txt','changed\\n')`;
			const script = `const fs=require('fs');const go=${JSON.stringify(go)},mutated=${JSON.stringify(mutated)},finish=${JSON.stringify(finish)};const start=setInterval(()=>{if(!fs.existsSync(go))return;clearInterval(start);${mutationCode};fs.writeFileSync(mutated,'');const hold=setInterval(()=>{if(fs.existsSync(finish)){clearInterval(hold);process.exit(0)}},10)},10)`;
			const { asyncDir, configPath } = writeExternalConfig(dir, `external-git-${mutation}`, script, attentionControl, gitDir);
			const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."));
			const statusPath = path.join(asyncDir, "status.json");
			const started = await waitForStatus(statusPath, (status) => status.steps?.[0]?.status === "running");
			fs.writeFileSync(go, "");
			await waitForFile(mutated);
			const credited = await waitForStatus(statusPath, (status) => status.steps?.[0]?.lastActivityAt > started.steps[0].startedAt, 7_000);
			assert.equal(credited.steps[0].activityState, undefined);
			if (mutation === "worktree") await waitForStatus(statusPath, (status) => status.steps?.[0]?.activityState === "needs_attention", 7_000);
			fs.writeFileSync(finish, "");
			assert.equal(await runnerDone, 0);
		});
	}

	it("does not credit process liveness or unchanged pre-existing Git dirtiness", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-git-unchanged-"));
		tempDirs.push(dir);
		const gitDir = await createGitRepo(dir, true);
		const startedMarker = path.join(dir, "started");
		const finish = path.join(dir, "finish");
		const script = `const fs=require('fs');const finish=${JSON.stringify(finish)};fs.writeFileSync(${JSON.stringify(startedMarker)},'');const hold=setInterval(()=>{if(fs.existsSync(finish)){clearInterval(hold);process.exit(0)}},10)`;
		const { asyncDir, configPath } = writeExternalConfig(dir, "external-git-unchanged", script, attentionControl, gitDir);
		const runnerDone = startRunner(configPath, path.resolve(import.meta.dirname, "../.."));
		await waitForFile(startedMarker);
		const attention = await waitForStatus(path.join(asyncDir, "status.json"), (status) => status.steps?.[0]?.activityState === "needs_attention", 7_000);
		assert.equal(attention.activityState, "needs_attention");
		fs.writeFileSync(finish, "");
		assert.equal(await runnerDone, 0);
	});

	it("writes status, events, result, output, and external process logs", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-lifecycle-"));
		tempDirs.push(dir);
		const asyncDir = path.join(dir, "async");
		fs.mkdirSync(asyncDir);
		const resultPath = path.join(dir, "result.json");
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({
			id: "external-lifecycle",
			sessionId: "session-external",
			steps: [{
				agent: "external",
				task: "Task text",
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('RESULT:'+s))"] },
				systemPrompt: "System text",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			}],
			resultPath,
			cwd: dir,
			placeholder: "{previous}",
			artifactConfig: { enabled: false },
			asyncDir,
			resultMode: "single",
		}));
		const repo = path.resolve(import.meta.dirname, "../..");
		const exitCode = await runProcess(process.execPath, [path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath], repo);
		assert.equal(exitCode, 0);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.equal(status.state, "complete");
		assert.equal(status.steps[0].runner.type, "external-cli");
		assert.equal(status.steps[0].externalProcess.exitCode, 0);
		assert.ok(fs.existsSync(status.steps[0].externalProcess.stdoutPath));
		assert.ok(fs.existsSync(status.steps[0].externalProcess.stderrPath));
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /<System instructions>[\s\S]*System text[\s\S]*<Task>[\s\S]*Task text/);
		assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.step\.completed/);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(result.success, true);
		assert.equal(result.results[0].runner.type, "external-cli");
	});

	it("keeps terminal status recoverable when public result publish fails", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-external-pending-result-"));
		tempDirs.push(dir);
		const asyncDir = path.join(dir, "async");
		fs.mkdirSync(asyncDir);
		const resultPath = path.join(dir, "result.json");
		fs.mkdirSync(resultPath);
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({
			id: "external-pending-result",
			sessionId: "session-external",
			steps: [{
				agent: "external",
				task: "Task text",
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
				inheritProjectContext: false,
				inheritSkills: false,
			}],
			resultPath,
			cwd: dir,
			placeholder: "{previous}",
			artifactConfig: { enabled: false },
			asyncDir,
			resultMode: "single",
		}));
		const repo = path.resolve(import.meta.dirname, "../..");
		const exitCode = await runProcess(process.execPath, [path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath], repo);
		assert.equal(exitCode, 0);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.equal(status.state, "complete");

		fs.rmSync(resultPath, { recursive: true, force: true });
		assert.deepEqual(resultFilesForSession(dir, "session-external"), ["result.json"]);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(result.success, true);
		assert.equal(result.results[0].output, "ok");
	});

	it("mirrors a child into Orca without replacing its configured runner", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-observer-"));
		tempDirs.push(dir);
		const asyncDir = path.join(dir, "async");
		const agentDir = path.join(dir, "agent-dir");
		const capture = path.join(dir, "orca-args.json");
		const fakeOrca = writeNodeCommand(dir, "orca", "require('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))");
		fs.mkdirSync(asyncDir);
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ orcaProgressTabs: { enabled: true } }));
		const resultPath = path.join(dir, "result.json");
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({
			id: "orca-observer-external",
			sessionId: "session-orca-external",
			steps: [{
				agent: "external",
				task: "Task text",
				runner: { type: "external-cli", command: process.execPath, args: ["-e", "process.stdout.write('native runner output')"] },
				systemPrompt: "System text",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			}],
			resultPath,
			cwd: dir,
			placeholder: "{previous}",
			artifactConfig: { enabled: false },
			asyncDir,
			resultMode: "single",
		}));
		const repo = path.resolve(import.meta.dirname, "../..");
		const exitCode = await runProcess(
			process.execPath,
			[path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath],
			repo,
			{ ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_ORCA_BINARY: fakeOrca, ORCA_TEST_CAPTURE: capture },
		);
		assert.equal(exitCode, 0);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(result.results[0].runner.type, "external-cli");
		assert.match(result.results[0].output, /native runner output/);
		await waitForFile(capture);
		const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		assert.deepEqual(args.slice(0, 2), ["terminal", "create"]);
		assert.equal(args[args.indexOf("--worktree") + 1], `path:${path.resolve(dir)}`);
		assert.match(args[args.indexOf("--title") + 1], /subagents · external/);
	});
});
