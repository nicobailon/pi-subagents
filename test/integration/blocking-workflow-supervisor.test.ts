import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createNativeSupervisorChannel, resolveSupervisorChannelDir } from "../../src/intercom/native-supervisor-channel.ts";
import { setChildSessionFactoryModule } from "../../src/runs/shared/child-session.ts";
import { ASYNC_DIR, SUBAGENT_ASYNC_STARTED_EVENT, type SubagentState } from "../../src/shared/types.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, createSubagentExecutor, installAsyncExecutionHooks, readAsyncPayload, tempDir } from "../support/async-execution-fixture.ts";

describe("supervisor asks in blocking workflows", { skip: !available }, () => {
	installAsyncExecutionHooks();
	for (const mode of ["blocking", "async", "explicit-async-child", "cancel"] as const) {
		it(`${mode}: preserves partial work and distinguishes an unreachable supervisor from a real reply`, { timeout: 30_000 }, async () => {
			setChildSessionFactoryModule(fileURLToPath(new URL("../support/asking-child-session-factory.ts", import.meta.url)));
			const bus = createEventBus();
			const ctx = makeMinimalCtx(tempDir);
			const owner = ctx.sessionManager.getSessionId();
			const state = {
				baseCwd: tempDir, currentSessionId: null, supervisorOwnerSessionId: owner,
				asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
				cleanupTimers: new Map(), lastUiContext: ctx, completionSeen: new Map(),
			} as SubagentState;
			const tools = new Map<string, { execute(id: string, params: unknown): Promise<unknown> }>();
			const notices: Array<{ details?: { requestId?: string } }> = [];
			const dirs = new Set<string>();
			const childIds: string[] = [];
			const pi = {
				events: bus, getSessionName: () => undefined,
				getAllTools: () => [...tools.keys()].map(name => ({ name })),
				registerTool: (tool: { name: string; execute(id: string, params: unknown): Promise<unknown> }) => tools.set(tool.name, tool),
				sendMessage: (message: { details?: { requestId?: string } }) => { notices.push(message); return false; },
			};
			const channel = createNativeSupervisorChannel(pi as never, state, { getChannelDirs: () => ({ dirs: [...dirs] }) });
			bus.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
				const launch = data as { id: string; mode?: string };
				if (launch.mode === "workflow") return;
				childIds.push(launch.id);
				dirs.add(resolveSupervisorChannelDir(launch.id, "worker", 0));
				channel.activateTransport();
			});
			const executor = createSubagentExecutor!({
				pi: pi as never, state, config: {}, asyncByDefault: true, tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => path.join(tempDir, "sessions"), expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});
			const controller = new AbortController();
			const expectedChildren = mode === "explicit-async-child" ? 1 : 2;
			if (mode !== "cancel") channel.start();
			try {
				const execution = executor.executePublic(`supervisor-${mode}`, {
					...(mode === "explicit-async-child"
						? { workflowScript: `return await runs.run("asker", { agent: "worker", task: "Ask before deciding", acceptance: false, output: false, async: true });` }
						: { workflow: "parallel", args: { tasks: [{ agent: "worker", task: "Ask before choosing approach A" }, { agent: "worker", task: "Ask before choosing approach B" }] } }),
					async: mode === "async", timeoutMs: 15_000, acceptance: false, output: false, mission: false,
				}, controller.signal, undefined, ctx);
				if (mode === "cancel") {
					const deadline = Date.now() + 10_000;
					while ((state.blockingWorkflowChildren?.size ?? 0) < expectedChildren && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
					assert.equal(state.blockingWorkflowChildren?.size, expectedChildren);
					controller.abort();
					assert.equal((await execution).isError, true);
					assert.equal(state.blockingWorkflowChildren?.size, 0, "abort must release every registration");
					// Let stopped runners finish their publications before removing the test directories.
					while (childIds.some(id => ["running", "queued"].includes(JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8")).state)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
					return;
				}
				const result = await execution;
				assert.notEqual(result.isError, true, JSON.stringify(result));
				assert.equal(state.blockingWorkflowChildren?.size ?? 0, 0, "blocking call must release its registrations");
				if (mode !== "blocking") {
					const deadline = Date.now() + 10_000;
					while (notices.filter(notice => notice.details?.requestId).length < expectedChildren && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
					const requests = notices.flatMap(notice => notice.details?.requestId ? [notice.details.requestId] : []);
					assert.equal(requests.length, expectedChildren, "a non-blocking parent can see every real question");
					for (const requestId of requests) await tools.get("subagent_supervisor")!.execute("reply", { action: "reply", replyTo: requestId, message: "Proceed with approach A" });
					await readAsyncPayload(mode === "async" ? result.details.asyncId! : childIds[0]!);
				}
				assert.equal(childIds.length, expectedChildren);
				for (const childId of childIds) {
					const report = JSON.parse(fs.readFileSync(path.join(tempDir, `${childId}-ask.json`), "utf8"));
					assert.notEqual(report.pid, process.pid, "exercise an actual separate runner process");
					assert.match(report.partial, /Verified finding/);
					if (mode === "blocking") {
						assert.match(report.error, /parent is blocked.*async:false.*async:true/s);
						assert.equal(report.reply, undefined, "a transport error must never be interpreted as supervisor approval");
						assert.deepEqual(notices, []);
						assert.match(JSON.stringify(result), /Partial results: Verified finding/);
						assert.doesNotMatch(JSON.stringify(result), /timed out/i);
					} else {
						assert.equal(report.error, undefined);
						assert.match(JSON.stringify(report.reply), /Proceed with approach A/);
					}
				}
				assert.equal(channel.pending.size, 0);
			} finally {
				controller.abort();
				channel.dispose();
				setChildSessionFactoryModule(fileURLToPath(new URL("../support/runner-child-session-factory.ts", import.meta.url)));
				for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
				for (const childId of childIds) fs.rmSync(path.join(ASYNC_DIR, childId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		});
	}
});
