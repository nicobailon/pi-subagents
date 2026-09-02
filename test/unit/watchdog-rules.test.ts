import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countWatchdogRules, evaluateLaunchRules, evaluateToolRules, ruleViolationWarning, watchdogGlobMatch } from "../../src/watchdog/rules.ts";
import type { WatchdogRulesConfig } from "../../src/watchdog/types.ts";

function rules(overrides: Partial<WatchdogRulesConfig> = {}): WatchdogRulesConfig {
	return { action: "warn", roleModels: {}, minStages: {}, forbidAfterLaunch: [], ...overrides };
}

describe("watchdog launch rules", () => {
	it("matches globs anchored and case-sensitively", () => {
		assert.equal(watchdogGlobMatch("openai-codex/gpt-5.6-*:max", "openai-codex/gpt-5.6-luna:max"), true);
		assert.equal(watchdogGlobMatch("openai-codex/gpt-5.6-*", "openai-codex/gpt-5.6-luna:max"), true);
		assert.equal(watchdogGlobMatch("gpt-5.6-*", "openai-codex/gpt-5.6-luna"), false, "patterns are anchored at the start");
		assert.equal(watchdogGlobMatch("*", "anything/at-all"), true);
		assert.equal(watchdogGlobMatch("anthropic/claude-opus-4.?", "anthropic/claude-opus-4.8"), true);
		assert.equal(watchdogGlobMatch("anthropic/claude-opus-4.8", "anthropic/claude-opus-4x8"), false);
		assert.equal(watchdogGlobMatch("Anthropic/*", "anthropic/claude"), false);
	});

	it("applies deny before allow and matches the base model when the suffix differs", () => {
		const config = rules({ roleModels: { scout: { allow: ["openai-codex/gpt-5.6-luna"], deny: ["openai-codex/gpt-5.6-sol*"], note: "scout is cheap" } } });
		assert.deepEqual(evaluateLaunchRules(config, { agent: "scout", model: "openai-codex/gpt-5.6-luna:max" }), []);
		const denied = evaluateLaunchRules(config, { agent: "scout", model: "openai-codex/gpt-5.6-sol:high" });
		assert.equal(denied.length, 1);
		assert.equal(denied[0]?.rule, "roleModels");
		assert.match(denied[0]?.summary ?? "", /denied model 'openai-codex\/gpt-5\.6-sol:high'/);
		assert.match(denied[0]?.evidence ?? "", /scout is cheap/);
		const outside = evaluateLaunchRules(config, { agent: "scout", model: "anthropic/claude-opus-4-8" });
		assert.match(outside[0]?.summary ?? "", /not in its allowed list/);
		assert.match(outside[0]?.recommendedAction ?? "", /openai-codex\/gpt-5\.6-luna/);
		assert.deepEqual(evaluateLaunchRules(config, { agent: "worker", model: "anthropic/claude-opus-4-8" }), [], "other roles are unaffected");
		assert.deepEqual(evaluateLaunchRules(config, { agent: "scout" }), [], "an unknown model cannot be judged");
		assert.deepEqual(evaluateLaunchRules(undefined, { agent: "scout", model: "x/y" }), []);
	});

	it("flags too few stages only when the agent is launched at all", () => {
		const config = rules({ minStages: { worker: 2 } });
		assert.deepEqual(evaluateLaunchRules(config, { agent: "worker", stageCount: 0 }), []);
		assert.deepEqual(evaluateLaunchRules(config, { agent: "worker", stageCount: 2 }), []);
		const single = evaluateLaunchRules(config, { agent: "worker", stageCount: 1 });
		assert.equal(single[0]?.rule, "minStages");
		assert.match(single[0]?.summary ?? "", /launched 1 time; the configured minimum is 2/);
		assert.deepEqual(evaluateLaunchRules(config, { agent: "worker" }), [], "single launches inside a workflow pass no stage count");
	});

	it("flags forbidden tools after a launch and shapes a concern from a violation", () => {
		const config = rules({ forbidAfterLaunch: ["bg_wait"] });
		assert.equal(evaluateToolRules(config, { toolName: "read" }), undefined);
		const violation = evaluateToolRules(config, { toolName: "bg_wait" });
		assert.equal(violation?.rule, "forbidAfterLaunch");
		const warning = ruleViolationWarning(violation!);
		assert.equal(warning.severity, "concern");
		assert.equal(warning.category, "missed-constraint");
		assert.equal(warning.confidence, "high");
		assert.equal(warning.source, "main");
		assert.equal(countWatchdogRules(rules({ roleModels: { a: {}, b: {} }, minStages: { a: 2 }, forbidAfterLaunch: ["x", "y"] })), 5);
		assert.equal(countWatchdogRules(undefined), 0);
	});
});
