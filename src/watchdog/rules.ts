import { splitKnownThinkingSuffix } from "../shared/model-info.ts";
import { resolveWatchdogConfig } from "./settings.ts";
import type { WatchdogRulesConfig, WatchdogWarning } from "./types.ts";
import { createWatchdogWarningMessage } from "./warning-format.ts";

export type WatchdogRuleKind = "roleModels" | "minStages" | "forbidAfterLaunch";

export interface WatchdogRuleViolation {
	rule: WatchdogRuleKind;
	agent?: string;
	summary: string;
	evidence: string;
	recommendedAction: string;
}

/** Deterministic launch-shape rules, read from settings at launch time. Undefined when none are configured. */
export function loadWatchdogLaunchRules(cwd: string): WatchdogRulesConfig | undefined {
	const result = resolveWatchdogConfig(cwd);
	return result.ok ? result.config.rules : undefined;
}

export function countWatchdogRules(rules: WatchdogRulesConfig | undefined): number {
	if (!rules) return 0;
	return Object.keys(rules.roleModels).length + Object.keys(rules.minStages).length + rules.forbidAfterLaunch.length;
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

export function evaluateLaunchRules(rules: WatchdogRulesConfig | undefined, input: { agent: string; model?: string; stageCount?: number }): WatchdogRuleViolation[] {
	if (!rules) return [];
	const violations: WatchdogRuleViolation[] = [];
	const roleRule = rules.roleModels[input.agent];
	if (roleRule && input.model) {
		const note = roleRule.note ? ` ${roleRule.note}` : "";
		const denied = roleRule.deny?.length ? modelMatches(roleRule.deny, input.model) : undefined;
		if (denied !== undefined) {
			violations.push({
				rule: "roleModels",
				agent: input.agent,
				summary: `Agent '${input.agent}' was launched with denied model '${input.model}'.`,
				evidence: `subagents.watchdog.rules.roleModels.${input.agent}.deny matches '${denied}'.${note}`,
				recommendedAction: roleRule.allow?.length ? `Use one of: ${roleRule.allow.join(", ")}.` : "Choose a different model for this role.",
			});
		} else if (roleRule.allow?.length && modelMatches(roleRule.allow, input.model) === undefined) {
			violations.push({
				rule: "roleModels",
				agent: input.agent,
				summary: `Agent '${input.agent}' was launched with model '${input.model}', which is not in its allowed list.`,
				evidence: `subagents.watchdog.rules.roleModels.${input.agent}.allow is [${roleRule.allow.join(", ")}].${note}`,
				recommendedAction: `Use one of: ${roleRule.allow.join(", ")}.`,
			});
		}
	}
	const minStages = rules.minStages[input.agent];
	if (minStages !== undefined && input.stageCount !== undefined && input.stageCount > 0 && input.stageCount < minStages) {
		violations.push({
			rule: "minStages",
			agent: input.agent,
			summary: `Agent '${input.agent}' is launched ${input.stageCount} time${input.stageCount === 1 ? "" : "s"}; the configured minimum is ${minStages}.`,
			evidence: `subagents.watchdog.rules.minStages.${input.agent} is ${minStages}.`,
			recommendedAction: `Split the work so '${input.agent}' runs at least ${minStages} stages, or lower the rule.`,
		});
	}
	return violations;
}

export function evaluateToolRules(rules: WatchdogRulesConfig | undefined, input: { toolName: string }): WatchdogRuleViolation | undefined {
	if (!rules?.forbidAfterLaunch.includes(input.toolName)) return undefined;
	return {
		rule: "forbidAfterLaunch",
		summary: `Tool '${input.toolName}' was called after a subagent launch in this run.`,
		evidence: `subagents.watchdog.rules.forbidAfterLaunch lists '${input.toolName}'.`,
		recommendedAction: "Return control and let the completion notification wake this session instead.",
	};
}

export function ruleViolationWarning(violation: WatchdogRuleViolation): WatchdogWarning {
	return {
		severity: "concern",
		category: "missed-constraint",
		confidence: "high",
		source: "main",
		...(violation.agent ? { agent: violation.agent } : {}),
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
