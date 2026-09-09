import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { installAsyncExecutionHooks, available, createSubagentExecutor, mockPi, tempDir, createRepo, readAsyncPayload, ASYNC_DIR } from "../support/async-execution-fixture.ts";

function makeAdmissionExecutor(config: Record<string, unknown> = {}) {
	return createSubagentExecutor!({
		pi: { events: createEventBus(), getSessionName: () => undefined, sendMessage() {} },
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
		config,
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir,
		expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [makeAgent("worker")] }),
	});
}

function callCount(): number {
	return fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json")).length;
}

describe("public workflow worktree admission", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const async of [false, true]) {
		for (const source of ["nonrepo", "dirty"] as const) {
			it(`rejects a mixed ${source} group before child dispatch or budget claims (async=${async})`, async () => {
				const repo = createRepo("pi-admission-valid-");
				const invalid = source === "dirty" ? createRepo("pi-admission-dirty-") : tempDir;
				if (source === "dirty") fs.writeFileSync(path.join(invalid, "untracked.txt"), "dirty");
				try {
					const executor = makeAdmissionExecutor(source === "dirty" ? { worktree: true } : {});
					const output = path.join(tempDir, "child-output.md");
					const script = `const results = await runs.all([${JSON.stringify(repo)}, ${JSON.stringify(invalid)}].map((cwd, i) => ({ key: 'child-' + i, agent: 'worker', task: 'Inspect', cwd, output: i === 0 ? ${JSON.stringify(output)} : false }))); if (results.some(r => !r.ok)) throw new Error(results.map(r => r.error).join('; ')); return results;`;
					const result = await executor.executePublic(`admission-${source}-${async}`, { workflowScript: script, async, ...(source === "nonrepo" ? { isolation: "worktree" } : {}), maxSubagentSpawnsPerRun: 2, output: false }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
					let budget: unknown;
					if (async) {
						assert.ok(result.details?.asyncId);
						const payload = await readAsyncPayload(result.details.asyncId);
						assert.equal(payload.success, false);
						assert.match(payload.error ?? "", /Worktree admission failed.*child-1/);
						const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, result.details.asyncId, "status.json"), "utf8"));
						budget = status.runFanoutBudget;
						assert.ok(status.steps.every((step: { runId?: string }) => !step.runId));
					} else {
						assert.equal(result.isError, true);
						assert.match(result.content.map((item) => item.text).join("\n"), /Worktree admission failed.*child-1/);
						budget = (result.details as { runFanoutBudget?: unknown }).runFanoutBudget;
					}
					assert.deepEqual(budget, { used: 0, limit: 2, remaining: 2 });
					assert.equal(callCount(), 0);
					assert.equal(fs.existsSync(output), false);
				} finally {
					fs.rmSync(repo, { recursive: true, force: true });
					if (invalid !== tempDir) fs.rmSync(invalid, { recursive: true, force: true });
				}
			});
		}
	}
	it("launches a valid isolated child and preserves explicit false on a non-repository sibling", async () => {
		const repo = createRepo("pi-admission-clean-");
		mockPi.onCall({ output: "Inspected" });
		mockPi.onCall({ output: "Shared cwd inspected" });
		try {
			const executor = makeAdmissionExecutor({ worktreeProvider: "native", worktree: true });
			const result = await executor.executePublic("admission-clean", {
				workflowScript: `const results = await runs.all([{ key: 'isolated', agent: 'worker', task: 'Inspect', cwd: ${JSON.stringify(repo)}, async: false }, { key: 'shared', agent: 'worker', task: 'Inspect shared', worktree: false, async: false }]); return results.map(r => r.ok);`,
				async: false, worktree: true, output: false,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(callCount(), 2);
			assert.deepEqual((result.details as { workflow?: { value?: unknown } }).workflow?.value, [true, true]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
