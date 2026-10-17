import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { PI_CODING_AGENT_PACKAGE } from "../../src/runs/shared/pi-spawn.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

for (const source of ["override", "host dependency"] as const) {
	test(`executor doctor/status remain available with a broken ${source}`, (t) => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-executor-discovery-"));
		t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
		const host = path.join(tmp, "host");
		fs.mkdirSync(host);
		fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "embedded-host" }));
		const entry = path.join(host, "sessiond.mjs");
		fs.writeFileSync(entry, "throw new Error('host entry must not execute');\n");
		const dependency = path.join(host, "node_modules", PI_CODING_AGENT_PACKAGE);
		fs.mkdirSync(dependency, { recursive: true });
		fs.writeFileSync(path.join(dependency, "package.json"), source === "host dependency"
			? "{" : JSON.stringify({ name: PI_CODING_AGENT_PACKAGE }));
		const env = {
			...process.env,
			HOME: path.join(tmp, "home"), USERPROFILE: path.join(tmp, "home"),
			PI_SUBAGENTS_TEMP_ROOT: path.join(tmp, "runs"),
			[PI_CODING_AGENT_PACKAGE_ROOT_ENV]: source === "override" ? path.join(tmp, "absent-override") : "",
		};
		// Each case needs a fresh static dependency graph, not just a cache-busted executor URL.
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import childProcess from "node:child_process";
			import { syncBuiltinESMExports } from "node:module";
			process.argv[1] = ${JSON.stringify(entry)};
			let spawnCalls = 0;
			childProcess.spawn = () => { spawnCalls++; throw new Error("unexpected spawn"); };
			syncBuiltinESMExports();
			const executorPromise = import(${JSON.stringify(new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url).href)});
			await assert.doesNotReject(executorPromise);
			const { createSubagentExecutor } = await executorPromise;
			const { createEventBus, makeMinimalCtx, makeAgent } = await import(${JSON.stringify(new URL("../support/helpers.ts", import.meta.url).href)});
			const cwd = ${JSON.stringify(tmp)};
			const state = {
				baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(),
				foregroundControls: new Map([["visible-run", { runId: "visible-run", mode: "single", startedAt: 1, updatedAt: 1 }]]),
				lastForegroundControlId: "visible-run", pendingForegroundControlNotices: new Map(),
				cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(),
				watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} },
			};
			const pi = { events: createEventBus(), getSessionName: () => undefined };
			const executor = createSubagentExecutor({
				pi, state, config: {}, asyncByDefault: false, tempArtifactsDir: cwd,
				getSubagentSessionRoot: () => cwd, expandTilde: (value) => value,
				discoverAgents: () => ({ agents: [] }),
			});
			const ctx = makeMinimalCtx(cwd);
			async function checkManagement() {
				const doctor = await executor.execute("doctor", { action: "doctor" }, undefined, undefined, ctx);
				assert.equal(doctor.isError, undefined);
				assert.match(doctor.content[0].text, /^Subagents doctor report/);
				const status = await executor.execute("status", { action: "status" }, undefined, undefined, ctx);
				assert.equal(status.isError, undefined);
				assert.match(status.content[0].text, /Run: visible-run/);
				assert.match(status.content[0].text, /State: running/);
			}
			await checkManagement();
			const { executeAsyncSingle } = await import(${JSON.stringify(new URL("../../src/runs/background/async-execution.ts", import.meta.url).href)});
			const launch = await executeAsyncSingle("invalid-sdk", {
				agent: "worker", task: "Check discovery", agentConfig: makeAgent("worker"),
				ctx: { pi, cwd, currentSessionId: "session-123" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: cwd, maxSubagentDepth: 1, acceptance: false,
			});
			assert.equal(launch.isError, true);
			assert.match(launch.content[0].text, ${source === "override" ? "/ENOENT/" : "/malformed JSON/"});
			assert.equal(spawnCalls, 0);
			assert.strictEqual(await executorPromise, await import(${JSON.stringify(new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url).href)}));
			await checkManagement();
			console.log("management available before and after failed launch; no spawn");
		`], { cwd: tmp, env, encoding: "utf8", timeout: 30_000 });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
		assert.match(result.stdout, /management available before and after failed launch; no spawn/);
	});
}
