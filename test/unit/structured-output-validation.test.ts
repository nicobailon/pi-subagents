import assert from "node:assert/strict";
import test from "node:test";
import type { JsonSchemaObject } from "../../src/shared/types.ts";
import { validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";

async function invalidMessage(schema: JsonSchemaObject, value: unknown): Promise<string> {
	const result = await validateStructuredOutputValue(schema, value);
	assert.equal(result.status, "invalid");
	return result.status === "invalid" ? result.message : "";
}

test("reports the missing field selected by a root then branch", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: { kind: { type: "string" } },
		if: { properties: { kind: { const: "full" } }, required: ["kind"] },
		then: { required: ["detail"] },
	}, { kind: "full" });

	assert.equal(message, "detail: is required");
});

test("reports an invalid field selected by an else branch", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: { kind: { type: "string" }, count: {} },
		if: { properties: { kind: { const: "full" } }, required: ["kind"] },
		else: { properties: { count: { type: "string" } } },
	}, { kind: "brief", count: 2 });

	assert.equal(message, "count: must be string");
});

test("roots selected-branch errors for a conditional nested under a property", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: {
			config: {
				type: "object",
				properties: { enabled: { type: "boolean" } },
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { config: { enabled: true } });

	assert.equal(message, "config.token: is required");
});

test("preserves root definitions for refs in the selected branch and at the root", async () => {
	const branchRef = await invalidMessage({
		$defs: { count: { type: "number" } },
		type: "object",
		properties: { enabled: { type: "boolean" }, count: {} },
		if: { properties: { enabled: { const: true } }, required: ["enabled"] },
		then: { properties: { count: { $ref: "#/$defs/count" } } },
	}, { enabled: true, count: "many" });
	assert.equal(branchRef, "count: must be number");

	const rootRef = await invalidMessage({
		$ref: "#/$defs/conditional",
		$defs: {
			conditional: {
				type: "object",
				properties: { enabled: { type: "boolean" } },
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { enabled: true });
	assert.equal(rootRef, "token: is required");
});

test("roots a conditional reached through a nested property ref", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: { config: { $ref: "#/$defs/C" } },
		$defs: {
			C: {
				type: "object",
				properties: { enabled: { type: "boolean" } },
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { config: { enabled: true } });

	assert.equal(message, "config.token: is required");
});

test("expands a conditional inside a tuple element", async () => {
	const message = await invalidMessage({
		type: "array",
		prefixItems: [{
			type: "object",
			if: { properties: { enabled: { const: true } }, required: ["enabled"] },
			then: { required: ["token"] },
		}],
	}, [{ enabled: true }]);

	assert.equal(message, "0.token: is required");
});

test("treats a numeric object property as a property path", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: {
			"0": {
				type: "object",
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { "0": { enabled: true } });

	assert.equal(message, "0.token: is required");
});

test("expands reused and recursive refs only at the failing instance", async () => {
	const reused = await invalidMessage({
		type: "object",
		properties: { left: { $ref: "#/$defs/C" }, right: { $ref: "#/$defs/C" } },
		$defs: {
			C: {
				type: "object",
				properties: { enabled: { type: "boolean" } },
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { left: { enabled: false }, right: { enabled: true } });
	assert.equal(reused, "right.token: is required");

	const recursive = await invalidMessage({
		$ref: "#/$defs/Node",
		$defs: {
			Node: {
				type: "object",
				properties: { enabled: { type: "boolean" }, next: { $ref: "#/$defs/Node" } },
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { enabled: false, next: { enabled: true } });
	assert.equal(recursive, "next.token: is required");
});

test("emits an unrelated root baseline error once before a nested conditional leaf", async () => {
	const message = await invalidMessage({
		type: "object",
		required: ["name"],
		properties: {
			config: {
				type: "object",
				if: { properties: { enabled: { const: true } }, required: ["enabled"] },
				then: { required: ["token"] },
			},
		},
	}, { config: { enabled: true } });

	assert.equal(message, "name: is required; config.token: is required");
});

test("expands nested selected conditionals until reaching an actionable field", async () => {
	const message = await invalidMessage({
		type: "object",
		if: { properties: { mode: { const: "configured" } }, required: ["mode"] },
		then: {
			if: { properties: { enabled: { const: true } }, required: ["enabled"] },
			then: { required: ["token"] },
		},
	}, { mode: "configured", enabled: true });

	assert.equal(message, "token: is required");
});

test("uses the selected branch's own diagnostic when no field path is available", async () => {
	const message = await invalidMessage({
		type: "object",
		if: { const: {} },
		then: false,
	}, {});

	assert.equal(message, "root: schema is false");
});

test("keeps selected-branch diagnostics deterministic and bounded to eight", async () => {
	const required = Array.from({ length: 10 }, (_, index) => `field${index}`);
	const message = await invalidMessage({
		type: "object",
		required,
		allOf: Array.from({ length: 20 }, (_, index) => ({
			if: { properties: { [`later${index}`]: { const: true } }, required: [`later${index}`] },
			then: { required: [`detail${index}`] },
		})),
	}, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`later${index}`, true])));

	assert.equal(message, required.slice(0, 8).map((field) => `${field}: is required`).join("; "));
});

test("names the permitted values for an invalid enum or const field", async () => {
	const message = await invalidMessage({
		type: "object",
		properties: {
			outcome: { type: "string", enum: ["applied", "blocked"] },
			level: { enum: Array.from({ length: 25 }, (_, index) => index) },
			kind: { const: "report" },
		},
		required: ["outcome"],
		additionalProperties: false,
	}, { outcome: "fixed", level: 99, kind: "note" });

	assert.equal(message, [
		`outcome: must be one of "applied", "blocked"`,
		`level: must be one of ${Array.from({ length: 20 }, (_, index) => index).join(", ")}, and 5 more`,
		`kind: must be "report"`,
	].join("; "));
});
