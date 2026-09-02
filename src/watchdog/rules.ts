import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { splitKnownThinkingSuffix } from "../shared/model-info.ts";
import { resolveWatchdogConfig } from "./settings.ts";
import type { WatchdogRulesConfig, WatchdogWarning } from "./types.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";

export interface WatchdogRuleViolation {
	agent: string;
	summary: string;
	evidence: string;
	recommendedAction: string;
}

function loadWatchdogLaunchRules(cwd: string): WatchdogRulesConfig | undefined {
	const result = resolveWatchdogConfig(cwd);
	return result.ok ? result.config.rules : undefined;
}

/** `*` matches any run of characters, `?` one character; anchored, case-sensitive. */
export function watchdogGlobMatch(pattern: string, value: string): boolean {
	const source = pattern.split("").map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
	return new RegExp(`^${source}$`).test(value);
}

function modelMatches(patterns: string[], model: string): string | undefined {
	const base = splitKnownThinkingSuffix(model).baseModel;
	return patterns.find((pattern) => watchdogGlobMatch(pattern, model) || watchdogGlobMatch(pattern, base));
}

/** Deny wins over allow; an unknown model cannot be judged. */
export function evaluateLaunchRule(rules: WatchdogRulesConfig | undefined, agent: string, model: string | undefined): WatchdogRuleViolation | undefined {
	const roleRule = rules?.roleModels[agent];
	if (!roleRule || !model) return undefined;
	const note = roleRule.note ? ` ${roleRule.note}` : "";
	const denied = roleRule.deny?.length ? modelMatches(roleRule.deny, model) : undefined;
	if (denied !== undefined) {
		return {
			agent,
			summary: `Agent '${agent}' was launched with denied model '${model}'.`,
			evidence: `subagents.watchdog.rules.roleModels.${agent}.deny matches '${denied}'.${note}`,
			recommendedAction: roleRule.allow?.length ? `Use one of: ${roleRule.allow.join(", ")}.` : "Choose a different model for this role.",
		};
	}
	if (!roleRule.allow?.length || modelMatches(roleRule.allow, model) !== undefined) return undefined;
	return {
		agent,
		summary: `Agent '${agent}' was launched with model '${model}', which is not in its allowed list.`,
		evidence: `subagents.watchdog.rules.roleModels.${agent}.allow is [${roleRule.allow.join(", ")}].${note}`,
		recommendedAction: `Use one of: ${roleRule.allow.join(", ")}.`,
	};
}

export function ruleViolationWarning(violation: WatchdogRuleViolation): WatchdogWarning {
	return { severity: "concern", category: "missed-constraint", confidence: "high", source: "main", ...violation };
}

export function applyWatchdogLaunchRules(input: { cwd: string; agent: string; model?: string; warn?: (violation: WatchdogRuleViolation) => void }): string | undefined {
	const rules = loadWatchdogLaunchRules(input.cwd);
	const violation = evaluateLaunchRule(rules, input.agent, input.model);
	if (!violation) return undefined;
	if (rules?.action === "block") return `Launch blocked by subagents.watchdog.rules: ${violation.summary}`;
	input.warn?.(violation);
	return undefined;
}

/** For launch paths without a main watchdog runtime (background chain steps). */
export function sendRuleViolationWarning(pi: Pick<ExtensionAPI, "sendMessage">, violation: WatchdogRuleViolation): void {
	const warning = ruleViolationWarning(violation);
	pi.sendMessage(createWatchdogWarningMessage(warning, { display: true, details: { state: "displayed", displayedAt: new Date().toISOString() } }), { deliverAs: "steer" });
}
