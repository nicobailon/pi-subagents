import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, resolveAgentName } from "../../src/agents/agents.ts";
import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_ENV_ALLOWLIST, CLAUDE_CODE_WRITER_ADAPTER_ID, CLAUDE_CODE_WRITER_TOOLS, createClaudeCodeJsonlParser, resolveClaudeCodeLaunch, resolveClaudeCodeOverride } from "../../src/runs/shared/claude-code-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-claude-code-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeClaudeScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-claude.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const args = process.argv.slice(2);
+if (args[0] === "--version") { console.log("2.1.150 (Claude Code)"); process.exit(0); }
+if (args[0] === "--help") {
+  console.log("Claude Code - starts an interactive session --print --input-format text --output-format stream-json --verbose --permission-mode plan acceptEdits --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --disable-slash-commands --no-chrome");
+  process.exit(0);
+}
+let prompt = "";
+process.stdin.on("data", chunk => prompt += chunk);
+process.stdin.on("end", () => {
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("oversized")) return process.stdout.write(JSON.stringify({type:"assistant", value:"x".repeat(300000)}) + "\n");
+  process.stdout.write(JSON.stringify({type:"system", subtype:"init"}) + "\n");
+  if (prompt.includes("missing-terminal")) return;
+  if (prompt.includes("auth-error")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_during_execution", is_error:true, errors:["authentication required"]}) + "\n");
+  if (prompt.includes("max-turns")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_max_turns", is_error:true, result:"partial"}) + "\n");
+  if (prompt.includes("budget")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_max_budget_usd", is_error:true, result:"partial"}) + "\n");
+  if (prompt.includes("missing-text")) return process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:""}) + "\n");
+  process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"untrusted partial"}]}}) + "\n");
+  process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:"trusted final result", session_id:"not-persisted"}) + "\n");
+  if (prompt.includes("duplicate-terminal")) process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:"duplicate"}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(dir: string, stepIndex: number, prompt: string, adapter: typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID = CLAUDE_CODE_ADAPTER_ID) {
	const scriptPath = fakeClaudeScript(dir);
	const launch = resolveClaudeCodeLaunch({ adapter, command: process.execPath, commandPrefixArgs: [scriptPath] });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt, asyncDir: dir, stepIndex });
	return { launch, result };
}

describe("Claude Code adapter", () => {
	it("owns no-tools argv, stdin delivery, launch preflight, and terminal result proof", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 0, "review $HOME; echo nope");
		assert.deepEqual(launch.args.slice(1), [
			"-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan",
			"--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence",
			"--disable-slash-commands", "--no-chrome",
		]);
		assert.equal(launch.args.some((arg) => /dangerously|bypassPermissions|acceptEdits|--bare|--resume|--continue/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "2.1.150 (Claude Code)");
	});

	it("passes the local identity and temporary-directory keys required by CLI login", () => {
		assert.equal(CLAUDE_CODE_ENV_ALLOWLIST.includes("USER"), true);
		assert.equal(CLAUDE_CODE_ENV_ALLOWLIST.includes("LOGNAME"), true);
		assert.equal(CLAUDE_CODE_ENV_ALLOWLIST.includes("TMPDIR"), true);
	});

	it("owns explicit file writer argv without permission bypass or MCP", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 9, "write the requested file", CLAUDE_CODE_WRITER_ADAPTER_ID);
		assert.deepEqual(launch.args.slice(1), [
			"-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
			"--tools", CLAUDE_CODE_WRITER_TOOLS, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence",
			"--disable-slash-commands", "--no-chrome",
		]);
		assert.equal(launch.args.some((arg) => /dangerously|bypassPermissions|--bare|--resume|--continue|\bBash\b/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
	});

	it("fails closed on malformed, oversized, auth, limit, EOF, missing-text, and duplicate terminal output", async () => {
		const dir = tempDir();
		for (const [index, prompt, pattern] of [
			[1, "malformed", /malformed JSONL/],
			[2, "oversized", /line exceeded/],
			[3, "auth-error", /authentication required/],
			[4, "max-turns", /partial/],
			[5, "budget", /partial/],
			[6, "missing-terminal", /did not produce a terminal state/],
			[7, "missing-text", /terminal result success/],
			[8, "duplicate-terminal", /duplicate terminal result/],
		] as const) {
			const { result } = await runFake(dir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
		}
	});

	it("rejects unsupported version and incomplete help during launch preflight", () => {
		const launch = resolveClaudeCodeLaunch({ adapter: CLAUDE_CODE_ADAPTER_ID, command: "claude" });
		const help = "Claude Code - starts an interactive session --print --input-format stream-json --verbose --permission-mode plan --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --disable-slash-commands --no-chrome";
		const evidence = { binaryPath: "/tmp/claude", binaryMtimeMs: 1, version: "2.1.150 (Claude Code)", help, cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.({ ...evidence, version: "2026.4.24 macos-arm64 (2026-04-27)" }));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "Claude unknown" }), /Unsupported Claude Code version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "2026.4.24 macos-arm64 (not-a-date)" }), /Unsupported Claude Code version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "Claude Code - starts an interactive session --print" }), /does not document required option/);
	});

	it("accepts non-terminal hook trailers but rejects duplicate result events", () => {
		const parser = createClaudeCodeJsonlParser();
		parser.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"done"}');
		assert.doesNotThrow(() => parser.parseLine('{"type":"system","subtype":"hook_response"}'));
		assert.throws(() => parser.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"again"}'), /duplicate terminal result/);
	});

	it("publishes compact Claude safety receipt metadata", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: "claude-code", command: "claude" });
		const metadata = externalCliReceiptMetadata({ runner, externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" } });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "claude-workflow",
			state: "complete",
			children: [{ key: "claude", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }],
		});
		const root = tempDir();
		const runDir = path.join(root, receipt.workflowRunId);
		fs.mkdirSync(runDir);
		writeWorkflowReceipt(runDir, receipt);
		const persisted = readWorkflowReceipt(root, receipt.workflowRunId);
		assert.equal(persisted.entries.claude?.externalAdapter?.adapter.id, "claude-code");
		assert.deepEqual(persisted.entries.claude?.externalAdapter?.safety, { access: "read-only", authentication: "existing-cli-required", permissionMode: "plan", tools: "none", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false });
		assert.doesNotMatch(JSON.stringify(receipt), /trusted final result|session_id|rawOutput/);
	});

	it("publishes strict writer safety metadata and reads legacy local Claude receipts", () => {
		const writer = externalCliReceiptMetadata({ runner: resolveExternalCliRunnerStatus({ adapter: "claude-code-writer", command: "claude" }) });
		assert.deepEqual(writer.safety, { access: "workspace-write", authentication: "existing-cli-required", permissionMode: "acceptEdits", tools: CLAUDE_CODE_WRITER_TOOLS, mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false });

		const root = tempDir();
		const writerDir = path.join(root, "writer");
		fs.mkdirSync(writerDir);
		const writerReceipt = buildWorkflowReceipt({
			workflowRunId: "writer",
			state: "complete",
			children: [{ key: "claude", ok: true, output: "done", resumability: { state: "not-resumable", reason: writer.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: writer, results: [], artifactPaths: [] }],
		});
		writeWorkflowReceipt(writerDir, writerReceipt);
		assert.deepEqual(readWorkflowReceipt(root, "writer").entries.claude?.externalAdapter?.safety, writer.safety);
		fs.writeFileSync(path.join(writerDir, "workflow-receipt.json"), JSON.stringify(writerReceipt, (key, value) => key === "tools" ? "Bash" : value), "utf-8");
		assert.throws(() => readWorkflowReceipt(root, "writer"), /externalAdapter\.safety is invalid/);

		const runDir = path.join(root, "legacy-claude");
		fs.mkdirSync(runDir);
		const legacy = buildWorkflowReceipt({
			workflowRunId: "legacy-claude",
			state: "complete",
			children: [{ key: "claude", ok: true, output: "done", resumability: { state: "not-resumable", reason: writer.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: externalCliReceiptMetadata({ runner: resolveExternalCliRunnerStatus({ adapter: "claude-code", command: "claude" }) }), results: [], artifactPaths: [] }],
		});
		fs.writeFileSync(path.join(runDir, "workflow-receipt.json"), JSON.stringify(legacy, (key, value) => key === "safety" ? { permissionMode: "plan", tools: "none", mcp: "empty-strict", settingSources: "none", sessionPersistence: false } : value), "utf-8");
		assert.equal(readWorkflowReceipt(root, "legacy-claude").entries.claude?.externalAdapter?.adapter.id, "claude-code");
	});

	it("discovers the built-in profile without probing Claude Code", () => {
		const agents = discoverAgentsAll(tempDir()).builtin;
		assert.deepEqual(agents.find((candidate) => candidate.name === "claude-code")?.runner, { type: "external-cli", adapter: "claude-code", command: "claude", promptDelivery: "stdin" });
		assert.deepEqual(agents.find((candidate) => candidate.name === "claude-code-writer")?.runner, { type: "external-cli", adapter: "claude-code-writer", command: "claude", promptDelivery: "stdin" });
	});

	it("rejects user and project shadows that widen the read-only profile", () => {
		const project = tempDir();
		const userRoot = tempDir();
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const definition = `---\nname: claude-code\ndescription: Unsafe Claude shadow\nrunner:\n  type: external-cli\n  adapter: claude-code-writer\n  command: claude\n---\nWrite.\n`;
		try {
			process.env.PI_CODING_AGENT_DIR = userRoot;
			fs.mkdirSync(path.join(userRoot, "agents"), { recursive: true });
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.writeFileSync(path.join(userRoot, "agents", "claude-code.md"), definition, "utf-8");
			fs.writeFileSync(path.join(project, ".pi", "agents", "claude-code.md"), definition, "utf-8");

			const discovered = discoverAgentsAll(project);
			assert.equal(discovered.user.some((candidate) => candidate.name === "claude-code"), false);
			assert.equal(discovered.project.some((candidate) => candidate.name === "claude-code"), false);
			for (const source of ["user", "project"] as const) {
				assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.source === source && diagnostic.name === "claude-code")?.error ?? "", /reserved for the read-only 'claude-code' adapter/);
			}
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("keeps disabled read-only selection reserved across local names and aliases", () => {
		const project = tempDir();
		const userRoot = tempDir();
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const packageRoot = path.join(project, ".pi", "npm", "node_modules", "unsafe-claude-package");
		try {
			process.env.PI_CODING_AGENT_DIR = userRoot;
			fs.mkdirSync(path.join(userRoot, "agents"), { recursive: true });
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "claude-code": { disabled: true } } } }), "utf-8");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unsafe-claude-package", "pi-subagents": { agents: ["./agents"] } }), "utf-8");
			fs.writeFileSync(path.join(packageRoot, "agents", "claude-code.md"), `---\nname: claude-code\npackage: unsafe-mode\ndescription: Unsafe package local name\nrunner:\n  type: external-cli\n  adapter: claude-code-writer\n  command: claude\n---\nWrite.\n`, "utf-8");
			fs.writeFileSync(path.join(project, ".pi", "agents", "project-writer.md"), `---\nname: project-writer\naliases: claude-code\ndescription: Unsafe project alias\nrunner:\n  type: external-cli\n  adapter: claude-code-writer\n  command: claude\n---\nWrite.\n`, "utf-8");
			fs.writeFileSync(path.join(userRoot, "agents", "user-writer.md"), `---\nname: user-writer\naliases: claude-code\ndescription: Unsafe user alias\nrunner:\n  type: external-cli\n  adapter: claude-code-writer\n  command: claude\n---\nWrite.\n`, "utf-8");

			const all = discoverAgentsAll(project);
			for (const [source, name] of [["package", "claude-code"], ["project", "project-writer"], ["user", "user-writer"]] as const) {
				assert.match(all.agentDiagnostics?.find((diagnostic) => diagnostic.source === source && diagnostic.name === name)?.error ?? "", /Selection name 'claude-code' is reserved/);
			}
			const effective = discoverAgents(project, "both").agents;
			assert.equal(resolveAgentName("claude-code", effective).agent, undefined);
			const writer = resolveAgentName("claude-code-writer", effective).agent;
			assert.equal(writer?.runner?.type === "external-cli" ? writer.runner.adapter : undefined, "claude-code-writer");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("derives the model and the effort from the model suffix", () => {
		assert.equal(resolveClaudeCodeOverride({}), undefined);
		assert.deepEqual(resolveClaudeCodeOverride({ model: "claude-opus-5.5" }), { args: ["--model", "claude-opus-5.5"], model: "claude-opus-5.5" });
		assert.deepEqual(resolveClaudeCodeOverride({ model: " sonnet " }), { args: ["--model", "sonnet"], model: "sonnet" });
		assert.deepEqual(resolveClaudeCodeOverride({ model: "claude-opus-5.5:high" }), { args: ["--model", "claude-opus-5.5", "--effort", "high"], model: "claude-opus-5.5" });
		// A bare ":level" asks for the effort without pinning a model.
		assert.deepEqual(resolveClaudeCodeOverride({ model: ":medium" }), { args: ["--effort", "medium"] });
		// The suffix wins over the frontmatter value, which is the Pi child precedence.
		assert.deepEqual(resolveClaudeCodeOverride({ model: "opus:low", thinking: "max" }), { args: ["--model", "opus", "--effort", "low"], model: "opus" });
		assert.deepEqual(resolveClaudeCodeOverride({ thinking: "medium" }), { args: ["--effort", "medium"] });
		// Pi's wider thinking scale collapses onto Claude Code's five-value effort scale.
		assert.equal(resolveClaudeCodeOverride({ thinking: "off" }), undefined);
		assert.deepEqual(resolveClaudeCodeOverride({ model: "haiku:minimal" }), { args: ["--model", "haiku", "--effort", "low"], model: "haiku" });
		assert.deepEqual(resolveClaudeCodeOverride({ thinking: "xhigh" }), { args: ["--effort", "xhigh"] });
	});

	it("runs a bare level on the agent's own model and keeps a Pi default out of --model", () => {
		// A bare level means the agent's model at that effort, so the two forms agree.
		assert.deepEqual(resolveClaudeCodeOverride({ model: ":high", agent: { model: "claude-opus-5.5" } }), { args: ["--model", "claude-opus-5.5", "--effort", "high"], model: "claude-opus-5.5" });
		assert.deepEqual(resolveClaudeCodeOverride({ agent: { model: "claude-opus-5.5" } }), { args: ["--model", "claude-opus-5.5"], model: "claude-opus-5.5" });
		// A launch model replaces the agent's model entirely.
		assert.deepEqual(resolveClaudeCodeOverride({ model: "haiku:low", agent: { model: "claude-opus-5.5" } }), { args: ["--model", "haiku", "--effort", "low"], model: "haiku" });
		// subagents.defaultModel is a Pi child model, so the CLI never sees it.
		const fromSettings = { model: "anthropic/claude-sonnet-4-5", modelSource: { type: "subagents.defaultModel", model: "anthropic/claude-sonnet-4-5" } };
		assert.equal(resolveClaudeCodeOverride({ agent: fromSettings }), undefined);
		assert.deepEqual(resolveClaudeCodeOverride({ agent: fromSettings, thinking: "low" }), { args: ["--effort", "low"] });
		// A frontmatter model the operator wrote stays the agent's own model.
		assert.deepEqual(resolveClaudeCodeOverride({ agent: { model: "claude-opus-5.5", modelSource: { type: "subagents.defaultModel", model: "anthropic/claude-sonnet-4-5" } } }), { args: ["--model", "claude-opus-5.5"], model: "claude-opus-5.5" });
	});

	it("rejects a model or thinking value it cannot pass as its own argv element", () => {
		assert.throws(() => resolveClaudeCodeOverride({ model: "" }), /Invalid Claude Code model/);
		assert.throws(() => resolveClaudeCodeOverride({ model: ":" }), /Invalid Claude Code model/);
		assert.throws(() => resolveClaudeCodeOverride({ model: ":turbo" }), /Invalid Claude Code model/);
		assert.throws(() => resolveClaudeCodeOverride({ model: "--dangerously-skip-permissions" }), /Invalid Claude Code model/);
		assert.throws(() => resolveClaudeCodeOverride({ model: "opus --tools Bash" }), /Invalid Claude Code model/);
		assert.throws(() => resolveClaudeCodeOverride({ thinking: "turbo" }), /Invalid thinking level/);
		assert.throws(() => resolveClaudeCodeOverride({ thinking: "off; rm -rf /" }), /Invalid thinking level/);
		// A Bedrock inference profile keeps its colon, because "0" is not a level.
		assert.deepEqual(resolveClaudeCodeOverride({ model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }), {
			args: ["--model", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
			model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		});
	});

	it("rejects an effort above the ceiling and keeps the boundary level", () => {
		assert.throws(
			() => resolveClaudeCodeOverride({ model: "sonnet:max", thinkingCeiling: "low", agentName: "cc", runId: "run-1" }),
			/Thinking level 'max' exceeds configured maximum 'low' for agent 'cc' run 'run-1'\./,
		);
		// The ceiling compares the requested level, not the effort it maps to, so a
		// "minimal" request stays legal under a "minimal" ceiling although it emits low.
		assert.deepEqual(resolveClaudeCodeOverride({ model: "sonnet:minimal", thinkingCeiling: "minimal" }), { args: ["--model", "sonnet", "--effort", "low"], model: "sonnet" });
		assert.deepEqual(resolveClaudeCodeOverride({ model: "sonnet:max", thinkingCeiling: "max" }), { args: ["--model", "sonnet", "--effort", "max"], model: "sonnet" });
		// No requested level means no ceiling to check.
		assert.deepEqual(resolveClaudeCodeOverride({ model: "sonnet", thinkingCeiling: "low" }), { args: ["--model", "sonnet"], model: "sonnet" });
	});

	it("appends an override after the fixed argv and keeps it out of preflight", () => {
		const overrideArgs = resolveClaudeCodeOverride({ model: "claude-opus-5.5:medium" })?.args;
		const launch = resolveClaudeCodeLaunch({ adapter: CLAUDE_CODE_ADAPTER_ID, command: "claude", overrideArgs });
		assert.deepEqual(launch.args.slice(-4), ["--model", "claude-opus-5.5", "--effort", "medium"]);
		assert.deepEqual(launch.args.slice(0, 2), ["-p", "--input-format"]);
		assert.equal(launch.args.includes("--no-chrome"), true);
		assert.deepEqual(launch.preflight.versionArgs, ["--version"]);
		assert.deepEqual(launch.preflight.helpArgs, ["--help"]);
		const writer = resolveClaudeCodeLaunch({ adapter: CLAUDE_CODE_WRITER_ADAPTER_ID, command: "claude", overrideArgs });
		assert.deepEqual(writer.args.slice(-4), ["--model", "claude-opus-5.5", "--effort", "medium"]);
	});

	it("passes an explicit model and effort to a real launch", async () => {
		const dir = tempDir();
		const scriptPath = path.join(dir, "claude-argv.cjs");
		fs.writeFileSync(scriptPath, String.raw`
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.150 (Claude Code)"); process.exit(0); }
if (args[0] === "--help") { console.log("Claude Code - starts an interactive session --print --input-format text --output-format stream-json --verbose --permission-mode plan acceptEdits --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --disable-slash-commands --no-chrome"); process.exit(0); }
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "argv:" + args.join(" ") }) + "\n");
});
`, "utf-8");

		const overrideArgs = resolveClaudeCodeOverride({ model: "claude-opus-5.5:high" })?.args;
		const launch = resolveClaudeCodeLaunch({ adapter: CLAUDE_CODE_ADAPTER_ID, command: process.execPath, commandPrefixArgs: [scriptPath], overrideArgs });
		const result = await runExternalCli({ ...launch, cwd: dir, prompt: "review", asyncDir: dir, stepIndex: 0 });
		assert.equal(result.parserTerminal?.state, "completed");
		assert.match(result.output ?? "", /--model claude-opus-5.5 --effort high$/);
	});

	it("accepts model and thinking frontmatter only on the Claude Code adapters", () => {
		const dir = tempDir();
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "cc-pinned.md"), `---\nname: cc-pinned\ndescription: Pinned Claude\nmodel: claude-opus-5.5\nthinking: medium\nrunner:\n  type: external-cli\n  adapter: claude-code\n  command: claude\n---\nReview.\n`, "utf-8");
		fs.writeFileSync(path.join(agentsDir, "ccx-pinned.md"), `---\nname: ccx-pinned\ndescription: Pinned Codex\nmodel: gpt-5\nrunner:\n  type: external-cli\n  adapter: codex-exec\n  command: codex\n---\nReview.\n`, "utf-8");
		const discovered = discoverAgentsAll(dir);
		assert.equal(discovered.project.find((candidate) => candidate.name === "cc-pinned")?.model, "claude-opus-5.5");
		assert.equal(discovered.agentDiagnostics?.some((diagnostic) => diagnostic.name === "cc-pinned"), false);
		assert.equal(discovered.project.some((candidate) => candidate.name === "ccx-pinned"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "ccx-pinned")?.error ?? "", /declares unsupported Pi-only fields: model/);
	});

	it("rejects frontmatter argv that would widen the packaged adapter", () => {
		const dir = tempDir();
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "unsafe.md"), `---\nname: unsafe\ndescription: Unsafe override\nrunner:\n  type: external-cli\n  adapter: claude-code\n  command: claude\n  args: ["--dangerously-skip-permissions"]\n---\nReview.\n`, "utf-8");
		fs.writeFileSync(path.join(agentsDir, "unsafe-writer.md"), `---\nname: unsafe-writer\ndescription: Unsafe writer override\nrunner:\n  type: external-cli\n  adapter: claude-code-writer\n  command: claude\n  args: ["--tools", "Bash"]\n---\nWrite.\n`, "utf-8");
		const discovered = discoverAgentsAll(dir);
		assert.equal(discovered.project.some((candidate) => candidate.name === "unsafe"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe")?.error ?? "", /claude-code adapter owns its argv/);
		assert.equal(discovered.project.some((candidate) => candidate.name === "unsafe-writer"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe-writer")?.error ?? "", /claude-code-writer adapter owns its argv/);
	});
});
