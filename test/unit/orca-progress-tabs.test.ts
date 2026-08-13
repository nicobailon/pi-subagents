import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOrcaProgressTab, resolveOrcaCommand, resolvePiSessionId } from "../../src/runs/shared/orca-progress-tabs.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

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
		const key = createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 20);
		fs.rmSync(path.join(progressRoot, `counter-${key}`), { force: true });
		fs.rmSync(path.join(progressRoot, `counter-${key}.lock`), { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
	removeProgressFiles("progress-");
	removeProgressFiles("disabled-run-");
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-tabs-test-"));
	tempDirs.push(dir);
	return dir;
}

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("resolveOrcaCommand only returns executable commands", () => {
	const dir = tempDir();
	const executable = path.join(dir, process.platform === "win32" ? "orca.cmd" : "orca");
	fs.writeFileSync(executable, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
	if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
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

test("malformed optional observer metadata cannot break child execution", async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const fakeOrca = path.join(dir, "orca");
	fs.writeFileSync(fakeOrca, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))\n`);
	fs.chmodSync(fakeOrca, 0o755);
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
	const fakeOrca = path.join(dir, "orca");
	fs.writeFileSync(fakeOrca, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))\n`);
	fs.chmodSync(fakeOrca, 0o755);
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

test("enabled tabs use a worktree sequence and successful Pi sessions get cleanup guidance", { skip: process.platform === "win32" }, async () => {
	const dir = tempDir();
	const capture = path.join(dir, "capture.json");
	const secondCapture = path.join(dir, "capture-2.json");
	const fakeOrca = path.join(dir, "orca");
	fs.mkdirSync(path.join(dir, ".git"));
	fs.writeFileSync(fakeOrca, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))\n`);
	fs.chmodSync(fakeOrca, 0o755);
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
	const sessionFile = path.join(dir, `2026-08-13T22-31-16-313Z_${sessionId}.jsonl`);
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
	assert.ok(text.includes(`completed. To remove the Pi session of this subagent, run rm $(find ~/.pi/agent/sessions -name "*_${sessionId}.jsonl" -print -quit)`));

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
