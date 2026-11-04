import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";
import { approveSessionHandoff, consumeSessionHandoff, inheritedSessionIds, recordSessionReplacement, recordSessionStart } from "../../src/shared/session-succession.ts";

const OWNER = "owner-a";

describe("result delivery ownership", () => {
	it("requires an exact one-shot handoff offer; a startup cannot inherit a failed switch's offer", () => {
		approveSessionHandoff("offer-target", "offer-source");
		assert.equal(consumeSessionHandoff("offer-target", "wrong-source"), false);
		assert.equal(consumeSessionHandoff("offer-target", "offer-source"), false);
		approveSessionHandoff("offer-target", "offer-source");
		assert.equal(consumeSessionHandoff("offer-target"), false);
		assert.equal(consumeSessionHandoff("offer-target", "offer-source"), false);
		approveSessionHandoff("offer-target", "offer-source");
		recordSessionStart("offer-source", true);
		assert.equal(consumeSessionHandoff("offer-target", "offer-source"), false, "reopening the source reclaims its runs");
	});

	it("keeps an approved chain on reload but drops it when that session is opened again", () => {
		recordSessionReplacement("reload-owner", "reload-source");
		recordSessionStart("reload-owner", false);
		assert.deepEqual(inheritedSessionIds("reload-owner"), ["reload-source"]);
		recordSessionStart("reload-owner", true);
		assert.deepEqual(inheritedSessionIds("reload-owner"), []);
	});

	it("owns results of sessions this process replaced on the way to the current session", () => {
		const state = { currentSessionId: "ownership-old" as string | null, completionOwnerId: OWNER };
		const ownership = createResultDeliveryOwnership(state);
		assert.equal(ownership.owns("ownership-old", OWNER), true);
		assert.deepEqual(ownership.claimedSessionIds(), []);
		recordSessionReplacement("ownership-new", "ownership-old");
		state.currentSessionId = "ownership-new";
		assert.deepEqual(ownership.claimedSessionIds(), ["ownership-old"]);
		assert.equal(ownership.owns("ownership-old", OWNER), true);
		assert.equal(ownership.owns("ownership-new", OWNER), true);
		assert.equal(ownership.owns("ownership-old", "other-owner"), false);
		assert.equal(ownership.owns("ownership-foreign", OWNER), false);
		// A workflow whose Pi exited and that no owning session adopted: any session that owns the run delivers it.
		assert.equal(ownership.owns("ownership-old", "owning-session"), true);
		assert.equal(ownership.owns("ownership-foreign", "owning-session"), false);
		state.currentSessionId = "ownership-fresh";
		assert.equal(ownership.owns("ownership-old", OWNER), false);
	});

	it("keeps inherited sessions bounded", () => {
		const state = { currentSessionId: "bound-0" as string | null, completionOwnerId: OWNER };
		const ownership = createResultDeliveryOwnership(state);
		for (let index = 0; index < 9; index += 1) {
			recordSessionReplacement(`bound-${index + 1}`, `bound-${index}`);
			state.currentSessionId = `bound-${index + 1}`;
		}
		assert.deepEqual(ownership.claimedSessionIds(), ["bound-8", "bound-7", "bound-6", "bound-5", "bound-4", "bound-3", "bound-2", "bound-1"]);
		assert.equal(ownership.owns("bound-0", OWNER), false);
		assert.equal(ownership.owns("bound-1", OWNER), true);
	});

	it("forgets the oldest recorded replacements once a long-lived process has recorded many", () => {
		const state = { currentSessionId: "cap-1" as string | null, completionOwnerId: OWNER };
		const ownership = createResultDeliveryOwnership(state);
		recordSessionReplacement("cap-1", "cap-0");
		assert.deepEqual(ownership.claimedSessionIds(), ["cap-0"]);
		for (let index = 0; index < 64; index += 1) recordSessionReplacement(`cap-later-${index}`, `cap-earlier-${index}`);
		assert.deepEqual(ownership.claimedSessionIds(), []);
	});
});
