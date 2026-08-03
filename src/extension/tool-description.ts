import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and only run executable/non-disabled agents or chains.
• Keep execution and management separate: omit action for SINGLE/PARALLEL/CHAIN execution; use action only for management/control, including mission.create/list/show/update/attach-run/close.
• Async/background runs are the default for ordinary launches. Agent profiles with runner.type='external-cli' are async-only, one-shot commands using argv plus stdin (never a shell); they support timeout/stop and artifacts but not clarify/foreground, steer/resume, or Pi-only model/tool/protocol fields. Use async:false only when a blocking foreground Pi result is needed; clarify:true also stays foreground. Do not sleep or poll status just to wait. In an interactive session, normally return control and let Pi wake you; do not call subagent_wait merely to wait. Override that default and call subagent_wait when the current request is run-to-completion — for example, the user asked you to report results back before continuing or a skill must finish in one turn. Headless sessions auto-drain current-session work at agent_end; use subagent_wait when this turn must receive results before it ends.
• Child-safety boundary: ordinary child subagents are not orchestrators and must not run subagents. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Writing/review safety: keep one writer for the same cwd/worktree. Use fresh-context read-only reviewers/validators for independent review, then have the parent synthesize and apply fixes as the sole writer unless an isolated worktree was intentionally requested.
• Artifacts/status essentials: chain outputs live under {chain_dir}; async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `To delegate work, call with { agent, task } for one child or { workflowScript } for composed orchestration; omit action. Use action only for management/control actions. Compatibility tasks[] and chain[] inputs remain supported for existing static callers.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• SCRIPTED WORKFLOW: { workflowScript: "const scan = await runs.run('scan', {agent:'agent-a', task:'...'}); return scan.output" } - the primary surface for sequence, parallelism, branching, retries, aggregation, and long-running orchestration. Starts asynchronously by default and returns a workflow id; pass async:false only for a small foreground smoke run. Stable keys are required. Workflow-level child execution controls (including turn/tool budgets and mission attachment) default onto each runs.run launch; explicit runs.run fields override them. A workflow usageBudget is enforced once across the workflow. Available globals are runs.run, runs.all, runs.status, runs.ref/refs, emit, console, and standard JavaScript only. Scripts cannot access filesystem, shell, arbitrary Pi tools, or host globals.
• PARALLEL (compatibility): tasks[] remains supported for existing static concurrent callers; prefer runs.all(...) in workflowScript for new orchestration.
• CHAIN (compatibility): chain[] remains supported for existing static sequential callers; prefer workflowScript for new orchestration.
• Optional context: { context: "fresh" | "fork" } (explicit value overrides every child; when omitted, each requested agent uses its own defaultContext, otherwise "fresh"; inspect agent defaults via { action: "list" })
• Durable mission attachment is automatic for ordinary task launches by default; pass missionId to attach an existing mission, mission:{title,goal?,labels?} to override the auto-created record, mission:false for intentionally ephemeral work, or set config.missions.enabled=false to disable auto-create.
• Fork thinking: model strings accept a thinking suffix (provider/model:off|minimal|low|medium|high|xhigh|max). Forking over a parent transcript that carries signed Anthropic thinking blocks forces thinking off only when a child's effective primary or fallback model resolves to the Anthropic provider or anthropic-messages API; unresolved models are treated conservatively. The result notes affected children, including on failures. Use fresh context when an Anthropic child needs thinking.
• Optional timeout: { timeoutMs } or { maxRuntimeMs } sets a run-level max runtime for foreground and async/background runs; foreground defaults to 30 minutes only when neither value nor an agent timeout is provided
• External CLI profiles: runner.type='external-cli' executes the configured command without a shell, sends the combined profile instructions/task over stdin, and requires async/background mode
• Acceptance: omit acceptance for reviewer/read-only calls. Evidence levels end at verified. Use acceptance.review.required to require independent review of a writer result. Never request acceptance:"reviewed"; reviewed is achieved only after an independent reviewer result.
• If { action: "list" } shows proactive skill subagent suggestions, consider a small fresh-context fanout for broad tasks where one of those skills would materially help

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

CHAIN EXAMPLES (quick reference for the nested schema):
• Sequential: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }
• Parallel fan-out: { chain: [{parallel: [{agent:"agent-a", task:"Check part of {task}", count: 3}]}] }
• Mixed: { chain: [{agent:"agent-a", task:"Research {task}"}, {checkpoint:"review", message:"Approve implementation?"}, {parallel: [{agent:"agent-b", task:"Review {previous}", count: 2}]}, {agent:"agent-c", task:"Summarize {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "models", agent?: "name" } - show the runtime-loaded builtin subagent model mapping, optionally filtered to one builtin
• { action: "watchdog.status" | "watchdog.check" | "watchdog.recommend-model" } - inspect the opt-in subagent watchdog and its strong complementary model recommendation
• { action: "watchdog.configure", model: "recommended" | "inherit" | "provider/model[:thinking]", scope?: "session" | "user" | "project", target?: "main" | "children" | "child", agent?: "name", thinking?: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } - configure watchdog model selection; default scope is session, use persistent scopes only when the user asks
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, acceptance, acceptanceRole: "read-only" | "writer", ... } }
• acceptanceRole affects inferred acceptance only, never tool access. Explicit task mutation/no-edit intent wins; omission preserves name heuristics. Update with false or an empty string to clear it.
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• { action: "eject", agent: "reviewer", agentScope?: "user" | "project" } - copy a bundled/package agent to user/project scope as an editable custom file that shadows the original (default scope: user)
• { action: "disable", agent: "reviewer", agentScope?: "user" | "project" } - hide any agent from runtime discovery via a reversible settings override (default scope: user)
• { action: "enable", agent: "reviewer", agentScope?: "user" | "project" } - remove a disabled override and restore discovery
• { action: "reset", agent: "reviewer", agentScope?: "user" | "project" } - delete the scope's custom agent file and/or settings override, restoring the bundled default
• { action: "grant-spawn-budget", additional: 10 } - add bounded capacity from the root interactive parent after authority resolution; grants are rejected while children are active and cumulative grants cannot exceed the original configured cap
• Mission actions: mission.create/list/show/update/attach-run/close. Project records live under .pi-subagents/missions by default; mission.show is the resume entry point, and mission.list with missionScope:"global" reads the user-global pointer index.
• { action: "worktree.discard", handoffPath: "<parallelHandoff.path>" } - permanently remove preserved managed worktrees and temporary branches after authority resolution.
• Herdr panes (optional, Herdr 0.7.5+): inspector.open/status/close target async lifecycle artifacts; project.open/status/close manage project-rooted Pi panes for cross-project orchestration. focus applies when opening a pane; ordinary subagents remain headless.
• Use chainName for chain operations; packaged chains also use dotted runtime names

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "status", view: "fleet" } - read-only active foreground/async fleet view with transcript commands
• { action: "status", id: "...", view: "transcript", index?: 0, lines?: 80 } - tail a run or child output/session transcript
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "stop", id: "..." } - stop a current-session top-level async run; stopped runs finish with state "stopped"
• { action: "resume", id: "...", message: "...", index?: 0 } - revive a paused, completed, or failed async/foreground child from its session; stopped runs are non-resumable; routed nested runs may accept live follow-ups; use steer for a live top-level async child
• { action: "steer", id: "...", message: "...", index?: 0 } - await correlated child-Pi input acceptance for up to 3 seconds; returns delivered, scheduled, pending, partial, recovered, or failed with a request id. Only top-level single runs may recover after a further 15-second pause/revival bound; chain, parallel, and nested runs never auto-interrupt.
• { action: "append-step", id: "...", chain: [{agent:"agent-c", task:"Use {previous}"}] } - append one step to the tail of a running async chain
• { action: "approve-checkpoint", id: "..." } / { action: "reject-checkpoint", id: "..." } - decide a paused current-session async chain checkpoint

SCHEDULE (enabled by default; disable with { "scheduledRuns": { "enabled": false } } in config.json):
• { action: "schedule", agent, task?, schedule: "+10m" | "2030-01-01T09:00:00Z", scheduleName? } - defer a subagent launch until a future time. Also accepts tasks[] or chain[]. Scheduled runs always launch async with fresh context; they become normal tracked async runs once they fire. Only schedule explicit delayed runs the user asked for.
• { action: "schedule-list" } - list scheduled runs for this session
• { action: "schedule-status", id: "..." } - inspect one scheduled run
• { action: "schedule-cancel", id: "..." } - cancel a scheduled run before it fires

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate one child with { agent, task }, or compose work with { workflowScript }; omit action. Use action only for management/control. Compatibility tasks[] and chain[] remain accepted. Use exactly one mode per call.

EXECUTE:
• Before execution, call { action: "list" }; run only executable/non-disabled configured agents/chains.
• SINGLE {agent, task?}; SCRIPT {workflowScript:"..."} with stable-key runs.run/runs.all for sequence, parallelism, branching, retries, and aggregation. Scripts start async by default; async:false is the foreground escape hatch. tasks[]/chain[] remain compatibility inputs.
• context can be "fresh" or "fork"; omitted uses each agent defaultContext, otherwise fresh. timeoutMs/maxRuntimeMs apply to foreground and async/background runs; foreground defaults to 30 minutes only when neither value nor an agent timeout is provided.
• Omit acceptance for reviewer/read-only calls. Evidence levels end at verified; use acceptance.review.required for independent writer review. reviewed is an achieved status, never an explicit input.
• Chain templates may use {task}, {previous}, {chain_dir}, and named outputs. Parallel worktree isolation requires a clean git repo.
• Chain example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {parallel: [{agent:"agent-b", task:"Check {previous}", count: 3}]}] }
• If list shows proactive skill subagent suggestions, use a small fresh-context fanout only when the task is broad enough.

MANAGE / CONTROL:
• Use action without execution fields: list, get, models, create, update, delete, eject, disable, enable, reset, mission.create/list/show/update/attach-run/close, worktree.discard, inspector.open/status/close, project.open/status/close, grant-spawn-budget, doctor, watchdog.status, watchdog.check, watchdog.recommend-model, watchdog.configure.
• Agent acceptanceRole (read-only or writer) affects inferred acceptance only, never tools. Explicit task intent wins; omission keeps name heuristics. Update with false or an empty string to clear it.
• Async control actions: status, interrupt, stop, resume, steer, append-step, approve-checkpoint, reject-checkpoint. Use stop with an id for current-session top-level async runs. Use status view:"fleet" for active-run overview, view:"transcript" to tail child output, steer for acknowledged top-level live async guidance, and resume for paused/completed/failed revival or a routed nested follow-up. Stopped runs are non-resumable. Steering delivery means Pi accepted the correlated user input, not model compliance; use index for a specific child.
• Schedule actions (enabled by default; disable with scheduledRuns.enabled:false): schedule, schedule-list, schedule-status, schedule-cancel. Schedule only explicit delayed runs the user asked for.

ASYNC / WAIT:
• Omitted async detaches background work; use async:false for a foreground result. Do not sleep or poll just to wait. In an interactive session, normally return control to the user and let Pi wake you on completion; do not call subagent_wait merely to wait. Override that default with subagent_wait only for run-to-completion requests (the user asked for results back this turn, or a skill must finish in one turn). Non-interactive runs (pi -p) auto-drain current-session work at agent_end; call subagent_wait when this turn must receive results before it ends. Otherwise continue useful work or respond.
• Status and artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, session files, and { action:"status", id:"..." }.

SAFETY:
• Ordinary child subagents are not orchestrators and must not run subagents. Only explicit fanout children may use child-safe subagent, still bounded by depth/session limits.
• Keep one writer per cwd/worktree. Use fresh read-only review/validation fanout, then synthesize and apply fixes from the parent unless isolated worktrees were intentionally requested.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const mode = resolveToolDescriptionMode(config, options);
	if (mode === "compact") return COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
	}
	return FULL_SUBAGENT_TOOL_DESCRIPTION;
}
