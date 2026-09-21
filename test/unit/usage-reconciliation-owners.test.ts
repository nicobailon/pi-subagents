import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { buildRunnerChildLaunch } from "../../src/runs/background/runner-child-launch.ts";
import { toSubagentDelegationUpdate } from "../../src/slash/delegation-adapters.ts";
import { makeAgent } from "../support/helpers.ts";

const inherited = { role: "assistant", content: [{ type: "text", text: "old" }], timestamp: 1, usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100, cost: { total: 100 } } } as unknown as AgentMessage;
const liveMessage = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", model: "mock/test", usage: { input: 5, output: 3 } } as unknown as AgentMessage;
const persistedMessage = { ...liveMessage, timestamp: 2, usage: { input: 5, output: 3, cacheRead: 7, cacheWrite: 2, cost: { total: 0.4 } } } as unknown as AgentMessage;
const expected = { input: 5, output: 3, cacheRead: 7, cacheWrite: 2, cost: 0.4, turns: 1 };

function scriptedFactory(fail = false): ChildSessionFactory {
	return {
		async create() {
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			let terminal: readonly AgentMessage[] = [inherited];
			return {
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt() {
					for (const listener of listeners) listener({ type: "message_end", message: liveMessage } as ChildSessionEvent);
					terminal = [inherited, persistedMessage];
					if (fail) throw new Error("prompt failed after usage");
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
				get messages() { return terminal; },
				get sessionFile() { return undefined; },
				get sessionId() { return "usage-test"; },
				get modelId() { return "mock/test"; },
			} satisfies ChildSession;
		},
		async dispose() {},
	};
}

describe("terminal usage reconciliation owners", () => {
	it("reconciles foreground runSync usage before its terminal progress update", async () => {
		const updates: any[] = [];
		const result = await runSync(process.cwd(), [makeAgent("worker")], "worker", "test usage", {
			acceptance: false,
			childSessionFactory: scriptedFactory(),
			onUpdate(update) { updates.push(update.details); },
		});
		assert.deepEqual(result.usage, expected);
		const details = updates.at(-1)!;
		assert.deepEqual(details.results[0]!.usage, expected);
		assert.deepEqual({ tokens: details.progress[0]!.tokens, inputTokens: details.progress[0]!.inputTokens, outputTokens: details.progress[0]!.outputTokens, turnCount: details.progress[0]!.turnCount }, { tokens: 8, inputTokens: 5, outputTokens: 3, turnCount: 1 });
		assert.equal(details.progress[0]!.cacheRead, undefined);
		assert.equal(details.progress[0]!.cacheWrite, undefined);
		const update = toSubagentDelegationUpdate({ requestId: "usage-test", ownerRunId: "owner", nodeId: "node", agent: "worker", task: "test usage", context: "fresh", cwd: process.cwd(), result: { kind: "text" } }, { details });
		assert.equal(update?.usage, undefined);
	});

	it("reconciles background settlement after success and failure", async () => {
		for (const fail of [false, true]) {
			const launch = buildRunnerChildLaunch({ agent: "worker", task: "test usage", cwd: process.cwd(), inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false }, { cwd: process.cwd(), id: `usage-${fail}`, flatIndex: 0 }, { sessionEnabled: true, watchdogStatus() {} });
			const result = await runChildSession({ factory: scriptedFactory(fail), launch, prompt: "Task: test usage", appendChildEvent() {}, writeOutputLine() {} });
			assert.deepEqual(result.usage, expected);
			assert.equal(result.exitCode, fail ? 1 : 0);
			if (fail) assert.match(result.error ?? "", /prompt failed after usage/u);
		}
	});
});
