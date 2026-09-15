import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { createGeminiAgentJsonlParser, GEMINI_AGENT_ADAPTER_ID, GEMINI_AGENT_WRITER_ADAPTER_ID, resolveGeminiAgentLaunch } from "../../src/runs/shared/gemini-agent-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { formatHerdrMachineRunnerUnsupported } from "../../src/runs/shared/herdr-machine.ts";
import { validateCodeOwnedProfileRunner } from "../../src/runs/shared/external-cli-contract.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-gemini-agent-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeAgyScript(dir: string): string {
	const script = path.join(dir, "fake-agy.cjs");
	fs.writeFileSync(script, String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.2.3"); process.exit(0); }
if (args[0] === "--help") { console.log("--input-format stream-json --output-format stream-json --mode plan accept-edits --sandbox"); process.exit(0); }
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(require("node:path").join(__dirname, "stdin.txt"), input);
  process.stdout.write(JSON.stringify({event:"init", tools:["write"]}) + "\n");
  process.stdout.write(JSON.stringify({event:"result", result:{status:"SUCCESS", response:"agy response"}}) + "\n");
});
`, "utf8");
	return script;
}

async function runFake(dir: string, adapter = GEMINI_AGENT_ADAPTER_ID) {
	const launch = resolveGeminiAgentLaunch({ adapter, command: process.execPath, commandPrefixArgs: [fakeAgyScript(dir)] });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt: launch.serializePrompt("hello"), asyncDir: dir, stepIndex: 0 });
	return { launch, result };
}

describe("Gemini agy adapter", () => {
	it("owns argv, NDJSON stdin, preflight, and terminal result proof", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir);
		assert.deepEqual(launch.args.slice(1), ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "plan", "--sandbox"]);
		assert.equal(launch.args.some((arg) => /print|dangerously|disable-slash|resume|conversation|project|model|effort|json-schema/.test(arg)), false);
		assert.equal(launch.serializePrompt("hello"), `${JSON.stringify({ event: "user", message: { role: "user", content: "hello" } })}\n`);
		assert.equal(fs.readFileSync(path.join(dir, "stdin.txt"), "utf8"), launch.serializePrompt("hello"));
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "agy response");
		assert.equal(result.preflight?.version, "1.2.3");
	});

	it("selects accept-edits intent for writer without claiming bypass", () => {
		const launch = resolveGeminiAgentLaunch({ adapter: GEMINI_AGENT_WRITER_ADAPTER_ID, command: "agy" });
		assert.deepEqual(launch.args, ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "accept-edits", "--sandbox"]);
		assert.equal(launch.args.includes("--dangerously-skip-permissions"), false);
	});

	it("fails closed for malformed, non-success, duplicate, missing, and empty terminal results", () => {
		assert.throws(() => createGeminiAgentJsonlParser().parseLine("{bad"), /malformed JSONL/);
		for (const result of [{ status: "FAILED", response: "no" }, { status: "SUCCESS", response: "" }]) {
			const parser = createGeminiAgentJsonlParser();
			const parsed = parser.parseLine(JSON.stringify({ event: "result", result }));
			assert.ok(parsed);
			assert.equal(parsed.phase, "failed");
			assert.equal(parser.finish()?.state, "failed");
		}
		const duplicate = createGeminiAgentJsonlParser();
		duplicate.parseLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }));
		assert.throws(() => duplicate.parseLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "again" } })), /after its terminal state/);
		const missing = createGeminiAgentJsonlParser();
		missing.parseLine(JSON.stringify({ event: "init" }));
		assert.equal(missing.finish(), undefined);
	});

	it("validates required help flags without version-format assumptions", () => {
		const launch = resolveGeminiAgentLaunch({ adapter: GEMINI_AGENT_ADAPTER_ID, command: "agy" });
		const evidence = { binaryPath: "/tmp/agy", binaryMtimeMs: 1, version: "Antigravity 2026.09", help: "--input-format stream-json --output-format stream-json --mode plan accept-edits --sandbox", cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.(evidence));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "--input-format stream-json" }), /does not document required option/);
	});

	it("publishes truthful safety metadata and discovers both profiles", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: GEMINI_AGENT_ADAPTER_ID, command: "agy" });
		assert.deepEqual(runner.safety, { mode: "plan", sandbox: "enabled", authentication: "existing-cli-required", settingSources: "vendor-managed", sessionPersistence: "vendor-managed", enforcement: "unverified" });
		const metadata = externalCliReceiptMetadata({ runner });
		assert.deepEqual(metadata.safety, runner.safety);
		const receiptRoot = tempDir();
		const receiptDir = path.join(receiptRoot, "gemini");
		fs.mkdirSync(receiptDir);
		writeWorkflowReceipt(receiptDir, buildWorkflowReceipt({ workflowRunId: "gemini", state: "complete", children: [{ key: "gemini", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }] }));
		assert.deepEqual(readWorkflowReceipt(receiptRoot, "gemini").entries.gemini?.externalAdapter?.safety, metadata.safety);
		const agents = discoverAgentsAll(tempDir()).builtin;
		const geminiAgent = agents.find((agent) => agent.name === "gemini-agent");
		const geminiWriter = agents.find((agent) => agent.name === "gemini-agent-writer");
		const geminiRunner = geminiAgent?.runner;
		const geminiWriterRunner = geminiWriter?.runner;
		assert.ok(geminiRunner?.type === "external-cli");
		assert.ok(geminiWriterRunner?.type === "external-cli");
		assert.equal(geminiRunner.adapter, "gemini-agent");
		assert.equal(geminiWriterRunner.adapter, "gemini-agent-writer");
	});

	it("keeps plan-mode selection reserved and rejects machine placement explicitly", () => {
		assert.match(validateCodeOwnedProfileRunner({ name: "gemini-agent", runner: { type: "external-cli", adapter: "gemini-agent-writer" } }) ?? "", /reserved for the plan-mode/);
		assert.match(formatHerdrMachineRunnerUnsupported({ machine: "workmac", agentName: "gemini-agent", runnerType: "external-cli", adapter: "gemini-agent" }) ?? "", /local-only/);
	});
});
