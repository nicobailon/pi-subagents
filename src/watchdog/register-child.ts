import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureWatchdogDiffBaseline, type WatchdogDiffBaseline } from "./diff-tool.ts";
import { MainWatchdogRuntime } from "./runtime.ts";
import { createMainWatchdogReview } from "./review.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "./settings.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";
import {
	CHILD_WATCHDOG_STATUS_EVENT,
	type ChildWatchdogConfig,
	type ChildWatchdogPhase,
	type ChildWatchdogStatusEvent,
} from "./child-status.ts";
import type { ResolvedWatchdogConfig, WatchdogWarningDetails } from "./types.ts";

export function childResolvedConfig(config: ChildWatchdogConfig): ResolvedWatchdogConfig {
	return {
		...DEFAULT_WATCHDOG_CONFIG,
		enabled: true,
		agentEndTimeoutMs: config.agentEndTimeoutMs,
		maxWarnings: config.maxWarnings,
		main: {
			enabled: true,
			...(config.model ? { model: config.model } : {}),
			...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
		},
		stalemateRepeats: config.stalemateRepeats,
		cadence: { ...config.cadence },
		children: {
			...DEFAULT_WATCHDOG_CONFIG.children,
			watchdogTailTimeoutMs: config.watchdogTailTimeoutMs,
		},
		lsp: { ...config.lsp },
	};
}

function childWarningDetails(details: WatchdogWarningDetails, config: ChildWatchdogConfig): WatchdogWarningDetails {
	return {
		...details,
		source: details.source === "lsp" ? "lsp" : "child",
		...(config.agent ? { agent: config.agent } : {}),
		...(config.runId ? { runId: config.runId } : {}),
	};
}

/**
 * Register the child-side watchdog. Status events go to the sink the hosting
 * process passed in the child runtime config; the host folds them into the
 * child's event stream.
 */
export function registerChildWatchdog(
	pi: ExtensionAPI,
	childConfig: ChildWatchdogConfig | undefined,
	writeStatus: ((event: ChildWatchdogStatusEvent) => void) | undefined,
): MainWatchdogRuntime | undefined {
	if (!childConfig) return undefined;
	if (!writeStatus) throw new Error("Child watchdog status sink is missing; the host must pass ChildRuntimeConfig.watchdogStatus.");
	let currentContext: ExtensionContext | undefined;
	let diffBaseline: WatchdogDiffBaseline | undefined;
	let seq = 0;
	const emitStatus = (phase: ChildWatchdogPhase, reason?: string): void => {
		writeStatus({
			type: CHILD_WATCHDOG_STATUS_EVENT,
			...(childConfig.runId ? { runId: childConfig.runId } : {}),
			...(childConfig.agent ? { agent: childConfig.agent } : {}),
			...(childConfig.childIndex !== undefined ? { childIndex: childConfig.childIndex, stepIndex: childConfig.childIndex } : {}),
			seq: ++seq,
			phase,
			ts: Date.now(),
			...(reason ? { reason } : {}),
		});
	};
	const resolved = childResolvedConfig(childConfig);
	const runtime = new MainWatchdogRuntime({
		resolveConfig: () => ({ ok: true, config: resolved, errors: [], sources: [{ scope: "session", exists: true }] }),
		review: createMainWatchdogReview(() => currentContext, { getThinkingLevel: () => pi.getThinkingLevel(), diffBaseline: () => diffBaseline }),
		reviewDescription: "child model review",
		reviewChangesOnly: true,
		displayWarning: (details, options) => {
			const childDetails = childWarningDetails(details, childConfig);
			pi.sendMessage(createWatchdogWarningMessage(childDetails, { display: true, details: childDetails }), options);
		},
	});
	const rememberContext = (ctx: ExtensionContext) => {
		currentContext = ctx;
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", (_event, ctx) => {
		rememberContext(ctx);
		diffBaseline = captureWatchdogDiffBaseline(ctx.cwd);
		runtime.bindSession(ctx);
		emitStatus("idle");
	});
	onRuntimeEvent("before_agent_start", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleBeforeAgentStart(event, ctx);
	});
	onRuntimeEvent("turn_end", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleTurnEnd(event, ctx);
	});
	onRuntimeEvent("tool_result", (_event, ctx) => {
		rememberContext(ctx);
		runtime.handleToolResult(ctx);
	});
	onRuntimeEvent("agent_end", async (event, ctx) => {
		rememberContext(ctx);
		emitStatus("reviewing");
		await runtime.handleAgentEnd(event, ctx);
		const snapshot = runtime.getSnapshot(ctx.cwd);
		if (snapshot.status === "failed") emitStatus("failed", snapshot.lastError);
		else if (snapshot.status === "stale") emitStatus("stale", "review stale");
		else emitStatus("idle");
	});
	onRuntimeEvent("session_shutdown", () => {
		currentContext = undefined;
		runtime.dispose();
		emitStatus("idle");
	});
	return runtime;
}
