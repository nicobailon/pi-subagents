import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createWatchdogPermissionArbiter } from "../../src/watchdog/permission-arbiter.ts";

function model(): Model<any> {
	return { id: "watchdog", name: "watchdog", api: "faux", provider: "test", baseUrl: "https://example.invalid", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096 };
}

function ctx(current = model()) {
	return {
		cwd: "/tmp/watchdog-permission",
		model: current,
		signal: undefined,
		modelRegistry: {
			getAvailable: () => [current],
			find: (provider: string, id: string) => provider === current.provider && id === current.id ? current : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			getRegisteredProviderConfig: () => undefined,
		},
	} as never;
}

function responseStream(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
	return stream;
}

function stream(decision: "approve" | "deny", reason: string): StreamFn {
	const responses = [
		fauxAssistantMessage(fauxToolCall("watchdog_permission_decision", { decision, reason }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	];
	return () => responseStream(responses.shift()!);
}

const childConfig = JSON.stringify({
	enabled: true,
	watchdogTailTimeoutMs: 1_000,
	agentEndTimeoutMs: 1_000,
	maxWarnings: null,
	lsp: { enabled: false, timeoutMs: 100, maxFiles: 1, maxDiagnostics: 1 },
	autoFollowBlockers: false,
	autoFollowMaxAttempts: null,
	stalemateRepeats: 2,
});

describe("watchdog permission arbiter", () => {
	it("approves and denies exact calls through the watchdog model decision tool", async () => {
		const approved = await createWatchdogPermissionArbiter({ streamFn: stream("approve", "safe output path") })({ ctx: ctx(), toolName: "write", args: { path: "out.txt" }, rawWatchdogConfig: childConfig });
		assert.deepEqual(approved, { approved: true, reason: "safe output path", source: "watchdog" });

		const denied = await createWatchdogPermissionArbiter({ streamFn: stream("deny", "path is outside scope") })({ ctx: ctx(), toolName: "write", args: { path: "/etc/hosts" }, rawWatchdogConfig: childConfig });
		assert.deepEqual(denied, { approved: false, reason: "path is outside scope", source: "watchdog" });
	});

	it("fails closed when the child watchdog is unavailable and audits redacted decisions", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-permission-"));
		try {
			const auditPath = path.join(dir, "audit.jsonl");
			const result = await createWatchdogPermissionArbiter()({ ctx: ctx(), toolName: "write", args: { token: "secret-value", path: "out.txt" }, auditPath });
			assert.equal(result.approved, false);
			assert.match(result.reason, /disabled/);
			const records = fs.readFileSync(auditPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
			assert.equal(records.length, 2);
			assert.equal(records[0]?.decisionSource, "watchdog");
			assert.equal(records[1]?.decision, "unavailable");
			assert.doesNotMatch(String(records[0]?.preview), /secret-value/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
