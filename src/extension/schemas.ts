/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";

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

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean" },
	],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "Default inline; file-only requires output path.",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running (array of filenames), or false to disable",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "Strict structured output; object-root JSON Schema only.",
});

// Provider boolean branches intentionally overapproximate false-only runtime inputs.
// Restricted function-declaration converters only support string enum members.
const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "attested", "checked"] },
		{
			type: "string",
			enum: ["reviewed"],
			deprecated: true,
			description: "Invalid as an explicit policy. Recognized only so preflight can explain that reviewed is an achieved status.",
		},
		{
			type: "string",
		},
		{ type: "boolean" },
		{ type: "object", additionalProperties: true },
	],
	description: "Evidence policy; omit for read-only/review. false disables; true invalid. Prefer object; see guide tool-reference for levels, evidence and review.required.",
});

const AgentContractOverride = Type.Object({
	version: Type.Integer({ minimum: 1, maximum: 1, description: "Enable compatibility behavior for this run/child." }),
}, { additionalProperties: false, description: "Compatibility behavior. Omit for the default behavior." });

const ChainGateOverride = Type.String({
	enum: ["execution", "acceptance"],
	description: "For chain steps with agentContract, choose whether the chain advances on execution success or acceptance success. Defaults to execution.",
});

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
}, { additionalProperties: false, description: "soft nudges; after hard, block tools (default read/grep/find/ls, '*' for all) so child can finalize." });

const UsageBudgetLimitOverride = Type.Object({
	soft: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	hard: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });

const UsageBudgetOverride = Type.Object({
	tokens: Type.Optional(UsageBudgetLimitOverride),
	costUsd: Type.Optional(UsageBudgetLimitOverride),
}, { additionalProperties: false, description: "Root-only reported usage; hard prevents later launches. Running children are not stopped." });

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
}, { additionalProperties: false, description: "Display-only lane hints; coverage mismatches warn, never change authority/execution." });

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this parallel task." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
});

export const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Prior named structured output to expand from." }),
		path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Template variable name for each item. Defaults to item." })),
	key: Type.Optional(Type.String({ description: "JSON Pointer relative to each item for stable child ids." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required fanout bound unless configured globally." })),
	onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Empty input behavior. Defaults to skip." })),
}, { additionalProperties: false });

export const DynamicParallelTemplateSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {item}, {item.path}, {task}, {previous}, {chain_dir}, and {outputs.name} variables." })),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label; item templates are supported." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
}, { additionalProperties: false });

export const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Safe output name for the ordered collected result array." }),
	outputSchema: Type.Optional(JsonSchemaObject),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
export const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first step, defaults to '{previous}' for subsequent steps."
	})),
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this chain step." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. This can increase quota or cost." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	agentContract: Type.Optional(AgentContractOverride),
	gateOn: Type.Optional(ChainGateOverride),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
			DynamicParallelTemplateSchema,
		],
		description: "Static parallel tasks array, or a single dynamic fanout child template when expand/collect are present.",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, {
	description: "Chain step: use {agent, task?, ...} for sequential, {parallel: [...]} for static concurrent execution, or {expand, parallel: {...}, collect} for dynamic fanout.",
	additionalProperties: false,
});

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
	extensionBindings: Type.Optional(Type.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Child-only bounded JSON; namespaces package.name/1." })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({ minLength: 1,
		description: "Management/control only; omit for execution. validate accepts either script input. Discover actions with guide topic tool-reference."
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
	repo: Type.Optional(Type.String({ description: "worktree.cleanup repo; default cwd." })),
	planId: Type.Optional(Type.String({ description: "Reserved; cleanup is plan-only." })),
	laneId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact manifest run id for lane actions." })),
	merge: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordMerge evidence; read guide tool-reference." })),
	supersession: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "lane.recordSupersession evidence; read guide tool-reference." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child/transcript index." })),
	childId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Child-scoped stop identity." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "status view: fleet overview or transcript tail with id/dir and optional index.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Transcript tail lines; default 80." })),
	topic: Type.Optional(Type.String()),
	message: Type.Optional(Type.String({ description: "resume/steer guidance or project.open prompt." })),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up", "auto", "plan", "apply"], description: "steer delivery mode; worktree.cleanup supports plan only, no apply/removal." })),
	steeringRecovery: Type.Optional(Type.Boolean({ description: "steer: pause/revive after missed acknowledgment; default true in direct steer mode, forced false by extension RPC for exact ownership." })),
	additional: Type.Optional(Type.Integer({ minimum: 1, description: "grant-spawn-budget: root interactive parent + native user confirmation only; total grants capped at original configured cap." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "watchdog.configure scope; default session, persistent only if explicit." })),
	target: Type.Optional(Type.String({ enum: ["main", "children", "child"], description: "Watchdog target." })),
	focus: Type.Optional(Type.Boolean({ description: "Focus inspector.open/project.open pane." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "watchdog.configure only: off/minimal/low/medium/high/xhigh/max, inherit, false=off; true invalid. Dispatch ignores this; use model suffix." })),
	at: Type.Optional(Type.String({ description: "schedule.create: delay (+10m) or zoned ISO timestamp." })),
	every: Type.Optional(Type.String({ description: "schedule.create interval, e.g. 30m/6h/2d/2w." })),
	sessionOnly: Type.Optional(Type.Boolean()),
	quiet: Type.Optional(Type.Boolean()),
	on: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "integer" }], description: "Reserved calendar selector." })),
	timezone: Type.Optional(Type.String()),
	overlap: Type.Optional(Type.String({ enum: ["skip"] })),
	catchUp: Type.Optional(Type.String({ enum: ["none", "latest"], description: "Missed schedule occurrences; default latest." })),
	missionId: Type.Optional(Type.String()),
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
	workflow: Type.Optional(Type.String({ minLength: 1, description: "Extension-owned workflow resource." })),
	args: Type.Optional(Type.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Bounded plain-JSON resource args." })),
	workflowScript: Type.Optional(Type.String({ minLength: 1, description: "Inline JavaScript statement body; raw/unknown provenance, no runs.host. Use explicit return and top-level await; see tool guidance/guide workflows." })),
	workflowScriptPath: Type.Optional(Type.String({ minLength: 1, description: "Raw script file; host reads from request cwd before sandbox. Mutually exclusive with workflowScript and workflow." })),
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
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout. Foreground and single async runs use config timeoutMs, else 30m; async composites have no default parent deadline. Alias maxRuntimeMs." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias timeoutMs (same defaults)." })),
	checkpointBeforeDeadlineMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Async single-agent runs only: the runner requests that the child checkpoint and stop this many ms before the run deadline (best-effort; the deadline kill still applies)." })),
	toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-tool deadline (ms); fast builtins default 5m." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	usageBudget: Type.Optional(UsageBudgetOverride),
	agentScope: Type.Optional(Type.String({ description: "user/project/both (default); project wins collisions." })),
	cwd: Type.Optional(Type.String({ description: "Execution/project-pane directory." })),
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
	outputSchema: Type.Optional(JsonSchemaObject),
	agentContract: Type.Optional(AgentContractOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	gate: Type.Optional(Type.String({ minLength: 1, description: "Host gate command. Cannot be combined with acceptance; an explicit acceptance of false is treated as omitted." })),
};

const SubagentParamsSchema = Type.Object(SubagentParamProperties);

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

export function createSubagentParamsSchema(): typeof SubagentParams {
	return SubagentParams;
}

const SubagentWaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({
		description: "Async run or remembered detached foreground run id/prefix to wait for one specific run. Ordinary async subagent runs already notify this session natively; use bg_wait for provider, detached, or other background work without native notification, or when same-turn blocking results are truly needed. Omit to wait across every active async run started in this session only when a same-turn wait is truly needed.",
	})),
	nonBlocking: Type.Optional(Type.Boolean({
		description: "When true, resolve id to one exact run, persist a wake subscription, and return immediately. Use this only for provider, detached, or other background work without a native completion notification; ordinary async subagent runs already notify this session natively and do not need a subscription. The originating session is woken on completion, failure, attention, reconciliation failure, or timeout. Requires id and cannot be combined with all.",
	})),
	all: Type.Optional(Type.Boolean({
		description: "Wait for ALL active runs to finish. Ordinary async subagent runs already notify this session natively; use all only when a same-turn result from tracked background work is truly needed. Default false: return when the first tracked run or provider item finishes or needs attention. Ignored when id targets a single run.",
	})),
	timeoutMs: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Give up waiting after this many milliseconds (the runs keep going regardless). Ordinary async subagent runs already notify this session natively; use a wait timeout only when same-turn results are truly needed for provider, detached, or other background work without native notification. Defaults to config waitTool.defaultTimeoutMs, then 1800000 (30 minutes). Window expiry is a non-error active-work result.",
	})),
	stopOnAttention: Type.Optional(Type.Boolean({
		description: "For a blocking wait that is truly needed, stop when a run needs attention by default. Set false to keep waiting through idle or long-thinking attention; supervisor/contact requests still stop the wait.",
	})),
});

export const SubagentWaitParams = keepTopLevelParameterDescriptions(SubagentWaitParamsSchema);
