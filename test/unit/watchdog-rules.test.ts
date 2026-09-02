import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countWatchdogRules, evaluateLaunchRules, ruleViolationWarning, watchdogGlobMatch } from "../../src/watchdog/rules.ts";
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
		assert.deepEqual(evaluateLaunchRules(config, { agent: "scout", model: "openai-codex/gpt-5.6-luna:max" }), []);
		const denied = evaluateLaunchRules(config, { agent: "scout", model: "openai-codex/gpt-5.6-sol:high" });
		assert.equal(denied.length, 1);
		assert.match(denied[0]?.summary ?? "", /denied model 'openai-codex\/gpt-5\.6-sol:high'/);
		assert.match(denied[0]?.evidence ?? "", /scout is cheap/);
		const outside = evaluateLaunchRules(config, { agent: "scout", model: "anthropic/claude-opus-4-8" });
		assert.match(outside[0]?.summary ?? "", /not in its allowed list/);
		assert.match(outside[0]?.recommendedAction ?? "", /openai-codex\/gpt-5\.6-luna/);
		assert.deepEqual(evaluateLaunchRules(config, { agent: "worker", model: "anthropic/claude-opus-4-8" }), [], "other roles are unaffected");
		assert.deepEqual(evaluateLaunchRules(config, { agent: "scout" }), [], "an unknown model cannot be judged");
		assert.deepEqual(evaluateLaunchRules(undefined, { agent: "scout", model: "x/y" }), []);

		const warning = ruleViolationWarning(denied[0]!);
		assert.equal(warning.severity, "concern");
		assert.equal(warning.category, "missed-constraint");
		assert.equal(warning.confidence, "high");
		assert.equal(warning.source, "main");
		assert.equal(warning.agent, "scout");
		assert.equal(countWatchdogRules(config), 1);
		assert.equal(countWatchdogRules(undefined), 0);
	});
});
