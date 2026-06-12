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

function isRequiredOnlySchema(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length === 1 && keys[0] === "required";
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
		assert.match(description, /whole invocation/);
	});

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskSchema = SubagentParams?.properties?.tasks?.items?.properties;
		const taskCountSchema = taskSchema?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		assert.match(String(taskCountSchema.description ?? ""), /repeat/i);
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

	it("includes foreground run timeout aliases", () => {
		const timeoutSchema = SubagentParams?.properties?.timeoutMs;
		assert.ok(timeoutSchema, "timeoutMs schema should exist");
		assert.equal(timeoutSchema.minimum, 1);
		assert.match(String(timeoutSchema.description ?? ""), /foreground/i);
		assert.match(String(timeoutSchema.description ?? ""), /soft-interrupted/i);

		const maxRuntimeSchema = SubagentParams?.properties?.maxRuntimeMs;
		assert.ok(maxRuntimeSchema, "maxRuntimeMs schema should exist");
		assert.equal(maxRuntimeSchema.minimum, 1);
		assert.match(String(maxRuntimeSchema.description ?? ""), /alias/i);
	});

	it("uses an enum for management and control actions", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.deepEqual(actionSchema.enum, ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "doctor"]);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control action/);
		assert.match(description, /Omit for execution mode/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);

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

	it("does not encode acceptance contract presence with required-only schema nodes", () => {
		const rejectedPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown; insideAcceptance: boolean }> = [{ path: name, value: schema, insideAcceptance: false }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				const insideAcceptance = current.insideAcceptance
					|| (current.value && typeof current.value === "object" && !Array.isArray(current.value) && String((current.value as JsonSchemaNode).description ?? "").startsWith("Optional acceptance contract."));
				if (insideAcceptance && isRequiredOnlySchema(current.value)) rejectedPaths.push(current.path);
				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value, insideAcceptance }));
				} else if (current.value && typeof current.value === "object") {
					for (const [key, value] of Object.entries(current.value)) stack.push({ path: `${current.path}.${key}`, value, insideAcceptance });
				}
			}
		}

		assert.deepEqual(rejectedPaths, []);
	});

	it("does not emit provider-rejected union schema shapes", () => {
		const rejectedPaths: string[] = [];

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

		const chainItem = SubagentParams?.properties?.chain?.items;
		assert.ok(chainItem, "chain item schema should exist");
		assert.equal(chainItem.type, "object");
		assert.equal(chainItem.anyOf, undefined);
		assert.equal(chainItem.oneOf, undefined);
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
			{ agent: "worker", task: "Fix", acceptance: { criteria: ["Patch the bug"], evidence: ["changed-files"], maxFinalizationTurns: 2 } },
			{ agent: "worker", task: "Fix", acceptance: { verify: [{ id: "unit", command: "npm test" }] } },
			{ agent: "worker", task: "Fix", acceptance: {} },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];
		const invalidValues = [
			{ skill: 123 },
			{ skill: [123] },
			{ output: 123 },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: 123 }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: "input.md" }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", skill: 123 }] }] },
			{ chain: [{ agent: "reviewer", outputSchema: "schema.json" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", outputSchema: "schema.json" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: [{ agent: "reviewer" }], collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4, expression: "items" }, parallel: { agent: "reviewer" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer", as: "child" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer" }, collect: { as: "reviews" }, when: "later" }] },
			{ agent: "worker", task: "Fix", acceptance: true },
			{ agent: "worker", task: "Fix", acceptance: "checked" },
			{ agent: "worker", task: "Fix", acceptance: false },
			{ agent: "worker", task: "Fix", acceptance: { level: "checked" } },
			{ agent: "worker", task: "Fix", acceptance: { criteria: ["Patch"], review: true } },
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
