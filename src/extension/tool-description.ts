import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Use { action: "list" } before execution and only run executable/non-disabled agents.
• Keep execution and management separate: omit action for workflowScript execution; use action only for management/control.
• Async/background runs are the default. Use async:false only when a blocking foreground result is needed. Do not sleep or poll status just to wait; use subagent_wait only when the current request must finish in this turn.
• Ordinary child subagents are not orchestrators. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Keep one writer for the same cwd/worktree. Use fresh-context read-only reviewers for independent review, then have the parent synthesize and apply fixes.
• Async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Run subagents only through { workflowScript }; omit action. Use action only for management/control actions.

EXECUTION:
• Before executing, use { action: "list" } and run only executable/non-disabled configured agents.
• WORKFLOW SCRIPT: { workflowScript: "return runs.run('main', {agent:'worker', task:'...'})" }. Every execution is a workflow. Use stable-key runs.run for one child and runs.all for parallel children; ordinary JavaScript provides sequence, branching, filtering, retries, and aggregation. workflowScript is an ordinary JavaScript statement body, so use an explicit return for a useful result. For task text with Markdown fences or shell blocks, build quoted lines instead of nesting raw template literals: \`const task=["Run:","\`\`\`bash","npm test","\`\`\`"].join("\\n")\`. Scripts start asynchronously by default; pass async:false only for a small foreground run. Same-repo foreground workflows default to a live in-chat card; set chatProgress to auto, off, or live-card to control that projection. Workflow-level child controls default onto each runs.run launch, and explicit child fields override them. Use {action:"children.list"} to list up to 10 completed retained children from this parent session, then continue one with runs.run(key, {resume:"run-id", task:"follow-up"}); resume and agent are mutually exclusive, and resume keeps the stored agent/model/tool contract. For repository mutation lanes, set worktree:true on the workflow or individual runs.run/runs.all item for managed isolation; each parallel child gets a separate worktree and handoff artifact. A workflow usageBudget is enforced once across the workflow. Available globals are runs.run, runs.all, runs.status, runs.ref/refs, emit, console, and standard JavaScript only. Workflows get async state.get(key) and state.set(key, JSONValue) through their automatic or explicit mission; mission:false workflows do not have a state global. Scripts cannot access filesystem, shell, arbitrary Pi tools, or host globals.
• Sequential example: { workflowScript: "const a = await runs.run('analyze', {agent:'agent-a', task:'Analyze the request'}); return (await runs.run('plan', {agent:'agent-b', task:'Plan from: '+a.output})).output" }
• Parallel example: { workflowScript: "const [a,b] = await runs.all([{key:'correctness',agent:'agent-a',task:'Review correctness'},{key:'tests',agent:'agent-b',task:'Review tests'}]); return {correctness:a.output,tests:b.output}" }
• Optional context is "fresh" or "fork". timeoutMs/maxRuntimeMs apply to foreground and async workflows; foreground workflows default to 30 minutes and async workflows have no default timeout. Omit acceptance for reviewer/read-only calls; evidence levels end at verified, and acceptance.review.required requests independent writer review.
• Durable mission attachment is automatic by default. Use missionId to attach an existing mission, mission:{...} to override auto-create, or mission:false for ephemeral work.

MANAGEMENT / CONTROL (use action; omit execution fields):
• list, get, models, guide, children.list, create, update, delete, eject, disable, enable, reset, doctor, grant-spawn-budget, worktree.discard, refine/refine.show/refine.rollback, mission.create/list/show/update/attach-run/close, inspector.open/status/close, project.open/status/close, and watchdog actions remain available. Use {action:"guide", topic:"overview"} for packaged current-version help; topics are overview, workflows, agents, missions, observability, tool-reference, configuration, models, watchdog, and extension-api.
• status, interrupt, stop, resume, and steer manage live or persisted runs. Use status view:"fleet" for an overview or view:"transcript" with id and optional index to tail output.
• { action: "append-step", id: "...", step: {agent:"agent-c", task:"Use {previous}"} } appends one step to an already-running durable legacy chain. step is control-only, not an execution mode.
• approve-checkpoint and reject-checkpoint decide a paused durable legacy chain checkpoint.
• Create durable project schedules with { action:"schedule.create", id?, name?, at:"+10m" | ISO, workflowScript:"return runs.run('main', {agent:'worker', task:'...'})" } or { every:"6h", workflowScript:"..." }. Manage them with schedule.list/show/history/pause/resume/run/run-due/delete. This first slice supports fixed intervals; calendar schedules and schedule mission attachment are deferred.

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Run subagents only through { workflowScript }; omit action. Use action only for management/control actions.

EXECUTE:
• Call { action:"list" } first and use only executable/non-disabled agents.
• SCRIPT {workflowScript:"return runs.run('main', {agent:'worker', task:'...'})"}. Use stable-key runs.run for one child and runs.all for parallel work. Use {action:"children.list"} for the last 10 retained children in this parent session, then runs.run(key,{resume:"run-id",task:"follow-up"}) to continue one with its stored contract. Workflows get async state.get/state.set through their automatic or explicit mission; mission:false does not. Scripts are ordinary JavaScript statement bodies; use explicit return for a useful result. For task text with Markdown fences or shell blocks, build quoted lines instead of nesting raw template literals: \`const task=["Run:","\`\`\`bash","npm test","\`\`\`"].join("\\n")\`. Use JavaScript for sequence, branching, retries, and aggregation. For repository mutation lanes, use worktree:true on the workflow or runs.run/runs.all item for managed isolation. Scripts start async by default; async:false is the foreground escape hatch and auto-enables a same-repo live chat card unless chatProgress is off.
• Example: {workflowScript:"const [a,b]=await runs.all([{key:'a',agent:'agent-a',task:'Implement A',worktree:true},{key:'b',agent:'agent-b',task:'Implement B',worktree:true}]); return [a.output,b.output]"}
• context can be fresh or fork. timeoutMs/maxRuntimeMs apply to foreground and async workflows; foreground workflows default to 30 minutes and async workflows have no default timeout. Omit acceptance for reviewer/read-only calls.

MANAGE / CONTROL:
• Use action without execution fields for list/get/models/guide/authoring, refine/refine.show/refine.rollback, mission, watchdog, status, interrupt, stop, resume, steer, script-only scheduling, diagnostics, and other management actions. guide reads shipped current-version docs by topic.
• append-step uses step:{...} only for an already-running durable legacy chain; step is not an execution mode.

ASYNC / SAFETY:
• Omitted async detaches background work. Do not sleep or poll merely to wait; use subagent_wait only when this turn must receive results.
• Ordinary children are not orchestrators. Keep one writer per cwd/worktree and use fresh read-only reviewers for independent checks.
• Status and artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, and {action:"status",id:"..."}.`;


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
