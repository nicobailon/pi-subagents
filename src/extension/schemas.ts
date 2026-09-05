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
	description: "Skill name(s) to make available (comma-separated), array of strings, or boolean (false disables, true uses default)",
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
	description: "Return saved output inline (default) or only a concise file reference. file-only requires output to be a path.",
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
	description: "JSON Schema object for strict structured output. Non-object roots are rejected.",
});

const AcceptanceEvidenceKinds = [
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
	"diff-summary",
	"review-findings",
	"manual-notes",
];

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
	description: `Optional acceptance policy. false disables acceptance; true is invalid. Prefer an inline JSON object. JSON-encoded object strings are tolerated only during input normalization; invalid strings fail closed. Reviewer/read-only calls, omit acceptance. { level: "checked", evidence: ["commands-run", "changed-files"] }. Supported evidence kinds: ${AcceptanceEvidenceKinds.join(",")}. acceptance.review.required.`,
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
}, { additionalProperties: false, description: "Optional bounded child lane metadata. Display/triage only; sourceRef is opaque and never resolved during status rendering." });

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
}, { additionalProperties: false, description: "Optional child tool-call budget. soft nudges the child; after hard, block tools (default read/grep/find/ls, or '*' for all tools) are blocked so the child can finalize." });

const UsageBudgetLimitOverride = Type.Object({
	soft: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	hard: Type.Number({ exclusiveMinimum: 0 }),
}, { additionalProperties: false });

const UsageBudgetOverride = Type.Object({
	tokens: Type.Optional(UsageBudgetLimitOverride),
	costUsd: Type.Optional(UsageBudgetLimitOverride),
}, { additionalProperties: false, description: "Optional root-only reported-usage budget. Hard limits prevent future child launches; running children are not stopped." });

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
}, { additionalProperties: false, description: "Bounded display-only lane hints for workflow launch/status. Coverage mismatches warn but never change launch authority or execution." });

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
	agent: Type.Optional(Type.String({ description: "Agent for one-child execution, or target for agent management actions." })),
	task: Type.Optional(Type.String({ description: "Optional one-child task. Requires agent; cannot combine with action, workflowScript, or workflowScriptPath." })),
	extensionBindings: Type.Optional(Type.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Namespaced, bounded plain-JSON metadata delivered only to the child runtime. Namespace keys use package.name/1 syntax." })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({ minLength: 1,
		description: "Optional management/control action. Use action='validate' with workflowScript or workflowScriptPath for offline checks. Omit this field for structured single-child or workflow execution; otherwise, use it only for management/control actions."
	})),
	capabilities: Type.Optional(Type.Boolean({ description: "For action='list', return compact capability rows and structured details without system prompts." })),
	name: Type.Optional(Type.String({ description: "Human-readable name for action='schedule.create'." })),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status/debug.run, interrupt, steer, or mission.attach-run."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID for debug.run, interrupt, steer, or mission.attach-run. Prefer id."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for status/debug.run, stop, resume, or steer."
	})),
	handoffPath: Type.Optional(Type.String({ description: "Existing parallel handoff manifest for worktree.discard, worktree.cleanup metadata, or lane evidence actions." })),
	repo: Type.Optional(Type.String({ description: "Repository path for action='worktree.cleanup'; defaults to cwd." })),
	planId: Type.Optional(Type.String({ description: "Cleanup plan id reserved for a future worktree.cleanup apply action." })),
	laneId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Exact manifest run id for lane.status, lane.recordMerge, or lane.recordSupersession." })),
	merge: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "Attested merge evidence for lane.recordMerge: prNumber, reviewedHead, mergeCommit, treeEquivalent, postMergeChecks, attestedBy, and attestedAt." })),
	supersession: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true, description: "Attested replacement-lane evidence for lane.recordSupersession: supersededBy, attestedBy, and attestedAt." })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child or transcript." })),
	childId: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Stable child identity for child-scoped stop requests." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "Optional status view. Use view='fleet' for a read-only active foreground/async fleet surface, or view='transcript' with id/dir (and optional index) to tail a run transcript.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum transcript lines for action='status', view='transcript'. Defaults to 80." })),
	topic: Type.Optional(Type.String()),
	message: Type.Optional(Type.String({ description: "Follow-up message for resume, live guidance for steer, or optional startup prompt for project.open." })),
	mode: Type.Optional(Type.String({ enum: ["steer", "follow_up", "auto", "plan", "apply"], description: "Delivery mode for action='steer', or plan/apply mode for worktree.cleanup. worktree.cleanup currently supports plan only; apply/removal is not available yet." })),
	steeringRecovery: Type.Optional(Type.Boolean({ description: "For action='steer', allow pause-and-revive recovery after a missed acknowledgment. Defaults true for direct tool calls in steer mode; extension RPC steering forces false so callers retain exact child ownership." })),
	additional: Type.Optional(Type.Integer({ minimum: 1, description: "Positive launches to add with action='grant-spawn-budget'. Root interactive parent with native user confirmation only; total grants cannot exceed the original configured cap." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "Scope for action='watchdog.configure'. Defaults to session to avoid persistent settings writes unless user/project is explicit." })),
	target: Type.Optional(Type.String({ enum: ["main", "children", "child"], description: "Target for watchdog actions." })),
	focus: Type.Optional(Type.Boolean({ description: "Focus the new Herdr pane for inspector.open or project.open." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean" }], description: "Thinking level for action='watchdog.configure' only (off/minimal/low/medium/high/xhigh/max, inherit, or false for off; true is invalid). Ignored on dispatch; set per-run child thinking with a suffix on the model string, e.g. model: 'provider/id:high'." })),
	at: Type.Optional(Type.String({ description: "One-shot trigger for action='schedule.create': a relative delay such as '+10m' or an ISO timestamp with timezone." })),
	every: Type.Optional(Type.String({ description: "Fixed recurring interval for action='schedule.create', such as '30m', '6h', '2d', or '2w'." })),
	sessionOnly: Type.Optional(Type.Boolean()),
	on: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "integer" }], description: "Calendar selector reserved for a later schedule slice." })),
	timezone: Type.Optional(Type.String()),
	overlap: Type.Optional(Type.String({ enum: ["skip"], description: "Overlap policy. This slice supports skip only." })),
	catchUp: Type.Optional(Type.String({ enum: ["none", "latest"], description: "Missed occurrence policy for recurring schedules. Defaults to latest." })),
	missionId: Type.Optional(Type.String({ description: "Mission id." })),
	mission: Type.Optional(Type.Unsafe({ ...MissionLaunchOverride, description: "Mission object, or false for no mission; true is invalid. Set exactly one non-empty title or summary; objective and labels are optional. goal may only be true and then requires budget.tokens." })),
	missionUpdate: Type.Optional(Type.Unsafe({ ...MissionUpdateOverride, description: "Mission update: objective, goal false or {paused:boolean}, budget, summary, labels, decisions, artifacts, or delivery receipts." })),
	missionStatus: Type.Optional(Type.String({ description: "Mission status." })),
	missionScope: Type.Optional(Type.String({ description: "Mission list scope: project (default) or global pointer index." })),
	runMode: Type.Optional(Type.String({ description: "Attached run mode." })),
	runStatus: Type.Optional(Type.String({ description: "Attached run status." })),
	summary: Type.Optional(Type.String({ description: "Mission close summary." })),
	// Agent configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent config for create/update. Object or JSON string."
	})),
	workflow: Type.Optional(Type.String({ minLength: 1, description: "Extension-owned workflow resource; resolves its script and authority internally." })),
	args: Type.Optional(Type.Unsafe({ type: "object", maxProperties: 16, additionalProperties: true, description: "Bounded plain-JSON args for workflow; resource validation applies." })),
	workflowScript: Type.Optional(Type.String({ minLength: 1, description: "Inline JavaScript statement body with unknown resource provenance. Normally async unless asyncByDefault:false; set async:true for async workflows and async:false only when the parent must block. Use explicit return, top-level await, plain helper functions, or explicit Promise chains. Nested async function, arrow, and method helpers are rejected. Globals: runs, emit, console, and mission state when enabled. No filesystem, shell, Pi tools, or host globals except through runs.host." })),
	workflowScriptPath: Type.Optional(Type.String({ minLength: 1, description: "Path to a JavaScript workflow file with unknown resource provenance. Mutually exclusive with workflowScript and workflow. Relative paths resolve against the request cwd. The host reads the file before the filesystem-free workflow sandbox starts." })),
	globalConcurrencyLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxSubagentSpawnsPerRun: Type.Optional(Type.Integer({ minimum: 1 })),
	preflight: Type.Optional(WorkflowPreflightOverride),
	chatProgress: Type.Optional(Type.String({ enum: ["auto", "off", "live-card"], description: "WorkflowScript chat progress projection. auto shows a live in-chat card only for watched foreground workflows in the same Git repository; it is off otherwise. Explicit live-card requires same-repository async:false; async workflows should omit chatProgress or use auto/off." })),
	isolation: Type.Optional(Type.String({ enum: ["none", "worktree"], description: "Workflow child isolation. none runs in the shared cwd; worktree requires managed git worktree isolation." })),
	worktree: Type.Optional(Type.Boolean({ description: "Managed child isolation. true gives each workflow child a separate git worktree; an individual runs.run/runs.all item can override a workflow default with worktree:false." })),
	baseRef: Type.Optional(Type.String()),
	lane: Type.Optional(WorkflowLaneMetadata),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork", "profile"],
		description: "'fresh' or 'fork' to branch from parent session, or 'profile' to require the selected agent's declared defaultContext. Explicit fresh/fork overrides every child; profile ignores config defaultSubagentContext and fails when an agent has no defaultContext. If omitted, config defaultSubagentContext wins over each agent defaultContext; implicit fork needs a persisted parent session and leaf, else fresh. Config forkContext may prune resolved forks before spawn without adding another context value.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Run in background unless asyncByDefault:false. Set false only when the parent must block until completion." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout. Foreground and single async runs use config timeoutMs, else 30m; async composites have no default parent deadline. Alias maxRuntimeMs." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias timeoutMs. Foreground and single async runs use config timeoutMs, else 30m; async composites have no default parent deadline." })),
	toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional hard per-tool-call timeout in milliseconds; known-fast built-in tools have a five-minute default." })),
	toolBudget: Type.Optional(ToolBudgetOverride),
	usageBudget: Type.Optional(UsageBudgetOverride),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)" })),
	cwd: Type.Optional(Type.String({ description: "Execution cwd, or target project directory for project.open/status/close." })),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	control: Type.Optional(ControlOverrides),
	// Workflow defaults forwarded to each runs.run/runs.all child unless overridden there.
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Default child output file (string), or false to disable. Relative workflow child paths use managed artifact routing. Task filename prose is not an output declaration; for durable workflow handoff, return the child's outputReference, outputPathMapping, or artifactPaths.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Default child model override. Full provider/id values are accepted; bare ids resolve from the active registry. Append a thinking suffix (off/minimal/low/medium/high/xhigh/max, e.g. 'provider/id:low') to set the child's thinking level for the run; the suffix wins over the agent's thinking default." })),
	fast: Type.Optional(Type.Boolean({ description: "Opt into priority service tier for supported native OpenAI-Codex child models. Default false. This can increase quota or cost." })),
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
