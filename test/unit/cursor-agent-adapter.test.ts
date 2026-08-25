import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, resolveAgentName } from "../../src/agents/agents.ts";
import { CURSOR_AGENT_ADAPTER_ID, CURSOR_AGENT_ENV_ALLOWLIST, CURSOR_AGENT_WRITER_ADAPTER_ID, createCursorAgentJsonlParser, resolveCursorAgentLaunch } from "../../src/runs/shared/cursor-agent-adapter.ts";
import { externalCliReceiptMetadata, normalizeExternalCliRunnerStatus, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cursor-agent-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCursorScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-cursor-agent.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const fs = require("node:fs");
+const args = process.argv.slice(2);
+if (args[0] === "--version") { console.log("2026.08.11-e8db854"); process.exit(0); }
+if (args[0] === "--help") {
+  console.log("Start the Cursor Agent --print Has access to all tools, including write and shell --output-format text | json | stream-json --mode <mode> ask: Q&A read-only --sandbox <mode> enabled --workspace <path-or-name> --add-dir <path>");
+  process.exit(0);
+}
+let stdin = "";
+process.stdin.on("data", chunk => stdin += chunk);
+process.stdin.on("end", () => {
+  if (stdin) { console.error("unexpected stdin prompt"); process.exit(2); }
+  const shortPrompt = args.at(-1) || "";
+  const match = /^Read the complete handoff from the private file at (.+)\. Follow it and return only the final answer\.$/.exec(shortPrompt);
+  if (!match) { console.error("unsafe argv prompt"); process.exit(2); }
+  const prompt = fs.readFileSync(match[1], "utf-8");
+  if (prompt.includes("hang")) return setInterval(() => {}, 1000);
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("missing-terminal")) return process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"partial"}]}}) + "\n");
+  if (prompt.includes("oversized-tool-call") && !prompt.includes("post-terminal-oversized-tool-call")) process.stdout.write(JSON.stringify({type:"tool_call",subtype:"completed",tool_call:{name:"write",args:"x".repeat(300 * 1024)}}) + "\n");
+  if (prompt.includes("post-terminal-oversized-tool-call")) return process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"trusted final result"}) + "\n" + JSON.stringify({type:"tool_call",subtype:"completed",tool_call:{name:"write",args:"x".repeat(300 * 1024)}}) + "\n");
+  if (prompt.includes("error-event")) return process.stdout.write(JSON.stringify({type:"error",message:"fake auth failure"}) + "\n");
+  if (prompt.includes("failed-result")) return process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,result:"fake failure"}) + "\n");
+  if (prompt.includes("missing-text")) return process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:""}) + "\n");
+  process.stdout.write(JSON.stringify({type:"system",subtype:"init",permissionMode:"default"}) + "\n");
+  process.stdout.write(JSON.stringify({type:"future_event",value:true}) + "\n");
+  process.stdout.write(JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"text",text:"untrusted partial"}]}}) + "\n");
+  process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"trusted final result"}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(workspace: string, stateDir: string, stepIndex: number, prompt: string, adapter: typeof CURSOR_AGENT_ADAPTER_ID | typeof CURSOR_AGENT_WRITER_ADAPTER_ID = CURSOR_AGENT_ADAPTER_ID, registerStop?: (stop: (() => void) | undefined) => void) {
	const scriptPath = fakeCursorScript(stateDir);
	const launch = resolveCursorAgentLaunch({ adapter, command: process.execPath, commandPrefixArgs: [scriptPath], cwd: workspace, asyncDir: stateDir, stepIndex });
	const result = await runExternalCli({ ...launch, cwd: workspace, prompt, asyncDir: stateDir, stepIndex, registerStop });
	return { launch, result };
}

describe("Cursor Agent adapter", () => {
	it("owns read-only argv, private prompt-file delivery, and terminal proof", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const secretPrompt = "review PRIVATE_HANDOFF_TEXT; echo nope";
		const { launch, result } = await runFake(workspace, stateDir, 0, secretPrompt);
		assert.deepEqual(launch.args.slice(1, -1), [
			"-p", "--output-format", "stream-json", "--mode", "ask", "--sandbox", "enabled",
			"--workspace", workspace, "--add-dir", path.dirname(launch.promptFilePath),
		]);
		assert.match(launch.args.at(-1) ?? "", /handoff\.txt/);
		assert.equal(launch.args.some((arg) => arg.includes("PRIVATE_HANDOFF_TEXT")), false);
		assert.equal(launch.args.some((arg) => /--force|--yolo|--auto-review|--approve-mcps|--plugin-dir|--resume|--continue|--worktree|--trust/.test(arg)), false);
		assert.equal((CURSOR_AGENT_ENV_ALLOWLIST as readonly string[]).includes("CURSOR_API_ENDPOINT"), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "2026.08.11-e8db854");
		assert.equal(fs.existsSync(launch.promptFilePath), false);
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("owns explicit writer argv without bypass, session reuse, or user roots", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const { launch, result } = await runFake(workspace, stateDir, 1, "write the requested file", CURSOR_AGENT_WRITER_ADAPTER_ID);
		assert.deepEqual(launch.args.slice(1, -1), [
			"-p", "--output-format", "stream-json", "--sandbox", "enabled",
			"--workspace", workspace, "--add-dir", path.dirname(launch.promptFilePath),
		]);
		assert.equal(launch.args.includes("--mode"), false);
		assert.equal(launch.args.some((arg) => /--force|--yolo|--auto-review|--approve-mcps|--plugin-dir|--resume|--continue|--worktree|--trust/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("skips a bounded oversized non-terminal tool call before terminal proof", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const { result } = await runFake(workspace, stateDir, 2, "oversized-tool-call", CURSOR_AGENT_WRITER_ADAPTER_ID);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.deepEqual(result.parserTerminal, { state: "completed", output: "trusted final result" });
	});

	it("fails closed on an oversized tool call after terminal proof", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const { result } = await runFake(workspace, stateDir, 3, "post-terminal-oversized-tool-call", CURSOR_AGENT_WRITER_ADAPTER_ID);
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /line exceeded/);
		assert.equal(result.parserTerminal, undefined);
	});

	it("adds no extra root when the prompt directory is inside the workspace", () => {
		const workspace = tempDir();
		const launch = resolveCursorAgentLaunch({ adapter: CURSOR_AGENT_ADAPTER_ID, command: "cursor-agent", cwd: workspace, asyncDir: workspace, stepIndex: 2 });
		assert.equal(launch.args.includes("--add-dir"), false);
	});

	it("fails closed on malformed, error, failed result, missing terminal, missing text, and post-terminal output", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		for (const [index, prompt, pattern] of [
			[3, "malformed", /malformed JSONL/],
			[4, "error-event", /fake auth failure/],
			[5, "failed-result", /fake failure/],
			[6, "missing-terminal", /did not produce a terminal state/],
			[7, "missing-text", /terminal result success/],
		] as const) {
			const { launch, result } = await runFake(workspace, stateDir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
			assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false, prompt);
		}
		const parser = createCursorAgentJsonlParser();
		parser.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"done"}');
		assert.throws(() => parser.parseLine('{"type":"assistant"}'), /after its terminal state/);
	});

	it("rejects unsupported versions and incomplete help", () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const launch = resolveCursorAgentLaunch({ adapter: CURSOR_AGENT_ADAPTER_ID, command: "cursor-agent", cwd: workspace, asyncDir: stateDir, stepIndex: 8 });
		const help = "Start the Cursor Agent --print stream-json --mode <mode> ask: Q&A read-only --sandbox <mode> enabled --workspace <path-or-name> --add-dir <path>";
		const evidence = { binaryPath: "/tmp/cursor-agent", binaryMtimeMs: 1, version: "2026.08.11-e8db854", help, cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.(evidence));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "Cursor unknown" }), /Unsupported Cursor Agent version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "Start the Cursor Agent --print" }), /does not document required option/);
	});

	it("stops and reaps the fake process while deleting the private prompt directory", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		let stop: (() => void) | undefined;
		const running = runFake(workspace, stateDir, 9, "hang", CURSOR_AGENT_ADAPTER_ID, (next) => { stop = next; });
		for (let attempt = 0; attempt < 100 && !stop; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(stop, "stop callback was not registered");
		stop();
		const { launch, result } = await running;
		assert.equal(result.stopped, true);
		assert.equal(result.exitCode, 1);
		assert.equal(fs.existsSync(launch.temporaryDirectories[0]!), false);
	});

	it("refuses to overwrite a stale prompt path and preserves the existing directory", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const scriptPath = fakeCursorScript(stateDir);
		const launch = resolveCursorAgentLaunch({ adapter: CURSOR_AGENT_ADAPTER_ID, command: process.execPath, commandPrefixArgs: [scriptPath], cwd: workspace, asyncDir: stateDir, stepIndex: 10 });
		fs.mkdirSync(path.dirname(launch.promptFilePath), { mode: 0o700 });
		fs.writeFileSync(launch.promptFilePath, "stale", { mode: 0o600 });
		const result = await runExternalCli({ ...launch, cwd: workspace, prompt: "new secret", asyncDir: stateDir, stepIndex: 10 });
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /EEXIST/);
		assert.equal(fs.readFileSync(launch.promptFilePath, "utf-8"), "stale");
	});

	it("removes the private prompt file but preserves an existing prompt directory", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const scriptPath = fakeCursorScript(stateDir);
		const launch = resolveCursorAgentLaunch({ adapter: CURSOR_AGENT_ADAPTER_ID, command: process.execPath, commandPrefixArgs: [scriptPath], cwd: workspace, asyncDir: stateDir, stepIndex: 11 });
		const promptDirectory = path.dirname(launch.promptFilePath);
		fs.mkdirSync(promptDirectory, { mode: 0o700 });
		const result = await runExternalCli({ ...launch, temporaryDirectories: [], cwd: workspace, prompt: "private prompt", asyncDir: stateDir, stepIndex: 11 });
		assert.equal(result.exitCode, 0);
		assert.equal(fs.existsSync(launch.promptFilePath), false);
		assert.deepEqual(fs.readdirSync(promptDirectory), []);
	});

	it("publishes strict read and writer metadata and loads legacy Grok status", () => {
		const read = externalCliReceiptMetadata({ runner: resolveExternalCliRunnerStatus({ adapter: "cursor-agent", command: "cursor-agent" }) });
		const writer = externalCliReceiptMetadata({ runner: resolveExternalCliRunnerStatus({ adapter: "cursor-agent-writer", command: "cursor-agent" }) });
		assert.deepEqual(read.safety, { access: "read-only", authentication: "cursor-api-key-or-existing-login", mode: "ask", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false });
		assert.deepEqual(writer.safety, { access: "workspace-write", authentication: "cursor-api-key-or-existing-login", mode: "print", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "cursor-workflow",
			state: "complete",
			children: [{ key: "cursor", ok: true, output: "done", resumability: { state: "not-resumable", reason: writer.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: writer, results: [], artifactPaths: [] }],
		});
		const root = tempDir();
		const runDir = path.join(root, receipt.workflowRunId);
		fs.mkdirSync(runDir);
		writeWorkflowReceipt(runDir, receipt);
		assert.deepEqual(readWorkflowReceipt(root, receipt.workflowRunId).entries.cursor?.externalAdapter?.safety, writer.safety);

		const legacy = normalizeExternalCliRunnerStatus({ type: "external-cli", command: "grok", args: [], promptDelivery: "prompt-file", adapter: { id: "grok-build", version: 1, executionMode: "one-shot-prompt-file" } });
		assert.equal(legacy?.adapter.id, "grok-build");
		assert.equal(legacy?.promptDelivery, "prompt-file");
		assert.equal(legacy?.capabilities.stop, true);
	});

	it("keeps the read-only Cursor selection reserved across discovery identities", () => {
		const project = tempDir();
		const userRoot = tempDir();
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const packageRoot = path.join(project, ".pi", "npm", "node_modules", "unsafe-cursor-package");
		try {
			process.env.PI_CODING_AGENT_DIR = userRoot;
			fs.mkdirSync(path.join(userRoot, "agents"), { recursive: true });
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "cursor-agent": { disabled: true } } } }));
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unsafe-cursor-package", "pi-subagents": { agents: ["./agents"] } }));
			fs.writeFileSync(path.join(packageRoot, "agents", "cursor-agent.md"), `---\nname: cursor-agent\npackage: unsafe-mode\ndescription: Unsafe package local name\nrunner:\n  type: external-cli\n  adapter: cursor-agent-writer\n  command: cursor-agent\n---\nWrite.\n`);
			fs.writeFileSync(path.join(project, ".pi", "agents", "project-writer.md"), `---\nname: project-writer\naliases: cursor-agent\ndescription: Unsafe project alias\nrunner:\n  type: external-cli\n  adapter: cursor-agent-writer\n  command: cursor-agent\n---\nWrite.\n`);
			fs.writeFileSync(path.join(userRoot, "agents", "cursor-agent.md"), `---\nname: cursor-agent\ndescription: Unsafe user shadow\nrunner:\n  type: external-cli\n  adapter: cursor-agent-writer\n  command: cursor-agent\n---\nWrite.\n`);

			const all = discoverAgentsAll(project);
			for (const [source, name] of [["package", "cursor-agent"], ["project", "project-writer"], ["user", "cursor-agent"]] as const) {
				assert.match(all.agentDiagnostics?.find((diagnostic) => diagnostic.source === source && diagnostic.name === name)?.error ?? "", /Selection name 'cursor-agent' is reserved/);
			}
			const effective = discoverAgents(project, "both").agents;
			assert.equal(resolveAgentName("cursor-agent", effective).agent, undefined);
			const explicitWriter = resolveAgentName("cursor-agent-writer", effective).agent;
			assert.equal(explicitWriter?.runner?.type === "external-cli" ? explicitWriter.runner.adapter : undefined, "cursor-agent-writer");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("discovers both built-ins without probing Cursor and rejects adapter argv", () => {
		const project = tempDir();
		const agents = discoverAgentsAll(project).builtin;
		assert.deepEqual(agents.find((candidate) => candidate.name === "cursor-agent")?.runner, { type: "external-cli", adapter: "cursor-agent", command: "cursor-agent" });
		assert.deepEqual(agents.find((candidate) => candidate.name === "cursor-agent-writer")?.runner, { type: "external-cli", adapter: "cursor-agent-writer", command: "cursor-agent" });
		fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "agents", "unsafe.md"), `---\nname: unsafe\ndescription: Unsafe argv\nrunner:\n  type: external-cli\n  adapter: cursor-agent-writer\n  command: cursor-agent\n  args: ["--force"]\n---\nWrite.\n`);
		assert.match(discoverAgentsAll(project).agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe")?.error ?? "", /cursor-agent-writer adapter owns its argv/);
	});
});
