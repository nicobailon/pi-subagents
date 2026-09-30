import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { resolveDisabledFeatureSurface, type DisabledFeatureSurface, type SubagentSurfaceFeature } from "../shared/disabled-features.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;
const AGENT_SELECTION_GUIDANCE = 'First call {action:"list",capabilities:true}: executable, non-disabled agents only; external-cli requires runner.available === true. Passive PATH/PATHEXT/X_OK is not authentication/version/launch proof; preflight is authoritative.';
const SUBAGENT_FAILURE_RECOVERY_GUIDANCE = "Workflow, child launch, prompt runtime, extension load or child tooling failure is a lane infrastructure blocker. Stop; report exact failure, run/status and repo/cwd/worktree/branch/ref; verify clean worktree or capture partial diff before same-protocol retry or asking the owner. Never silently switch to interactive_shell, pi -ne, Codex/Claude/Cursor CLI or foreground/external mode: governed-workflow fallback requires explicit owner approval, not Pi core's generic pi -ne hint. Explicit foreground/CLI requests and work outside that protocol remain valid.";

type FeatureText = (feature: SubagentSurfaceFeature, text: string, disabledText?: string) => string;

function featureText(disabled: DisabledFeatureSurface): FeatureText {
	return (feature, text, disabledText = "") => disabled.features.has(feature) ? disabledText : text;
}

const safetyGuidance = (on: FeatureText) => `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Direct parent execution is the default. Invoke subagents only when delegation is authorized by the operator's current request or applicable user/project instructions; task size, complexity, risk, tool-call count, or recipe fit do not independently authorize delegation.
• ${AGENT_SELECTION_GUIDANCE}
• ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE}
• Omit action for execution. For an authorized delegated multi-step/parallel workflow: exactly one top-level subagent ${on("workflow-scripts", "workflow call with async:true; children launch only inside it", "chain or tasks call with async:true")}.
• Async follows asyncByDefault (normally true); async:false only to block the parent, not for final reviews/gates. Consume results at dependency barriers. Native async completion wakes this session: return control, no sleep/poll or bg_wait merely for a wake. bg_wait is for provider/detached work without native notification needing a same-turn result.
• Ordinary child subagents are not orchestrators; only configured fanout within depth/session limits. For an authorized delegated workflow, keep one writer per cwd/worktree and isolate concurrent writers. Use fresh-context read-only reviewers when independent review was requested, then parent synthesis/fixes. Oracle/advisor unknowns use supervisor dialogue; one-shot only when requested.
• Bind durable output ${on("workflow-scripts", "on runs.run/runs.all", "with output")}, not task filename prose; return actual outputReference/outputPathMapping/artifactPaths, evidence and residual risks.
• children.list is workflow-only, not an exhaustive list of direct native children: resume only resumable rows. When an intended child's exact run id is known, inspect it with {action:"status",id}; if status identifies the candidate, attempt {action:"resume",id,message}. Resume authoritatively checks eligibility, may reject it, and otherwise detaches a follow-up/challenge with the stored agent/model/tool contract. Use a labeled same-role fallback only when no known candidate exists or resume rejects eligibility.${on("workflow-scripts", " Scripts await runs.run(newKey,{resume:runId,task}); continue from latest returned runId. Each distinct resume pass needs a new stable key; same-key reuse requires identical launch parameters.")}
${on("workflow-scripts", "• Named resources own authority; raw scripts (workflow:true or a path) cannot use runs.host. Granted commands/relative outputs use workflow cwd, never per-step cwd.\n")}• Inspect asyncId/asyncDir (status.json, events.jsonl, logs) with status/debug.run; control with interrupt/stop/resume/steer. Read {action:"guide",topic:"tool-reference"} for controls/evidence gates.`;

const scriptExecutionGuidance = (on: FeatureText) => `Delegate one child with {agent,task?}; otherwise set exactly one workflow source, with optional args.
Workflow script: write it as one \`\`\`js workflow block in this reply, then call subagent({workflow:true,...}). workflow:'./path.js' (any value with '/') loads a file from request cwd; other strings name a resource.
agent/task exclude workflow; task excludes action. agent may target management actions. action is management/control; validate accepts workflow:true or a path without launching.
Scripts: JavaScript statement bodies with explicit return, top-level await, plain helpers/Promise chains; nested async function/arrow/method helpers are rejected. Await runs.run('key',{agent,task}) before .output; await runs.all([{key,agent,task},...]) for an ordered array, not a key map. Observe every stored run promise with direct await, Promise.race or Promise.all. Await/return runs.steer(key,message,options?) for a prior key, never raw run ids; queued/delivered/missed/failed receipts are not compliance proof.
Before advanced orchestration (runs.lanes, rolling fanout, mission state, handoffs), read {action:"guide",topic:"workflows"} or the pi-subagents skill. Raw-script sandboxes add deeply frozen args; all sandboxes provide runs, emit, console, JavaScript and enabled mission state, with no filesystem/shell/Pi tools/host globals. External CLI agents support native options only when their runner declares them; read guide tool-reference before passing model, structured output, acceptance/agentContract, ${on("tool-budgets", "tool budget, ")}fast, fork context or skills/tools.
Model override: first call {action:"models"}; copy exact provider/id, not agent names. Thinking uses model suffix${on("watchdog", ", not watchdog-only thinking")}.
Named resources: {workflow:'review',args:{task:'...'}} or {workflow:'run-ci',args:{command:'npm test'}}. Raw scripts also accept bounded plain-data args; raw-script args persist as evidence, so never include secrets. worktree:true requires clean source; baseRef defaults to HEAD at allocation or a supported named ref, never full 40/64-character commit IDs or revision expressions.`;

const structuredExecutionGuidance = (on: FeatureText) => `Delegate one child with {agent,task?}. tasks:[{agent,task},...] runs children in parallel. chain:[{agent,task?,as?} or {parallel:[{agent,task},...]}] runs steps in order; a parallel step waits for all its children and a failed step stops the chain.
Chain task placeholders: {task} is the top-level task (the original request); {previous} is the prior step's output (a parallel step's outputs in order), and the default when task is omitted; {outputs.name} is the output of an earlier step with as:'name'.
agent, chain and tasks exclude each other and action. action is management/control; agent may target management actions.
External CLI agents support native options only when their runner declares them; read guide tool-reference before passing model, structured output, acceptance/agentContract, ${on("tool-budgets", "tool budget, ")}fast, fork context or skills/tools.
Model override: first call {action:"models"}; copy exact provider/id, not agent names. Thinking uses model suffix${on("watchdog", ", not watchdog-only thinking")}.
worktree:true requires clean source; baseRef defaults to HEAD at allocation or a supported named ref, never full 40/64-character commit IDs or revision expressions.`;

const defaultDescription = (on: FeatureText) => `${on("workflow-scripts", scriptExecutionGuidance(on), structuredExecutionGuidance(on))}\n\n${safetyGuidance(on)}`;

const managementDiscovery = (on: FeatureText) => [
	["list/get/models/guide"],
	[on("agent-management", "create/update/delete/eject/disable/enable/reset/refine")],
	[on("missions", "mission.*"), on("schedules", "schedule.*"), on("watchdog", "watchdog.*"), on("panes", "inspector.*, project.*"), on("lane-management", "lane.status/recordMerge/recordSupersession")],
	[on("lane-management", "worktree.discard and plan-only worktree.cleanup")],
	[`doctor${on("spawn-budget-grants", " and grant-spawn-budget")}`],
].map((group) => group.filter(Boolean).join(", ")).filter(Boolean).join("; ");

const fullDescription = (on: FeatureText) => `${defaultDescription(on)}

WORKFLOW DETAILS:
${on("workflow-scripts", "• runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task}]}]) runs first stages together, later stages sequentially per lane. Failures stay lane-local; only explicit structuredOutput.verdict === 'blocked' blocks a successful stage, never reviewer prose.\n")}• ${on("workflow-scripts", "Workflow child controls default onto runs.run/runs.all items; child fields override them.", "Top-level child controls apply to every chain/tasks child.")} worktree:true isolates each child and returns handoff artifacts.${on("usage-budgets", " usageBudget is shared across the workflow; already-running children are not stopped.")}
• Missions auto-attach${on("missions", " unless mission:false")}; ${on("workflow-scripts", "await state.get(key)/state.set(key,JSONValue) requires a mission. ")}See guide topic missions. Omit acceptance for reviewer/read-only calls; acceptance.review.required requests independent writer review.
• Management discovery: ${managementDiscovery(on)}. Use guide topics agents, ${on("missions", "missions, ")}observability, tool-reference, configuration, models${on("watchdog", ", watchdog")} or extension-api for exact action fields.${on("schedules", on("workflow-scripts", " Schedules take script inputs, not direct children; recipes live in the missions guide."))}`;

const allEnabled = featureText(resolveDisabledFeatureSurface({}));

export const SUBAGENT_SAFETY_GUIDANCE = safetyGuidance(allEnabled);

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = defaultDescription(allEnabled);

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "For operator-requested delegation, use subagents; compose multi-child work in one workflow call.";
const STRUCTURED_SUBAGENT_TOOL_PROMPT_SNIPPET = "For operator-requested delegation, use subagents; compose multi-child work in one chain or tasks call.";
export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	"Do not invoke subagents unless the operator requested delegation directly or through applicable instructions.",
];

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = DEFAULT_SUBAGENT_TOOL_DESCRIPTION;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = fullDescription(allEnabled);

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
	/** Removes lines for disabled features from the default and full descriptions; custom descriptions are unchanged apart from the appended safety guidance. */
	disabledFeatures?: DisabledFeatureSurface;
}

export interface SubagentToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, disabledFeatures?: DisabledFeatureSurface): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return {
		promptSnippet: disabledFeatures?.features.has("workflow-scripts") ? STRUCTURED_SUBAGENT_TOOL_PROMPT_SNIPPET : SUBAGENT_TOOL_PROMPT_SNIPPET,
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

function withMandatorySafetyGuidance(description: string, safety: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.flatMap((part) => part.split(safety))
		.flatMap((part) => part.split(SUBAGENT_FAILURE_RECOVERY_GUIDANCE))
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${safety}`
		: safety;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const on = options?.disabledFeatures ? featureText(options.disabledFeatures) : allEnabled;
	if (config.toolDescriptionMode === undefined) return defaultDescription(on);
	const mode = resolveToolDescriptionMode(config, options);
	let description: string;
	if (mode === "compact") description = defaultDescription(on);
	else if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) description = withMandatorySafetyGuidance(custom, safetyGuidance(on));
		else {
			warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
			description = fullDescription(on);
		}
	} else description = fullDescription(on);
	return description;
}
