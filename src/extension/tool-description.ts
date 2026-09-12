import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;
const AGENT_SELECTION_GUIDANCE = 'First call {action:"list",capabilities:true}: executable, non-disabled agents only; external-cli requires runner.available === true. Passive PATH/PATHEXT/X_OK is not authentication/version/launch proof; preflight is authoritative.';
const SUBAGENT_FAILURE_RECOVERY_GUIDANCE = "Workflow, child launch, prompt runtime, extension load or child tooling failure is a lane infrastructure blocker. Stop; report exact failure, run/status and repo/cwd/worktree/branch/ref; verify clean worktree or capture partial diff before same-protocol retry or asking the owner. Never silently switch to interactive_shell, pi -ne, Codex/Claude/Cursor CLI or foreground/external mode: governed-workflow fallback requires explicit owner approval, not Pi core's generic pi -ne hint. Explicit foreground/CLI requests and work outside that protocol remain valid.";

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• ${AGENT_SELECTION_GUIDANCE}
• ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE}
• Omit action for execution. Multi-step/parallel work: exactly one top-level subagent workflow call with async:true; children launch only inside it.
• Async follows asyncByDefault (normally true); async:false only to block the parent, not for final reviews/gates. Consume results at dependency barriers. Native async completion wakes this session: return control, no sleep/poll or bg_wait merely for a wake. bg_wait is for provider/detached work without native notification needing a same-turn result.
• Ordinary child subagents are not orchestrators; only configured fanout within depth/session limits. One writer per cwd/worktree; isolate concurrent writers. Fresh-context read-only reviewers, then parent synthesis/fixes. Oracle/advisor unknowns use supervisor dialogue; one-shot only when requested.
• Bind durable output on runs.run/runs.all, not task filename prose; return actual outputReference/outputPathMapping/artifactPaths, evidence and residual risks.
• children.list: resume only resumable rows. {action:"resume",id,message} detaches a follow-up/challenge with stored agent/model/tool contract. If none is resumable, label a same-role fallback challenge. Scripts await runs.run(newKey,{resume:runId,task}); continue from latest returned runId. Each distinct resume pass needs a new stable key; same-key reuse requires identical launch parameters.
• Named resources own authority; raw workflowScript/workflowScriptPath cannot use runs.host. Granted commands/relative outputs use workflow cwd, never per-step cwd.
• Inspect asyncId/asyncDir (status.json, events.jsonl, logs) with status/debug.run; control with interrupt/stop/resume/steer. Read {action:"guide",topic:"tool-reference"} for controls/evidence gates.`;

const EXECUTION_GUIDANCE = `Delegate one child with {agent,task?}; otherwise choose exactly one of workflowScript, workflowScriptPath or {workflow,args}. agent/task exclude workflow inputs; task excludes action. agent may target management actions. action is management/control; validate accepts either script without launching. workflowScriptPath loads from request cwd before sandbox execution.
Scripts: JavaScript statement bodies with explicit return, top-level await, plain helpers/Promise chains; nested async function/arrow/method helpers are rejected. Await runs.run('key',{agent,task}) before .output; await runs.all([{key,agent,task},...]) for an ordered array, not a key map. Observe every stored run promise with direct await, Promise.race or Promise.all. Await/return runs.steer(key,message,options?) for a prior key, never raw run ids; queued/delivered/missed/failed receipts are not compliance proof.
Before advanced orchestration (runs.lanes, rolling fanout, mission state, handoffs), read {action:"guide",topic:"workflows"} or the pi-subagents skill. Sandbox: runs, emit, console, JavaScript and enabled mission state; no filesystem/shell/Pi tools/host globals. External CLI agents support native options only when their runner declares them; read guide tool-reference before passing model, structured output, acceptance/agentContract, tool budget, fast, fork context or skills/tools.
Model override: first call {action:"models"}; copy exact provider/id, not agent names. Thinking uses model suffix, not watchdog-only thinking.
Named resources: {workflow:'review',args:{task:'...'}} or {workflow:'run-ci',args:{command:'npm test'}}; args are bounded plain data. worktree:true requires clean source; baseRef defaults to HEAD at allocation or a supported named ref, never full 40/64-character commit IDs or revision expressions.`;

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `${EXECUTION_GUIDANCE}\n\n${SUBAGENT_SAFETY_GUIDANCE}`;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate to subagents; orchestrate in one workflow call.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Use subagent only when delegation is needed.",
];

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `${DEFAULT_SUBAGENT_TOOL_DESCRIPTION}

WORKFLOW DETAILS:
• runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task}]}]) runs first stages together, later stages sequentially per lane. Failures stay lane-local; only explicit structuredOutput.verdict === 'blocked' blocks a successful stage, never reviewer prose.
• Workflow child controls default onto runs.run/runs.all items; child fields override them. worktree:true isolates each child and returns handoff artifacts. usageBudget is shared across the workflow; already-running children are not stopped.
• Missions auto-attach unless mission:false; await state.get(key)/state.set(key,JSONValue) requires a mission. See guide topic missions. Omit acceptance for reviewer/read-only calls; acceptance.review.required requests independent writer review.
• Management discovery: list/get/models/guide; create/update/delete/eject/disable/enable/reset/refine; mission.*, schedule.*, watchdog.*, inspector.*, project.*, lane.status/recordMerge/recordSupersession; worktree.discard and plan-only worktree.cleanup; doctor and grant-spawn-budget. Use guide topics agents, missions, observability, tool-reference, configuration, models, watchdog or extension-api for exact action fields. Schedules take script inputs, not direct children; recipes live in the missions guide.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	/** Host approval for project-local templates; absent means global-only. */
	projectTrusted?: boolean;
	warn?: (message: string) => void;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return {
		promptSnippet: SUBAGENT_TOOL_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_TOOL_PROMPT_GUIDELINES,
	};
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
		...(options?.projectTrusted === true ? [path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE)] : []),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = options?.projectTrusted === true ? getProjectConfigDir(cwd) : path.join(cwd, ".pi");
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
		.flatMap((part) => part.split(SUBAGENT_FAILURE_RECOVERY_GUIDANCE))
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	if (config.toolDescriptionMode === undefined) return DEFAULT_SUBAGENT_TOOL_DESCRIPTION;
	const mode = resolveToolDescriptionMode(config, options);
	let description: string;
	if (mode === "compact") description = COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	else if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) description = withMandatorySafetyGuidance(custom);
		else {
			warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
			description = FULL_SUBAGENT_TOOL_DESCRIPTION;
		}
	} else description = FULL_SUBAGENT_TOOL_DESCRIPTION;
	return description;
}
