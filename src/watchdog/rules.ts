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

/** Deterministic launch rules, read from settings at launch time. Undefined when none are configured. */
export function loadWatchdogLaunchRules(cwd: string): WatchdogRulesConfig | undefined {
	const result = resolveWatchdogConfig(cwd);
	return result.ok ? result.config.rules : undefined;
}

export function countWatchdogRules(rules: WatchdogRulesConfig | undefined): number {
	return rules ? Object.keys(rules.roleModels).length : 0;
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

/** Role model allow/deny check for one launch. Deny wins; an unknown model cannot be judged. */
export function evaluateLaunchRules(rules: WatchdogRulesConfig | undefined, input: { agent: string; model?: string }): WatchdogRuleViolation[] {
	const roleRule = rules?.roleModels[input.agent];
	if (!roleRule || !input.model) return [];
	const note = roleRule.note ? ` ${roleRule.note}` : "";
	const denied = roleRule.deny?.length ? modelMatches(roleRule.deny, input.model) : undefined;
	if (denied !== undefined) {
		return [{
			agent: input.agent,
			summary: `Agent '${input.agent}' was launched with denied model '${input.model}'.`,
			evidence: `subagents.watchdog.rules.roleModels.${input.agent}.deny matches '${denied}'.${note}`,
			recommendedAction: roleRule.allow?.length ? `Use one of: ${roleRule.allow.join(", ")}.` : "Choose a different model for this role.",
		}];
	}
	if (roleRule.allow?.length && modelMatches(roleRule.allow, input.model) === undefined) {
		return [{
			agent: input.agent,
			summary: `Agent '${input.agent}' was launched with model '${input.model}', which is not in its allowed list.`,
			evidence: `subagents.watchdog.rules.roleModels.${input.agent}.allow is [${roleRule.allow.join(", ")}].${note}`,
			recommendedAction: `Use one of: ${roleRule.allow.join(", ")}.`,
		}];
	}
	return [];
}

export function ruleViolationWarning(violation: WatchdogRuleViolation): WatchdogWarning {
	return {
		severity: "concern",
		category: "missed-constraint",
		confidence: "high",
		source: "main",
		agent: violation.agent,
		summary: violation.summary,
		evidence: violation.evidence,
		recommendedAction: violation.recommendedAction,
	};
}

/** Fallback display when no main watchdog runtime is available to the caller. */
export function sendRuleViolationWarning(pi: { sendMessage?: (message: unknown, options?: unknown) => unknown } | undefined, violation: WatchdogRuleViolation): void {
	if (typeof pi?.sendMessage !== "function") return;
	const warning = ruleViolationWarning(violation);
	pi.sendMessage(createWatchdogWarningMessage(warning, { display: true, details: { state: "displayed", displayedAt: new Date().toISOString() } }));
}
