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
		workflow?: JsonSchemaNode;
		args?: JsonSchemaNode;
		globalConcurrencyLimit?: {
			type?: string;
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		maxSubagentSpawnsPerRun?: {
			type?: string;
			minimum?: number;
			maximum?: number;
			description?: string;
		};
		preflight?: JsonSchemaNode;
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
		capabilities?: {
			type?: string;
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

let schemas: Record<string, JsonSchemaNode> = {};
// Full flat property schemas: RPC validation and model `options` validation both use these definitions.
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentFlatParams as SubagentParamsSchema;
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
	it("accepts object or false output schema overrides and rejects null", () => {
		assert.ok(SubagentParams);
		assert.ok(CompileSchema);
		const validator = CompileSchema!(SubagentParams);
		const base = { agent: "worker", task: "work" };
		assert.equal(validator.Check({ ...base, outputSchema: { type: "object" } }), true);
		assert.equal(validator.Check({ ...base, outputSchema: false }), true);
		assert.equal(validator.Check({ ...base, outputSchema: null }), false);
	});

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

	it("exposes one workflow field for the reply block, script paths, and named resources", () => {
		const workflow = SubagentParams?.properties?.workflow;
		assert.equal(hasAnyOfType(workflow, "boolean"), true);
		assert.equal(anyOfBranches(workflow).find((branch) => branch.type === "string")?.minLength, 1);
		assert.match(String(workflow?.description ?? ""), /true: run the one ```js workflow block written in this same reply/);
		assert.match(String(workflow?.description ?? ""), /String with '\/': script file read from request cwd/);
		assert.match(String(workflow?.description ?? ""), /Other string: named workflow resource/);
		assert.match(String(workflow?.description ?? ""), /no runs.host/);
		const args = SubagentParams?.properties?.args;
		assert.equal(args?.type, "object");
		assert.equal(args?.maxProperties, 16);
		assert.match(String(args?.description ?? ""), /plain-JSON args for workflow; 16 fields\/object, 64 items\/array, depth 8, 16 KiB total;/i);
		assert.match(String(args?.description ?? ""), /raw-script.*deeply frozen.*persisted.*secrets/i);
		for (const name of ["globalConcurrencyLimit", "maxSubagentSpawnsPerRun"] as const) {
			const capacity = SubagentParams?.properties?.[name];
			assert.equal(capacity?.type, "integer");
			assert.equal(capacity?.minimum, 1);
		}
		const preflight = SubagentParams?.properties?.preflight;
		assert.equal(preflight?.type, "object");
		assert.equal(preflight?.additionalProperties, false);
		assert.match(String(preflight?.description ?? ""), /display-only/i);
		assert.equal((preflight?.properties as JsonSchemaNode | undefined)?.version?.minimum, 1);
		assert.equal((preflight?.properties as JsonSchemaNode | undefined)?.version?.maximum, 1);
		assert.equal((preflight?.properties as JsonSchemaNode | undefined)?.lanes?.maxItems, 64);
		const chatProgress = SubagentParams?.properties?.chatProgress;
		assert.equal(chatProgress?.type, "string");
		assert.deepEqual(chatProgress?.enum, ["auto", "off", "live-card"]);
		assert.match(String(chatProgress?.description ?? ""), /same Git repository/i);
		assert.match(String(chatProgress?.description ?? ""), /async:false/);
		assert.match(String(chatProgress?.description ?? ""), /async: omit or auto\/off/);
		const worktree = SubagentParams?.properties?.worktree;
		assert.equal(worktree?.type, "boolean");
		assert.match(String(worktree?.description ?? ""), /each workflow child/i);
		const isolation = SubagentParams?.properties?.isolation;
		assert.equal(isolation?.type, "string");
		assert.deepEqual(isolation?.enum, ["none", "worktree"]);
		const gate = SubagentParams?.properties?.gate;
		assert.equal(hasAnyOfType(gate, "string"), true);
		assert.equal(hasAnyOfType(gate, "object"), true);
		const gateObject = anyOfBranches(gate).find((branch) => branch.type === "object");
		assert.deepEqual(gateObject?.required, ["command"]);
		assert.deepEqual((gateObject?.properties as Record<string, JsonSchemaNode> | undefined)?.output?.enum, ["json"]);
		assert.match(String(gate?.description ?? ""), /cannot be combined with acceptance/i);
		const properties = SubagentParams?.properties as Record<string, JsonSchemaNode> | undefined;
		assert.equal(properties?.task?.type, "string");
		assert.match(String(properties?.task?.description ?? ""), /one-child/i);
		assert.match(String((properties?.agent as JsonSchemaNode | undefined)?.description ?? ""), /one-child/i);
		assert.equal(properties?.clarify, undefined, "clarify should not be model-facing");
		assert.ok(properties?.output, "output remains a workflow child default");
		assert.match(String(properties?.output?.description ?? ""), /relative workflow paths use managed artifact routing/i);
		assert.match(String(properties?.output?.description ?? ""), /Bind durable output here, not task prose/i);
		assert.match(String(properties?.output?.description ?? ""), /outputReference.*outputPathMapping.*artifactPaths/i);
	});

	it("omits removed legacy and workflow-child-only fields", () => {
		for (const name of ["tasks", "chain", "concurrency", "chainDir", "step", "schedule", "scheduleName", "resume", "workflowScript", "workflowScriptPath"]) {
			assert.equal((SubagentParams?.properties as Record<string, unknown> | undefined)?.[name], undefined, `${name} should not be public`);
		}
	});

	it("allows runtime validation of management and control action strings", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.equal(actionSchema.minLength, 1);
		assert.equal(actionSchema.enum, undefined);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control only; omit for execution/);
		assert.match(description, /validate accepts workflow: true or a script path/);
		assert.match(description, /\{action:"guide",options:\{topic:"tool-reference"\}\}/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("accepts prompt-free capability discovery on list requests", () => {
		const capabilitiesSchema = SubagentParams?.properties?.capabilities;
		assert.ok(capabilitiesSchema, "capabilities schema should exist");
		assert.equal(capabilitiesSchema.type, "boolean");
		const description = String(capabilitiesSchema.description ?? "");
		assert.match(description, /list:/i);
		assert.match(description, /compact/i);
		assert.match(description, /system prompt/i);

		if (CompileSchema) {
			const validator = CompileSchema(SubagentParams);
			assert.equal(validator.Check({ action: "list", capabilities: true }), true);
			assert.equal(validator.Check({ action: "list", capabilities: "true" }), false);
		}
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

	it("documents workflow timeout aliases and omits removed turn budgets", () => {
		const timeoutSchema = SubagentParams?.properties?.timeoutMs;
		const maxRuntimeSchema = SubagentParams?.properties?.maxRuntimeMs;
		const turnBudgetSchema = SubagentParams?.properties?.turnBudget;
		const toolBudgetSchema = SubagentParams?.properties?.toolBudget;
		assert.ok(timeoutSchema, "timeoutMs schema should exist");
		assert.ok(maxRuntimeSchema, "maxRuntimeMs schema should exist");
		assert.equal(timeoutSchema.minimum, 1);
		assert.equal(maxRuntimeSchema.minimum, 1);
		assert.match(String(timeoutSchema.description ?? ""), /config timeoutMs, else 30m foreground/i);
		assert.match(String(timeoutSchema.description ?? ""), /background runs get none with a UI \(30-min check-ins\) and 30m without/i);
		assert.match(String(timeoutSchema.description ?? ""), /async composites have no default parent deadline/i);
		assert.doesNotMatch(String(timeoutSchema.description ?? ""), /foreground-only/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /timeoutMs/i);
		assert.match(String(maxRuntimeSchema.description ?? ""), /Alias timeoutMs \(same defaults\)/);
		assert.equal(turnBudgetSchema, undefined);
		assert.equal(toolBudgetSchema?.properties?.soft?.minimum, 1);
		assert.equal(toolBudgetSchema?.properties?.hard?.minimum, 1);
	});

	it("includes root-only reported usage budget", () => {
		const usageBudgetSchema = SubagentParams?.properties?.usageBudget;
		assert.ok(usageBudgetSchema, "usageBudget schema should exist");
		assert.ok(CompileSchema);
		const validator = CompileSchema!(SubagentParams);
		assert.equal(validator.Check({ usageBudget: {} }), false);
		assert.equal(validator.Check({ usageBudget: { tokens: { hard: 1 } } }), true);
		assert.equal(usageBudgetSchema.properties?.tokens?.properties?.soft?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.tokens?.properties?.hard?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.costUsd?.properties?.soft?.exclusiveMinimum, 0);
		assert.equal(usageBudgetSchema.properties?.costUsd?.properties?.hard?.exclusiveMinimum, 0);
		assert.match(String(usageBudgetSchema.description ?? ""), /root-only/i);
		assert.match(String(usageBudgetSchema.description ?? ""), /running children are not stopped/i);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /control/i);
		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /prefer id/i);
		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);
		assert.match(String(dirSchema.description ?? ""), /control/i);

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

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		// Transport accepts both booleans; semantic boundaries still reject unsupported true.
		for (const field of ["acceptance", "mission", "thinking"]) {
			assert.deepEqual(anyOfBranches(SubagentParams.properties[field]).find((branch) => branch.type === "boolean"), { type: "boolean" });
			assert.equal(validator.Check({ [field]: false }), true);
			assert.equal(validator.Check({ [field]: true }), true);
			assert.equal(validator.Check({ [field]: 123 }), false);
		}
		for (const acceptance of ["auto", "attested", "checked", false, { level: "checked" }, '{"level":"checked"}', '  \n {"level":"checked"}']) {
			assert.equal(validator.Check({ agent: "worker", task: "Fix", acceptance }), true, `${JSON.stringify(acceptance)} acceptance should validate`);
		}
		for (const acceptance of ["cheked", "none", "verified", "not-json", '[{"level":"checked"}]']) {
			assert.equal(validator.Check({ agent: "worker", task: "Fix", acceptance }), false, `${JSON.stringify(acceptance)} acceptance should not validate`);
		}
		const validValues = [
			{ skill: "review" },
			{ workflow: true },
			{ workflow: "workflows/review.js" },
			{ skill: false },
			{ action: "get", agent: "worker" },
			{ workflow: true, timeoutMs: 1000 },
			{ action: "steer", id: "run-1", message: "focus on tests" },
			{ action: "steer", id: "run-1", index: 0, message: "focus on tests" },
			{ action: "not-a-real-action" },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
			{ agent: "worker", task: "Fix", acceptance: JSON.stringify({ level: "checked", evidence: ["commands-run"] }) },
		];
		const invalidValues = [
			{ workflow: "" },
			{ workflow: 123 },
			{ skill: 123 },
			{ skill: [123] },
			{ output: 123 },
			{ timeoutMs: 0 },
			{ maxRuntimeMs: -1 },
			{ config: [] },
			{ config: null },
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
