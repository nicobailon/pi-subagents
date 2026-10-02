/**
 * End-to-end dispatch tests for the Claude Code model and thinking override.
 *
 * These launch the real background runner against a fake `claude` that records
 * its argv, so they prove the tokens travel from a launch request to the CLI.
 * On Windows the fake is an npm-style `.cmd` shim, as an npm install would create.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeAgent } from "../support/helpers.ts";
import { writeNodeCommand } from "../support/node-command.ts";
import {
	available, executeAsyncChain, executeAsyncSingle, installAsyncExecutionHooks, isAsyncAvailable, tempDir, waitForAsyncResultFile,
} from "../support/async-execution-fixture.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";

const CLAUDE_HELP =
	"Claude Code - starts an interactive session --print --input-format text --output-format stream-json --verbose --permission-mode plan acceptEdits --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --disable-slash-commands --no-chrome";

const dirs: string[] = [];
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake CLI that records every invocation and answers the adapter's preflight. */
function fakeClaude(): { command: string; calls: () => string[][] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cc-dispatch-"));
	dirs.push(dir);
	const evidence = path.join(dir, "argv.jsonl");
	const command = writeNodeCommand(dir, "claude", `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--version") { process.stdout.write("2.1.150 (Claude Code)\\n"); process.exit(0); }
if (args.length === 1 && args[0] === "--help") { process.stdout.write(${JSON.stringify(CLAUDE_HELP)} + "\\n"); process.exit(0); }
process.stdin.resume();
process.stdin.on("end", () => {
	process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
});
`);
	return {
		command,
		calls: () => fs.existsSync(evidence)
			? fs.readFileSync(evidence, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
			: [],
	};
}

function claudeCodeRunner(command: string): Record<string, unknown> {
	return { type: "external-cli", adapter: "claude-code", command, promptDelivery: "stdin" };
}

const artifactConfig = { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 };
const asyncOnly = { skip: !isAsyncAvailable() ? "jiti not available" : undefined };

describe("Claude Code override launch", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("carries a model suffix into --model and --effort through a real launch", asyncOnly, async () => {
		const claude = fakeClaude();
		const id = `cc-dispatch-suffix-${Date.now().toString(36)}`;
		const launched = executeAsyncSingle(id, {
			agent: "claude-code",
			task: "Review the handoff",
			modelOverride: "claude-opus-5.5:high",
			agentConfig: makeAgent("claude-code", { runner: claudeCodeRunner(claude.command) } as never),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
		});
		assert.equal(launched.isError, undefined, launched.content[0]?.text ?? "launch failed");
		await waitForAsyncResultFile(id, 15_000);

		const calls = claude.calls();
		const launch = calls.filter((args) => args[0] === "-p");
		assert.equal(launch.length, 1);
		assert.deepEqual(launch[0]?.slice(-4), ["--model", "claude-opus-5.5", "--effort", "high"]);
		// The preflight probes stay single-argument: no launch token leaks into them.
		assert.deepEqual(calls.filter((args) => args[0] === "--version" || args[0] === "--help"), [["--version"], ["--help"]]);
	});

	it("gives each chain step and each parallel item its own flags", asyncOnly, async () => {
		const claude = fakeClaude();
		const id = `cc-dispatch-chain-${Date.now().toString(36)}`;
		const launched = executeAsyncChain(id, {
			chain: [
				{ agent: "claude-code", task: "First", model: "sonnet:low" },
				{ parallel: [{ agent: "claude-code", task: "Second", model: "haiku:xhigh" }] },
			],
			agents: [makeAgent("claude-code", { runner: claudeCodeRunner(claude.command) } as never)],
			resultMode: "chain",
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			acceptance: false,
		});
		assert.equal(launched.isError, undefined, launched.content[0]?.text ?? "launch failed");
		await waitForAsyncResultFile(id, 20_000);

		const launch = claude.calls().filter((args) => args[0] === "-p");
		assert.equal(launch.length, 2);
		assert.deepEqual(launch[0]?.slice(-4), ["--model", "sonnet", "--effort", "low"]);
		assert.deepEqual(launch[1]?.slice(-4), ["--model", "haiku", "--effort", "xhigh"]);
	});

	it("rejects an effort above maxThinking before the CLI runs", asyncOnly, () => {
		const claude = fakeClaude();
		const launched = executeAsyncSingle(`cc-dispatch-ceiling-${Date.now().toString(36)}`, {
			agent: "claude-code",
			task: "Review the handoff",
			modelOverride: "sonnet:max",
			agentConfig: makeAgent("claude-code", { maxThinking: "low", runner: claudeCodeRunner(claude.command) } as never),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
		});
		assert.equal(launched.isError, true);
		assert.match(launched.content[0]?.text ?? "", /Thinking level 'max' exceeds configured maximum 'low'/);
		assert.deepEqual(claude.calls(), []);
	});
});
