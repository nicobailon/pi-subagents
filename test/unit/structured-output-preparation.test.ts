import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonSchemaObject } from "../../src/shared/types.ts";
import { prepareStructuredOutputArguments } from "../../src/runs/shared/structured-output.ts";

function prepare(schema: JsonSchemaObject, args: unknown): unknown {
	return prepareStructuredOutputArguments(schema, args);
}

describe("structured output raw argument preparation", () => {
	it("passes valid arguments through unchanged", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["tags", "count"],
			properties: {
				tags: { type: "array", items: { type: "string" } },
				count: { type: "integer" },
			},
		};
		const args = { value: { tags: ["a", "b"], count: 2 } };

		assert.equal(prepare(schema, args), args);
	});

	it("rejects raw scalar strings and numbers for fields that require an array", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["tags"],
			properties: { tags: { type: "array", items: { type: "string" } } },
		};

		assert.throws(() => prepare(schema, { value: { tags: "one" } }), /value\.tags must be an array, received raw string/);
		assert.throws(() => prepare(schema, { value: { tags: 5 } }), /value\.tags must be an array, received raw number/);
	});

	it("rejects raw null for a field that requires an array", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["tags"],
			properties: { tags: { type: "array", items: { type: "string" } } },
		};

		assert.throws(() => prepare(schema, { value: { tags: null } }), /value\.tags must not be null/);
	});

	it("rejects raw null for a required string field so it cannot become literal null text", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["title"],
			properties: { title: { type: "string" } },
		};

		assert.throws(() => prepare(schema, { value: { title: null } }), /value\.title must not be null/);
	});

	it("rejects raw null and raw scalars inside nested objects and array items", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["config", "tags"],
			properties: {
				config: {
					type: "object",
					required: ["labels"],
					properties: { labels: { type: "array", items: { type: "string" } } },
				},
				tags: { type: "array", items: { type: "string" } },
			},
		};

		assert.throws(() => prepare(schema, { value: { config: { labels: "x" }, tags: [] } }), /value\.config\.labels must be an array/);
		assert.throws(() => prepare(schema, { value: { config: { labels: [] }, tags: ["ok", null] } }), /value\.tags\[1\] must not be null/);
	});

	it("resolves local $ref and $defs when guarding raw values", () => {
		const schema: JsonSchemaObject = {
			$defs: {
				tags: { type: "array", items: { type: "string" } },
				title: { type: "string" },
			},
			type: "object",
			required: ["tags", "title"],
			properties: {
				tags: { $ref: "#/$defs/tags" },
				title: { $ref: "#/$defs/title" },
			},
		};

		assert.throws(() => prepare(schema, { value: { tags: "x", title: "t" } }), /value\.tags must be an array/);
		assert.throws(() => prepare(schema, { value: { tags: [], title: null } }), /value\.title must not be null/);
		const valid = { value: { tags: ["a"], title: "t" } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("allows null where the schema allows null and for optional fields", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["note"],
			properties: {
				note: { type: ["string", "null"] },
				detail: { type: "string" },
			},
		};
		const args = { value: { note: null, detail: null } };

		assert.equal(prepare(schema, args), args);
	});

	it("preserves accepted coercions such as numeric strings for numeric fields and numeric array items", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["count"],
			properties: {
				count: { type: "integer" },
				weights: { type: "array", items: { type: "number" } },
			},
		};
		const args = { value: { count: "5", weights: ["1.5", 2] } };

		assert.equal(prepare(schema, args), args);
	});

	it("allows a numeric string when a union has a non-array number branch", () => {
		const schema: JsonSchemaObject = {
			anyOf: [{ type: "array", items: { type: "string" } }, { type: "number" }],
		};
		const args = { value: "5" };

		assert.equal(prepare(schema, args), args);
		assert.throws(() => prepare(schema, { value: "abc" }), /value must be an array, received raw string/);
	});

	it("rejects non-integer numeric strings when the union's numeric branch is integer-only", () => {
		const schema: JsonSchemaObject = {
			anyOf: [{ type: "array", items: { type: "string" } }, { type: "integer" }],
		};
		const integerString = { value: "1" };

		assert.equal(prepare(schema, integerString), integerString);
		assert.throws(() => prepare(schema, { value: "1.5" }), /value must be an array, received raw string/);
	});

	it("allows object values for unions that include a non-array branch", () => {
		const schema: JsonSchemaObject = {
			anyOf: [
				{ type: "array", items: { type: "string" } },
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
			],
		};
		const args = { value: { a: "x" } };

		assert.equal(prepare(schema, args), args);
	});

	it("allows raw scalars when a boolean true branch makes the union accept anything", () => {
		const schema: JsonSchemaObject = {
			anyOf: [{ type: "array", items: { type: "string" } }, true],
		};
		const args = { value: "raw" };

		assert.equal(prepare(schema, args), args);
	});

	it("ignores boolean false branches when deciding whether an array is required", () => {
		const schema: JsonSchemaObject = {
			anyOf: [{ type: "array", items: { type: "string" } }, false],
		};

		assert.throws(() => prepare(schema, { value: "raw" }), /value must be an array, received raw string/);
	});

	it("allows null when a boolean true branch makes the union accept anything", () => {
		const schema: JsonSchemaObject = {
			anyOf: [{ type: "string" }, true],
		};
		const args = { value: null };

		assert.equal(prepare(schema, args), args);
	});

	it("allows null for oneOf branches that permit null", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["note"],
			properties: { note: { oneOf: [{ type: "null" }, { type: "string" }] } },
		};
		const args = { value: { note: null } };

		assert.equal(prepare(schema, args), args);
	});

	it("rejects null when the allOf intersection does not allow null", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["note"],
			properties: { note: { allOf: [{ type: "string" }, { type: "null" }] } },
		};

		assert.throws(() => prepare(schema, { value: { note: null } }), /value\.note must not be null/);
	});

	it("allows null when enum contains null and for const null", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["note", "fixed"],
			properties: {
				note: { enum: ["a", null] },
				fixed: { const: null },
			},
		};
		const args = { value: { note: null, fixed: null } };

		assert.equal(prepare(schema, args), args);
	});

	it("guards tuple items described by prefixItems", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["pair"],
			properties: { pair: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] } },
		};

		assert.throws(() => prepare(schema, { value: { pair: ["x", null] } }), /value\.pair\[1\] must not be null/);
		const valid = { value: { pair: ["x", "2"] } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("fails open on cyclic $ref schemas instead of recursing forever", () => {
		const schema: JsonSchemaObject = {
			$defs: { node: { anyOf: [{ $ref: "#/$defs/node" }, { type: "string" }] } },
			type: "object",
			required: ["v"],
			properties: { v: { $ref: "#/$defs/node" } },
		};
		const args = { value: { v: "x" } };

		assert.equal(prepare(schema, args), args);
		const cyclicSelfReference: JsonSchemaObject = { allOf: [{ $ref: "#" }] };
		const rawArgs = { value: "raw" };
		assert.equal(prepare(cyclicSelfReference, rawArgs), rawArgs);
	});

	it("still guards every level of a legitimately recursive tree schema", () => {
		const schema: JsonSchemaObject = {
			$defs: {
				node: {
					type: "object",
					required: ["label"],
					properties: {
						label: { type: "string" },
						children: { type: "array", items: { $ref: "#/$defs/node" } },
					},
				},
			},
			type: "object",
			required: ["root"],
			properties: { root: { $ref: "#/$defs/node" } },
		};
		const nestedNull = { value: { root: { label: "a", children: [{ label: null }] } } };

		assert.throws(() => prepare(schema, nestedNull), /value\.root\.children\[0\]\.label must not be null/);
		const valid = { value: { root: { label: "a", children: [{ label: "b", children: [] }] } } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw values inside applicable anyOf object branches", () => {
		const schema: JsonSchemaObject = {
			anyOf: [
				{ type: "object", required: ["tags"], properties: { tags: { type: "array", items: { type: "string" } } } },
				{ type: "null" },
			],
		};

		assert.throws(() => prepare(schema, { value: { tags: "x" } }), /value\.tags must be an array, received raw string/);
		const validArray = { value: { tags: ["a"] } };
		assert.equal(prepare(schema, validArray), validArray);
		const validNull = { value: null };
		assert.equal(prepare(schema, validNull), validNull);
	});

	it("rejects raw values inside applicable union branches of object properties", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["item"],
			properties: {
				item: {
					oneOf: [
						{ type: "object", required: ["tags"], properties: { tags: { type: "array", items: { type: "string" } } } },
					{ type: "null" },
					],
				},
			},
		};

		assert.throws(() => prepare(schema, { value: { item: { tags: "x" } } }), /value\.item\.tags must be an array, received raw string/);
		const valid = { value: { item: { tags: ["a"] } } };
		assert.equal(prepare(schema, valid), valid);
		const validNull = { value: { item: null } };
		assert.equal(prepare(schema, validNull), validNull);
	});

	it("accepts the raw value when another applicable union branch allows it", () => {
		const schema: JsonSchemaObject = {
			anyOf: [
				{ type: "object", required: ["tags"], properties: { tags: { type: "array", items: { type: "string" } } } },
				{ type: "object", properties: { tags: { type: "string" } } },
			],
		};
		const rawString = { value: { tags: "x" } };
		const rawArray = { value: { tags: ["a"] } };

		assert.equal(prepare(schema, rawString), rawString);
		assert.equal(prepare(schema, rawArray), rawArray);
	});

	it("rejects raw null when required and properties split across allOf branches", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["title"],
			allOf: [{ properties: { title: { type: "string" } } }],
		};

		assert.throws(() => prepare(schema, { value: { title: null } }), /value\.title must not be null/);
		const valid = { value: { title: "ok" } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw null when allOf splits required and properties in reverse order", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			allOf: [{ required: ["title"] }, { properties: { title: { type: "string" } } }],
		};

		assert.throws(() => prepare(schema, { value: { title: null } }), /value\.title must not be null/);
		const valid = { value: { title: "ok" } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw null when required is inherited through allOf and properties sit inside anyOf", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			allOf: [
				{ required: ["x"] },
				{ anyOf: [{ properties: { x: { type: "string" } } }] },
			],
		};

		assert.throws(() => prepare(schema, { value: { x: null } }), /value\.x must not be null/);
		const valid = { value: { x: "ok" } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("allows raw null across allOf branches when the field schema allows null", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["title"],
			allOf: [{ properties: { title: { type: ["string", "null"] } } }],
		};
		const args = { value: { title: null } };

		assert.equal(prepare(schema, args), args);
	});

	it("rejects raw scalars when the node's own array type combines with anyOf", () => {
		const schema: JsonSchemaObject = {
			type: "array",
			items: { type: "string" },
			anyOf: [{ type: "array" }, { type: "null" }],
		};

		assert.throws(() => prepare(schema, { value: "x" }), /value must be an array, received raw string/);
		assert.throws(() => prepare(schema, { value: null }), /value must not be null/);
		const valid = { value: ["x"] };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw scalars for the Greptile maxItems/minItems array example", () => {
		const schema: JsonSchemaObject = {
			type: "array",
			items: { type: "string" },
			anyOf: [{ maxItems: 1 }, { minItems: 3 }],
		};

		assert.throws(() => prepare(schema, { value: "x" }), /value must be an array, received raw string/);
		const valid = { value: ["a"] };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw scalars for properties whose own array type combines with anyOf", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["tags"],
			properties: { tags: { type: "array", anyOf: [{ type: "array" }, { type: "null" }] } },
		};

		assert.throws(() => prepare(schema, { value: { tags: "x" } }), /value\.tags must be an array, received raw string/);
		assert.throws(() => prepare(schema, { value: { tags: null } }), /value\.tags must not be null/);
		const valid = { value: { tags: ["x"] } };
		assert.equal(prepare(schema, valid), valid);
	});

	it("rejects raw scalars for properties with a nullable array union and no outer type", () => {
		const schema: JsonSchemaObject = {
			type: "object",
			required: ["tags"],
			properties: { tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] } },
		};

		assert.throws(() => prepare(schema, { value: { tags: "x" } }), /value\.tags must be an array, received raw string/);
		const validArray = { value: { tags: ["a", "b"] } };
		assert.equal(prepare(schema, validArray), validArray);
		const validNull = { value: { tags: null } };
		assert.equal(prepare(schema, validNull), validNull);
	});

	it("passes non-object arguments through for normal validation to reject", () => {
		const schema: JsonSchemaObject = { type: "object", properties: { tags: { type: "array" } } };

		assert.equal(prepare(schema, null), null);
		assert.equal(prepare(schema, "raw"), "raw");
		const passthrough = { other: true };
		assert.equal(prepare(schema, passthrough), passthrough);
	});
});
