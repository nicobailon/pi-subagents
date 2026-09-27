import assert from "node:assert/strict";
import { test } from "node:test";
import { readMainThinkingLevel } from "../../src/tui/running-tone.ts";

const staleMessage = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";
const unboundMessage = "Extension runtime not initialized. Action methods cannot be called during extension loading.";

test("reads the main session's thinking level and treats a stale or unbound runtime as having none", () => {
	assert.equal(readMainThinkingLevel(() => "high"), "high");
	assert.equal(readMainThinkingLevel(() => { throw new Error(staleMessage); }), undefined);
	assert.equal(readMainThinkingLevel(() => { throw new Error(unboundMessage); }), undefined);
	assert.throws(() => readMainThinkingLevel(() => { throw new Error("disk on fire"); }), /disk on fire/);
});
