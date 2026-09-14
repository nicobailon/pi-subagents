import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerMainWatchdog } from "../../src/watchdog/register-main.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "../../src/watchdog/runtime.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/watchdog/settings.ts";
import type { ResolvedWatchdogConfig, WatchdogSettingsResult } from "../../src/watchdog/types.ts";

function enabledConfig(): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		enabled: true,
		clarification: true,
		main: { ...DEFAULT_WATCHDOG_CONFIG.main, enabled: true },
		lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: false },
	};
}

function configResult(config: ResolvedWatchdogConfig): WatchdogSettingsResult {
	return { ok: true, config, errors: [], sources: [] };
}

function activityTurn(text: string) {
	return {
		type: "turn_end",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "activity-call", name: "subagent", arguments: { action: "status", id: "run" } }],
		},
		toolResults: [{ role: "toolResult", toolCallId: "activity-call", toolName: "subagent", content: [{ type: "text", text }], isError: false }],
	};
}

function createHarness(review: WatchdogReviewFunction) {
	const handlers = new Map<string, Array<(event: any, ctx: { cwd: string }) => void | Promise<void>>>();
	const api = {
		on(name: string, handler: (event: any, ctx: { cwd: string }) => void | Promise<void>) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		sendMessage() {},
		appendEntry() {},
		getThinkingLevel() { return "off"; },
	};
	const runtime = new MainWatchdogRuntime({
		cwd: process.cwd(),
		resolveConfig: () => configResult(enabledConfig()),
		reviewChangesOnly: false,
		displayClarification: () => {},
		review,
	});
	// SAFETY: registerMainWatchdog only calls the seven ExtensionAPI methods stubbed above.
	registerMainWatchdog(api as never, { runtime });
	const ctx = { cwd: process.cwd() };
	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { runtime, emit };
}

describe("watchdog compaction scope", () => {
	it("preserves user scope while clearing transient activity", async () => {
		const requests: Parameters<WatchdogReviewFunction>[0][] = [];
		const { runtime, emit } = createHarness((request) => {
			requests.push(request);
			return { stopReason: "stop" };
		});
		try {
			await emit("session_start", { reason: "startup" });
			await emit("before_agent_start", { prompt: "Implement the authorized routing change." });
			await emit("turn_end", activityTurn("Old transient activity"));
			await emit("session_compact", { reason: "threshold" });
			await emit("before_agent_start", { prompt: "Continue the implementation." });
			await emit("turn_end", { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Updated code." }] }, toolResults: [] });
			await emit("agent_end");

			assert.equal(requests.length, 1);
			assert.match(requests[0]!.delta, /Implement the authorized routing change\./);
			assert.match(requests[0]!.delta, /Continue the implementation\./);
			assert.doesNotMatch(requests[0]!.delta, /Old transient activity/);

			await emit("session_before_switch", { reason: "new" });
			await emit("before_agent_start", { prompt: "Start unrelated work." });
			await emit("turn_end", { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "New work." }] }, toolResults: [] });
			await emit("agent_end");
			assert.doesNotMatch(requests[1]!.delta, /authorized routing change/);
		} finally {
			runtime.dispose();
		}
	});
});
