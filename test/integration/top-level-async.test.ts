import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tryImport } from "../support/helpers.ts";

interface TopLevelAsyncModule {
	applyForceTopLevelAsyncOverride<T extends { async?: boolean; clarify?: boolean }>(
		params: T,
		depth: number,
		forceTopLevelAsync: boolean,
	): T;
}

const mod = await tryImport<TopLevelAsyncModule>("./top-level-async.ts");
const available = !!mod;

describe("force top-level async helper", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("forces top-level calls async and disables clarify", () => {
		const params = { async: false, clarify: true, agent: "worker" };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 0, true);
		assert.notEqual(next, params);
		assert.equal(next.async, true);
		assert.equal(next.clarify, false);
		assert.equal(next.agent, "worker");
	});

	it("leaves nested calls unchanged", () => {
		const params = { async: false, clarify: true };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 1, true);
		assert.equal(next, params);
	});

	it("leaves top-level calls unchanged when the feature is off", () => {
		const params = { async: false, clarify: true };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 0, false);
		assert.equal(next, params);
	});
});
