import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runProcess(command: string, args: string[], cwd: string): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
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
});
