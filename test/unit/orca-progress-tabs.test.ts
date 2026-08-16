import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOrcaProgressTab, resolveOrcaCommand, resolvePiSessionId } from "../../src/runs/shared/orca-progress-tabs.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { writeNodeCommand } from "../support/node-command.ts";

const tempDirs: string[] = [];

function removeProgressFiles(prefix: string): void {
	const root = path.join(TEMP_ROOT_DIR, "orca-progress");
	if (!fs.existsSync(root)) return;
	for (const name of fs.readdirSync(root)) {
		if (name.startsWith(prefix)) fs.rmSync(path.join(root, name), { force: true });
	}
}

afterEach(() => {
	const progressRoot = path.join(TEMP_ROOT_DIR, "orca-progress");
	for (const dir of tempDirs.splice(0)) {
		let scope = path.resolve(dir);
		try { scope = fs.realpathSync(dir); } catch { /* use the lexical path */ }
		const key = createHash("sha256").update(scope).digest("hex").slice(0, 20);
		fs.rmSync(path.join(progressRoot, `counter-${key}`), { force: true });
		fs.rmSync(path.join(progressRoot, `counter-${key}.lock`), { recursive: true, force: true });
		if (fs.existsSync(progressRoot)) {
			for (const name of fs.readdirSync(progressRoot)) {
				if (name.startsWith(`create-${key}-`) && (name.endsWith(".ready") || name.endsWith(".pending"))) fs.rmSync(path.join(progressRoot, name), { force: true });
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
	removeProgressFiles("progress-");
	removeProgressFiles("disabled-run-");
	removeProgressFiles("standalone-pi-");
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-tabs-test-"));
	tempDirs.push(dir);
	return dir;
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function progressFile(prefix: string, suffix: ".log" | ".done"): string {
	const root = path.join(TEMP_ROOT_DIR, "orca-progress");
	const name = fs.readdirSync(root).find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix));
	assert.ok(name, `Expected ${suffix} file for ${prefix}`);
	return path.join(root, name);
}

function captureCommand(command: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => { output += chunk; });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`Viewer exited ${code}: ${output}`)));
	});
}

function writeCaptureOrca(dir: string): string {
	return writeNodeCommand(dir, "orca", "require('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

test("Orca progress tabs are disabled on Windows", { skip: process.platform === "win32" ? undefined : "Windows-only platform boundary" }, () => {
	const dir = tempDir();
	assert.equal(createOrcaProgressTab({
		cwd: dir,
		runId: "windows-disabled",
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: process.execPath,
	}), undefined);
});

test("resolveOrcaCommand only returns executable commands", () => {
	const dir = tempDir();
	const executable = writeNodeCommand(dir, "orca", "process.exit(0)");
	assert.equal(resolveOrcaCommand({ PATH: dir, PATHEXT: ".CMD" }), executable);
	assert.equal(resolveOrcaCommand({ PATH: "", PI_SUBAGENT_ORCA_BINARY: path.join(dir, "missing") }), undefined);
});

test("an unavailable Orca command leaves native execution untouched", () => {
	const dir = tempDir();
	assert.equal(createOrcaProgressTab({
		cwd: dir,
		runId: "missing-orca",
		agent: "worker",
		index: 0,
		config: { enabled: true },
		env: { PATH: "", PI_SUBAGENT_ORCA_BINARY: path.join(dir, "missing") },
	}), undefined);
});

test("standalone Pi executables use PATH Node for the watchdog and viewer", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const fakePi = path.join(dir, "pi");
	const originalExecPath = process.execPath;
	try {
		process.execPath = fakePi;
		const tab = createOrcaProgressTab({
			cwd: dir,
			runId: "standalone-pi",
			agent: "worker",
			index: 0,
			config: { enabled: true },
			command: fakeOrca,
			env: { ...process.env, ORCA_TEST_CAPTURE: capture },
		});
		assert.ok(tab);
		tab.finish("failed");
		await waitForFile(capture);
		const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		const viewer = args[args.indexOf("--command") + 1]!;
		assert.match(viewer, /^'node' '-e' /);
		assert.equal(viewer.includes(fakePi), false);
		assert.match(await captureCommand(viewer, dir), /failed/);
	} finally {
		process.execPath = originalExecPath;
	}
});

test("hung Orca terminal creation does not delay the owning process", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const fakeOrca = writeNodeCommand(dir, "orca", "require('fs').writeFileSync(process.env.ORCA_TEST_PID, String(process.pid));setInterval(()=>{},1000)");
	const pidFile = path.join(dir, "orca.pid");
	const moduleUrl = new URL("../../src/runs/shared/orca-progress-tabs.ts", import.meta.url).href;
	const ownerScript = `import {createOrcaProgressTab} from ${JSON.stringify(moduleUrl)};const tab=createOrcaProgressTab({cwd:${JSON.stringify(dir)},runId:'progress-hung-owner',agent:'worker',index:0,config:{enabled:true},command:${JSON.stringify(fakeOrca)},env:{...process.env,ORCA_TEST_PID:${JSON.stringify(pidFile)}}});if(!tab)throw new Error('tab unavailable');`;
	const startedAt = Date.now();
	const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", ownerScript], { cwd: dir, stdio: "ignore" });
	const ownerClosed = new Promise<number | null>((resolve, reject) => {
		owner.once("error", reject);
		owner.once("close", resolve);
	});
	let fakePid: number | undefined;
	try {
		assert.equal(await ownerClosed, 0);
		assert.ok(Date.now() - startedAt < 2_000, "the Orca observer delayed runner completion");
		await waitForFile(pidFile);
		fakePid = Number.parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
		process.kill(fakePid, 0);
	} finally {
		if (fakePid !== undefined) {
			try { process.kill(fakePid, "SIGKILL"); } catch { /* already stopped */ }
		}
		if (owner.exitCode === null) owner.kill("SIGKILL");
	}
});

test("malformed optional observer metadata cannot break child execution", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId: undefined,
		agent: undefined,
		index: undefined,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	} as never);
	assert.ok(tab);
	tab.finish("completed");
	await waitForFile(capture);
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	assert.equal(args[args.indexOf("--title") + 1], "subagent · subagent · 1");
	removeProgressFiles("run-0-");
});

test("disabled Orca progress tabs do not invoke Orca", async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId: "disabled-run",
		agent: "worker",
		index: 0,
		config: { enabled: false },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.equal(tab, undefined);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(fs.existsSync(capture), false);
});

test("enabled tabs use a worktree sequence and successful Pi sessions get cleanup guidance", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const secondCapture = path.join(dir, "capture-2.json");
	const fakeOrca = writeCaptureOrca(dir);
	fs.mkdirSync(path.join(dir, ".git"));
	const runId = `progress-${Date.now()}`;
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId,
		agent: "worker",
		index: 2,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	tab.append("starting\n");
	tab.event({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
	tab.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done output" }] } as never });
	const sessionId = "019ffd40-4859-7015-94e4-7d15c31885ef";
	const sessionFile = path.join(dir, `session file's ${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
	assert.equal(resolvePiSessionId(sessionFile), sessionId);
	assert.equal(resolvePiSessionId(path.join(dir, `missing_${sessionId}.jsonl`)), undefined);
	tab.finish("completed", sessionFile);

	await waitForFile(capture);
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	assert.deepEqual(args.slice(0, 2), ["terminal", "create"]);
	assert.equal(args[args.indexOf("--worktree") + 1], `path:${path.resolve(dir)}`);
	assert.equal(args[args.indexOf("--title") + 1], "subagent · worker · 1");
	const viewer = args[args.indexOf("--command") + 1];
	assert.ok(viewer.includes(process.execPath));
	assert.doesNotMatch(viewer, /(?:^|;)\s*exec\s/);
	assert.doesNotMatch(viewer, /(?:&|;)\s*exit(?:\s|$)/);

	const progressDir = path.join(TEMP_ROOT_DIR, "orca-progress");
	const log = fs.readdirSync(progressDir).find((name) => name.startsWith(`${runId}-2-`) && name.endsWith(".log"));
	assert.ok(log);
	const text = fs.readFileSync(path.join(progressDir, log), "utf-8");
	assert.match(text, /starting/);
	assert.match(text, /› read: README\.md/);
	assert.match(text, /done output/);
	const quotedSessionFile = `'${fs.realpathSync(sessionFile).replace(/'/g, `'"'"'`)}'`;
	assert.ok(text.includes(`completed. To remove the Pi session of this subagent, run rm -- ${quotedSessionFile}`));
	assert.doesNotMatch(text, /find ~\/\.pi\/agent\/sessions/);

	const nestedCwd = path.join(dir, "packages", "app");
	fs.mkdirSync(nestedCwd, { recursive: true });
	const secondTab = createOrcaProgressTab({
		cwd: nestedCwd,
		runId: `${runId}-second`,
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: secondCapture },
	});
	assert.ok(secondTab);
	secondTab.finish("failed", sessionFile);
	await waitForFile(secondCapture);
	const secondArgs = JSON.parse(fs.readFileSync(secondCapture, "utf-8")) as string[];
	assert.equal(secondArgs[secondArgs.indexOf("--title") + 1], "subagent · worker · 2");
	const secondLog = fs.readdirSync(progressDir).find((name) => name.startsWith(`${runId}-second-0-`) && name.endsWith(".log"));
	assert.ok(secondLog);
	const secondText = fs.readFileSync(path.join(progressDir, secondLog), "utf-8");
	assert.match(secondText, /failed/);
	assert.doesNotMatch(secondText, /To remove the Pi session/);
});

test("viewer strips split terminal control sequences across poll ticks", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const runId = `progress-sanitize-${Date.now()}`;
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId,
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	await waitForFile(capture);
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	const viewer = args[args.indexOf("--command") + 1]!;
	const outputPromise = captureCommand(viewer, dir);
	await new Promise((resolve) => setTimeout(resolve, 200));
	tab.append("safe CSI \u001b[");
	await new Promise((resolve) => setTimeout(resolve, 200));
	tab.append("31mred OSC \u001b]0;secret");
	await new Promise((resolve) => setTimeout(resolve, 200));
	tab.append(" title\u0007visible\u0000\u0001\r\t\u007f\n");
	tab.finish("failed");
	const output = await outputPromise;
	assert.match(output, /safe CSI red OSC visible\n/);
	assert.doesNotMatch(output, /\u001b|31m|secret|title|\u0000|\u0001|\r|\t|\u007f/);
});

test("mirror output keeps small writes that hit stream backpressure before the byte limit", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const runId = `progress-backpressure-${Date.now()}`;
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId,
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	for (let index = 0; index < 2_000; index++) tab.append(`line-${index.toString().padStart(4, "0")} ${"x".repeat(80)}\n`);
	tab.finish("completed");
	const log = progressFile(`${runId}-0-`, ".log");
	await waitForFile(log.replace(/\.log$/, ".done"));
	const text = fs.readFileSync(log, "utf-8");
	assert.match(text, /line-1999/);
	assert.doesNotMatch(text, /progress mirror truncated/);
});

test("same-worktree Orca creates wait for the previous numbered tab", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const order = path.join(dir, "order.txt");
	const firstCapture = path.join(dir, "first.json");
	const secondCapture = path.join(dir, "second.json");
	const fakeOrca = writeNodeCommand(dir, "orca", [
		"const fs=require('fs');",
		"const args=process.argv.slice(2);",
		"const title=args[args.indexOf('--title')+1];",
		"if(title.endsWith(' · 1')){const until=Date.now()+400;while(Date.now()<until){};fs.writeFileSync(process.env.ORCA_TEST_FIRST,JSON.stringify(args));}",
		"else fs.writeFileSync(process.env.ORCA_TEST_SECOND,JSON.stringify(args));",
		"fs.appendFileSync(process.env.ORCA_TEST_ORDER,title+'\\n');",
	].join(""));
	const first = createOrcaProgressTab({
		cwd: dir,
		runId: "ordered-first",
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_FIRST: firstCapture, ORCA_TEST_SECOND: secondCapture, ORCA_TEST_ORDER: order },
	});
	const second = createOrcaProgressTab({
		cwd: dir,
		runId: "ordered-second",
		agent: "reviewer",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_FIRST: firstCapture, ORCA_TEST_SECOND: secondCapture, ORCA_TEST_ORDER: order },
	});
	assert.ok(first);
	assert.ok(second);
	await waitForFile(secondCapture);
	const titles = fs.readFileSync(order, "utf-8").trim().split("\n");
	assert.deepEqual(titles, ["subagent · worker · 1", "subagent · reviewer · 2"]);
	first.finish("failed");
	second.finish("failed");
});

test("a missing predecessor marker does not delay the next tab", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const key = createHash("sha256").update(fs.realpathSync(dir)).digest("hex").slice(0, 20);
	const progressRoot = path.join(TEMP_ROOT_DIR, "orca-progress");
	fs.mkdirSync(progressRoot, { recursive: true, mode: 0o700 });
	const stalePending = path.join(progressRoot, `create-${key}-stale.pending`);
	fs.writeFileSync(path.join(progressRoot, `counter-${key}`), `4\n${stalePending}\n`, { encoding: "utf-8", mode: 0o600 });
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const startedAt = Date.now();
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId: "stale-predecessor",
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	await waitForFile(capture);
	assert.ok(Date.now() - startedAt < 2_000, "a missing predecessor delayed tab creation");
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	assert.equal(args[args.indexOf("--title") + 1], "subagent · worker · 5");
	tab.finish("failed");
});

test("queued same-worktree creates start their timeout when the predecessor becomes active", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const order = path.join(dir, "order.txt");
	const active = path.join(dir, "active.lock");
	const overlap = path.join(dir, "overlap.txt");
	const firstCapture = path.join(dir, "first.json");
	const secondCapture = path.join(dir, "second.json");
	const thirdCapture = path.join(dir, "third.json");
	const fakeOrca = writeNodeCommand(dir, "orca", [
		"const fs=require('fs');",
		"const args=process.argv.slice(2);",
		"const title=args[args.indexOf('--title')+1];",
		"let ownsLock=false;try{fs.writeFileSync(process.env.ORCA_TEST_ACTIVE,title,{flag:'wx'});ownsLock=true}catch{fs.appendFileSync(process.env.ORCA_TEST_OVERLAP,title+'\\n')}",
		"fs.appendFileSync(process.env.ORCA_TEST_ORDER,'start '+title+'\\n');",
		"const delay=title.endsWith(' · 1')||title.endsWith(' · 2')?14000:0;",
		"setTimeout(()=>{",
		" const capture=title.endsWith(' · 1')?process.env.ORCA_TEST_FIRST:title.endsWith(' · 2')?process.env.ORCA_TEST_SECOND:process.env.ORCA_TEST_THIRD;",
		" fs.writeFileSync(capture,JSON.stringify(args));",
		" fs.appendFileSync(process.env.ORCA_TEST_ORDER,'end '+title+'\\n');",
		" if(ownsLock)fs.rmSync(process.env.ORCA_TEST_ACTIVE,{force:true});",
		"},delay);",
	].join(""));
	const env = { ...process.env, ORCA_TEST_FIRST: firstCapture, ORCA_TEST_SECOND: secondCapture, ORCA_TEST_THIRD: thirdCapture, ORCA_TEST_ORDER: order, ORCA_TEST_ACTIVE: active, ORCA_TEST_OVERLAP: overlap };
	const first = createOrcaProgressTab({ cwd: dir, runId: "queued-first", agent: "worker", index: 0, config: { enabled: true }, command: fakeOrca, env });
	const second = createOrcaProgressTab({ cwd: dir, runId: "queued-second", agent: "reviewer", index: 0, config: { enabled: true }, command: fakeOrca, env });
	const third = createOrcaProgressTab({ cwd: dir, runId: "queued-third", agent: "scout", index: 0, config: { enabled: true }, command: fakeOrca, env });
	assert.ok(first);
	assert.ok(second);
	assert.ok(third);
	await waitForFile(thirdCapture, 35_000);
	assert.equal(fs.existsSync(overlap), false, "same-worktree Orca create invocations overlapped");
	const events = fs.readFileSync(order, "utf-8").trim().split("\n");
	assert.deepEqual(events, [
		"start subagent · worker · 1",
		"end subagent · worker · 1",
		"start subagent · reviewer · 2",
		"end subagent · reviewer · 2",
		"start subagent · scout · 3",
		"end subagent · scout · 3",
	]);
	first.finish("failed");
	second.finish("failed");
	third.finish("failed");
});

test("queued tabs defer cleanup until their terminal create settles", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const firstCapture = path.join(dir, "first.json");
	const secondCapture = path.join(dir, "second.json");
	const cleanupLog = path.join(dir, "cleanup.log");
	const fakeOrca = writeNodeCommand(dir, "orca", [
		"const fs=require('fs');",
		"const args=process.argv.slice(2);",
		"const title=args[args.indexOf('--title')+1];",
		"const capture=title.endsWith(' · 1')?process.env.ORCA_TEST_FIRST:process.env.ORCA_TEST_SECOND;",
		"const delay=title.endsWith(' · 1')?800:0;",
		"setTimeout(()=>fs.writeFileSync(capture,JSON.stringify(args)),delay);",
	].join(""));
	const fakePi = path.join(dir, "pi");
	fs.writeFileSync(fakePi, "#!/bin/sh\nexit 0\n", { encoding: "utf-8", mode: 0o755 });
	const fakeNode = path.join(dir, "node");
	fs.writeFileSync(fakeNode, [
		"#!/bin/sh",
		"case \"$2\" in",
		`*"deadline=Date.now()+Number(process.argv[1])"*) printf 'cleanup\\n' >> "\${ORCA_TEST_CLEANUP_LOG}" ;;`,
		"esac",
		`exec ${shellQuote(process.execPath)} "$@"`,
		"",
	].join("\n"), { encoding: "utf-8", mode: 0o755 });
	const originalExecPath = process.execPath;
	const originalCleanupLog = process.env.ORCA_TEST_CLEANUP_LOG;
	const originalPath = process.env.PATH;
	try {
		process.execPath = fakePi;
		process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
		process.env.ORCA_TEST_CLEANUP_LOG = cleanupLog;
		const env = { ...process.env, ORCA_TEST_FIRST: firstCapture, ORCA_TEST_SECOND: secondCapture, ORCA_TEST_CLEANUP_LOG: cleanupLog };
		const first = createOrcaProgressTab({ cwd: dir, runId: "cleanup-first", agent: "worker", index: 0, config: { enabled: true }, command: fakeOrca, env });
		const second = createOrcaProgressTab({ cwd: dir, runId: "cleanup-second", agent: "reviewer", index: 0, config: { enabled: true }, command: fakeOrca, env });
		assert.ok(first);
		assert.ok(second);
		second.finish("completed");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(fs.existsSync(cleanupLog), false, "cleanup started before queued terminal creation settled");
		await waitForFile(secondCapture);
		await waitForFile(cleanupLog);
		first.finish("failed");
	} finally {
		process.execPath = originalExecPath;
		process.env.PATH = originalPath;
		if (originalCleanupLog === undefined) delete process.env.ORCA_TEST_CLEANUP_LOG;
		else process.env.ORCA_TEST_CLEANUP_LOG = originalCleanupLog;
	}
});

test("mirror output truncates at a finite byte bound", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const runId = `progress-bounded-${Date.now()}`;
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId,
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	tab.append("x".repeat(2 * 1024 * 1024));
	tab.append("must be dropped");
	tab.finish("completed");
	const log = progressFile(`${runId}-0-`, ".log");
	await waitForFile(log.replace(/\.log$/, ".done"));
	assert.ok(fs.statSync(log).size <= 1024 * 1024);
	const text = fs.readFileSync(log, "utf-8");
	assert.match(text, /progress mirror truncated at 1048576 bytes/);
	assert.doesNotMatch(text, /must be dropped/);
});
