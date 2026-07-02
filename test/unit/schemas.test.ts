import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: {
			items?: {
				properties?: {
					count?: {
						minimum?: number;
						description?: string;
					};
				};
			};
		};
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		timeoutMs?: {
			minimum?: number;
			description?: string;
		};
		maxRuntimeMs?: {
			minimum?: number;
			description?: string;
		};
		id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		action?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				activeNoticeAfterMs?: { minimum?: number };
				activeNoticeAfterTurns?: { minimum?: number };
				activeNoticeAfterTokens?: { minimum?: number };
				failedToolAttemptsBeforeAttention?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		output?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: {
			items?: JsonSchemaNode & {
				properties?: Record<string, JsonSchemaNode>;
			};
		};
	};
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
	const anyOf = schema?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
	return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
	return anyOfBranches(schema).some((branch) => {
		if (branch.type !== "array") return false;
		const items = branch.items;
		return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
	});
}

function getPropertySchema(schema: JsonSchemaNode | undefined, path: string[]): JsonSchemaNode | undefined {
	let current: unknown = schema;
	for (const key of path) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as JsonSchemaNode).properties;
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current && typeof current === "object" ? current as JsonSchemaNode : undefined;
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
try {
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	// The structural schema assertions below do not need the optional compiler package.
}

describe("SubagentParams schema", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("includes context field for fresh/fork execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
		const description = String(contextSchema.description ?? "");
		assert.match(description, /fresh/);
		assert.match(description, /fork/);
		assert.match(description, /each requested agent/);
		assert.match(description, /overrides every child/);
	});

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskSchema = SubagentParams?.properties?.tasks?.items?.properties;
		const taskCountSchema = taskSchema?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		const outputSchema = taskSchema?.output as JsonSchemaNode | undefined;
		assert.equal(outputSchema?.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
		const readsSchema = taskSchema?.reads as JsonSchemaNode | undefined;
		assert.equal(readsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
		assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
		assert.equal(taskSchema?.progress?.type, "boolean");

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

	it("uses an enum for management and control actions", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.deepEqual(actionSchema.enum, ["list", "get", "models", "create", "update", "delete", "eject", "disable", "enable", "reset", "status", "interrupt", "resume", "append-step", "doctor"]);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control action/);
		assert.match(description, /Omit for execution mode/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("includes foreground timeout aliases", () => {
		const timeoutSchema = SubagentParams?.properties?.timeoutMs;
		const maxRuntimeSchema = SubagentParams?.properties?.maxRuntimeMs;
		assert.ok(timeoutSchema, "timeoutMs schema should exist");
		assert.ok(maxRuntimeSchema, "maxRuntimeMs schema should exist");
		assert.equal(timeoutSchema.minimum, 1);
		assert.equal(maxRuntimeSchema.minimum, 1);
		assert.match(String(timeoutSchema.description ?? ""), /foreground and async\/background/i);
		assert.doesNotMatch(String(timeoutSchema.description ?? ""), /foreground-only/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /timeoutMs/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /foreground and async\/background/i);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);
		assert.match(String(idSchema.description ?? ""), /append-step/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);
		assert.match(String(runIdSchema.description ?? ""), /append-step/i);

		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.needsAttentionAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTurns?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTokens?.minimum, 1);
		assert.equal(controlSchema.properties?.failedToolAttemptsBeforeAttention?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.notifyOn?.items?.enum, ["active_long_running", "needs_attention"]);
		assert.deepEqual(controlSchema.properties?.notifyChannels?.items?.enum, ["event", "async", "intercom"]);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Object.hasOwn(node, "description") && !Object.hasOwn(node, "type") && !Object.hasOwn(node, "anyOf")) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (node.type === "array" && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(missingItemsPaths, []);
	});

	it("keeps only top-level parameter descriptions to keep the provider payload compact", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const serialized = JSON.stringify(schema);
		assert.ok(serialized.length < 15_000, `expected compact schema under 15k chars, got ${serialized.length}`);
		assert.equal(serialized.includes('"$ref"'), false);
		assert.equal(serialized.includes('"$defs"'), false);
		assert.equal(serialized.split("Optional acceptance policy.").length - 1, 1);
		assert.match(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.agent?.description ?? ""), /SINGLE mode/);
		assert.match(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.acceptance?.description ?? ""), /acceptance policy/);

		const nestedDescriptionPaths: string[] = [];
		const stack: Array<{ path: string; value: unknown }> = [{ path: "SubagentParams", value: schema }];
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (!current.value || typeof current.value !== "object") continue;
			const node = current.value as JsonSchemaNode;
			const pathParts = current.path.split(".");
			const isTopLevelParameter = pathParts.length === 3 && pathParts[0] === "SubagentParams" && pathParts[1] === "properties";
			if (typeof node.description === "string" && !isTopLevelParameter) nestedDescriptionPaths.push(`${current.path}.description`);
			if (Array.isArray(current.value)) {
				current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
			} else {
				for (const [key, value] of Object.entries(node)) stack.push({ path: `${current.path}.${key}`, value });
			}
		}
		assert.deepEqual(nestedDescriptionPaths, []);
	});

	it("preserves TypeBox metadata while pruning provider-visible descriptions", () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		const schema = SubagentParams as unknown as JsonSchemaNode;
		const rootKind = Object.getOwnPropertyDescriptor(schema, "~kind");
		assert.equal(rootKind?.value, "Object");
		assert.equal(rootKind?.enumerable, false);

		const agentSchema = getPropertySchema(schema, ["agent"]);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~kind")?.enumerable, false);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.value, true);
		assert.equal(Object.getOwnPropertyDescriptor(agentSchema, "~optional")?.enumerable, false);

		const tasksSchema = getPropertySchema(schema, ["tasks"]);
		const taskItemsSchema = tasksSchema?.items as JsonSchemaNode | undefined;
		const taskCountSchema = getPropertySchema(taskItemsSchema, ["count"]);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~kind")?.enumerable, false);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.value, true);
		assert.equal(Object.getOwnPropertyDescriptor(taskCountSchema, "~optional")?.enumerable, false);
	});

	it("does not emit provider-rejected schema shapes", () => {
		const rejectedPaths: string[] = [];
		const rejectedKeywords = ["allOf", "const", "if", "then", "not"];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Array.isArray(node.type)) {
					rejectedPaths.push(`${current.path}.type`);
				}
				if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
					rejectedPaths.push(`${current.path}.type+anyOf`);
				}
				for (const keyword of rejectedKeywords) {
					if (Object.hasOwn(node, keyword)) rejectedPaths.push(`${current.path}.${keyword}`);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(rejectedPaths, []);
	});

	it("uses provider-friendly anyOf unions for flexible fields and chain items", () => {
		const skillSchema = SubagentParams?.properties?.skill;
		assert.ok(skillSchema, "skill schema should exist");
		assert.equal(skillSchema.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(skillSchema), true);
		assert.equal(hasAnyOfType(skillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(skillSchema, "string"), true);

		const outputSchema = SubagentParams?.properties?.output;
		assert.ok(outputSchema, "output schema should exist");
		assert.equal(outputSchema.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);

		const configSchema = SubagentParams?.properties?.config;
		assert.ok(configSchema, "config schema should exist");
		assert.equal(configSchema.type, undefined);
		assert.equal(anyOfBranches(configSchema).some((branch) => branch.type === "object" && branch.additionalProperties === true), true);
		assert.equal(hasAnyOfType(configSchema, "string"), true);

		const acceptanceSchema = SubagentParams?.properties?.acceptance;
		assert.ok(acceptanceSchema, "acceptance schema should exist");
		assert.equal(acceptanceSchema.type, undefined);
		assert.equal(hasAnyOfType(acceptanceSchema, "string"), true);
		assert.equal(hasAnyOfType(acceptanceSchema, "boolean"), true);
		const acceptanceObjectBranch = anyOfBranches(acceptanceSchema).find((branch) => branch.type === "object");
		assert.ok(acceptanceObjectBranch, "acceptance should support object config");
		assert.equal(acceptanceObjectBranch.additionalProperties, true);
		assert.equal(JSON.stringify(acceptanceObjectBranch).includes('"anyOf"'), false);

		const chainItem = SubagentParams?.properties?.chain?.items;
		assert.ok(chainItem, "chain item schema should exist");
		assert.equal(chainItem.type, "object");
		assert.equal(chainItem.anyOf, undefined);
		assert.equal(chainItem.allOf, undefined);
		assert.equal(chainItem.oneOf, undefined);
		assert.equal(chainItem.additionalProperties, false);
		assert.equal(chainItem.properties?.agent?.type, "string");
		assert.equal(chainItem.properties?.phase?.type, "string");
		assert.equal(chainItem.properties?.label?.type, "string");
		assert.equal(chainItem.properties?.as?.type, "string");
		assert.equal(chainItem.properties?.outputSchema?.type, "object");
		assert.equal(chainItem.properties?.parallel?.type, undefined);
		const parallelBranches = anyOfBranches(chainItem.properties?.parallel);
		const staticParallelBranch = parallelBranches.find((branch) => branch.type === "array");
		const dynamicParallelBranch = parallelBranches.find((branch) => branch.type === "object");
		assert.ok(staticParallelBranch, "parallel should support static task arrays");
		assert.ok(dynamicParallelBranch, "parallel should support a dynamic task template object");
		const chainParallelTask = (staticParallelBranch.items as { properties?: Record<string, JsonSchemaNode> } | undefined)?.properties;
		assert.equal(chainParallelTask?.agent?.type, "string");
		assert.equal(chainParallelTask?.phase?.type, "string");
		assert.equal(chainParallelTask?.label?.type, "string");
		assert.equal(chainParallelTask?.as?.type, "string");
		assert.equal(chainParallelTask?.outputSchema?.type, "object");
		const chainParallelOutputSchema = chainParallelTask?.output;
		assert.equal(chainParallelOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "boolean"), true);
		const chainParallelReadsSchema = chainParallelTask?.reads;
		assert.equal(chainParallelReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelReadsSchema), true);
		assert.equal(hasAnyOfType(chainParallelReadsSchema, "boolean"), true);
		assert.equal(chainItem.properties?.expand?.type, "object");
		assert.equal(chainItem.properties?.collect?.type, "object");
		const chainParallelSkillSchema = chainParallelTask?.skill;
		assert.equal(chainParallelSkillSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelSkillSchema), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "string"), true);
		const chainOutputSchema = chainItem.properties?.output as JsonSchemaNode | undefined;
		assert.equal(chainOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainOutputSchema, "boolean"), true);
		const chainReadsSchema = chainItem.properties?.reads as JsonSchemaNode | undefined;
		assert.equal(chainReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainReadsSchema), true);
		assert.equal(hasAnyOfType(chainReadsSchema, "boolean"), true);
	});

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ skill: "review" },
			{ skill: false },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: "review" }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", output: "review.md", reads: ["input.md"], progress: true }] },
			{ chain: [{ agent: "reviewer", reads: false }] },
			{ chain: [{ agent: "reviewer", phase: "Review", label: "Correctness", as: "findings", outputSchema: { type: "object" } }] },
			{ chain: [{ agent: "reviewer", skill: "review" }] },
			{ chain: [{ agent: "reviewer", skill: false }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: false, skill: false }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", phase: "Review", label: "Security", as: "security", outputSchema: { type: "object" } }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: "review.md", reads: ["input.md"], skill: "review" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 }, parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } }, collect: { as: "reviews" } }] },
			{ agent: "worker", task: "Fix", acceptance: false },
			{ agent: "worker", task: "Fix", timeoutMs: 1000 },
			{ tasks: [{ agent: "worker", task: "Fix" }], maxRuntimeMs: 1000 },
			{ chain: [{ agent: "worker", task: "Fix" }], timeoutMs: 1000, maxRuntimeMs: 1000 },
			{ agent: "worker", task: "Fix", acceptance: "checked" },
			{ agent: "worker", task: "Fix", acceptance: { level: "checked", review: false } },
			{ tasks: [{ agent: "worker", task: "Fix", acceptance: false }] },
			{ chain: [{ agent: "worker", acceptance: { level: "checked" } }] },
			{ chain: [{ parallel: [{ agent: "worker", acceptance: { level: "verified", verify: [{ id: "unit", command: "npm test" }] } }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "worker", acceptance: { level: "checked", review: false } }, collect: { as: "reviews" } }] },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];
		const invalidValues = [
			{ skill: 123 },
			{ skill: [123] },
			{ output: 123 },
			{ timeoutMs: 0 },
			{ maxRuntimeMs: -1 },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: 123 }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: "input.md" }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", skill: 123 }] }] },
			{ chain: [{ agent: "reviewer", outputSchema: "schema.json" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", outputSchema: "schema.json" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4, expression: "items" }, parallel: { agent: "reviewer" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer", as: "child" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer" }, collect: { as: "reviews" }, when: "later" }] },
			{ agent: "worker", task: "Fix", acceptance: true },
			{ tasks: [{ agent: "worker", task: "Fix", acceptance: true }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "worker", acceptance: true }, collect: { as: "reviews" } }] },
			{ config: [] },
			{ config: null },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});
