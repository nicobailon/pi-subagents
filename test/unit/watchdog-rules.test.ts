import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateLaunchRule, ruleViolationWarning, watchdogGlobMatch } from "../../src/watchdog/rules.ts";
import type { WatchdogRulesConfig } from "../../src/watchdog/types.ts";

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

	it("applies deny before allow, matches the base model when the suffix differs, and shapes a concern", () => {
		const config: WatchdogRulesConfig = { action: "warn", roleModels: { scout: { allow: ["openai-codex/gpt-5.6-luna"], deny: ["openai-codex/gpt-5.6-sol*"], note: "scout is cheap" } } };
		assert.equal(evaluateLaunchRule(config, "scout", "openai-codex/gpt-5.6-luna:max"), undefined);
		const denied = evaluateLaunchRule(config, "scout", "openai-codex/gpt-5.6-sol:high");
		assert.match(denied?.summary ?? "", /denied model 'openai-codex\/gpt-5\.6-sol:high'/);
		assert.match(denied?.evidence ?? "", /scout is cheap/);
		const outside = evaluateLaunchRule(config, "scout", "anthropic/claude-opus-4-8");
		assert.match(outside?.summary ?? "", /not in its allowed list/);
		assert.match(outside?.recommendedAction ?? "", /openai-codex\/gpt-5\.6-luna/);
		assert.equal(evaluateLaunchRule(config, "worker", "anthropic/claude-opus-4-8"), undefined, "other roles are unaffected");
		assert.equal(evaluateLaunchRule(config, "scout", undefined), undefined, "an unknown model cannot be judged");
		assert.equal(evaluateLaunchRule(undefined, "scout", "x/y"), undefined);

		const warning = ruleViolationWarning(denied!);
		assert.equal(warning.severity, "concern");
		assert.equal(warning.category, "missed-constraint");
		assert.equal(warning.confidence, "high");
		assert.equal(warning.source, "main");
		assert.equal(warning.agent, "scout");
	});
});
