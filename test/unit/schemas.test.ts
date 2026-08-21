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
		workflowScript?: {
			type?: string;
			minLength?: number;
			description?: string;
		};
		chatProgress?: {
			type?: string;
			enum?: string[];
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
		turnBudget?: {
			properties?: {
				maxTurns?: { minimum?: number };
				graceTurns?: { minimum?: number };
			};
		};
		usageBudget?: {
			properties?: {
				tokens?: { properties?: { soft?: { exclusiveMinimum?: number }; hard?: { exclusiveMinimum?: number } } };
				costUsd?: { properties?: { soft?: { exclusiveMinimum?: number }; hard?: { exclusiveMinimum?: number } } };
			};
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
		view?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		lines?: {
			minimum?: number;
			maximum?: number;
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
let SubagentWaitParams: JsonSchemaNode | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
	SubagentWaitParams = schemas.SubagentWaitParams as JsonSchemaNode;
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
	it("includes context field and default precedence for fresh/fork execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork", "profile"]);
		const description = String(contextSchema.description ?? "");
		assert.match(description, /fresh/);
		assert.match(description, /fork/);
		assert.match(description, /profile/);
		assert.match(description, /declared defaultContext/);
		assert.match(description, /defaultSubagentContext wins over each agent defaultContext/);
		assert.match(description, /overrides every child/);
		assert.match(description, /implicit fork/);
		assert.match(description, /else fresh/);
	});

	it("exposes a concise trusted inline workflow script mode", () => {
		const workflowScript = SubagentParams?.properties?.workflowScript;
		assert.equal(workflowScript?.type, "string");
		assert.equal(workflowScript?.minLength, 1);
		assert.match(String(workflowScript?.description ?? ""), /runs\.run/);
		assert.match(String(workflowScript?.description ?? ""), /await runs\.all\(\[\{key, agent, task\}, \.\.\.\]\)/);
		assert.match(String(workflowScript?.description ?? ""), /do not read \.output from unawaited runs\.run launches/i);
		assert.match(String(workflowScript?.description ?? ""), /advanced rolling fanout/);
		assert.match(String(workflowScript?.description ?? ""), /sequential and parallel phases dynamically/i);
		assert.match(String(workflowScript?.description ?? ""), /worktree:true/i);
		assert.match(String(workflowScript?.description ?? ""), /no filesystem, shell, Pi tools, or host globals/i);
		const chatProgress = SubagentParams?.properties?.chatProgress;
		assert.equal(chatProgress?.type, "string");
		assert.deepEqual(chatProgress?.enum, ["auto", "off", "live-card"]);
		assert.match(String(chatProgress?.description ?? ""), /same Git repository/i);
		assert.match(String(chatProgress?.description ?? ""), /async:false/);
		assert.match(String(chatProgress?.description ?? ""), /omit chatProgress or use auto\/off/);
		const worktree = SubagentParams?.properties?.worktree;
		assert.equal(worktree?.type, "boolean");
		assert.match(String(worktree?.description ?? ""), /each workflow child/i);
		const isolation = SubagentParams?.properties?.isolation;
		assert.equal(isolation?.type, "string");
		assert.deepEqual(isolation?.enum, ["none", "worktree"]);
		const gate = SubagentParams?.properties?.gate;
		assert.equal(gate?.type, "string");
		assert.equal(gate?.minLength, 1);
		assert.match(String(gate?.description ?? ""), /cannot be combined with acceptance/i);
		const properties = SubagentParams?.properties as Record<string, JsonSchemaNode> | undefined;
		assert.equal(properties?.task?.type, "string");
		assert.match(String(properties?.task?.description ?? ""), /one-child/i);
		assert.match(String((properties?.agent as JsonSchemaNode | undefined)?.description ?? ""), /one-child/i);
		assert.equal(properties?.clarify, undefined, "clarify should not be model-facing");
		assert.ok(properties?.output, "output remains a workflow child default");
	});

	it("omits removed legacy and workflow-child-only fields", () => {
		for (const name of ["tasks", "chain", "concurrency", "chainDir", "step", "schedule", "scheduleName", "resume"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}

		assert.doesNotMatch(JSON.stringify(SubagentParams), /append-step|approve-checkpoint|reject-checkpoint|scheduleName/);
	});

	it("allows runtime validation of management and control action strings", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.equal(actionSchema.minLength, 1);
		assert.equal(actionSchema.enum, undefined);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Optional management\/control action/);
		assert.match(description, /Omit this field for structured single-child or workflowScript execution/);
		assert.match(description, /use it only for management\/control actions/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("keeps agentContract.version as integer bounds without an enum (Gemini schema subset)", () => {
		const agentContract = (SubagentParams?.properties as Record<string, JsonSchemaNode> | undefined)?.agentContract;
		assert.ok(agentContract, "agentContract schema should exist");
		const version = (agentContract.properties as Record<string, JsonSchemaNode> | undefined)?.version;
		assert.ok(version, "agentContract.version schema should exist");
		assert.equal(version.type, "integer");
		assert.equal(version.minimum, 1);
		assert.equal(version.maximum, 1);
		assert.equal(version.enum, undefined);
	});

	it("documents workflow timeout aliases and turn budget", () => {
		const timeoutSchema = SubagentParams?.properties?.timeoutMs;
		const maxRuntimeSchema = SubagentParams?.properties?.maxRuntimeMs;
		const turnBudgetSchema = SubagentParams?.properties?.turnBudget;
		const toolBudgetSchema = SubagentParams?.properties?.toolBudget;
		assert.ok(timeoutSchema, "timeoutMs schema should exist");
		assert.ok(maxRuntimeSchema, "maxRuntimeMs schema should exist");
		assert.equal(timeoutSchema.minimum, 1);
		assert.equal(maxRuntimeSchema.minimum, 1);
		assert.match(String(timeoutSchema.description ?? ""), /foreground and single async runs/i);
		assert.match(String(timeoutSchema.description ?? ""), /use config timeoutMs, else 30m/i);
		assert.match(String(timeoutSchema.description ?? ""), /async composites have no default parent deadline/i);
		assert.doesNotMatch(String(timeoutSchema.description ?? ""), /foreground-only/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /timeoutMs/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /foreground and single async runs/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /use config timeoutMs, else 30m/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /async composites have no default parent deadline/i);
		assert.equal(turnBudgetSchema?.properties?.maxTurns?.minimum, 1);
		assert.equal(turnBudgetSchema?.properties?.graceTurns?.minimum, 0);
		assert.equal(toolBudgetSchema?.properties?.soft?.minimum, 1);
		assert.equal(toolBudgetSchema?.properties?.hard?.minimum, 1);
	});

	it("includes root-only reported usage budget", () => {
		const usageBudgetSchema = SubagentParams?.properties?.usageBudget;
		assert.ok(usageBudgetSchema, "usageBudget schema should exist");
		assert.equal(usageBudgetSchema.properties?.tokens?.properties?.soft?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.tokens?.properties?.hard?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.costUsd?.properties?.soft?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.costUsd?.properties?.hard?.exclusiveMinimum, 0);
		assert.match(String(usageBudgetSchema.description ?? ""), /root-only/);
		assert.match(String(usageBudgetSchema.description ?? ""), /running children are not stopped/i);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);
		assert.match(String(idSchema.description ?? ""), /steer/i);
		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);
		assert.match(String(runIdSchema.description ?? ""), /steer/i);
		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);
		assert.match(String(dirSchema.description ?? ""), /steer/i);

		const viewSchema = SubagentParams?.properties?.view;
		assert.ok(viewSchema, "view schema should exist");
		assert.equal(viewSchema.type, "string");
		assert.deepEqual(viewSchema.enum, ["fleet", "transcript"]);
		assert.match(String(viewSchema.description ?? ""), /status view/i);
		assert.match(String(viewSchema.description ?? ""), /transcript/i);

		const linesSchema = SubagentParams?.properties?.lines;
		assert.ok(linesSchema, "lines schema should exist");
		assert.equal(linesSchema.minimum, 1);
		assert.equal(linesSchema.maximum, 500);
		assert.match(String(linesSchema.description ?? ""), /transcript/i);

		const additionalSchema = SubagentParams?.properties?.additional;
		assert.ok(additionalSchema, "additional schema should exist");
		assert.equal(additionalSchema.minimum, 1);
		assert.match(String(additionalSchema.description ?? ""), /grant-spawn-budget/);
		assert.match(String(additionalSchema.description ?? ""), /root interactive parent/i);

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

	it("exposes tolerant wait mode on subagent_wait", () => {
		const properties = SubagentWaitParams?.properties as Record<string, JsonSchemaNode> | undefined;
		const stopOnAttention = properties?.stopOnAttention;
		assert.ok(stopOnAttention, "stopOnAttention schema should exist");
		assert.equal(stopOnAttention.type, "boolean");
		assert.match(String(stopOnAttention.description ?? ""), /idle or long-thinking attention/);
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
		// Mission, inspector, inline workflow, guide, and toolTimeoutMs fields intentionally expanded the public tool surface.
		assert.ok(serialized.length < 17_400, `expected compact schema under 17.4k chars, got ${serialized.length}`);
		assert.equal(serialized.includes('"$ref"'), false);
		assert.equal(serialized.includes('"$defs"'), false);
		assert.equal(serialized.split("Optional acceptance policy.").length - 1, 1);
		assert.match(String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.agent?.description ?? ""), /management actions/);
		const acceptanceDescription = String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.acceptance?.description ?? "");
		assert.match(acceptanceDescription, /acceptance policy/);
		assert.match(acceptanceDescription, /Supported evidence kinds:/);
		assert.match(acceptanceDescription, /commands-run/);
		assert.match(acceptanceDescription, /changed-files/);
		assert.match(acceptanceDescription, /manual-notes/);
		assert.match(acceptanceDescription, /\{ level: "checked", evidence: \["commands-run", "changed-files"\] \}/);
		const missionDescription = String((schema.properties as Record<string, JsonSchemaNode> | undefined)?.mission?.description ?? "");
		assert.match(missionDescription, /exactly one non-empty title or summary/);
		assert.match(missionDescription, /goal may only be true/);
		assert.match(missionDescription, /requires budget\.tokens/);

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
		const acceptanceStringBranches = anyOfBranches(acceptanceSchema).filter((branch) => branch.type === "string");
		const acceptanceLevelBranch = acceptanceStringBranches.find((branch) => Array.isArray(branch.enum) && branch.enum.includes("auto"));
		assert.deepEqual(acceptanceLevelBranch?.enum, ["auto", "attested", "checked"], "verified requires object form with runtime commands");
		const reviewedRecoveryBranch = acceptanceStringBranches.find((branch) => Array.isArray(branch.enum) && branch.enum.includes("reviewed"));
		assert.deepEqual(reviewedRecoveryBranch?.enum, ["reviewed"]);
		assert.equal(reviewedRecoveryBranch?.deprecated, true);
		assert.match(String(acceptanceSchema.description ?? ""), /reviewer\/read-only calls, omit acceptance/i);
		assert.match(String(acceptanceSchema.description ?? ""), /acceptance\.review\.required/);
		const acceptanceObjectBranch = anyOfBranches(acceptanceSchema).find((branch) => branch.type === "object");
		assert.ok(acceptanceObjectBranch, "acceptance should support object config");
		assert.equal(acceptanceObjectBranch.additionalProperties, true);
		assert.equal(JSON.stringify(acceptanceObjectBranch).includes('"anyOf"'), false);

	});

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ skill: "review" },
			{ workflowScript: "return await runs.run(\"one\", {agent: \"reviewer\", task: \"check\"})" },
			{ skill: false },
			{ action: "get", agent: "worker" },
			{ workflowScript: "return runs.run('main', { agent: 'worker', task: 'Fix', acceptance: false })", timeoutMs: 1000 },
			{ action: "steer", id: "run-1", message: "focus on tests" },
			{ action: "steer", id: "run-1", index: 0, message: "focus on tests" },
			{ action: "not-a-real-action" },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];
		const invalidValues = [
			{ skill: 123 },
			{ agent: "worker", task: "Fix", acceptance: "none" },
			{ agent: "worker", task: "Fix", acceptance: "verified" },
			{ skill: [123] },
			{ output: 123 },
			{ timeoutMs: 0 },
			{ maxRuntimeMs: -1 },
			{ agent: "worker", task: "Fix", acceptance: true },
			{ config: [] },
			{ config: null },
			{ agent: "worker", task: "Fix", turnBudget: { maxTurns: 0 } },
			{ agent: "worker", task: "Fix", turnBudget: { maxTurns: 5, graceTurns: -1 } },
			{ agent: "worker", task: "Fix", turnBudget: { maxTurns: 1.5 } },
			{ agent: "worker", task: "Fix", turnBudget: { graceTurns: 1 } },
			{ agent: "worker", task: "Fix", turnBudget: { maxTurns: 5, graceTurns: 1, extra: true } },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 0 } },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3, soft: 0 } },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3, block: [123] } },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3, block: [] } },
			{ agent: "worker", task: "Fix", toolBudget: { hard: 3, block: "read" } },
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
