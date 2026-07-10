import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import { resolveLeadershipConfigOrDefault } from "../../../src/model-leadership/builder.ts";

describe("model-leadership config validation", () => {
	it("resolves defaults when config is missing", () => {
		const resolved = resolveLeadershipConfigOrDefault(undefined);
		const prefs = resolved.preferences;
		strictEqual(prefs.preferFree, true);
		strictEqual(prefs.defaultCategory, "coding");
		strictEqual(prefs.maxResults, 50);
		strictEqual(prefs.paidSortRule.strategy, "priority");
	});

	it("merges user preferences over defaults", () => {
		const resolved = resolveLeadershipConfigOrDefault({
			preferences: {
				preferFree: false,
				defaultCategory: "reasoning",
				maxResults: 10,
				paidSortRule: { strategy: "ranking", rankingOrder: "desc" },
			},
		});
		const prefs = resolved.preferences;
		strictEqual(prefs.preferFree, false);
		strictEqual(prefs.defaultCategory, "reasoning");
		strictEqual(prefs.maxResults, 10);
		strictEqual(prefs.paidSortRule.strategy, "ranking");
		strictEqual(prefs.paidSortRule.rankingOrder, "desc");
	});

	it("normalizes invalid maxResults to 50", () => {
		const resolved = resolveLeadershipConfigOrDefault({
			preferences: { maxResults: 0 },
		});
		strictEqual(resolved.preferences.maxResults, 50);
	});
});
