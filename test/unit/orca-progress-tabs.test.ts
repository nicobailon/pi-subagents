import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOrcaProgressTab, ensureOrcaParentProgressTab, finishOrcaParentProgressTabs, recordOrcaParentResult, resolveOrcaCommand, resolvePiSessionId } from "../../src/runs/shared/orca-progress-tabs.ts";
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

afterEach(async () => {
	await finishOrcaParentProgressTabs();
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

async function waitForLineCount(file: string, count: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean) : [];
		if (lines.length >= count) return;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} lines in ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForFileCount(dir: string, count: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
		if (files.length >= count) return;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} files in ${dir}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForCreateReady(cwd: string, timeoutMs = 5_000): Promise<void> {
	const key = createHash("sha256").update(fs.realpathSync(cwd)).digest("hex").slice(0, 20);
	const root = path.join(TEMP_ROOT_DIR, "orca-progress");
	const deadline = Date.now() + timeoutMs;
	while (true) {
		if (fs.existsSync(root) && fs.readdirSync(root).some((name) => name.startsWith(`create-${key}-`) && name.endsWith(".ready"))) return;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for Orca create readiness in ${cwd}`);
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

test("one child opens one sanitized summary tab using its readable transcript", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	fs.mkdirSync(path.join(dir, ".git"));
	const runId = `progress-${Date.now()}`;
	const sessionId = "019ffd40-4859-7015-94e4-7d15c31885ef";
	const sessionFile = path.join(dir, `session file's ${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "TOP_SECRET_REASONING" }, { type: "toolCall", name: "find", arguments: { token: "TOP_SECRET_ARGUMENT" } }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "session output" }] } }),
	].join("\n") + "\n");
	const transcriptPath = path.join(dir, "subagent-artifacts", "run_worker_transcript.jsonl");
	fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
	fs.writeFileSync(transcriptPath, [
		...Array.from({ length: 2 }, () => JSON.stringify({ recordType: "tool_start", toolName: "read", argsPayload: "TOP_SECRET_TRANSCRIPT_ARGUMENT" })),
		JSON.stringify({ recordType: "message", role: "assistant", text: "first thinking-block update" }),
		...Array.from({ length: 3 }, () => JSON.stringify({ recordType: "tool_start", toolName: "read", argsPayload: "TOP_SECRET_TRANSCRIPT_ARGUMENT" })),
		...Array.from({ length: 6 }, () => JSON.stringify({ recordType: "tool_start", toolName: "ls", argsPayload: "TOP_SECRET_LIST_ARGUMENT" })),
		JSON.stringify({ recordType: "message", role: "assistant", text: "child summary output" }),
	].join("\n") + "\n");
	const tab = createOrcaProgressTab({
		cwd: dir,
		runId,
		agent: "worker",
		index: 0,
		transcriptPath,
		sessionFile,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	tab.finish("completed", sessionFile);
	await waitForFile(capture);
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	assert.equal(args[args.indexOf("--title") + 1], "subagent · worker · 1");
	const output = await captureCommand(args[args.indexOf("--command") + 1]!, dir);
	assert.match(output, /tools: 2x read\nfirst thinking-block update/);
	assert.match(output, /tools: 3x read, 6x ls\nchild summary output/);
	assert.doesNotMatch(output, /› (?:read|ls)/);
	assert.match(output, /✓ subagent completed\s*$/);
	assert.doesNotMatch(output, /mirror source retained|artifact transcript retained|Pi session retained|session output|TOP_SECRET_REASONING|TOP_SECRET_ARGUMENT|TOP_SECRET_TRANSCRIPT_ARGUMENT|TOP_SECRET_LIST_ARGUMENT/);
	assert.doesNotMatch(output, new RegExp(transcriptPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.equal(resolvePiSessionId(sessionFile), sessionId);
});

test("child execution cwd still appends tabs to the explicit parent Orca worktree", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const main = path.join(dir, "main");
	const linked = path.join(dir, "linked");
	fs.mkdirSync(path.join(main, ".git", "worktrees", "linked"), { recursive: true });
	fs.mkdirSync(linked, { recursive: true });
	fs.writeFileSync(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "linked")}\n`);
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const tab = createOrcaProgressTab({
		cwd: linked,
		orcaWorktree: main,
		runId: "linked-child",
		agent: "worker",
		index: 0,
		config: { enabled: true },
		command: fakeOrca,
		env: { ...process.env, ORCA_TEST_CAPTURE: capture },
	});
	assert.ok(tab);
	await waitForFile(capture);
	const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
	assert.equal(args[args.indexOf("--worktree") + 1], `path:${fs.realpathSync(main)}`);
	await tab.finish("completed");
});

test("successful tabs persist passive observer manifests with titles and Orca ids", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const fakeOrca = writeNodeCommand(dir, "orca", "process.stdout.write(JSON.stringify({ok:true,result:{terminal:{handle:'term-observer',tabId:'tab-observer',paneKey:'tab-observer:pane',ptyId:'pty-observer',worktreeId:'worktree-observer'}}}))");
	const sessionId = "01a02699-observer-manifest";
	const sessionFile = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
	const manifestDir = path.join(dir, ".pi", "subagents", "views", "orca");
	fs.mkdirSync(manifestDir, { recursive: true, mode: 0o755 });
	fs.chmodSync(manifestDir, 0o755);

	ensureOrcaParentProgressTab({ cwd: dir, batchId: "tool-call-manifest", sessionId, sessionFile, config: { enabled: true }, command: fakeOrca });
	const child = createOrcaProgressTab({ cwd: dir, runId: "manifest-run", agent: "worker", index: 0, config: { enabled: true }, command: fakeOrca });
	assert.ok(child?.observerManifestPath);
	await waitForFileCount(manifestDir, 2);
	const manifests = fs.readdirSync(manifestDir).map((name) => JSON.parse(fs.readFileSync(path.join(manifestDir, name), "utf-8")) as Record<string, unknown>);
	const parent = manifests.find((manifest) => manifest.role === "parent");
	const childManifest = manifests.find((manifest) => manifest.role === "child");
	assert.deepEqual(parent && {
		kind: parent.kind,
		observer: parent.observer,
		batchId: parent.batchId,
		title: parent.title,
	}, {
		kind: "orca-progress-tab",
		observer: "orca",
		batchId: "tool-call-manifest",
		title: `parent · ${sessionId} · all-manifest`,
	});
	assert.equal(childManifest?.title, "subagent · worker · 2");
	assert.equal(childManifest?.worktree, fs.realpathSync(dir));
	assert.deepEqual(childManifest?.terminal, {
		handle: "term-observer",
		tabId: "tab-observer",
		paneKey: "tab-observer:pane",
		ptyId: "pty-observer",
		worktreeId: "worktree-observer",
	});
	assert.equal(child.observerManifestPath, path.join(fs.realpathSync(dir), ".pi", "subagents", "views", "orca", path.basename(child.observerManifestPath)));
	assert.equal(fs.statSync(child.observerManifestPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(manifestDir).mode & 0o777, 0o700);
	await child.finish("completed");
});

test("an unsuccessful Orca JSON envelope does not publish a phantom manifest", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const fakeOrca = writeNodeCommand(dir, "orca", "process.stdout.write(JSON.stringify({ok:false,error:'not created'}))");
	const tab = createOrcaProgressTab({ cwd: dir, runId: "manifest-failed", agent: "worker", index: 0, config: { enabled: true }, command: fakeOrca });
	assert.ok(tab?.observerManifestPath);
	await waitForCreateReady(dir);
	assert.equal(fs.existsSync(tab.observerManifestPath), false);
	await tab.finish("failed");
});

test("observer manifests reject symlinked project storage roots", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	const outside = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	fs.symlinkSync(outside, path.join(dir, ".pi"), "dir");
	const fakeOrca = writeNodeCommand(dir, "orca", "process.stdout.write(JSON.stringify({ok:true,result:{terminal:{handle:'term-symlink'}}}))");
	const tab = createOrcaProgressTab({ cwd: dir, runId: "manifest-symlink", agent: "worker", index: 0, config: { enabled: true }, command: fakeOrca });
	assert.ok(tab?.observerManifestPath);
	await waitForCreateReady(dir);
	assert.equal(fs.existsSync(path.join(outside, "subagents", "views", "orca")), false);
	assert.equal(fs.existsSync(tab.observerManifestPath), false);
	await tab.finish("failed");
});

test("one parent aggregate plus N child tabs retain concise results and cleanup guidance", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const capture = path.join(dir, "captures.jsonl");
	const fakeOrca = writeNodeCommand(dir, "orca", "require('fs').appendFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2))+'\\n')");
	const parentId = "01a025fe-fae7-70c2-bf43-3f0b40887847";
	const parentFile = path.join(dir, `parent_${parentId}.jsonl`);
	fs.writeFileSync(parentFile, `${JSON.stringify({ type: "session", version: 3, id: parentId })}\n`);
	const childDir = path.join(dir, `parent_${parentId}`, "forks");
	fs.mkdirSync(childDir, { recursive: true });
	const childFile = path.join(childDir, "child.jsonl");
	const otherBatchFile = path.join(childDir, "other-batch.jsonl");
	fs.writeFileSync(childFile, `${JSON.stringify({ type: "session", version: 3, id: "child-session-1234" })}\n`);
	fs.writeFileSync(otherBatchFile, `${JSON.stringify({ type: "session", version: 3, id: "other-batch-session" })}\n`);
	const batchRunDir = path.join(dir, `parent_${parentId}`, "child-run");
	fs.mkdirSync(batchRunDir);
	fs.writeFileSync(path.join(batchRunDir, "retained.jsonl"), "retained");
	const artifactsDir = path.join(dir, "subagent-artifacts");
	fs.mkdirSync(artifactsDir);
	const inputPath = path.join(artifactsDir, "run_worker_input.md");
	const outputPath = path.join(artifactsDir, "run_worker_output.md");
	fs.writeFileSync(inputPath, "input");
	fs.writeFileSync(outputPath, "output");
	const env = { ...process.env, ORCA_TEST_CAPTURE: capture };

	ensureOrcaParentProgressTab({ cwd: dir, batchId: "tool-call-1", sessionId: parentId, sessionFile: parentFile, config: { enabled: true }, command: fakeOrca, env });
	const child = createOrcaProgressTab({ cwd: dir, runId: "child-run", agent: "worker", index: 0, sessionFile: childFile, config: { enabled: true }, command: fakeOrca, env });
	assert.ok(child);
	await recordOrcaParentResult({
		sessionId: parentId,
		sessionFile: parentFile,
		toolCallId: "tool-call-1",
		details: {
			results: [{ agent: "worker", runId: "child-run", exitCode: 0, finalOutput: "concise child result", sessionFile: childFile, artifactPaths: { inputPath, outputPath, batchRunDir, sharedArtifactsDir: artifactsDir } }],
		},
	});
	await child.finish("completed", childFile);

	await waitForLineCount(capture, 2);
	const captures = fs.readFileSync(capture, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
	const parentArgs = captures.find((args) => args[args.indexOf("--title") + 1]?.startsWith("parent ·"));
	const childArgs = captures.find((args) => args[args.indexOf("--title") + 1] === "subagent · worker · 2");
	assert.ok(parentArgs);
	assert.ok(childArgs);
	assert.equal(parentArgs[parentArgs.indexOf("--title") + 1], `parent · ${parentId} · tool-call-1`);
	const parentViewer = parentArgs[parentArgs.indexOf("--command") + 1]!;
	assert.doesNotMatch(parentViewer, / &$/);
	const parentOutput = await captureCommand(parentViewer, dir);
	assert.match(parentOutput, /✓ worker · child-run/);
	assert.match(parentOutput, /concise child result/);
	assert.ok(parentOutput.includes(`rm -f -- '${childFile}' '${inputPath}' '${outputPath}'`));
	assert.ok(parentOutput.includes(`rm -rf -- '${batchRunDir}'`));
	assert.doesNotMatch(parentOutput, new RegExp(`rm -rf -- '${childDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
	assert.doesNotMatch(parentOutput, new RegExp(`rm -rf -- '${artifactsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`));
	assert.doesNotMatch(parentOutput, new RegExp(otherBatchFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(parentOutput, /✓ parent batch completed\s*$/);
	assert.doesNotMatch(parentOutput, /launchContractDigest|tool arguments|mirror source retained|artifact transcript retained|Pi session retained/);
});

test("repeated calls in one Pi session create and complete separate parent batches", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const capture = path.join(dir, "captures.jsonl");
	const fakeOrca = writeNodeCommand(dir, "orca", "require('fs').appendFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2))+'\\n')");
	const sessionId = "01a02699-batch-test-session";
	const sessionFile = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
	const env = { ...process.env, ORCA_TEST_CAPTURE: capture };

	for (const batchId of ["call-a", "call-b"]) {
		ensureOrcaParentProgressTab({ cwd: dir, batchId, sessionId, sessionFile, config: { enabled: true }, command: fakeOrca, env });
		await recordOrcaParentResult({
			sessionId,
			sessionFile,
			toolCallId: batchId,
			details: { results: [{ agent: "worker", runId: `run-${batchId}`, exitCode: 0, finalOutput: `done ${batchId}` }] },
		});
	}

	await waitForLineCount(capture, 2);
	const titles = fs.readFileSync(capture, "utf-8").trim().split("\n")
		.map((line) => JSON.parse(line) as string[])
		.map((args) => args[args.indexOf("--title") + 1]);
	assert.deepEqual(titles, [`parent · ${sessionId} · call-a`, `parent · ${sessionId} · call-b`]);
});

test("an async parent batch stays open only until its run reaches a terminal result", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const sessionId = `async-parent-${Date.now()}`;
	const sessionFile = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
	ensureOrcaParentProgressTab({ cwd: dir, batchId: "async-call", sessionId, sessionFile, config: { enabled: true }, command: fakeOrca, env: { ...process.env, ORCA_TEST_CAPTURE: capture } });

	await recordOrcaParentResult({
		sessionId,
		sessionFile,
		toolCallId: "async-call",
		details: { asyncId: "run-async", asyncDir: path.join(dir, "async-run"), id: "run-async", results: [] },
	});
	const donePath = progressFile(`${sessionId}-0-`, ".log").replace(/\.log$/, ".done");
	assert.equal(fs.existsSync(donePath), false);

	await recordOrcaParentResult({
		sessionId,
		sessionFile,
		toolCallId: "async:run-async",
		details: { results: [{ agent: "worker", runId: "run-async", exitCode: 0, finalOutput: "async done" }] },
	});
	await waitForFile(donePath);
});

test("a detached foreground receipt stays open until its terminal completion event", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, ".git"));
	const capture = path.join(dir, "capture.json");
	const fakeOrca = writeCaptureOrca(dir);
	const sessionId = `foreground-parent-${Date.now()}`;
	const sessionFile = path.join(dir, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`);
	ensureOrcaParentProgressTab({ cwd: dir, batchId: "foreground-call", sessionId, sessionFile, config: { enabled: true }, command: fakeOrca, env: { ...process.env, ORCA_TEST_CAPTURE: capture } });

	await recordOrcaParentResult({
		sessionId,
		sessionFile,
		toolCallId: "foreground-call",
		details: { state: "complete", results: [{ agent: "worker", runId: "run-foreground", exitCode: -2, detached: true }] },
	});
	const donePath = progressFile(`${sessionId}-0-`, ".log").replace(/\.log$/, ".done");
	assert.equal(fs.existsSync(donePath), false);

	await recordOrcaParentResult({
		sessionId,
		sessionFile,
		toolCallId: "foreground:run-foreground",
		details: { state: "complete", results: [{ agent: "worker", runId: "run-foreground", exitCode: 0, finalOutput: "foreground done" }] },
	});
	await waitForFile(donePath);
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
	assert.match(text, /progress projection truncated at 1048576 bytes/);
	assert.doesNotMatch(text, /must be dropped/);
});
