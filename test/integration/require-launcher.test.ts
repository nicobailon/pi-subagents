/**
 * options.requireLauncher: a call that names a launcher and agent definition digest runs only when both match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { agentDefinitionDigest } from "../../src/shared/launch-contract.ts";
import { createRunFanoutBudget, getRunFanoutBudgetSnapshot } from "../../src/runs/shared/run-fanout-budget.ts";
import {
	installAsyncExecutionHooks, available, isAsyncAvailable, executeAsyncSingle, ASYNC_DIR,
	tempDir, mockPi, readAsyncPayload, makeAsyncExecutor, createSubagentExecutor,
} from "../support/async-execution-fixture.ts";

const SHAPE_ERROR = /requireLauncher is supported only on a top-level single-agent call/;

describe("requireLauncher", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	const sandboxed = () => makeAgent("sandboxed", { launcher: "wrap" });
	const launchers = () => {
		const wrapper = path.join(tempDir, "wrap.sh");
		const configCopy = path.join(tempDir, "runner-config.json");
		// The runner config is the last argument; keep a copy to read the digest the launch recorded.
		fs.writeFileSync(wrapper, `#!/bin/sh\nfor a; do last="$a"; done\ncp "$last" ${JSON.stringify(configCopy)}\nexec "$@"\n`, { mode: 0o755 });
		return { configCopy, runnerLaunchers: { wrap: [wrapper], other: [wrapper] } };
	};

	it("lets a matching requirement launch under the launcher, with the agent's digest in the runner config", { timeout: 30_000, skip: !isAsyncAvailable() || process.platform === "win32" ? "requires jiti and a POSIX wrapper" : undefined }, async () => {
		const { configCopy, runnerLaunchers } = launchers();
		const agent = sandboxed();
		const definitionDigest = agentDefinitionDigest(agent);
		mockPi.onCall({ output: "wrapped result" });
		const launch = await makeAsyncExecutor([agent], { runnerLaunchers }).executePublic("required-match", {
			agent: "sandboxed", task: "Work", requireLauncher: { name: "wrap", definitionDigest },
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		assert.equal((await readAsyncPayload(launch.details.asyncId!)).success, true);
		const config = JSON.parse(fs.readFileSync(configCopy, "utf-8")) as { steps: Array<{ definitionDigest?: string }> };
		assert.equal(config.steps[0]?.definitionDigest, definitionDigest);
	});

	it("refuses a mismatched launcher or digest before spending fan-out or creating a session directory", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const { runnerLaunchers } = launchers();
		const sessionDir = path.join(tempDir, "sessions-root");
		const agent = sandboxed();
		const digest = agentDefinitionDigest(agent);
		const cases = [
			[makeAgent("sandboxed"), { name: "wrap", definitionDigest: digest }, /Agent 'sandboxed' has no launcher, but the call requires launcher 'wrap'/],
			[agent, { name: "other", definitionDigest: digest }, /Agent 'sandboxed' uses launcher 'wrap', but the call requires launcher 'other'/],
			[agent, { name: "wrap", definitionDigest: "0".repeat(64) }, /definition digest is [0-9a-f]{64}, but the call requires 0{64}/],
		] as const;
		for (const [selected, requireLauncher, message] of cases) {
			const budget = createRunFanoutBudget(`required-launcher-${Date.now().toString(36)}`, 1);
			try {
				const refused = await makeAsyncExecutor([selected], { runnerLaunchers, defaultSessionDir: sessionDir })
					.execute("required-mismatch", { agent: "sandboxed", task: "Work", async: true, requireLauncher, runFanoutBudget: budget }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
				assert.equal(refused.isError, true);
				assert.match(refused.content[0]?.text ?? "", message);
				assert.deepEqual(getRunFanoutBudgetSnapshot(budget), { used: 0, limit: 1, remaining: 1 });
			} finally {
				fs.rmSync(budget.directory, { recursive: true, force: true });
			}
		}
		assert.deepEqual(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [], []);
		assert.equal(mockPi.callCount(), 0);
	});

	it("refuses at spawn when the agent it would start no longer matches", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const { runnerLaunchers } = launchers();
		const id = `required-spawn-${Date.now().toString(36)}`;
		const agent = sandboxed();
		const launch = executeAsyncSingle(id, {
			agent: "sandboxed",
			task: "Work",
			agentConfig: agent,
			requireLauncher: { name: "wrap", definitionDigest: agentDefinitionDigest({ ...agent, systemPrompt: "checked earlier" }) },
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-required-spawn", runnerLaunchers },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: false,
		});
		assert.equal((launch as { isError?: boolean }).isError, true);
		assert.match((launch as { content: Array<{ text: string }> }).content[0]?.text ?? "", /the agent definition changed after it was checked/);
		assert.equal(fs.existsSync(path.join(ASYNC_DIR, id)), false);
	});

	it("refuses every call shape other than a top-level single-agent launch, including workflow children", { skip: !createSubagentExecutor ? "executor not available" : undefined }, async () => {
		const { runnerLaunchers } = launchers();
		const agent = sandboxed();
		const requireLauncher = { name: "wrap", definitionDigest: agentDefinitionDigest(agent) };
		const executor = makeAsyncExecutor([agent], { runnerLaunchers });
		// tasks and chain are public inputs only while workflow scripts are disabled.
		const structured = makeAsyncExecutor([agent], { runnerLaunchers, disabledFeatures: ["workflow-scripts"] });
		for (const [request, run] of [
			[{ tasks: [{ agent: "sandboxed", task: "Work" }] }, structured],
			[{ chain: [{ agent: "sandboxed", task: "Work" }] }, structured],
			[{ workflow: "./script.js" }, executor],
			[{ action: "status" }, executor],
			[{ agent: "sandboxed", task: "Work", resume: "run-1" }, executor],
		] as const) {
			const refused = await run.executePublic("required-shape", { ...request, requireLauncher }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(refused.isError, true, JSON.stringify(request));
			assert.match(refused.content[0]?.text ?? "", SHAPE_ERROR, JSON.stringify(request));
		}
		// runs.run children are refused even though the script passed the field, including a resume child.
		for (const child of [{ agent: "sandboxed", task: "Work" }, { resume: "no-such-run", task: "Follow up" }]) {
			const workflow = await executor.executePublic("required-child", {
				async: false,
				workflowScript: `try { const child = await runs.run("sandboxed", ${JSON.stringify({ ...child, requireLauncher })}); return child.ok ? "ok" : child.error; } catch (error) { return error.message; }`,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.match(String(workflow.details?.workflow?.value ?? workflow.content[0]?.text), SHAPE_ERROR, JSON.stringify(child));
		}
		// The internal entry point skips the public shape check; a malformed value is still refused.
		const malformed = await executor.execute("required-null", { agent: "sandboxed", task: "Work", async: true, requireLauncher: null as never }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /requireLauncher must be \{ name, definitionDigest \}/);
		assert.equal(mockPi.callCount(), 0);
	});
});
