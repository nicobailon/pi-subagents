import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import { SLASH_TEXT_RESULT_TYPE } from "../shared/types.ts";
import { recommendStrongWatchdogModel, resolveWatchdogModelInput, parseWatchdogThinkingInput } from "./model-selection.ts";
import { renderWatchdogWarning } from "./render.ts";
import { createMainWatchdogReview } from "./review.ts";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "./runtime.ts";
import { getWatchdogUserSettingsPath, writeUserWatchdogEnabled, writeWatchdogModelSettings } from "./settings.ts";
import {
	SUBAGENT_WATCHDOG_WARNING_TYPE,
	type WatchdogRuntimeStatus,
	type WatchdogWarning,
	type WatchdogWarningDetails,
} from "./types.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";

interface RegisterMainWatchdogOptions {
	runtime?: MainWatchdogRuntime;
	review?: WatchdogReviewFunction;
}

function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boolLabel(value: boolean): string {
	return value ? "on" : "off";
}

function statusLabel(status: WatchdogRuntimeStatus): string {
	return status.replaceAll("-", " ");
}

function sourceLine(source: { scope: string; path?: string; exists: boolean }): string {
	const location = source.path ? ` ${source.path}` : "";
	return `- ${source.scope}${location}: ${source.exists ? "found" : "not found"}`;
}

function currentSessionModelLine(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
	if (model && typeof model.provider === "string" && typeof model.id === "string") return `current session (${model.provider}/${model.id})`;
	return "current session (not configured)";
}

function mainThinkingLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const configuredModel = snapshot.config.main.model;
	const configuredThinking = snapshot.config.main.thinking;
	if (configuredModel) {
		const effective = resolveEffectiveThinking(configuredModel, configuredThinking);
		if (effective) return effective;
		return "off (default for explicit watchdog model)";
	}
	if (configuredThinking === false) return "off";
	if (configuredThinking !== undefined) return configuredThinking;
	const currentThinking = (ctx as { thinkingLevel?: unknown }).thinkingLevel;
	return typeof currentThinking === "string" ? `current session (${currentThinking})` : "current session";
}

function mainModelLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	if (snapshot.config.main.model) {
		const source = snapshot.sessionModelOverride?.model ? "session override" : "configured";
		return `Main model: ${splitKnownThinkingSuffix(snapshot.config.main.model).baseModel} (${source})`;
	}
	return `Main model: ${currentSessionModelLine(ctx)}`;
}

function childrenLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const children = snapshot.config.children;
	const model = children.model ? splitKnownThinkingSuffix(children.model).baseModel : "current child session";
	const thinking = children.thinking === undefined ? "current child session" : children.thinking === false ? "off" : children.thinking;
	const overrides = Object.entries(children.overrides);
	const overrideText = overrides.length
		? ` · overrides ${overrides.map(([agent, override]) => {
			const bits = [agent];
			if (override.enabled !== undefined) bits.push(boolLabel(override.enabled));
			if (override.model) bits.push(splitKnownThinkingSuffix(override.model).baseModel);
			if (override.thinking !== undefined) bits.push(`thinking ${override.thinking === false ? "off" : override.thinking}`);
			return bits.join(" ");
		}).join("; ")}`
		: "";
	return `Children: ${boolLabel(snapshot.config.enabled && children.enabled)} · model ${model} · thinking ${thinking}${overrideText}`;
}

function recommendationLine(ctx: ExtensionContext): string {
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		return `Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking} (${recommendation.label}, complementary reviewer)`;
	} catch (error) {
		return `Recommended strong watchdog: unavailable (${messageFromError(error)})`;
	}
}

function lspLine(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>): string {
	const lsp = snapshot.lsp;
	const provider = lsp.provider ? ` · ${lsp.provider}` : "";
	const counts = lsp.diagnosticCount > 0 || lsp.freshDiagnosticCount > 0
		? ` · ${lsp.freshDiagnosticCount} new/${lsp.diagnosticCount} total`
		: "";
	const message = lsp.message ? ` · ${lsp.message}` : "";
	return `LSP diagnostics: ${lsp.enabled ? "on" : "off"} · ${lsp.status}${provider}${counts}${message}`;
}

export function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string {
	const lines = [
		"Subagent watchdog",
		`Main: ${boolLabel(snapshot.enabled)}${!snapshot.config.enabled && snapshot.sessionOverride === undefined ? " (default off)" : ""}`,
		`Runtime: ${statusLabel(snapshot.status)}${snapshot.bufferedDeltas > 0 ? ` · buffered deltas ${snapshot.bufferedDeltas}` : ""}`,
		`Review trigger: ${snapshot.reviewTrigger === "repo-edits" ? "repo edits only" : "every non-empty turn delta"}`,
		lspLine(snapshot),
		`Session override: ${snapshot.sessionOverride === undefined ? "none" : boolLabel(snapshot.sessionOverride)}`,
		mainModelLine(snapshot, ctx),
		`Main thinking: ${mainThinkingLine(snapshot, ctx)}`,
		childrenLine(snapshot),
		recommendationLine(ctx),
		`Agent-end timeout: ${snapshot.config.agentEndTimeoutMs}ms`,
		`Auto-follow: not implemented${snapshot.autoFollowQueued ? " (queued)" : ""}`,
		`Review model call: ${snapshot.reviewDescription}`,
	];
	if (snapshot.failedReviews > 0) lines.push(`Failed reviews: ${snapshot.failedReviews}`);
	if (snapshot.staleReviews > 0) lines.push(`Stale reviews: ${snapshot.staleReviews}`);
	if (snapshot.changedPaths?.length) {
		lines.push(`Changed paths: ${snapshot.changedPaths.slice(0, 8).join(", ")}${snapshot.changedPaths.length > 8 ? `, +${snapshot.changedPaths.length - 8} more` : ""}`);
	}
	if (snapshot.lastWarning) {
		lines.push(`Last warning: ${snapshot.lastWarning.severity} · ${snapshot.lastWarning.state ?? "candidate"} · ${snapshot.lastWarning.summary}`);
	}
	if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`);
	if (!snapshot.configOk) {
		lines.push("", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`), "Watchdog is disabled until the config is fixed.");
	} else {
		lines.push("", "Config: ok");
	}
	lines.push(
		"Sources:",
		...snapshot.sources.map(sourceLine),
		"",
		"Model commands:",
		"- /subagents-watchdog recommend-model",
		"- /subagents-watchdog model recommended",
		"- /subagents-watchdog model <provider/model[:thinking]>",
		"- /subagents-watchdog model inherit",
		"- /subagents-watchdog session model recommended",
		"Agent action: subagent({ action: \"watchdog.configure\", model: \"recommended\", scope: \"session\" })",
	);
	return lines.join("\n");
}

function parseTestCommand(input: string): { severity: "concern" | "blocker"; text: string } | undefined {
	const match = input.match(/^test\s+(concern|blocker)\s+([\s\S]+)$/);
	if (!match) return undefined;
	return { severity: match[1] as "concern" | "blocker", text: match[2]!.trim() };
}

function formatThinking(value: ThinkingLevel | false | undefined): string {
	if (value === undefined) return "inherit";
	return value === false ? "off" : value;
}

function parseThinkingCommand(raw: string): ThinkingLevel | false | null {
	const value = raw.trim();
	if (value === "inherit") return null;
	return parseWatchdogThinkingInput(value, "/subagents-watchdog thinking") ?? null;
}

function resolveModelCommandValue(ctx: ExtensionCommandContext, raw: string): { model: string | null; thinking: ThinkingLevel | false | null; description: string } {
	const value = raw.trim();
	if (!value) throw new Error("Expected a model, 'recommended', or 'inherit'.");
	if (value === "inherit") return { model: null, thinking: null, description: "current session model and thinking" };
	if (value === "recommended") {
		const recommendation = recommendStrongWatchdogModel(ctx as ExtensionContext);
		return {
			model: recommendation.model,
			thinking: recommendation.thinking,
			description: `${recommendation.model}:${recommendation.thinking} (${recommendation.label})`,
		};
	}
	const resolved = resolveWatchdogModelInput(ctx as ExtensionContext, value);
	return {
		model: resolved.model,
		thinking: resolved.thinking,
		description: `${resolved.model}${resolved.thinking ? `:${resolved.thinking}` : ""}`,
	};
}

function buildRecommendationText(ctx: ExtensionCommandContext): string {
	const recommendation = recommendStrongWatchdogModel(ctx as ExtensionContext);
	return [
		"Subagent watchdog recommended model",
		`Current session: ${currentSessionModelLine(ctx as ExtensionContext)}`,
		`Recommended: ${recommendation.model}:${recommendation.thinking}`,
		`Reason: ${recommendation.reason}`,
		"",
		"Apply for this session:",
		"/subagents-watchdog session model recommended",
		"",
		"Save as your user default:",
		"/subagents-watchdog model recommended",
	].join("\n");
}

function buildCheckText(runtime: MainWatchdogRuntime, ctx: ExtensionCommandContext): string {
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) {
		return ["Subagent watchdog config check", "", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	}
	const lines = ["Subagent watchdog config check", "", "Config: ok"];
	if (snapshot.config.main.model) {
		const resolved = resolveWatchdogModelInput(ctx as ExtensionContext, snapshot.config.main.model);
		lines.push(`Main model: ${resolved.model} auth ok`);
	} else {
		lines.push(`Main model: ${currentSessionModelLine(ctx as ExtensionContext)}`);
	}
	lines.push(`Main thinking: ${mainThinkingLine(snapshot, ctx as ExtensionContext)}`);
	lines.push(lspLine(snapshot));
	try {
		const recommendation = recommendStrongWatchdogModel(ctx as ExtensionContext);
		lines.push(`Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking}`);
	} catch (error) {
		lines.push(`Recommended strong watchdog: unavailable (${messageFromError(error)})`);
	}
	return lines.join("\n");
}

function createTestWarning(severity: "concern" | "blocker", text: string): WatchdogWarning {
	return {
		severity,
		category: "other",
		confidence: "high",
		source: "main",
		state: "displayed",
		summary: text,
		evidence: `Manual /subagents-watchdog test ${severity} message from the main session.`,
		recommendedAction: severity === "blocker"
			? "Verify the renderer and transcript delivery; no automatic follow-up is queued in Gate 1B."
			: "Verify the renderer and transcript delivery; decide manually whether any action is needed.",
	};
}

async function handleWatchdogCommand(
	pi: ExtensionAPI,
	runtime: MainWatchdogRuntime,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const input = args.trim();
	if (!input || input === "status") {
		sendSlashText(pi, buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		return;
	}
	if (input === "recommend-model") {
		try {
			sendSlashText(pi, buildRecommendationText(ctx));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog recommended model\n\n${messageFromError(error)}`);
		}
		return;
	}
	if (input === "check") {
		try {
			sendSlashText(pi, buildCheckText(runtime, ctx));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog config check\n\n${messageFromError(error)}`);
		}
		return;
	}
	if (input === "on" || input === "off") {
		const enabled = input === "on";
		try {
			const settingsPath = writeUserWatchdogEnabled(enabled);
			const snapshot = runtime.getSnapshot(ctx.cwd);
			sendSlashText(pi, [
				`Subagent watchdog ${boolLabel(enabled)} saved to user settings.`,
				`Updated: ${settingsPath}`,
				`Main now: ${boolLabel(snapshot.enabled)}${snapshot.sessionOverride !== undefined ? ` (session override ${boolLabel(snapshot.sessionOverride)})` : ""}`,
			].join("\n"));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog\n\nCould not update ${getWatchdogUserSettingsPath()}: ${messageFromError(error)}`);
		}
		return;
	}
	if (input === "session on" || input === "session off") {
		const enabled = input.endsWith("on");
		const snapshot = runtime.setSessionEnabled(enabled, ctx.cwd);
		sendSlashText(pi, [
			`Subagent watchdog session override: ${boolLabel(enabled)}.`,
			"No settings files were changed.",
			"",
			buildWatchdogStatus(snapshot, ctx),
		].join("\n"));
		return;
	}
	if (input.startsWith("session model ")) {
		const rawModel = input.slice("session model ".length);
		try {
			const value = resolveModelCommandValue(ctx, rawModel);
			const snapshot = value.model === null
				? runtime.clearSessionModel(ctx.cwd)
				: runtime.setSessionModel({ model: value.model, thinking: value.thinking ?? null }, ctx.cwd);
			sendSlashText(pi, [
				`Subagent watchdog session model: ${value.description}.`,
				"No settings files were changed.",
				"",
				buildWatchdogStatus(snapshot, ctx),
			].join("\n"));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog session model\n\n${messageFromError(error)}`);
		}
		return;
	}
	if (input.startsWith("model ")) {
		const rawModel = input.slice("model ".length);
		try {
			const value = resolveModelCommandValue(ctx, rawModel);
			const settingsPath = writeWatchdogModelSettings({
				scope: "user",
				target: { kind: "main" },
				model: value.model,
				thinking: value.thinking,
			});
			runtime.refreshConfig(ctx.cwd);
			const snapshot = runtime.getSnapshot(ctx.cwd);
			sendSlashText(pi, [
				`Subagent watchdog model saved: ${value.description}.`,
				`Updated: ${settingsPath}`,
				`Main now: ${boolLabel(snapshot.enabled)}`,
				value.model === null ? "The watchdog now inherits the current session model and thinking." : "Run /subagents-watchdog on if the watchdog is still off.",
				"",
				buildWatchdogStatus(snapshot, ctx),
			].join("\n"));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog model\n\n${messageFromError(error)}\nNo settings files were changed.`);
		}
		return;
	}
	if (input.startsWith("thinking ")) {
		const rawThinking = input.slice("thinking ".length);
		try {
			const thinking = parseThinkingCommand(rawThinking);
			const settingsPath = writeWatchdogModelSettings({
				scope: "user",
				target: { kind: "main" },
				thinking,
			});
			runtime.refreshConfig(ctx.cwd);
			sendSlashText(pi, [
				`Subagent watchdog thinking saved: ${formatThinking(thinking ?? undefined)}.`,
				`Updated: ${settingsPath}`,
				"",
				buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx),
			].join("\n"));
		} catch (error) {
			sendSlashText(pi, `Subagent watchdog thinking\n\n${messageFromError(error)}\nNo settings files were changed.`);
		}
		return;
	}
	const test = parseTestCommand(input);
	if (test) {
		if (!test.text) {
			ctx.ui.notify("Usage: /subagents-watchdog test concern|blocker <text>", "error");
			return;
		}
		const warning = createTestWarning(test.severity, test.text);
		const details = runtime.recordDisplayedWarning(warning);
		pi.sendMessage(createWatchdogWarningMessage(details, { display: true, details }));
		return;
	}
	ctx.ui.notify(`Usage: /subagents-watchdog [status|on|off|session on|session off|recommend-model|model recommended|model <provider/model[:thinking]>|model inherit|thinking ${THINKING_LEVELS.join("|")}|thinking inherit|session model recommended|check|test concern <text>|test blocker <text>]`, "error");
}

export function registerMainWatchdog(pi: ExtensionAPI, options: RegisterMainWatchdogOptions = {}): MainWatchdogRuntime {
	let currentContext: ExtensionContext | undefined;
	const rememberContext = (ctx: ExtensionContext) => {
		currentContext = ctx;
	};
	const runtime = options.runtime ?? new MainWatchdogRuntime({
		review: options.review ?? createMainWatchdogReview(() => currentContext, { getThinkingLevel: () => pi.getThinkingLevel() }),
		reviewDescription: options.review ? "injected seam" : "real model review",
		reviewChangesOnly: true,
		displayWarning: (details) => {
			pi.sendMessage(createWatchdogWarningMessage(details, { display: true, details }));
		},
	});

	pi.registerMessageRenderer<WatchdogWarningDetails>(SUBAGENT_WATCHDOG_WARNING_TYPE, (message, renderOptions, theme) => {
		const details = message.details as WatchdogWarningDetails | undefined;
		if (!details?.summary || !details.evidence || !details.recommendedAction) {
			const content = typeof message.content === "string"
				? message.content
				: message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
			return new Text(content, 0, 0);
		}
		return renderWatchdogWarning(details, renderOptions, theme);
	});

	pi.registerCommand("subagents-watchdog", {
		description: "Show or toggle the default-off subagent watchdog",
		handler: (args, ctx) => {
			rememberContext(ctx);
			return handleWatchdogCommand(pi, runtime, args, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		rememberContext(ctx);
		runtime.bindSession(ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleBeforeAgentStart(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		rememberContext(ctx);
		runtime.handleTurnEnd(event, ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		rememberContext(ctx);
		return runtime.handleAgentEnd(event, ctx);
	});
	pi.on("session_before_switch", () => runtime.reset("session switch", { clearReviewInputSignature: true, clearLspLedger: true }));
	pi.on("session_before_fork", () => runtime.reset("session fork", { clearReviewInputSignature: true, clearLspLedger: true }));
	pi.on("session_compact", () => runtime.reset("session compact"));
	pi.on("session_shutdown", () => {
		currentContext = undefined;
		runtime.dispose();
	});

	return runtime;
}
