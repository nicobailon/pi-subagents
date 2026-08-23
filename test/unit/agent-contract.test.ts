import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExecutionProjection } from "../../src/runs/shared/agent-contract.ts";

describe("buildExecutionProjection", () => {
	it("does not mark interrupted runs successful", () => {
		assert.deepEqual(buildExecutionProjection({ exitCode: 0, interrupted: true }), {
			status: "paused",
			success: false,
			exitCode: 0,
			interrupted: true,
		});
	});
});
