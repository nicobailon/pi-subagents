import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { writeNodeCommand } from "../support/node-command.ts";

const tempDirs: string[] = [];
afterEach(() => {
	const progressDir = path.join(TEMP_ROOT_DIR, "orca-progress");
	for (const dir of tempDirs.splice(0)) {
		let scope = path.resolve(dir);
		try { scope = fs.realpathSync(dir); } catch { /* use the lexical path */ }
		const key = createHash("sha256").update(scope).digest("hex").slice(0, 20);
		fs.rmSync(path.join(progressDir, `counter-${key}`), { force: true });
		fs.rmSync(path.join(progressDir, `counter-${key}.lock`), { recursive: true, force: true });
		if (fs.existsSync(progressDir)) {
			for (const name of fs.readdirSync(progressDir)) {
				if (name.startsWith(`create-${key}-`) && (name.endsWith(".ready") || name.endsWith(".pending"))) fs.rmSync(path.join(progressDir, name), { force: true });
			}
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
	if (fs.existsSync(progressDir)) {
		for (const name of fs.readdirSync(progressDir)) {
			if (name.startsWith("orca-observer-native-") || name.startsWith("concurrent-sequence-")) fs.rmSync(path.join(progressDir, name), { force: true });
		}
	}
});

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, env });
		child.once("error", reject);
		child.once("close", resolve);
	});
}

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(file)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForFileCount(dir: string, count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (fs.readdirSync(dir).length < count) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} files in ${dir}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("Orca progress-tab observer", () => {
	it("mirrors a native Pi child without replacing its execution path", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-native-"));
		tempDirs.push(dir);
		const asyncDir = path.join(dir, "async");
		const agentDir = path.join(dir, "agent-dir");
		const capture = path.join(dir, "orca-args.json");
		const fakeOrca = writeNodeCommand(dir, "orca", "require('fs').writeFileSync(process.env.ORCA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)))");
		fs.mkdirSync(asyncDir);
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ orcaProgressTabs: { enabled: true } }));
		const childEvents = [
			{ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } },
			{ type: "tool_execution_end", toolName: "read" },
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "native Pi result" }], stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } },
			{ type: "agent_settled" },
		];
		const fakePi = writeNodeCommand(dir, "pi", `for (const event of ${JSON.stringify(childEvents)}) process.stdout.write(JSON.stringify(event)+'\\n')`);

		const resultPath = path.join(dir, "result.json");
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({
			id: "orca-observer-native",
			sessionId: "session-orca-native",
			steps: [{
				agent: "worker",
				task: "Read the repository",
				systemPrompt: "Use native Pi",
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
			{
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_SUBAGENT_ORCA_BINARY: fakeOrca,
				PI_SUBAGENT_PI_BINARY: fakePi,
				ORCA_TEST_CAPTURE: capture,
			},
		);
		assert.equal(exitCode, 0);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(result.success, true);
		assert.equal(result.results[0].runner, undefined);
		assert.match(result.results[0].output, /native Pi result/);
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /read: README\.md[\s\S]*native Pi result/);

		await waitForFile(capture);
		const args = JSON.parse(fs.readFileSync(capture, "utf-8")) as string[];
		assert.deepEqual(args.slice(0, 2), ["terminal", "create"]);
		assert.equal(args[args.indexOf("--worktree") + 1], `path:${path.resolve(dir)}`);
		assert.equal(args[args.indexOf("--title") + 1], "subagents · worker · 1");
	});

	it("uses one observer tab for a background parallel run", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-parallel-"));
		tempDirs.push(dir);
		const asyncDir = path.join(dir, "async");
		const agentDir = path.join(dir, "agent-dir");
		const captures = path.join(dir, "orca-captures");
		fs.mkdirSync(asyncDir);
		fs.mkdirSync(captures);
		fs.mkdirSync(path.join(agentDir, "extensions", "subagent"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ orcaProgressTabs: { enabled: true } }));
		const fakeOrca = writeNodeCommand(dir, "orca", "const fs=require('fs'),path=require('path');const args=process.argv.slice(2);fs.writeFileSync(path.join(process.env.ORCA_TEST_CAPTURE_DIR, process.pid+'.json'),JSON.stringify(args))");
		const fakePi = writeNodeCommand(dir, "pi", "process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'parallel result'}]}})+'\\n')");

		const resultPath = path.join(dir, "result.json");
		const configPath = path.join(dir, "config.json");
		fs.writeFileSync(configPath, JSON.stringify({
			id: "orca-observer-parallel",
			sessionId: "session-orca-parallel",
			steps: [{
				parallel: [
					{ agent: "worker", task: "One", systemPrompt: "Use native Pi", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
					{ agent: "reviewer", task: "Two", systemPrompt: "Use native Pi", systemPromptMode: "replace", inheritProjectContext: false, inheritSkills: false },
				],
				concurrency: 2,
			}],
			resultPath,
			cwd: dir,
			placeholder: "{previous}",
			artifactConfig: { enabled: false },
			asyncDir,
			resultMode: "parallel",
		}));
		const repo = path.resolve(import.meta.dirname, "../..");
		const exitCode = await runProcess(
			process.execPath,
			[path.join(repo, "node_modules/jiti/lib/jiti-cli.mjs"), path.join(repo, "src/runs/background/subagent-runner.ts"), configPath],
			repo,
			{
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_SUBAGENT_ORCA_BINARY: fakeOrca,
				PI_SUBAGENT_PI_BINARY: fakePi,
				ORCA_TEST_CAPTURE_DIR: captures,
			},
		);

		assert.equal(exitCode, 0);
		await waitForFileCount(captures, 1);
		const captureFiles = fs.readdirSync(captures);
		assert.equal(captureFiles.length, 1);
		const args = JSON.parse(fs.readFileSync(path.join(captures, captureFiles[0]!), "utf-8")) as string[];
		assert.equal(args[args.indexOf("--title") + 1], "subagents · parallel-worker-reviewer · 1");
		const progressDir = path.join(TEMP_ROOT_DIR, "orca-progress");
		const log = fs.readdirSync(progressDir).find((name) => name.startsWith("orca-observer-parallel-0-") && name.endsWith(".log"));
		assert.ok(log);
		const text = fs.readFileSync(path.join(progressDir, log), "utf-8");
		assert.match(text, /2 children/);
		assert.match(text, /child 1\/2 · worker/);
		assert.match(text, /child 2\/2 · reviewer/);
	});

	it("allocates unique worktree-wide numbers across concurrent processes and nested cwd values", { skip: process.platform === "win32" ? "Orca progress tabs are not supported on Windows" : undefined }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-orca-counter-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		const nested = path.join(dir, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });
		const captures = path.join(dir, "captures");
		fs.mkdirSync(captures);
		const orderFile = path.join(dir, "order.txt");
		const fakeOrca = writeNodeCommand(dir, "orca", "const fs=require('fs'),path=require('path');const args=process.argv.slice(2);const title=args[args.indexOf('--title')+1];fs.appendFileSync(process.env.ORCA_TEST_ORDER,title+'\\n');fs.writeFileSync(path.join(process.env.ORCA_TEST_CAPTURE_DIR, process.pid+'.json'),JSON.stringify(args))");
		const repo = path.resolve(import.meta.dirname, "../..");
		const moduleUrl = new URL("../../src/runs/shared/orca-progress-tabs.ts", import.meta.url).href;
		const childScript = `import {createOrcaProgressTab} from ${JSON.stringify(moduleUrl)};const tab=createOrcaProgressTab({cwd:process.env.CHILD_CWD,runId:'concurrent-sequence',agent:'worker',index:0,config:{enabled:true}});if(!tab)throw new Error('tab unavailable');setTimeout(()=>tab.finish('failed'),100);setTimeout(()=>{},180);`;
		const processes = Array.from({ length: 8 }, (_, index) => runProcess(
			process.execPath,
			["--experimental-strip-types", "--input-type=module", "--eval", childScript],
			repo,
			{ ...process.env, PI_SUBAGENT_ORCA_BINARY: fakeOrca, ORCA_TEST_CAPTURE_DIR: captures, ORCA_TEST_ORDER: orderFile, CHILD_CWD: index % 2 === 0 ? dir : nested },
		));
		assert.deepEqual(await Promise.all(processes), Array(8).fill(0));
		await waitForFileCount(captures, 8);
		const titles = fs.readdirSync(captures).map((name) => {
			const args = JSON.parse(fs.readFileSync(path.join(captures, name), "utf-8")) as string[];
			return args[args.indexOf("--title") + 1];
		}).sort((left, right) => Number(left.split(" · ").at(-1)) - Number(right.split(" · ").at(-1)));
		assert.deepEqual(titles, Array.from({ length: 8 }, (_, index) => `subagents · worker · ${index + 1}`));
		const createdOrder = fs.readFileSync(orderFile, "utf-8").trim().split("\n");
		assert.deepEqual(createdOrder, titles);
	});
});
