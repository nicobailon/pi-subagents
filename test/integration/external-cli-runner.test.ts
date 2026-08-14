import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resultFilesForSession } from "../../src/runs/background/result-files.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { writeNodeCommand } from "../support/node-command.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	const progressDir = path.join(TEMP_ROOT_DIR, "orca-progress");
	if (fs.existsSync(progressDir)) {
		for (const name of fs.readdirSync(progressDir)) {
			if (name.startsWith("orca-observer-external-")) fs.rmSync(path.join(progressDir, name), { force: true });
		}
	}
});

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, env });
		child.once("error", reject);
		child.once("close", resolve);
	});
}

describe("external CLI async lifecycle", () => {
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
		assert.match(args[args.indexOf("--title") + 1], /subagent · external/);
	});
});
