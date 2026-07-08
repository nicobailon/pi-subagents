import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WatchdogEmissionGuard, normalizeWatchdogEmissionText } from "../../src/watchdog/emission-guard.ts";
import type { WatchdogWarning } from "../../src/watchdog/types.ts";

function warning(overrides: Partial<WatchdogWarning> = {}): WatchdogWarning {
	return {
		severity: "concern",
		summary: "Unvalidated file write",
		evidence: "The implementation writes settings without a test.",
		recommendedAction: "Add a focused settings write regression test.",
		...overrides,
	};
}

describe("watchdog emission guard", () => {
	it("normalizes text with NFKC, punctuation folding, lowercase, and whitespace collapse", () => {
		assert.equal(normalizeWatchdogEmissionText("  Ｆｉｘ—THE\tBug!!!  "), "fix the bug");
	});

	it("suppresses content-free and empty emissions", () => {
		assert.deepEqual(new WatchdogEmissionGuard().evaluate(warning({ summary: "No concerns." })), { accepted: false, reason: "content-free" });
		assert.deepEqual(new WatchdogEmissionGuard().evaluate(warning({ evidence: "LGTM" })), { accepted: false, reason: "content-free" });
		assert.deepEqual(new WatchdogEmissionGuard().evaluate(warning({ recommendedAction: "" })), { accepted: false, reason: "content-free" });
	});

	it("dedupes normalized repeated warnings across model updates", () => {
		const guard = new WatchdogEmissionGuard();
		assert.equal(guard.evaluate(warning({ summary: "Fix Ｆｏｏ!!!", evidence: "Line 1: bad whitespace." })).accepted, true);
		guard.startModelUpdate();
		const duplicate = guard.evaluate(warning({ summary: "fix foo", evidence: "line 1 bad whitespace" }));

		assert.equal(duplicate.accepted, false);
		assert.equal(duplicate.reason, "duplicate");
	});

	it("allows concern to blocker escalation for the same issue despite per-update budget", () => {
		const guard = new WatchdogEmissionGuard();
		const first = guard.evaluate(warning({ severity: "concern", summary: "Tests missing", evidence: "No unit covers the parser." }));
		const escalation = guard.evaluate(warning({ severity: "blocker", summary: "Tests missing", evidence: "No unit covers the parser." }));
		const extra = guard.evaluate(warning({ severity: "blocker", summary: "Docs missing", evidence: "No README section exists." }));

		assert.equal(first.accepted, true);
		assert.equal(escalation.accepted, true);
		assert.equal(escalation.escalation, true);
		assert.equal(extra.accepted, false);
		assert.equal(extra.reason, "update-budget");
	});

	it("enforces max warnings while still allowing escalation of an accepted concern", () => {
		const guard = new WatchdogEmissionGuard({ maxWarnings: 1 });
		assert.equal(guard.evaluate(warning({ severity: "concern", summary: "Parser gap", evidence: "Unknown fields are ignored." })).accepted, true);
		guard.startModelUpdate();
		const capped = guard.evaluate(warning({ severity: "concern", summary: "Renderer gap", evidence: "Stale state is hidden." }));
		const escalation = guard.evaluate(warning({ severity: "blocker", summary: "Parser gap", evidence: "Unknown fields are ignored." }));

		assert.equal(capped.accepted, false);
		assert.equal(capped.reason, "max-warnings");
		assert.equal(escalation.accepted, true);
		assert.equal(escalation.escalation, true);
	});
});
