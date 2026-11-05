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
import { recoveryDescriptorPath } from "../../src/runs/shared/run-launch-folder.ts";
import { getActiveAsyncCapacitySnapshot } from "../../src/runs/background/active-async-capacity.ts";
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
		assert.equal(launch.isError, true);
		assert.match(launch.content[0]?.text ?? "", /the agent definition changed after it was checked/);
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

	// Resume revives a retained session, so the source run is a fork with a pre-created session file.
	const forkCtx = (name: string) => {
		const parentSessionFile = path.join(tempDir, `${name}-parent.jsonl`);
		const sessionFile = path.join(tempDir, `${name}-child.jsonl`);
		const header = JSON.stringify({ type: "session", version: 1, id: name, cwd: fs.realpathSync(tempDir) });
		fs.writeFileSync(parentSessionFile, `${header}\n`);
		fs.writeFileSync(sessionFile, `${header}\n`);
		return { ...makeMinimalCtx(tempDir), sessionManager: { getSessionId: () => `${name}-session`, getSessionFile: () => parentSessionFile, getLeafId: () => "leaf", openSession: () => ({ createBranchedSession: () => sessionFile }) } };
	};

	it("resumes a run launched with the requirement only while the agent definition still matches", { timeout: 30_000, skip: !isAsyncAvailable() || process.platform === "win32" ? "requires jiti and a POSIX wrapper" : undefined }, async () => {
		const { runnerLaunchers } = launchers();
		const ctx = forkCtx("required-resume");
		const agent = sandboxed();
		const requireLauncher = { name: "wrap", definitionDigest: agentDefinitionDigest(agent) };
		mockPi.onCall({ output: "first run" });
		const launch = await makeAsyncExecutor([agent], { runnerLaunchers }).execute("required-resume-launch", { agent: "sandboxed", task: "Do work", async: true, context: "fork", acceptance: false, requireLauncher }, new AbortController().signal, undefined, ctx);
		assert.equal(launch.isError, undefined, launch.content[0]?.text);
		const sourceId = launch.details.asyncId!;
		assert.equal((await readAsyncPayload(sourceId)).success, true);
		assert.deepEqual(JSON.parse(fs.readFileSync(recoveryDescriptorPath(ASYNC_DIR, sourceId), "utf-8")).requiredLauncher, requireLauncher);
		const resume = (agents: ReturnType<typeof makeAgent>[], extra: Record<string, unknown> = {}, id = sourceId) => makeAsyncExecutor(agents, { runnerLaunchers })
			.execute(`resume-${id}`, { action: "resume", id, message: "Continue", acceptance: false, ...extra }, new AbortController().signal, undefined, ctx);

		const capacityBefore = getActiveAsyncCapacitySnapshot("required-resume-session", 4).used;
		const runsBefore = fs.readdirSync(ASYNC_DIR).length;
		const edited = await resume([makeAgent("sandboxed", { launcher: "wrap", systemPrompt: "edited after approval" })]);
		assert.equal(edited.isError, true);
		assert.match(edited.content[0]?.text ?? "", new RegExp(`Cannot resume: run '${sourceId}' was launched requiring launcher 'wrap' and agent definition ${requireLauncher.definitionDigest}; agent 'sandboxed' now has digest [0-9a-f]{64}\\.`));
		const missing = await resume([]);
		assert.match(missing.content[0]?.text ?? "", /agent 'sandboxed' now is missing\./);
		const attached = await resume([agent], { chain: [{ agent: "sandboxed", task: "More" }], message: undefined });
		assert.match(attached.content[0]?.text ?? "", /Cannot attach a chain to run .*launched with requireLauncher/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(getActiveAsyncCapacitySnapshot("required-resume-session", 4).used, capacityBefore);
		assert.equal(fs.readdirSync(ASYNC_DIR).length, runsBefore, "the refused resumes created no run");

		mockPi.onCall({ output: "resumed run" });
		const resumed = await resume([agent]);
		assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
		const revivedId = resumed.details.asyncId!;
		assert.equal((await readAsyncPayload(revivedId)).success, true);
		// The revived run keeps the requirement, so its own resume checks it too.
		assert.deepEqual(JSON.parse(fs.readFileSync(recoveryDescriptorPath(ASYNC_DIR, revivedId), "utf-8")).requiredLauncher, requireLauncher);
		const revivedEdited = await resume([makeAgent("sandboxed", { launcher: "wrap", systemPrompt: "edited after approval" })], {}, revivedId);
		assert.equal(revivedEdited.isError, true);
		assert.match(revivedEdited.content[0]?.text ?? "", /agent 'sandboxed' now has digest [0-9a-f]{64}\./);
	});
});
