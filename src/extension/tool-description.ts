import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import { resolveDisabledFeatureSurface, type DisabledFeatureSurface, type SubagentSurfaceFeature } from "../shared/disabled-features.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

type FeatureText = (feature: SubagentSurfaceFeature, text: string, disabledText?: string) => string;

function featureText(disabled: DisabledFeatureSurface): FeatureText {
	return (feature, text, disabledText = "") => disabled.features.has(feature) ? disabledText : text;
}

// Part of every built-in description and appended to custom ones, so it is sent on every request.
export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
- Delegate only when the operator asked, directly or through applicable user/project instructions; size, complexity or risk alone is not authorization.
- Native async completion wakes this session: return control; do not sleep, poll or call bg_wait for it.
- One writer per cwd/worktree; isolate concurrent writers.
- After a launch or runtime failure, stop and report it; never silently switch to interactive_shell, pi -ne or another CLI.`;

const scriptCalls = "One child: {agent,task}. Independent parallel children: {workflow:\"parallel\",args:{tasks:[{agent,task},...]}}. Dependent multi-step work: exactly one top-level subagent workflow call with async:true; write one ```js workflow block in this reply, then call subagent({workflow:true}); children launch only inside it.";
const structuredCalls = "One child: {agent,task}. Parallel: tasks:[{agent,task},...]. In order: chain:[{agent,task?,as?} or {parallel:[{agent,task},...]}]; step tasks can use {task}, {previous} and {outputs.name}. Use exactly one top-level subagent chain or tasks call with async:true.";

const essentials = (on: FeatureText) => `${on("workflow-scripts", scriptCalls, structuredCalls)}
Management: {action,id?,options:{...}}; fields not in this schema go in options.
Launch agents by name and pass models as exact provider/id; an unknown agent or model returns the valid choices.
Details: guide workflows/recommended-orchestration-pattern (async, review, failure recovery), ${on("workflow-scripts", "guide workflows/scripted-workflows, ")}guide tool-reference/retained-children, guide tool-reference/external-cli-agent-profiles.

${SUBAGENT_SAFETY_GUIDANCE}`;

const managementDiscovery = (on: FeatureText) => [
	["list/get/models/guide"],
	[on("agent-management", "create/update/delete/eject/disable/enable/reset/refine")],
	[on("missions", "mission.*"), on("schedules", "schedule.*"), on("watchdog", "watchdog.*"), on("panes", "inspector.*, project.*"), on("lane-management", "lane.status/recordMerge/recordSupersession")],
	[on("lane-management", "worktree.discard and reviewed worktree.cleanup")],
	[`doctor${on("spawn-budget-grants", " and grant-spawn-budget")}`],
].map((group) => group.filter(Boolean).join(", ")).filter(Boolean).join("; ");

const scriptDetails = `• Scripts: JavaScript statement bodies with explicit return, top-level await, plain helpers/Promise chains; nested async function/arrow/method helpers are rejected. Await runs.run('key',{agent,task}) before .output; await runs.all([{key,agent,task},...]) for an ordered array, not a key map. Observe every stored run promise with direct await, Promise.race or Promise.all. Await/return runs.steer(key,message,options?) for a prior key, never raw run ids; queued/delivered/missed/failed receipts are not compliance proof.
• workflow:'./path.js' (any value with '/') loads a file from request cwd; other strings name a resource, such as {workflow:'review',args:{task:'...'}}. agent/task exclude workflow; task excludes action; validate accepts workflow:true or a path without launching. Raw-script sandboxes add deeply frozen args that persist as evidence, so never include secrets; raw scripts cannot use runs.host. Granted commands/relative outputs use workflow cwd, never per-step cwd.
• runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task}]}]) runs first stages together, later stages sequentially per lane. Failures stay lane-local; only explicit structuredOutput.verdict === 'blocked' blocks a successful stage, never reviewer prose.
`;

// Opt-in through toolDescriptionMode "full": the rarer rules the default leaves to guide sections.
const fullDetails = (on: FeatureText) => `DETAILS:
${on("workflow-scripts", scriptDetails)}• ${on("workflow-scripts", "Workflow child controls default onto runs.run/runs.all items; child fields override them.", "Top-level child controls apply to every chain/tasks child.")} worktree:true requires clean source, isolates each child and returns handoff artifacts; options.baseRef defaults to HEAD at allocation or a supported named ref, never full 40/64-character commit IDs or revision expressions.${on("usage-budgets", " usageBudget is shared across the workflow; already-running children are not stopped.")}
• Async follows asyncByDefault (normally true); async:false only to block the parent, not for final reviews/gates. Consume results at dependency barriers. bg_wait is for provider/detached work without native notification that needs a same-turn result.
• Bind durable output ${on("workflow-scripts", "on runs.run/runs.all", "with output")}, not task filename prose; return actual outputReference/outputPathMapping/artifactPaths, evidence and residual risks.
• Ordinary child subagents are not orchestrators; only configured fanout within depth/session limits. Use fresh-context read-only reviewers when independent review was requested. Oracle/advisor unknowns use supervisor dialogue; one-shot only when requested.
• children.list is workflow-only, not an exhaustive list of direct native children: resume only resumable rows. When an intended child's exact run id is known, inspect it with {action:"status",id}; if status identifies the candidate, attempt {action:"resume",id,message}. Resume authoritatively checks eligibility and may reject it. Use a labeled same-role fallback only when no known candidate exists or resume rejects eligibility.${on("workflow-scripts", " Scripts await runs.run(newKey,{resume:runId,task}); continue from the latest returned runId. Each distinct resume pass needs a new stable key; same-key reuse requires identical launch parameters.")}
• External CLI agents need an installed, authenticated CLI; preflight at launch decides, and passive PATH/PATHEXT/X_OK is not authentication/version/launch proof. They support native options only when their runner declares them: model, structured output, acceptance/agentContract, ${on("tool-budgets", "tool budget, ")}fast, fork context or skills/tools.
• Model override: copy exact provider/id, not agent names. Thinking uses model suffix${on("watchdog", ", not watchdog-only thinking")}.
• Missions auto-attach${on("missions", " unless options.mission:false")}; ${on("workflow-scripts", "await state.get(key)/state.set(key,JSONValue) requires a mission. ")}See guide topic missions. Omit acceptance for reviewer/read-only calls; acceptance.review.required requests independent writer review.
• Inspect asyncId/asyncDir (status.json, events.jsonl, logs) with status/debug.run; control with interrupt/stop/resume/steer. For local Pi children explicitly granted subagent_command, command.status/yield/cancel targets one exact toolCallId without interrupting the child.
• After a failure, report the exact failure, run/status and repo/cwd/worktree/branch/ref, and verify a clean worktree or capture the partial diff before a same-protocol retry. Governed-workflow fallback to foreground/CLI needs explicit owner approval, not Pi core's generic pi -ne hint.
• Management discovery: ${managementDiscovery(on)}. Use guide topics agents, ${on("missions", "missions, ")}observability, tool-reference, configuration, models${on("watchdog", ", watchdog")} or extension-api for exact action fields.${on("schedules", on("workflow-scripts", " Schedules take script inputs, not direct children; recipes live in the missions guide."))}`;

const fullDescription = (on: FeatureText) => `${essentials(on)}\n\n${fullDetails(on)}`;

const allEnabled = featureText(resolveDisabledFeatureSurface({}));

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = essentials(allEnabled);

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate focused work to child agents; compose multi-child work in one workflow call.";
const STRUCTURED_SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate focused work to child agents; compose multi-child work in one chain or tasks call.";

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
}

// No promptGuidelines: the description carries the authorization rule, so it is stated once.
export function buildSubagentToolPromptMetadata(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, disabledFeatures?: DisabledFeatureSurface): SubagentToolPromptMetadata {
	if (config.toolDescriptionMode !== undefined) return {};
	return { promptSnippet: disabledFeatures?.features.has("workflow-scripts") ? STRUCTURED_SUBAGENT_TOOL_PROMPT_SNIPPET : SUBAGENT_TOOL_PROMPT_SNIPPET };
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
	const on = options?.disabledFeatures ? featureText(options.disabledFeatures) : allEnabled;
	if (config.toolDescriptionMode === undefined) return essentials(on);
	const mode = resolveToolDescriptionMode(config, options);
	if (mode === "compact") return essentials(on);
	if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) return withMandatorySafetyGuidance(custom);
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
	}
	return fullDescription(on);
}
