import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { createCodexExecJsonlParser, resolveCodexExecLaunch } from "../../src/runs/shared/codex-exec-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codex-exec-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCodexScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-codex.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const fs = require("node:fs");
+const args = process.argv.slice(2);
+if (args[0] === "--version") { console.log("codex-cli 0.147.0"); process.exit(0); }
+if (args[0] === "exec" && args[1] === "--help") {
+  console.log("Run Codex non-interactively --json --output-last-message --ephemeral --ignore-rules --skip-git-repo-check --sandbox read-only --config");
+  process.exit(0);
+}
+let prompt = "";
+process.stdin.on("data", chunk => prompt += chunk);
+process.stdin.on("end", () => {
+  const outputIndex = args.indexOf("--output-last-message");
+  const outputPath = args[outputIndex + 1];
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("oversized")) return process.stdout.write(JSON.stringify({type:"item.completed", value:"x".repeat(300000)}) + "\n");
+  if (prompt.includes("missing-terminal")) return process.stdout.write(JSON.stringify({type:"turn.started"}) + "\n");
+  if (prompt.includes("failed")) return process.stdout.write(JSON.stringify({type:"turn.failed", error:{message:"fake failure"}}) + "\n");
+  if (!prompt.includes("missing-artifact")) fs.writeFileSync(outputPath, "trusted final message");
+  process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"fake"}) + "\n" + JSON.stringify({type:"turn.completed", usage:{input_tokens:1}}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(dir: string, stepIndex: number, prompt: string) {
	const scriptPath = fakeCodexScript(dir);
	const launch = resolveCodexExecLaunch({ command: process.execPath, commandPrefixArgs: [scriptPath], asyncDir: dir, stepIndex });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt, asyncDir: dir, stepIndex });
	return { launch, result };
}

describe("Codex exec adapter", () => {
	it("owns safe argv, stdin delivery, preflight, terminal proof, and final-message output", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 0, "review $HOME; echo nope");
		assert.deepEqual(launch.args.slice(1), [
			"exec", "--json", "--color", "never", "--ephemeral", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only",
			"-c", 'approval_policy="never"', "--output-last-message", launch.finalOutputPath, "-",
		]);
		assert.equal(launch.args.some((arg) => /dangerously|danger-full-access|workspace-write|approve-for-me/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final message");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "codex-cli 0.147.0");
		assert.equal(result.externalProcess.finalOutputPath, launch.finalOutputPath);
		assert.equal(fs.readFileSync(launch.finalOutputPath, "utf-8"), "trusted final message");
	});

	it("fails closed on malformed, oversized, failed, missing terminal, and missing final artifacts", async () => {
		const dir = tempDir();
		for (const [index, prompt, pattern] of [
			[1, "malformed", /malformed JSONL/],
			[2, "oversized", /line exceeded/],
			[3, "failed", /fake failure/],
			[4, "missing-terminal", /did not produce a terminal state/],
			[5, "missing-artifact", /did not write its final-message artifact/],
		] as const) {
			const { result } = await runFake(dir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
		}
	});

	it("rejects unsupported version and incomplete help during launch preflight", () => {
		const dir = tempDir();
		const launch = resolveCodexExecLaunch({ command: "codex", asyncDir: dir, stepIndex: 6 });
		const evidence = { binaryPath: "/tmp/codex", binaryMtimeMs: 1, version: "codex-cli 0.147.0", help: "Run Codex non-interactively --json --output-last-message --ephemeral --ignore-rules --skip-git-repo-check --sandbox read-only --config", cacheHit: false };
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "Codex unknown" }), /Unsupported Codex version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "Run Codex non-interactively --json" }), /does not document required option/);
	});

	it("removes a stale final-message artifact before launch", () => {
		const dir = tempDir();
		const finalPath = path.join(dir, "external-7.final-message.txt");
		fs.writeFileSync(finalPath, "stale output");
		const launch = resolveCodexExecLaunch({ command: "codex", asyncDir: dir, stepIndex: 7 });
		assert.equal(launch.finalOutputPath, finalPath);
		assert.equal(fs.existsSync(finalPath), false);
	});

	it("rejects duplicate terminal events and oversized final-message artifacts", () => {
		const dir = tempDir();
		const finalPath = path.join(dir, "final.txt");
		const duplicate = createCodexExecJsonlParser(finalPath);
		duplicate.parseLine('{"type":"turn.completed"}');
		assert.throws(() => duplicate.parseLine('{"type":"turn.completed"}'), /after its terminal state/);
		fs.writeFileSync(finalPath, "x".repeat(1024 * 1024 + 1));
		assert.throws(() => duplicate.finish(), /artifact exceeded/);
	});

	it("publishes compact Codex safety and final-message receipt metadata", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: "codex-exec", command: "codex" });
		const metadata = externalCliReceiptMetadata({
			runner,
			externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr", finalOutputPath: "/tmp/final" },
		});
		const receipt = buildWorkflowReceipt({
			workflowRunId: "codex-workflow",
			state: "complete",
			children: [{ key: "codex", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }],
		});
		assert.equal(receipt.entries.codex?.externalAdapter?.adapter.id, "codex-exec");
		assert.deepEqual(receipt.entries.codex?.externalAdapter?.safety, { sandbox: "read-only", approvalPolicy: "never", ephemeral: true });
		assert.equal(receipt.entries.codex?.externalAdapter?.outputArtifacts?.finalOutputPath, "/tmp/final");
		assert.doesNotMatch(JSON.stringify(receipt), /trusted final message|turn\.completed|rawOutput/);
	});

	it("discovers the built-in profile without probing Codex", () => {
		const dir = tempDir();
		const agent = discoverAgentsAll(dir).builtin.find((candidate) => candidate.name === "codex-exec");
		assert.deepEqual(agent?.runner, { type: "external-cli", adapter: "codex-exec", command: "codex", promptDelivery: "stdin" });
	});
});
