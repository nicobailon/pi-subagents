/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";
import type { DisabledFeatureSurface } from "../shared/disabled-features.ts";
import { MAX_ARGS_BYTES, MAX_ARGS_DEPTH, MAX_ARGS_FIELDS, MAX_ARGS_ITEMS } from "../workflows/workflow-resources.ts";

function keepTopLevelParameterDescriptions<T>(schema: T): T {
	return pruneNestedDescriptions(schema, []) as T;
}

function pruneNestedDescriptions(value: unknown, path: string[]): unknown {
	if (!value || typeof value !== "object") return value;

	const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (key === "description" && !isTopLevelParameterDescription(path)) continue;
		if ("value" in descriptor) {
			const nextPath = typeof key === "string" ? [...path, key] : path;
			descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
		}
		Object.defineProperty(result, key, descriptor);
	}
	return result;
}

function isTopLevelParameterDescription(path: string[]): boolean {
	return path.length === 2 && path[0] === "properties";
}

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "Skills: names/CSV/array; false disables, true uses default.",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "Default inline; file-only requires output path.",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "Strict structured output; object-root JSON Schema only.",
});

const OutputSchemaOverride = Type.Unsafe({
	anyOf: [JsonSchemaObject, { type: "boolean" }],
	description: "Structured output schema override; false disables an agent default.",
});

// Provider boolean branches intentionally overapproximate false-only runtime inputs.
// Restricted function-declaration converters only support string enum members.
const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "attested", "checked"] },
		{
			type: "string",
			enum: ["reviewed"],
			description: "Invalid as an explicit policy. Recognized only so preflight can explain that reviewed is an achieved status.",
		},
		{
			type: "string",
			pattern: "^\\s*\\{[\\s\\S]*$",
		},
		{ type: "boolean" },
		{ type: "object", additionalProperties: true },
	],
	description: "Evidence policy; omit for read-only/review. false disables; true invalid. Prefer object; see guide tool-reference for levels, evidence and review.required.",
});

const AgentContractOverride = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1, description: "Enable compatibility behavior for this run/child." }),
}, { additionalProperties: false, description: "Compatibility behavior. Omit for the default behavior." });

const WorkflowLaneMetadata = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1 }),
	key: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
	mode: Type.Optional(Type.String({ enum: ["mutation", "review", "scout", "gate"] })),
	sourceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	claims: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 20 })),
	outputPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 10 })),
}, { additionalProperties: false, description: "Display/triage only; sourceRef is opaque, never resolved by status." });

const ToolBudgetBlock = Type.Unsafe({
	anyOf: [
		{ type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
		{ type: "string", enum: ["*"] },
	],
});

const ToolBudgetOverride = Type.Object({
	soft: Type.Optional(Type.Integer({ minimum: 1 })),
	hard: Type.Integer({ minimum: 1 }),
	block: Type.Optional(ToolBudgetBlock),
}, { additionalProperties: false, description: "soft <= hard; after hard block read/grep/find/ls or '*' for all." });

const UsageBudgetLimitOverride = Type.Object({
	soft: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	hard: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });

const UsageBudgetOverride = Type.Object({
	tokens: Type.Optional(UsageBudgetLimitOverride),
	costUsd: Type.Optional(UsageBudgetLimitOverride),
}, { additionalProperties: false, minProperties: 1, description: "tokens or costUsd; soft <= hard. Root-only reported usage; blocks launches. Running children are not stopped." });

const WorkflowPreflightLane = Type.Object({
	key: Type.String({ minLength: 1, maxLength: 128 }),
	mode: Type.Optional(Type.String({ enum: ["mutation", "review", "scout", "gate"] })),
	decision: Type.Optional(Type.String({ maxLength: 256 })),
	claims: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 })),
	expectedOutput: Type.Optional(Type.String({ maxLength: 256 })),
	independence: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });

const WorkflowPreflightOverride = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1 }),
	coverage: Type.Optional(Type.String({ enum: ["complete", "partial"] })),
	lanes: Type.Array(WorkflowPreflightLane, { maxItems: 64 }),
}, { additionalProperties: false, description: "workflow: true or a script path only; display-only hints; coverage warns." });

// Runtime mission handlers validate these untrusted nested objects loudly. Keeping
// their provider schema shallow avoids repeating a full durable-record schema in
// every tool request.
const MissionLaunchOverride = Type.Unsafe({
	anyOf: [
		{ type: "object", additionalProperties: true },
		{ type: "boolean" },
	],
});
const MissionUpdateOverride = Type.Unsafe({ type: "object", additionalProperties: true });

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
});

const SubagentParamProperties = {
	agent: Type.Optional(Type.String({ description: "One-child agent or management target." })),
	task: Type.Optional(Type.String({ description: "One-child task; requires agent." })),
	extensionBindings: Type.Optional(Type.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Child-only plain JSON; package.name/1; depth 16, 256 props, 16 KiB." })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({ minLength: 1,
		description: "Management/control only; omit for execution. validate accepts workflow: true or a script path. Discover actions with guide topic tool-reference."
	})),
	capabilities: Type.Optional(Type.Boolean({ description: "list: compact capability rows/details without system prompts." })),
	name: Type.Optional(Type.String({ description: "schedule.create name." })),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status/control."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID; prefer id."
	})),
	dir: Type.Optional(Type.String({
		description: "Async directory for status/control."
	})),
	handoffPath: Type.Optional(Type.String({ description: "Existing manifest for worktree/lane actions." })),
	repo: Type.Optional(Type.String({ description: "Cleanup repo; apply requires it." })),
	planId: Type.Optional(Type.String({ description: "Reviewed cleanup plan for apply." })),
	laneId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact manifest run id for lane actions." })),
	merge: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordMerge evidence; read guide tool-reference." })),
	supersession: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordSupersession evidence; read guide tool-reference." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child/transcript index." })),
	childId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Child-scoped stop identity." })),
	toolCallId: Type.Optional(Type.String({ description: "Command tool-call id." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "status view: fleet overview or transcript tail with id/dir and optional index.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Transcript tail lines; default 80." })),
	topic: Type.Optional(Type.String()),
	message: Type.Optional(Type.String({ description: "resume/steer guidance or project.open prompt." })),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up", "auto", "plan", "apply"], description: "steer delivery; worktree.cleanup plan/apply (reviewed planId)." })),
	steeringRecovery: Type.Optional(Type.Boolean({ description: "steer: pause/revive after missed acknowledgment; default true in direct steer mode, forced false by extension RPC for exact ownership." })),
	additional: Type.Optional(Type.Integer({ minimum: 1, description: "grant-spawn-budget: root interactive parent + native user confirmation only; total grants capped at original configured cap." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "watchdog.configure scope; default session, persistent only if explicit." })),
	target: Type.Optional(Type.String({ enum: ["main", "children", "child"], description: "Watchdog target." })),
	focus: Type.Optional(Type.Boolean({ description: "Focus inspector.open/project.open pane." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "watchdog.configure only: off/minimal/low/medium/high/xhigh/max, inherit, false=off; true invalid. Dispatch ignores this; use model suffix." })),
	at: Type.Optional(Type.String({ description: "Delay/ISO or local HH:mm." })),
	every: Type.Optional(Type.String({ description: "Duration or day/week." })),
	sessionOnly: Type.Optional(Type.Boolean()),
	quiet: Type.Optional(Type.Boolean()),
	on: Type.Optional(Type.Array(Type.String({ enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }), { minItems: 1, description: "Weekly." })),
	timezone: Type.Optional(Type.String({ description: "IANA/UTC." })),
	overlap: Type.Optional(Type.String({ enum: ["skip"] })),
	catchUp: Type.Optional(Type.String({ enum: ["none", "latest"], description: "Missed; default latest." })),
	missionId: Type.Optional(Type.String({ description: "Existing mission to attach to a workflow or schedule.create; read guide missions for lifecycle and retention." })),
	mission: Type.Optional(Type.Unsafe({ ...MissionLaunchOverride, description: "false disables; true invalid. Object: exactly one non-empty title or summary; objective/labels optional; goal only true, requires budget.tokens." })),
	missionUpdate: Type.Optional(Type.Unsafe({ ...MissionUpdateOverride, description: "Mission patch; read guide missions." })),
	missionStatus: Type.Optional(Type.String()),
	missionScope: Type.Optional(Type.String({ description: "project (default) or global pointer index." })),
	runMode: Type.Optional(Type.String({ description: "Attached run mode." })),
	runStatus: Type.Optional(Type.String({ description: "Attached run status." })),
	summary: Type.Optional(Type.String({ description: "Mission close summary." })),
	// Agent configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "create/update agent config; object or JSON string."
	})),
	workflow: Type.Optional(Type.Unsafe<string | true>({
		anyOf: [{ type: "boolean" }, { type: "string", minLength: 1 }],
		description: "true: run the one ```js workflow block written in this same reply (false invalid). String with '/': script file read from request cwd. Other string: named workflow resource. Raw scripts (true or path) have no runs.host.",
	})),
	args: Type.Optional(Type.Unsafe({ type: "object", maxProperties: MAX_ARGS_FIELDS, additionalProperties: true, description: `Plain-JSON args for workflow; ${MAX_ARGS_FIELDS} fields/object, ${MAX_ARGS_ITEMS} items/array, depth ${MAX_ARGS_DEPTH}, ${MAX_ARGS_BYTES / 1024} KiB total; raw-script args are exposed deeply frozen and persisted, so do not include secrets.` })),
	globalConcurrencyLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxSubagentSpawnsPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
	preflight: Type.Optional(WorkflowPreflightOverride),
	chatProgress: Type.Optional(Type.String({ enum: ["auto", "off", "live-card"], description: "auto: live card only for watched foreground in same Git repository. live-card requires same-repo async:false; async: omit or auto/off." })),
	isolation: Type.Optional(Type.String({ enum: ["none", "worktree"], description: "Shared cwd or managed git worktrees." })),
	worktree: Type.Optional(Type.Boolean({ description: "Isolate each workflow child in a managed git worktree; child worktree:false overrides default." })),
	baseRef: Type.Optional(Type.String()),
	lane: Type.Optional(WorkflowLaneMetadata),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork", "profile"],
		description: "fresh/fork overrides every child; profile requires agent's declared defaultContext, ignoring config. Omitted: defaultSubagentContext wins over each agent defaultContext; implicit fork needs persisted parent + leaf, else fresh. forkContext may prune forks before spawn.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Background; default asyncByDefault. false only to block parent." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Foreground and single async runs use config timeoutMs, else 30m; async composites have no default parent deadline. Alias maxRuntimeMs; must agree." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias timeoutMs (same defaults)." })),
	checkpointBeforeDeadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Async single-agent runs only: the runner requests that the child checkpoint and stop this many ms before the run deadline (best-effort; the deadline kill still applies)." })),
	toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-tool deadline (ms); fast builtins default 5m." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	usageBudget: Type.Optional(UsageBudgetOverride),
	agentScope: Type.Optional(Type.String({ description: "user/project/both (default); project wins collisions." })),
	cwd: Type.Optional(Type.String({ description: "Execution/project-pane directory." })),
	machine: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Herdr saved machine id or label; runs an external CLI agent there. cwd then means the directory on that machine." })),
	artifacts: Type.Optional(Type.Boolean({ description: "Debug artifacts; default true." })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Full result progress; default false." })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist; default false." })),
	sessionDir: Type.Optional(
		Type.String({ description: "Session log directory; default temp, independent of share." }),
	),
	control: Type.Optional(ControlOverrides),
	// Workflow defaults forwarded to each runs.run/runs.all child unless overridden there.
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Child output path or false; relative workflow paths use managed artifact routing. Bind durable output here, not task prose; return outputReference/outputPathMapping/artifactPaths.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Child model provider/id; bare id only if unique. Suffix :off/minimal/low/medium/high/xhigh/max overrides agent thinking default." })),
	fast: Type.Optional(Type.Boolean({ description: "Native OpenAI-Codex priority tier; default false, may cost more/quota." })),
	outputSchema: Type.Optional(OutputSchemaOverride),
	agentContract: Type.Optional(AgentContractOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	gate: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string", minLength: 1 },
			{ type: "object", properties: { command: { type: "string", minLength: 1 }, output: { type: "string", enum: ["json"] }, schema: { type: "object" }, timeoutMs: { type: "integer", minimum: 1 } }, required: ["command"], additionalProperties: false },
		],
		description: "Host gate command run after the child finishes: a string, or an object; with output \"json\", passing stdout becomes structuredOutput (not with outputSchema). Cannot be combined with acceptance except false (treated as omitted).",
	})),
};

const SubagentParamsSchema = Type.Object(SubagentParamProperties);

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

// Replaces workflow scripts when disabledFeatures lists "workflow-scripts". Kept small because every
// field is sent on every request; the executor validates step shapes and placeholders strictly.
const StructuredTask = { type: "object", properties: { agent: { type: "string", minLength: 1 }, task: { type: "string" } }, required: ["agent", "task"], additionalProperties: false };
const StructuredWorkflowProperties = {
	action: Type.Optional(Type.String({ minLength: 1, description: "Management/control only; omit for execution. Discover actions with guide topic tool-reference." })),
	task: Type.Optional(Type.String({ description: "One-child task with agent, or the original request ({task}) with chain/tasks." })),
	tasks: Type.Optional(Type.Unsafe({ type: "array", minItems: 1, items: StructuredTask, description: "Parallel children; results in order." })),
	// Flattened step: {agent, task?, as?} or {parallel}; no object-shape union for provider converters.
	chain: Type.Optional(Type.Unsafe({
		type: "array",
		minItems: 1,
		items: { type: "object", properties: { agent: { type: "string", minLength: 1 }, task: { type: "string" }, as: { type: "string" }, parallel: { type: "array", minItems: 1, items: StructuredTask } }, additionalProperties: false },
		description: "Sequential steps: {agent,task?,as?} or {parallel:[{agent,task}]}.",
	})),
};

export function createSubagentParamsSchema(disabled?: DisabledFeatureSurface): typeof SubagentParams {
	if (!disabled || disabled.params.size === 0) return SubagentParams;
	const structured = disabled.features.has("workflow-scripts");
	const enabledProperties = Object.fromEntries(Object.entries(SubagentParamProperties).flatMap(([name, schema]) => {
		if (disabled.params.has(name)) return [];
		if (structured && name === "action") return [[name, StructuredWorkflowProperties.action]];
		if (structured && name === "task") return [[name, StructuredWorkflowProperties.task], ["tasks", StructuredWorkflowProperties.tasks], ["chain", StructuredWorkflowProperties.chain]];
		return [[name, schema]];
	}));
	// SAFETY: only optional properties are dropped or added; the executor rejects disabled options and admits chain/tasks at runtime.
	return keepTopLevelParameterDescriptions(Type.Object(enabledProperties)) as typeof SubagentParams;
}

const SubagentWaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Run id or prefix." })),
	nonBlocking: Type.Optional(Type.Boolean({ description: "Subscribe to id's wake and return immediately; requires id, not with all." })),
	all: Type.Optional(Type.Boolean({ description: "Wait for all work active at call time." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Max wait; default waitTool.defaultTimeoutMs, then 30 min." })),
	stopOnAttention: Type.Optional(Type.Boolean({ description: "false: keep waiting through idle or long-thinking attention." })),
});

export const SubagentWaitParams = keepTopLevelParameterDescriptions(SubagentWaitParamsSchema);
