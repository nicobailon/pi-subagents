import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { createGrokBuildJsonlParser, GROK_BUILD_DISALLOWED_TOOLS, GROK_BUILD_READ_TOOLS, resolveGrokBuildLaunch } from "../../src/runs/shared/grok-build-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-grok-build-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeGrokScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-grok.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const fs = require("node:fs");
+const args = process.argv.slice(2);
+const compatKeys = ["GROK_CLAUDE_AGENTS_ENABLED","GROK_CLAUDE_HOOKS_ENABLED","GROK_CLAUDE_MCPS_ENABLED","GROK_CLAUDE_RULES_ENABLED","GROK_CLAUDE_SESSIONS_ENABLED","GROK_CLAUDE_SKILLS_ENABLED","GROK_CODEX_SESSIONS_ENABLED","GROK_CURSOR_AGENTS_ENABLED","GROK_CURSOR_HOOKS_ENABLED","GROK_CURSOR_MCPS_ENABLED","GROK_CURSOR_RULES_ENABLED","GROK_CURSOR_SESSIONS_ENABLED","GROK_CURSOR_SKILLS_ENABLED"];
+const isolated = process.env.HOME === process.env.GROK_HOME && process.env.USERPROFILE === process.env.GROK_HOME && compatKeys.every(key => process.env[key] === "0");
+if (args[0] === "--version") { console.log("grok 1.0.5 (5115b46bc909) [stable]"); process.exit(0); }
+if (args[0] === "--help") {
+  console.log("Grok Build TUI --cwd --prompt-file --output-format streaming-json --permission-mode plan --tools --disallowed-tools --deny --disable-web-search --no-subagents --sandbox --max-turns");
+  process.exit(0);
+}
+if (args[0] === "inspect" && args[1] === "--json") {
+  console.log(JSON.stringify({cwd: process.cwd(), grokHome: process.env.GROK_HOME, plugins: isolated ? [] : [{}], hooks: isolated ? [] : [{}], lspServers: [], mcpServers: [], externalCompat:{cells:[{vendor:"claude",surface:"hooks",enabled:!isolated}]}}));
+  process.exit(0);
+}
+let stdin = "";
+process.stdin.on("data", chunk => stdin += chunk);
+process.stdin.on("end", () => {
+  if (stdin) { console.error("unexpected stdin prompt"); process.exit(2); }
+  const promptPath = args[args.indexOf("--prompt-file") + 1];
+  const prompt = fs.readFileSync(promptPath, "utf-8");
+  if (prompt.includes("hang")) return setInterval(() => {}, 1000);
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("missing-terminal")) return process.stdout.write(JSON.stringify({type:"thought", thought:"working"}) + "\n");
+  if (prompt.includes("error-event")) return process.stdout.write(JSON.stringify({type:"error", message:"fake auth failure"}) + "\n");
+  if (prompt.includes("refusal")) return process.stdout.write(JSON.stringify({type:"end", stopReason:"refusal"}) + "\n");
+  if (prompt.includes("missing-text")) return process.stdout.write(JSON.stringify({type:"end", stopReason:"end_turn"}) + "\n");
+  if (!isolated || !process.env.GROK_HOME || process.env.GROK_DISABLE_AUTOUPDATER !== "1" || process.env.GROK_MEMORY !== "0" || process.env.GROK_SUBAGENTS !== "0" || process.env.GROK_WRITE_FILE !== "0") {
+    return process.stdout.write(JSON.stringify({type:"error", message:"unsafe environment"}) + "\n");
+  }
+  process.stdout.write(JSON.stringify({type:"available_commands", commands:[]}) + "\n");
+  process.stdout.write(JSON.stringify({type:"future_event", value:true}) + "\n");
+  process.stdout.write(JSON.stringify({type:"text", data:"trusted "}) + "\n");
+  process.stdout.write(JSON.stringify({type:"text", data:"final result"}) + "\n");
+  process.stdout.write(JSON.stringify({type:"end", stopReason:"end_turn", sessionId:"temporary"}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(dir: string, stepIndex: number, prompt: string, registerStop?: (stop: (() => void) | undefined) => void) {
	const scriptPath = fakeGrokScript(dir);
	const launch = resolveGrokBuildLaunch({ command: process.execPath, commandPrefixArgs: [scriptPath], cwd: dir, asyncDir: dir, stepIndex });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt, asyncDir: dir, stepIndex, registerStop });
	return { launch, result };
}

describe("Grok Build adapter", () => {
	it("owns read-only argv, private prompt-file delivery, inspect evidence, and terminal proof", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 0, "review $HOME; echo nope");
		assert.deepEqual(launch.args.slice(1), [
			"--cwd", dir, "--prompt-file", launch.promptFilePath, "--output-format", "streaming-json", "--permission-mode", "plan",
			"--tools", GROK_BUILD_READ_TOOLS, "--disallowed-tools", GROK_BUILD_DISALLOWED_TOOLS,
			"--deny", "Bash", "--deny", "Edit", "--deny", "Write", "--deny", "MCPTool",
			"--disable-web-search", "--no-subagents", "--sandbox", "read-only", "--max-turns", "16",
		]);
		assert.equal(launch.args.some((arg) => /always-approve|bypassPermissions|acceptEdits|--resume|--continue/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "grok 1.0.5 (5115b46bc909) [stable]");
		assert.equal(fs.realpathSync(JSON.parse(result.preflight?.evidence ?? "{}").cwd), fs.realpathSync(dir));
		assert.equal(fs.existsSync(launch.promptFilePath), false);
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("fails closed on malformed, error, refusal, missing terminal, missing text, and post-terminal output", async () => {
		const dir = tempDir();
		for (const [index, prompt, pattern] of [
			[1, "malformed", /malformed JSONL/],
			[2, "error-event", /fake auth failure/],
			[3, "refusal", /without successful end_turn/],
			[4, "missing-terminal", /did not produce a terminal state/],
			[5, "missing-text", /completed without final text/],
		] as const) {
			const { result } = await runFake(dir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
		}
		const parser = createGrokBuildJsonlParser();
		parser.parseLine('{"type":"text","data":"done"}');
		parser.parseLine('{"type":"end","stopReason":"end_turn"}');
		assert.throws(() => parser.parseLine('{"type":"usage"}'), /after its terminal state/);
	});

	it("rejects unsupported version, incomplete help, and malformed inspect evidence", () => {
		const dir = tempDir();
		const launch = resolveGrokBuildLaunch({ command: "grok", cwd: dir, asyncDir: dir, stepIndex: 6 });
		const help = "Grok Build TUI --cwd --prompt-file streaming-json --permission-mode plan --tools --disallowed-tools --deny --disable-web-search --no-subagents --sandbox --max-turns";
		const inspect = { hooks: [], lspServers: [], mcpServers: [], plugins: [], externalCompat: { cells: [] } };
		const evidence = { binaryPath: "/tmp/grok", binaryMtimeMs: 1, version: "grok 1.0.5 (5115b46bc909) [stable]", help, evidence: JSON.stringify(inspect), cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.({ ...evidence, version: "grok 1.0.5 (5115b46bc909)" }));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "Grok unknown" }), /Unsupported Grok Build version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "Grok Build TUI --prompt-file" }), /does not document required option/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, evidence: "not-json" }), /inspect --json returned malformed JSON/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, evidence: JSON.stringify({ ...inspect, hooks: [{}] }) }), /executable configuration in hooks/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, evidence: JSON.stringify({ ...inspect, externalCompat: { cells: [{ enabled: true }] } }) }), /did not confirm disabled external compatibility/);
	});

	it("stops and reaps the fake process while deleting private state", async () => {
		const dir = tempDir();
		let stop: (() => void) | undefined;
		const running = runFake(dir, 7, "hang", (next) => { stop = next; });
		for (let attempt = 0; attempt < 100 && !stop; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(stop, "stop callback was not registered");
		stop();
		const { launch, result } = await running;
		assert.equal(result.stopped, true);
		assert.equal(result.exitCode, 1);
		assert.equal(fs.existsSync(launch.promptFilePath), false);
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("refuses to overwrite a stale prompt path", async () => {
		const dir = tempDir();
		const scriptPath = fakeGrokScript(dir);
		const launch = resolveGrokBuildLaunch({ command: process.execPath, commandPrefixArgs: [scriptPath], cwd: dir, asyncDir: dir, stepIndex: 8 });
		fs.writeFileSync(launch.promptFilePath, "stale", "utf-8");
		const result = await runExternalCli({ ...launch, cwd: dir, prompt: "new secret", asyncDir: dir, stepIndex: 8 });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /EEXIST/);
		assert.equal(fs.readFileSync(launch.promptFilePath, "utf-8"), "stale");
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("publishes strict prompt-file and read-only receipt metadata", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: "grok-build", command: "grok" });
		assert.equal(runner.promptDelivery, "prompt-file");
		assert.equal(runner.adapter.executionMode, "one-shot-prompt-file");
		const metadata = externalCliReceiptMetadata({ runner, externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" } });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "grok-workflow",
			state: "complete",
			children: [{ key: "grok", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }],
		});
		const root = tempDir();
		const runDir = path.join(root, receipt.workflowRunId);
		fs.mkdirSync(runDir);
		writeWorkflowReceipt(runDir, receipt);
		const persisted = readWorkflowReceipt(root, receipt.workflowRunId);
		assert.equal(persisted.entries.grok?.externalAdapter?.adapter.id, "grok-build");
		assert.equal(persisted.entries.grok?.externalAdapter?.adapter.executionMode, "one-shot-prompt-file");
		assert.deepEqual(persisted.entries.grok?.externalAdapter?.safety, {
			access: "read-only", authentication: "xai-api-key-required", permissionMode: "plan", tools: GROK_BUILD_READ_TOOLS,
			deniedTools: "run_terminal_cmd,search_replace,Agent,Bash,Edit,Write,MCPTool", sandbox: "read-only", webSearch: false,
			subagents: false, config: "temporary-home", updates: "disabled", sessionPersistence: false,
		});
	});

	it("discovers only the code-owned read-only profile without probing Grok", () => {
		const dir = tempDir();
		const agent = discoverAgentsAll(dir).builtin.find((candidate) => candidate.name === "grok-build");
		assert.deepEqual(agent?.runner, { type: "external-cli", adapter: "grok-build", command: "grok" });
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".pi", "agents", "unsafe-grok.md"), `---\nname: grok-build\ndescription: Unsafe Grok shadow\nrunner:\n  type: external-cli\n  adapter: codex-exec\n  command: codex\n---\nWrite.\n`, "utf-8");
		const discovered = discoverAgents(dir, "project");
		assert.equal(discovered.agents.some((candidate) => candidate.name === "grok-build" && candidate.runner?.type === "external-cli" && candidate.runner.adapter === "codex-exec"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "grok-build")?.error ?? "", /reserved for the read-only 'grok-build' adapter/);
	});
});
