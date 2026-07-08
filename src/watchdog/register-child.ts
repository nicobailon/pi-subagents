import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MainWatchdogRuntime } from "./runtime.ts";
import { createMainWatchdogReview } from "./review.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "./settings.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";
import {
	CHILD_WATCHDOG_CONFIG_ENV,
	CHILD_WATCHDOG_STATUS_EVENT,
	decodeChildWatchdogConfig,
	type ChildWatchdogConfig,
	type ChildWatchdogPhase,
} from "./child-status.ts";
import type { ResolvedWatchdogConfig, WatchdogWarningDetails } from "./types.ts";

function childResolvedConfig(config: ChildWatchdogConfig): ResolvedWatchdogConfig {
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
		autoFollow: {
			blockers: config.autoFollowBlockers,
			maxAttempts: config.autoFollowMaxAttempts,
			stalemateRepeats: config.stalemateRepeats,
		},
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

function writeStatus(event: unknown): void {
	try {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Child watchdog status is advisory; stdout failures are handled by the child process itself.
	}
}

export function registerChildWatchdog(pi: ExtensionAPI, rawConfig = process.env[CHILD_WATCHDOG_CONFIG_ENV]): MainWatchdogRuntime | undefined {
	const childConfig = decodeChildWatchdogConfig(rawConfig);
	if (!childConfig?.enabled) return undefined;
	let currentContext: ExtensionContext | undefined;
	let seq = 0;
	const emitStatus = (phase: ChildWatchdogPhase, followUpPending = false, reason?: string): void => {
		writeStatus({
			type: CHILD_WATCHDOG_STATUS_EVENT,
			...(childConfig.runId ? { runId: childConfig.runId } : {}),
			...(childConfig.agent ? { agent: childConfig.agent } : {}),
			...(childConfig.childIndex !== undefined ? { childIndex: childConfig.childIndex, stepIndex: childConfig.childIndex } : {}),
			seq: ++seq,
			phase,
			ts: Date.now(),
			followUpPending,
			...(reason ? { reason } : {}),
		});
	};
	const resolved = childResolvedConfig(childConfig);
	const runtime = new MainWatchdogRuntime({
		resolveConfig: () => ({ ok: true, config: resolved, errors: [], sources: [{ scope: "session", exists: true }] }),
		review: createMainWatchdogReview(() => currentContext, { getThinkingLevel: () => pi.getThinkingLevel() }),
		reviewDescription: "child model review",
		reviewChangesOnly: true,
		displayWarning: (details) => {
			const childDetails = childWarningDetails(details, childConfig);
			pi.sendMessage(createWatchdogWarningMessage(childDetails, { display: true, details: childDetails }));
		},
	});
	const rememberContext = (ctx: ExtensionContext) => {
		currentContext = ctx;
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", (_event, ctx) => {
		rememberContext(ctx);
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
	onRuntimeEvent("agent_end", async (event, ctx) => {
		rememberContext(ctx);
		emitStatus("reviewing");
		await runtime.handleAgentEnd(event, ctx);
		const snapshot = runtime.getSnapshot(ctx.cwd);
		if (snapshot.status === "failed") emitStatus("failed", false, snapshot.lastError);
		else if (snapshot.status === "stale") emitStatus("stale", false, "review stale");
		else emitStatus("idle");
	});
	onRuntimeEvent("session_shutdown", () => {
		currentContext = undefined;
		runtime.dispose();
		emitStatus("idle");
	});
	return runtime;
}
