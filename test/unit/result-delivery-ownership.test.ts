import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResultDeliveryOwnership } from "../../src/runs/background/result-delivery-ownership.ts";

const OWNER = "owner-a";

describe("result delivery ownership", () => {
	it("claims only the directly proven previous runtime session", () => {
		const state = { currentSessionId: "old" as string | null, completionOwnerId: OWNER };
		const ownership = createResultDeliveryOwnership(state);
		assert.equal(ownership.claimPredecessor(undefined, "old"), false);
		assert.equal(ownership.claimPredecessor("different", "old"), false);
		assert.equal(ownership.claimPredecessor("old", "different"), false);
		assert.equal(ownership.claimPredecessor("old", "old"), true);
		state.currentSessionId = "new";
		assert.equal(ownership.owns("old", OWNER), true);
		assert.equal(ownership.owns("new", OWNER), true);
		assert.equal(ownership.owns("old", "other-owner"), false);
		assert.equal(ownership.owns("foreign", OWNER), false);
	});

	it("keeps predecessor claims bounded", () => {
		const state = { currentSessionId: "session-0" as string | null, completionOwnerId: OWNER };
		const ownership = createResultDeliveryOwnership(state);
		for (let index = 0; index < 9; index += 1) {
			const previous = `session-${index}`;
			assert.equal(ownership.claimPredecessor(previous, previous), true);
			state.currentSessionId = `session-${index + 1}`;
		}
		assert.deepEqual(ownership.claimedSessionIds(), ["session-1", "session-2", "session-3", "session-4", "session-5", "session-6", "session-7", "session-8"]);
		assert.equal(ownership.owns("session-0", OWNER), false);
		assert.equal(ownership.owns("session-8", OWNER), true);
	});
});
