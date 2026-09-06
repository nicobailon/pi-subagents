import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import type { Details } from "../shared/types.ts";
import { buildWatchdogStatus } from "./register-main.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";
import { parseWatchdogThinkingInput, recommendStrongWatchdogModel, resolveWatchdogModelInput } from "./model-selection.ts";
import { writeWatchdogModelSettings, type WatchdogModelSettingsTarget, type WatchdogSettingsWriteScope } from "./settings.ts";

interface WatchdogToolParams {
	action?: string;
	scope?: string;
	target?: string;
	agent?: string;
	model?: string;
	thinking?: string | false;
	cwd?: string;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseScope(raw: string | undefined): "session" | WatchdogSettingsWriteScope {
	if (raw === undefined || raw === "session") return "session";
	if (raw === "user" || raw === "project") return raw;
	throw new Error("watchdog.configure scope must be 'session', 'user', or 'project'.");
}

function parseTarget(params: WatchdogToolParams): WatchdogModelSettingsTarget {
	const target = params.target ?? "main";
	if (target === "main") return { kind: "main" };
	if (target === "children") return { kind: "children" };
	if (target === "child") {
		if (!params.agent?.trim()) throw new Error("watchdog.configure target='child' requires agent.");
		return { kind: "child", agent: params.agent.trim() };
	}
	throw new Error("watchdog.configure target must be 'main', 'children', or 'child'.");
}

function parseThinking(raw: string | false | undefined): ThinkingLevel | false | null | undefined {
	if (raw === undefined) return undefined;
	if (raw === "inherit") return null;
	return parseWatchdogThinkingInput(raw, "watchdog.configure thinking") ?? undefined;
}

function resolveConfiguredValue(ctx: ExtensionContext, params: WatchdogToolParams): { model?: string | null; thinking?: ThinkingLevel | false | null; description: string } {
	const thinking = parseThinking(params.thinking);
	const rawModel = params.model?.trim();
	if (!rawModel) {
		if (thinking === undefined) throw new Error("watchdog.configure requires model, thinking, or both.");
		return { thinking, description: `thinking ${thinking === null ? "inherit" : thinking === false ? "off" : thinking}` };
	}
	if (rawModel === "inherit") return { model: null, thinking: thinking ?? null, description: "inherit" };
	if (rawModel === "recommended") {
		const recommendation = recommendStrongWatchdogModel(ctx);
		return {
			model: recommendation.model,
			thinking: recommendation.thinking,
			description: `${recommendation.model}:${recommendation.thinking}`,
		};
	}
	const resolved = resolveWatchdogModelInput(ctx, rawModel);
	return {
		model: resolved.model,
		thinking: resolved.thinking ?? thinking,
		description: `${resolved.model}${resolved.thinking ?? thinking ? `:${resolved.thinking ?? thinking}` : ""}`,
	};
}

function buildRecommendationText(ctx: ExtensionContext): string {
	const recommendation = recommendStrongWatchdogModel(ctx);
	return [
		"Subagent watchdog recommended model",
		`Recommended: ${recommendation.model}:${recommendation.thinking}`,
		`Reason: ${recommendation.reason}`,
		"Apply temporarily with subagent({ action: \"watchdog.configure\", scope: \"session\", model: \"recommended\" }).",
		"Persist with scope: \"project\" or scope: \"user\" only when the user asks for that scope.",
	].join("\n");
}

function buildCheckText(runtime: MainWatchdogRuntime | undefined, ctx: ExtensionContext): string {
	if (!runtime) return "Subagent watchdog runtime is unavailable.";
	const snapshot = runtime.getSnapshot(ctx.cwd);
	if (!snapshot.configOk) return ["Subagent watchdog config check", "Config errors:", ...snapshot.errors.map((error) => `- ${error.message}`)].join("\n");
	const lines = ["Subagent watchdog config check", "Config: ok"];
	if (snapshot.config.main.model) {
		const resolved = resolveWatchdogModelInput(ctx, snapshot.config.main.model);
		lines.push(`Main model: ${resolved.model} auth ok`);
	} else {
		lines.push("Main model: current session");
	}
	lines.push(`LSP diagnostics: ${snapshot.lsp.enabled ? "on" : "off"} · ${snapshot.lsp.status}`);
	try {
		const recommendation = recommendStrongWatchdogModel(ctx);
		lines.push(`Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking}`);
	} catch (error) {
		lines.push(`Recommended strong watchdog unavailable: ${messageFromError(error)}`);
	}
	return lines.join("\n");
}

export function handleWatchdogToolAction(action: string, params: WatchdogToolParams, ctx: ExtensionContext, runtime?: MainWatchdogRuntime): AgentToolResult<Details> {
	try {
		if (action === "watchdog.status") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			return result(buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx));
		}
		if (action === "watchdog.recommend-model") return result(buildRecommendationText(ctx));
		if (action === "watchdog.check") return result(buildCheckText(runtime, ctx));
		if (action !== "watchdog.configure") return result(`Unknown watchdog action: ${action}`, true);

		const scope = parseScope(params.scope);
		const target = parseTarget(params);
		const value = resolveConfiguredValue(ctx, params);
		if (scope === "session") {
			if (!runtime) return result("Subagent watchdog runtime is unavailable.", true);
			if (target.kind !== "main") return result("Session-scoped watchdog.configure currently supports target='main' only.", true);
			runtime.setSessionModel({ model: value.model, thinking: value.thinking }, ctx.cwd);
			return result([
				`Subagent watchdog session model configured: ${value.description}.`,
				"No settings files were changed.",
				"",
				buildWatchdogStatus(runtime.getSnapshot(ctx.cwd), ctx),
			].join("\n"));
		}

		const settingsPath = writeWatchdogModelSettings({
			scope,
			cwd: ctx.cwd,
			target,
			model: value.model,
			thinking: value.thinking,
		});
		runtime?.refreshConfig(ctx.cwd);
		const targetLabel = target.kind === "child" ? `child ${target.agent}` : target.kind;
		return result([
			`Subagent watchdog ${targetLabel} model configured: ${value.description}.`,
			`Updated: ${settingsPath}`,
		].join("\n"));
	} catch (error) {
		return result(`Subagent watchdog action failed: ${messageFromError(error)}`, true);
	}
}

export const WATCHDOG_TOOL_ACTIONS = ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"] as const;
export const WATCHDOG_THINKING_VALUES = ["inherit", ...THINKING_LEVELS] as const;
