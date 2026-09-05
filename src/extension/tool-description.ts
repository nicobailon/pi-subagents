import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;
const EXTERNAL_CLI_RUNNER_GUIDANCE = "External CLI agents (codex-exec, codex-exec-writer, claude-code, claude-code-writer, cursor-agent, cursor-agent-writer) use their own runner contract and do not support native Pi child options such as model override, structured output, acceptance/agent contract, tool budget, fast mode, fork context, skills, or native Pi tools unless the runner explicitly implements them.";
const SUBAGENT_FAILURE_RECOVERY_GUIDANCE = "If a subagent workflow, child launch, prompt runtime, extension load, or child tooling setup fails, treat it as a lane infrastructure blocker—not permission to change execution mode. Stop and report the exact failure, run/status, and repo/cwd/worktree/branch/ref state; verify the worktree is clean or capture a partial diff before retrying or asking the owner. Retry or fix the subagent path only through a clear same-protocol retry. Do not silently switch to interactive_shell, pi -ne, Codex/Claude/Cursor CLI, a foreground agent, or another external mode. For backlog lanes and other subagent-governed workflows, external/foreground/CLI fallback requires explicit owner approval. Pi core may print a generic pi -ne extension-load hint; that out-of-repo hint is not protocol-approved fallback. interactive_shell remains valid when the user explicitly requests foreground/CLI work or the task is outside the governed subagent protocol.";
const AGENT_SELECTION_GUIDANCE = "Before execution, call { action: \"list\", capabilities: true } and run only executable, non-disabled agents; for external-cli rows, also require runner.available === true. This is a passive PATH/PATHEXT/X_OK lookup, not authentication, version, or launch proof; launch preflight remains authoritative.";
const WORKFLOW_RESUME_KEY_GUIDANCE = "Each workflow key identifies one result lane: use a new stable workflow key for every distinct retained resume pass; same-key calls are reused only when launch parameters are identical, and incompatible parameters are rejected.";
const WORKFLOW_OUTPUT_BINDING_GUIDANCE = "For durable workflow child files, set output on runs.run/runs.all; task filename prose is not an output declaration, and return the child's outputReference, outputPathMapping, or artifactPaths instead of inventing a literal path.";
const WORKFLOW_LANES_GUIDANCE = "For bounded parallel sequential chains, use runs.lanes([{key,stages:[{key,agent,task},{key,resume:'previous',task},...]}]); first stages run together, later stages sequence per lane, and the bounded board reports lane-local failures. Only an explicit structuredOutput.verdict === 'blocked' blocks a successful stage; reviewer prose is not parsed.";
const WORKTREE_BASE_REF_GUIDANCE = "baseRef must be HEAD or a supported named ref such as refs/heads/main; full 40/64-character commit IDs and revision expressions such as HEAD~1 are unsupported. Omitted baseRef defaults to HEAD resolved at worktree allocation. The source checkout must still be clean.";
const WORKFLOW_SCRIPT_PORTABILITY_GUIDANCE = "workflowScript rejects nested async function, arrow, and method helpers; use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains instead.";
const WORKFLOW_RESOURCE_GUIDANCE = "For permission/policy-extension interoperability, use an extension-owned named resource such as {workflow:'review',args:{task:'...'}} or {workflow:'run-ci',args:{command:'npm test'}}. The host resolves the script and authority internally so policy can distinguish it from raw workflowScript/workflowScriptPath; args are bounded plain data, and do not combine workflow with agent, task, workflowScript, or workflowScriptPath.";
const WORKFLOW_HOST_GUIDANCE = "For permission-sensitive host calls, use an extension-owned resource such as {workflow:'run-ci',args:{command:'npm test'}}; raw workflowScript/workflowScriptPath have unknown resource provenance and cannot use runs.host. In a resource that grants it, await runs.host(key,{kind:'command',command,timeoutMs,output?,role?,provider?}). runs.host has no per-step cwd: commands and relative output paths use the workflow cwd; set cwd on the outer subagent request instead (for example, {cwd:'/path/to/worktree',workflowScript:'...'}), or put a trusted directory change in the command (for example, 'cd /path/to/worktree && npm test'). v1 supports only command steps; output is bounded and command failure fails the workflow.";

export const DEFAULT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to configured subagents. For execution, omit action and use {agent, task?} for one child, workflowScript for inline orchestration, workflowScriptPath to load a script from the request cwd, or a named workflow resource for permission/policy-aware execution. ${WORKFLOW_RESOURCE_GUIDANCE} ${AGENT_SELECTION_GUIDANCE} The script inputs are mutually exclusive. Use action:'validate' with either script input to check it without launching children. For multi-step or parallel work, make exactly one top-level subagent call with async:true; launch children only inside that workflow and do not make another top-level call for them. Use runs.run('key',{agent,task}) for one child, await runs.all([{key:'a',agent:'reviewer',task:'...'},{key:'b',agent:'reviewer',task:'...'}]) for ordinary parallel children, and read its ordered array result with indexes, destructuring, or .map(...), not by key property. ${WORKFLOW_SCRIPT_PORTABILITY_GUIDANCE} ${WORKFLOW_LANES_GUIDANCE} ${WORKFLOW_HOST_GUIDANCE} ${WORKTREE_BASE_REF_GUIDANCE} ${EXTERNAL_CLI_RUNNER_GUIDANCE} ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE} Use action only for management/control. Use guide or the pi-subagents skill for advanced workflow details.`;

export const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate to subagents; orchestrate in one workflowScript call.";

export const SUBAGENT_TOOL_PROMPT_GUIDELINES = [
	`Use subagent only when delegation is needed. ${AGENT_SELECTION_GUIDANCE}`,
	'Omit action for execution; use { agent, task? } for one child. For multi-step or parallel work, make exactly one top-level { workflowScript, async: true } call and launch children only inside it. Use action only for management/control.',
	"workflowScript rejects nested async function, arrow, and method helpers; use top-level await, plain helper functions, or explicit Promise chains.",
	"Inside workflowScript, use runs.run/runs.all and await their results. runs.all returns an ordered array, not a key map; stored runs.run promises must later be observed with direct await, Promise.race, or Promise.all.",
	'Keep one writer per cwd/worktree; isolate concurrent writers. For durable files, set output on runs.run/runs.all and return the child\'s outputReference, outputPathMapping, or artifactPaths. For advanced workflows, read the bundled pi-subagents skill or call { action: "guide", topic: "workflows" }.',
];

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• ${AGENT_SELECTION_GUIDANCE}
• ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE}
• Keep execution and management separate: omit action for structured single-child or workflowScript execution; use action only for management/control.
• Async/background runs are the normal default unless config sets asyncByDefault:false; set async:true explicitly when async behavior matters. Use async:false only when the parent must block until completion. Async mode still shows progress. Final reviews and gate checks stay async; needing a result is not a blocking reason. After an async launch, continue independent work only until its next dependency barrier; consume the result before work that depends on it. Ordinary async subagents notify this session natively, so return control and do not call bg_wait merely to get a completion wake. Do not sleep or poll status just to wait; use bg_wait only for provider, detached, or other background work without a native notification when this turn must receive its result.
• ${WORKFLOW_RESUME_KEY_GUIDANCE}
• ${WORKFLOW_OUTPUT_BINDING_GUIDANCE}
• ${WORKFLOW_HOST_GUIDANCE}
• Ordinary child subagents are not orchestrators. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Oracle/advisor consultations should use supervisor dialogue for material unknowns when available; request one-shot only when desired.
• Keep one writer for the same cwd/worktree. Use fresh-context read-only reviewers for independent review, then have the parent synthesize and apply fixes.
• Async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, status via { action: "status", id }, and lifecycle diagnostics via { action: "debug.run", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Run one child with { agent, task? }; use { workflowScript } for inline orchestration or { workflowScriptPath } to load it from the request cwd. The script inputs are mutually exclusive. Omit action for execution. Use action only for management/control actions.

${WORKFLOW_RESOURCE_GUIDANCE}

EXECUTION:
• ${EXTERNAL_CLI_RUNNER_GUIDANCE}
• ${AGENT_SELECTION_GUIDANCE}
• When passing an explicit model to a child (on the call or a runs.run/runs.all item), first call { action: "models" } and copy an exact provider/id; bare ids resolve only when unique in the registry, and agent names (e.g. gpt-pro, advisor) are not model ids. Set per-run thinking with a suffix on the model string (e.g. provider/id:high; off/minimal/low/medium/high/xhigh/max); the suffix wins over the agent's thinking default. The thinking field only applies to action='watchdog.configure' and is ignored on dispatch.
• SINGLE CHILD: { agent:"worker", task:"..." }. This structured form starts exactly one direct child. Fields such as model, context, cwd, worktree, output, budgets, acceptance, and async apply to that child. Do not combine agent/task with action, workflowScript, or workflowScriptPath.
• WORKFLOW SCRIPT: { workflowScript: "return runs.run('main', {agent:'worker', task:'...'})" }. Use stable-key runs.run for one child and await runs.all([{key,agent,task}, ...]) for ordinary parallel children. runs.all resolves to an ordered array, not a key map, so use results[0], array destructuring, or results.map((result) => result.output), not results.<key>. Do not read .output from unawaited runs.run launches. Stored runs.run promises are only for advanced rolling fanout and each must later be observed with direct await, Promise.race, or Promise.all. Ordinary JavaScript provides sequence, branching, filtering, retries, and aggregation. workflowScript is an ordinary JavaScript statement body, so use an explicit return for a useful result. Use top-level await, plain helper functions, or explicit Promise chains; nested async function, arrow, and method helpers are rejected. For task text with Markdown fences or shell blocks, build quoted lines instead of nesting raw template literals: \`const task=["Run:","\`\`\`bash","npm test","\`\`\`"].join("\\n")\`. Scripts normally start async unless config sets asyncByDefault:false; set async:true explicitly when async behavior matters. Pass async:false only when the parent must block until completion, never for final reviews or gates. Same-repo blocking workflows default to a live in-chat card; explicit live-card requires same-repository async:false, so async workflows should omit chatProgress or use auto/off. Workflow-level child controls default onto each runs.run launch, and explicit child fields override them. Use {action:"children.list"} to list recent retained workflow children with resumable/not-resumable reasons. Resume only rows reported resumable. For a simple follow-up or implementation challenge, use {action:"resume", id:"run-id", message:"..."}. Resume keeps the stored agent/model/tool contract. If no resumable child is listed, launch a same-role fallback challenge and label it as fallback. Inside workflowScript, continue one with runs.run(key, {resume:"run-id", task:"follow-up"}); workflow resumes wait for completed output, and loops must continue from each latest returned runId. Await runs.steer(key, message, {mode?, index?, ackTimeoutMs?}) to guide a prior keyed child without exposing its run id; receipts are queued, delivered, missed, or failed. Always await or return runs.steer. For repository mutation lanes, set worktree:true on the workflow or individual runs.run/runs.all item for managed isolation; each parallel child gets a separate worktree and handoff artifact. ${WORKTREE_BASE_REF_GUIDANCE} A workflow usageBudget is enforced once across the workflow. Available globals are runs.run, runs.all, runs.steer, runs.status, runs.ref/refs, emit, console, and standard JavaScript only. Workflows get async state.get(key) and state.set(key, JSONValue) through their automatic or explicit mission; mission:false workflows do not have a state global. Scripts cannot access filesystem, shell, arbitrary Pi tools, or host globals.
• ${WORKFLOW_LANES_GUIDANCE}
• FILE SCRIPT: { workflowScriptPath:"workflows/review.js" }. Relative paths resolve against the request cwd. The host reads the file before the filesystem-free workflow sandbox starts. Do not combine this field with workflowScript.
• Sequential example: { workflowScript: "const a = await runs.run('analyze', {agent:'agent-a', task:'Analyze the request'}); return (await runs.run('plan', {agent:'agent-b', task:'Plan from: '+a.output})).output" }
• Parallel example: { workflowScript: "const [a,b] = await runs.all([{key:'correctness',agent:'agent-a',task:'Review correctness'},{key:'tests',agent:'agent-b',task:'Review tests'}]); return {correctness:a.output,tests:b.output}" }
• Optional context is "fresh", "fork", or "profile". profile requires the selected agent's declared defaultContext and ignores config defaultSubagentContext. Explicit fresh/fork wins. When omitted, config defaultSubagentContext wins over agent defaultContext. Config forkContext can summarize transcript overflow with stable recovery refs before spawn without adding another public context value. timeoutMs/maxRuntimeMs apply to foreground and async workflows; foreground workflows default to 30 minutes and async workflows have no default timeout. Omit acceptance for reviewer/read-only calls; evidence levels end at verified, and acceptance.review.required requests independent writer review.
• Durable mission attachment is automatic by default. Use missionId to attach an existing mission, mission:{...} to override auto-create, or mission:false for ephemeral work. A mission object needs exactly one non-empty title or summary; objective and labels are optional. goal may only be true and requires budget:{tokens}.

MANAGEMENT / CONTROL (use action; omit execution fields):
• validate checks workflowScript or workflowScriptPath syntax and statically decidable structure without launching children. list, get, models, guide, children.list, create, update, delete, eject, disable, enable, reset, status, debug.run, doctor, grant-spawn-budget, worktree.discard, worktree.cleanup (plan-only), lane.status, lane.recordMerge, lane.recordSupersession, refine/refine.show/refine.rollback, mission.create/list/show/update/resolve-decision/attach-run/close, inspector.open/status/close, project.open/status/close, and watchdog actions remain available. Use {action:"guide", topic:"overview"} for packaged current-version help; topics are overview, workflows, agents, missions, observability, tool-reference, configuration, models, watchdog, and extension-api.
• status, interrupt, stop, resume, and steer manage live or persisted runs. Use status view:"fleet" for an overview or view:"transcript" with id and optional index to tail output.
• Create durable project schedules with { action:"schedule.create", id?, name?, sessionOnly?:true, at:"+10m" | ISO, baseRef?, workflowScript:"return runs.run('main', {agent:'worker', task:'...'})" }, or use workflowScriptPath instead. An optional baseRef uses the same managed-worktree ref policy and resolves at allocation; the source checkout must still be clean. With sessionOnly:true, the schedule records the creating session file and only that session can restore or execute it; omitted/false preserves project-wide behavior. Manage them with schedule.list/show/history/pause/resume/run/run-due/delete. This first slice supports fixed intervals; calendar schedules and schedule mission attachment are deferred.

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Run one child with { agent, task? }; use { workflowScript } for inline orchestration or { workflowScriptPath } to load it from the request cwd. The script inputs are mutually exclusive. Omit action for execution. Use action only for management/control actions.

${WORKFLOW_RESOURCE_GUIDANCE}

EXECUTE:
• ${EXTERNAL_CLI_RUNNER_GUIDANCE}
• ${AGENT_SELECTION_GUIDANCE}
• Passing an explicit model? Call {action:"models"} first and copy an exact provider/id; bare ids resolve only when unique in the registry; agent names (e.g. gpt-pro, advisor) are not model ids. Per-run thinking is a suffix on the model string (provider/id:high; off/minimal/low/medium/high/xhigh/max), and the suffix wins over the agent's thinking default; the thinking field only applies to action='watchdog.configure' and is ignored on dispatch.
• SINGLE {agent:"worker",task:"..."} starts exactly one direct child. Fields apply to that child. Do not combine agent/task with action, workflowScript, or workflowScriptPath.
• SCRIPT {workflowScript:"return runs.run('main', {agent:'worker', task:'...'})"}. Use stable-key runs.run for one child and await runs.all([{key,agent,task}, ...]) for ordinary parallel work. runs.all resolves to an ordered array, not a key map; use results[0], destructuring, or results.map(...), not results.<key>. Do not read .output from unawaited runs.run launches. Stored runs.run promises are only for advanced rolling fanout and each must later be observed with direct await, Promise.race, or Promise.all. Await runs.steer(key,message,options?) to guide a prior keyed child; it returns queued, delivered, missed, or failed and never accepts a raw run id. Always await or return steering calls. Use {action:"children.list"} for recent retained workflow children and resume only rows reported resumable. Use {action:"resume",id:"run-id",message:"..."} for a simple follow-up or challenge; resume keeps the stored agent/model/tool contract. If none is resumable, launch a same-role fallback challenge and label it as fallback. Inside workflowScript use runs.run(key,{resume:"run-id",task:"follow-up"}) when the script must wait for completion and continue from the latest returned runId. Workflows get async state.get/state.set through their automatic or explicit mission; mission:false does not. Scripts are ordinary JavaScript statement bodies; use explicit return for a useful result. Use top-level await, plain helper functions, or explicit Promise chains; nested async function, arrow, and method helpers are rejected. For task text with Markdown fences or shell blocks, build quoted lines instead of nesting raw template literals: \`const task=["Run:","\`\`\`bash","npm test","\`\`\`"].join("\\n")\`. Use JavaScript for sequence, branching, retries, and aggregation. For repository mutation lanes, use worktree:true on the workflow or runs.run/runs.all item for managed isolation. ${WORKTREE_BASE_REF_GUIDANCE} Scripts normally start async unless config sets asyncByDefault:false; set async:true explicitly when async behavior matters. async:false blocks the parent until completion and auto-enables a same-repo live chat card unless chatProgress is off; explicit live-card requires same-repository async:false, so async workflows should omit chatProgress or use auto/off.
• ${WORKFLOW_LANES_GUIDANCE}
• FILE SCRIPT {workflowScriptPath:"workflows/review.js"} loads the script on the host relative to the request cwd before sandbox execution. Do not combine it with workflowScript.
• Example: {workflowScript:"const [a,b]=await runs.all([{key:'a',agent:'agent-a',task:'Implement A',worktree:true},{key:'b',agent:'agent-b',task:'Implement B',worktree:true}]); return [a.output,b.output]"}
• context can be fresh, fork, or profile. profile requires the selected agent's declared defaultContext and ignores defaultSubagentContext. Explicit fresh/fork wins; omitted context follows defaultSubagentContext before agent defaultContext. Config forkContext can summarize transcript overflow with stable recovery refs before spawn without adding another public context value. timeoutMs/maxRuntimeMs apply to foreground and async workflows; foreground workflows default to 30 minutes and async workflows have no default timeout. Omit acceptance for reviewer/read-only calls.

MANAGE / CONTROL:
• Use action without execution fields for list/get/models/guide/authoring, refine/refine.show/refine.rollback, mission, watchdog, status, interrupt, stop, resume, steer, worktree.cleanup (mode:'plan' only), script-only scheduling, diagnostics, and other management actions. guide reads shipped current-version docs by topic.
• A mission object needs exactly one non-empty title or summary; objective and labels are optional. goal may only be true and requires budget:{tokens}.

ASYNC / SAFETY:
• ${SUBAGENT_FAILURE_RECOVERY_GUIDANCE}
• Omitted async follows asyncByDefault config; set async:true explicitly when async behavior matters. Continue independent work only until its next dependency barrier; consume the result before work that depends on it. Ordinary async subagents notify this session natively, so return control and do not call bg_wait merely to get a completion wake. Do not sleep or poll merely to wait; use bg_wait only for provider, detached, or other background work without a native notification when this turn must receive its result.
• ${WORKFLOW_RESUME_KEY_GUIDANCE}
• ${WORKFLOW_OUTPUT_BINDING_GUIDANCE}
• ${WORKFLOW_HOST_GUIDANCE}
• Ordinary children are not orchestrators. Keep one writer per cwd/worktree and use fresh read-only reviewers for independent checks.
• Oracle/advisor consultations use available supervisor dialogue for material unknowns; request one-shot when desired.
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
