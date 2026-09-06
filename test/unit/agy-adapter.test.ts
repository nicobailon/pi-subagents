import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { AGY_ADAPTER_WRITER_ID, AGY_ENV_ALLOWLIST, createAgyJsonlParser, resolveAgyLaunch } from "../../src/runs/shared/agy-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agy-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAgyScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-agy.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const args = process.argv.slice(2);
+if (args[0] === "--version") { console.log("1.1.27"); process.exit(0); }
+if (args[0] === "--help") { console.error("Usage of agy: --print --input-format text stream-json --output-format stream-json --mode plan accept-edits"); process.exit(0); }
+let prompt = "";
+process.stdin.on("data", chunk => prompt += chunk);
+process.stdin.on("end", () => {
+  process.stdout.write(JSON.stringify({event:"init", conversation_id:"abc", init:{model:"gemini-3.8-flash", cwd:process.cwd()}}) + "\n");
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("missing-event")) return process.stdout.write('{"result":{}}\n');
+  if (prompt.includes("auth-error")) return process.stdout.write(JSON.stringify({event:"result", result:{status:"ERROR", error:"authentication required"}}) + "\n");
+  if (prompt.includes("missing-response")) return process.stdout.write(JSON.stringify({event:"result", result:{status:"SUCCESS", response:""}}) + "\n");
+  if (prompt.includes("missing-terminal")) { process.stdout.write(JSON.stringify({event:"step_update", step_update:{step_index:0, state:"ACTIVE", step_type:"tool", tool_name:"run_command"}}) + "\n"); return; }
+  if (prompt.includes("duplicate-terminal")) {
+    process.stdout.write(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"first"}}) + "\n");
+    process.stdout.write(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"second"}}) + "\n");
+    return;
+  }
+  if (prompt !== "verify-stdin: write $HOME; echo nope\nKeep Unicode: café\n") throw new Error("stdin prompt changed");
+  process.stdout.write(JSON.stringify({event:"step_update", step_update:{step_index:1, state:"DONE", step_type:"tool", tool_name:"write_file", duration_seconds:0.05}}) + "\n");
+  process.stdout.write(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"trusted final result", num_turns:1}}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(dir: string, stepIndex: number, prompt: string, adapter: typeof AGY_ADAPTER_WRITER_ID = AGY_ADAPTER_WRITER_ID) {
	const scriptPath = fakeAgyScript(dir);
	const launch = resolveAgyLaunch({ adapter, command: process.execPath, commandPrefixArgs: [scriptPath] });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt, asyncDir: dir, stepIndex });
	return { launch, result };
}

describe("agy-writer adapter", () => {
	it("owns stdin text delivery, accept-edits argv, launch preflight, and terminal result proof", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 0, "verify-stdin: write $HOME; echo nope\nKeep Unicode: café\n");
		assert.deepEqual(launch.args.slice(1), ["--input-format", "text", "--output-format", "stream-json", "--mode", "accept-edits"]);
		assert.equal(launch.args.some((arg) => /dangerously|skip-permissions|continue|conversation|bypass/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "1.1.27");
	});

	it("passes the local identity, proxy, and SSL keys required by CLI login", () => {
		for (const key of ["PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "TMPDIR", "HTTP_PROXY", "SSL_CERT_FILE"])
			assert.equal(AGY_ENV_ALLOWLIST.includes(key), true);
	});

	it("fails closed on malformed, missing-event, auth, missing-text, EOF, and duplicate terminal output", async () => {
		const dir = tempDir();
		for (const [index, prompt, pattern] of [
			[1, "malformed", /malformed JSONL/],
			[2, "missing-event", /invalid event field/],
			[3, "auth-error", /authentication required/],
			[4, "missing-response", /terminal result with status SUCCESS/],
			[5, "missing-terminal", /did not produce a terminal state/],
			[6, "duplicate-terminal", /after its terminal state/],
		] as const) {
			const { result } = await runFake(dir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
		}
	});

	it("rejects unsupported version and incomplete help during launch preflight", () => {
		const launch = resolveAgyLaunch({ adapter: AGY_ADAPTER_WRITER_ID, command: "agy" });
		const help = "Usage of agy: --print --input-format text stream-json --output-format stream-json --mode plan accept-edits";
		const evidence = { binaryPath: "/tmp/agy", binaryMtimeMs: 1, version: "1.1.27", help, cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.(evidence));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "agy unknown" }), /Unsupported agy version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "1.27" }), /Unsupported agy version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "Usage of agy: --print stream-json --mode plan" }), /does not document required option/);
	});

	it("rejects progress events after the terminal result", () => {
		const parser = createAgyJsonlParser();
		parser.parseLine('{"event":"init","init":{}}');
		parser.parseLine('{"event":"result","result":{"status":"SUCCESS","response":"done"}}');
		assert.throws(() => parser.parseLine('{"event":"step_update","step_update":{"state":"DONE"}}'), /after its terminal state/);
	});

	it("publishes workspace-write agy safety receipt metadata", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: "agy-writer", command: "agy" });
		const metadata = externalCliReceiptMetadata({ runner, externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" } });
		assert.deepEqual(metadata.safety, { access: "workspace-write", authentication: "existing-cli-required", permissionMode: "accept-edits" });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "agy-writer-workflow",
			state: "complete",
			children: [{ key: "agy-writer", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }],
		});
		const root = tempDir();
		const runDir = path.join(root, receipt.workflowRunId);
		fs.mkdirSync(runDir);
		writeWorkflowReceipt(runDir, receipt);
		const persisted = readWorkflowReceipt(root, receipt.workflowRunId);
		assert.equal(persisted.entries["agy-writer"]?.externalAdapter?.adapter.id, "agy-writer");
		assert.deepEqual(persisted.entries["agy-writer"]?.externalAdapter?.safety, metadata.safety);
		fs.writeFileSync(path.join(runDir, "workflow-receipt.json"), JSON.stringify(receipt, (key, value) => key === "permissionMode" ? "plan" : value), "utf-8");
		assert.throws(() => readWorkflowReceipt(root, receipt.workflowRunId), /externalAdapter\.safety is invalid/);
	});

	it("rejects frontmatter argv that would widen the packaged adapter", () => {
		const dir = tempDir();
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "unsafe.md"), `---\nname: unsafe\ndescription: Unsafe override\nrunner:\n  type: external-cli\n  adapter: agy-writer\n  command: agy\n  args: ["--dangerously-skip-permissions"]\n---\nWrite.\n`, "utf-8");
		const discovered = discoverAgentsAll(dir);
		assert.equal(discovered.project.some((candidate) => candidate.name === "unsafe"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe")?.error ?? "", /agy-writer adapter owns its argv/);
	});
});
