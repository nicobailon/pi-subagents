import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { authorityConfirmTitle, managementActionAuthority, type AuthorityPolicyConfig } from "../policy/authority.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { disabledFeatureSectionNotice, type DisabledFeatureSurface } from "../shared/disabled-features.ts";
import { isStaleExtensionContextError } from "../shared/extension-context.ts";
import type { Details, GuideSummary } from "../shared/types.ts";
import { finalizeToolResult } from "./tool-result.ts";
import { readReplyWorkflowScript } from "./reply-workflow-script.ts";
import { isBlankValue, liftArgsFields, prepareSubagentToolArguments } from "./subagent-options.ts";

export const SUBAGENT_TOOL_DESCRIPTION = "Delegate work to child agents and manage their runs. Call subagent({}) first for the guide: agents, fields, all actions.";
export const SUBAGENT_TOOL_PARAMETERS = Type.Unsafe<Record<string, unknown>>({ type: "object", properties: { args: { type: "object", additionalProperties: true } }, additionalProperties: true });

const TRUE_VALUED_FIELDS = new Set(["workflow", "async", "worktree", "all", "nonBlocking", "stopOnAttention", "clarify", "share", "fast", "foregroundOnly"]);

function isBlankCall(params: Record<string, unknown>): boolean {
	const entries = Object.entries(params);
	if (!entries.every(([, value]) => isBlankValue(value))) return false;
	const realAsBlank = ([key, value]: [string, unknown]) => (TRUE_VALUED_FIELDS.has(key) && (value === true || value === "true"))
		|| ((key === "args" || key === "options") && typeof value === "object" && value !== null);
	return !entries.every(realAsBlank);
}

export const BLANK_CALL_TEXT = 'This call\'s fields arrived empty or blank: this provider may drop fields the tool doesn\'t declare. Pass them inside args: subagent({args:{agent, task, …}}) or subagent({args:{action:"status"}}). The full guide: subagent({action:"guide"}).';

const BLANK_WORKFLOW_TEXT = 'If workflow:"<name>" arrived as true or was dropped, put the whole call in args: subagent({args:{workflow:"<name>", args:{…}}}).';

function blankedWorkflowName(request: Record<string, unknown>): boolean {
	const args = request.args;
	return request.workflow === true && request.workflowScript === undefined
		&& typeof args === "object" && args !== null && !Array.isArray(args) && Object.keys(args).length > 0;
}

function droppedWorkflowName(params: Record<string, unknown>, message: string): boolean {
	return params.workflow === undefined && params.action === undefined
		&& ["tasks", "chain"].some((key) => params[key] !== undefined && message.includes(`unknown field '${key}'`));
}

interface GuideAgent {
	name: string;
	description?: string;
}

const AGENT_SUMMARY_MAX_CHARS = 32;
const DANGLING_WORD = /\s+(?:a|an|the|for|of|to|and|or|with|through|that|in|on|by)$/i;

function agentSummary(description: string | undefined): string {
	const first = (description ?? "").split(/[.;,—(]|\s-\s/)[0]!.trim();
	if (first.length <= AGENT_SUMMARY_MAX_CHARS) return first;
	let cut = first.slice(0, AGENT_SUMMARY_MAX_CHARS);
	cut = cut.slice(0, cut.lastIndexOf(" ")).trim();
	while (DANGLING_WORD.test(cut)) cut = cut.replace(DANGLING_WORD, "");
	return cut;
}

const LAUNCH_GUIDE = `Launch: subagent({agent, task, ...})
- task: the child starts cold: goal, cwd, what it may change, evidence, done-when, what to return, when to stop
- cwd: working directory (default: yours)
- context: "fresh" (default) or "fork" (the child gets this conversation)
- model: "provider/id", optional thinking suffix :low|medium|high|xhigh
- output: file for the child's report, or false
- label: 2-4 words for run lists
- worktree: true isolates it in a git worktree (needs a clean checkout)
- timeoutMs: hard deadline in ms; with none (call/agent/config) a check-in wakes you every 30 min (no UI: 30-min stop)

Parallel: subagent({workflow:"parallel", args:{tasks:[{agent, task, cwd?, model?, label?}]}, worktree?})
Steps per item, items in parallel: {action:"guide", topic:"workflows/parallel-sequential-lanes"}
`;

const NO_SCRIPTS_GUIDE = `
Parallel: subagent({tasks:[{agent, task, cwd?, model?}]})
Dependent steps: subagent({task, chain:[{agent, task?, as?}]}); a step's task can use {task}, {previous}, {outputs.<as>}
`;

const MANAGE_GUIDE = `Manage (id from the launch reply, or a prefix):
- {action:"status"} lists all runs and child questions; with id, one run
- {action:"steer", id, message} redirects a live run
- {action:"resume", id, message} continues a finished run; returns a new id
- {action:"stop", id or [ids]} ends it; interrupt pauses it
- {action:"reply", replyTo, message} answers a child's question
- {action:"wait", id} (or all:true) blocks, only when this same turn needs the result
- also: list, get, models, doctor, validate, create, update, delete, dismiss
- families: schedule, mission, worktree, lane, inspector, project, watchdog, command, refine
- unsure? {action:"guide", topic:"<action, family or subject, e.g. workflows>"}; a wrong guess lists topics
- fields arrive blank? put them all in args: subagent({args:{agent, task, …}})`;

const GUIDE_LAUNCH_ROW_SKIPS = new Set(["task", "label"]);
const GUIDE_LAUNCH_ROW = [
	LAUNCH_GUIDE.split("\n")[0]!.replace(/^Launch: /, "").replace("...", "…"),
	...[...LAUNCH_GUIDE.matchAll(/^- (\w+):/gm)].map((match) => match[1]!).filter((field) => !GUIDE_LAUNCH_ROW_SKIPS.has(field)),
];
const GUIDE_MANAGE_ROW = [...MANAGE_GUIDE.matchAll(/^- \{action:"([\w.-]+)"/gm)].map((match) => match[1]!);

function estimateTokens(text: string): number {
	return Math.round(text.length / 2.3 / 50) * 50;
}

export interface GuideReply {
	text: string;
	summary?: GuideSummary;
}

export function buildGuide(agents: readonly GuideAgent[], options: { canLaunch: boolean; child?: boolean; disabled?: DisabledFeatureSurface }): GuideReply {
	if (!options.canLaunch) {
		return { text: `subagent guide (child run). This child cannot launch runs. {action:"wait"} (or all:true) blocks until this child's own background work finishes. Ask your parent with contact_supervisor.` };
	}
	const intro = options.child
		? `subagent guide (child run). Your launches are your own children and run in the background; their results do not wake you. Collect them with {action:"wait"} (or all:true) before you finish. Agent changes (create, update, delete …) are blocked here.`
		: `subagent guide. Children run in the background; a finished child's result wakes you: keep working or end your turn. Don't poll. Not for messaging an open Pi session; use a messaging tool.`;
	const names = new Set(agents.map((agent) => agent.name));
	const writerVariant = (name: string) => name.endsWith("-writer") && names.has(name.slice(0, -"-writer".length));
	const listed = agents.filter((agent) => !writerVariant(agent.name));
	const agentLines = listed.map((agent) => {
		const summary = agentSummary(agent.description);
		const writer = names.has(`${agent.name}-writer`) ? `; ${agent.name}-writer edits` : "";
		return `- ${agent.name}${summary ? `: ${summary}` : ""}${writer}`;
	});
	const launch = options.disabled?.features.has("workflow-scripts") ? LAUNCH_GUIDE.replace(/\nParallel:[^]*$/, NO_SCRIPTS_GUIDE) : LAUNCH_GUIDE;
	const notice = options.disabled ? disabledFeatureSectionNotice(options.disabled) : undefined;
	const text = [intro, `${launch}\n${MANAGE_GUIDE}`, ...(notice ? [notice] : []), agentLines.length ? `Agents (as of now; {action:"list"} refreshes):\n${agentLines.join("\n")}` : "Agents: none found; {action:\"list\"} shows why."].join("\n\n");
	return { text, summary: { tokens: estimateTokens(text), launch: GUIDE_LAUNCH_ROW, manage: GUIDE_MANAGE_ROW, agents: listed.map((agent) => agent.name) } };
}

const ACTION_TOPICS: Record<string, string> = {
	status: 'status: no id lists all runs and child questions; id (a prefix works) shows one run; view:"fleet"|"transcript" with index, lines. Example: subagent({action:"status", id:"r-1f3"})',
	steer: 'steer: id, message; a live run only (a finished run needs resume). Example: subagent({action:"steer", id:"r-1f3", message:"focus on ..."})',
	resume: 'resume: id, message; continues a finished or paused run and returns a new id: use the latest. Example: subagent({action:"resume", id:"r-1f3", message:"..."})',
	stop: 'stop: id, or a list of ids; ends the run, not resumable. interrupt: id or a list; pauses its current turn. Example: subagent({action:"stop", id:"r-1f3"}); several: id:["r-1f3","r-9a2"]',
	interrupt: 'interrupt: id, or a list of ids; pauses the current turn, resumable. Example: subagent({action:"interrupt", id:"r-1f3"}); several: id:["r-1f3","r-9a2"]',
	wait: 'wait: id, or all:true; nonBlocking:true (with id) returns now and wakes you later; timeoutMs; stopOnAttention:false keeps waiting through attention. Completion wakes you anyway: wait only when this same turn needs the result. Example: subagent({action:"wait", id:"r-1f3"})',
	reply: 'reply: replyTo (the question id from status or the notice), message. Example: subagent({action:"reply", replyTo:"<question id>", message:"Yes, rerun only that job."})',
	list: 'list: search, capabilities:true for compact rows. get: agent. models: lists model ids. Example: subagent({action:"list", search:"review"})',
	validate: 'validate: workflow (true with a ```js workflow block in the same reply, or a script path); checks without launching. Example: subagent({action:"validate", workflow:"./flow.js"})',
	create: 'create/update: config (object: name, description, systemPrompt, tools, model, ...); delete/eject/disable/enable/reset: agent. Example: subagent({action:"create", config:{name:"auditor", description:"...", systemPrompt:"..."}})',
	schedule: 'schedule.create: name or id, workflow (true with a ```js workflow block in the same reply, or a script path; a single child is runs.run("main", {agent, task})), and one trigger: at ("HH:mm", ISO or "10m") or every ("6h", "day", "week"); on (["mon".."sun"]) with every:"week"; timezone; catchUp "none"|"latest". Example: subagent({action:"schedule.create", name:"pr-review", workflow:"./review.js", every:"week", on:["mon","tue","wed","thu","fri"], at:"09:00"}). Then schedule.list, schedule.show / history / pause / resume / run / delete with id.',
	mission: 'mission.create: mission ({title or summary, objective?, labels?}). mission.list, mission.show (missionId), mission.update (missionId, missionUpdate), mission.attach-run (missionId, id), mission.close (missionId, summary). Example: subagent({action:"mission.create", mission:{title:"Auth refresh"}})',
	worktree: 'worktree.cleanup: repo, mode:"plan", then mode:"apply" with the reviewed planId. worktree.discard: handoffPath. Example: subagent({action:"worktree.cleanup", repo:"/path/to/repo", mode:"plan"})',
	lane: 'lane.status: handoffPath, laneId. lane.recordMerge: handoffPath, laneId, merge (evidence). lane.recordSupersession: handoffPath, laneId, supersession. Example: subagent({action:"lane.status", handoffPath:"..."})',
	inspector: 'inspector.open / status / close / command: id, index?, focus?. Example: subagent({action:"inspector.open", id:"r-1f3", index:0})',
	project: 'project.open: cwd, message, focus?; project.status, project.close. Example: subagent({action:"project.open", cwd:"/path/to/repo", message:"Start here."})',
	watchdog: 'watchdog.status, watchdog.check, watchdog.recommend-model; watchdog.configure: model ("recommended" or provider/id), thinking, scope "session"|"user"|"project", target. Example: subagent({action:"watchdog.configure", model:"recommended", scope:"session"}). How it works: topic "watchdog/when-it-runs".',
	command: 'command.status / yield / cancel: id, index, toolCallId?. Example: subagent({action:"command.status", id:"r-1f3", index:0})',
	refine: 'refine: agent; refine.show and refine.rollback: agent. Example: subagent({action:"refine", agent:"reviewer"})',
	other: 'children.list: id. dismiss: id, or a list of ids. debug.run: id. doctor: no fields. grant-spawn-budget: additional (asks the user). Example: subagent({action:"doctor"})',
};

const TOPIC_ALIASES: Record<string, string> = {
	get: "list", models: "list", update: "create", delete: "create", eject: "create", disable: "create", enable: "create", reset: "create",
	"children.list": "other", dismiss: "other", "debug.run": "other", doctor: "other", "grant-spawn-budget": "other",
};

export function actionTopicKey(name: string): string | undefined {
	const family = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
	if (Object.hasOwn(ACTION_TOPICS, name)) return name;
	if (Object.hasOwn(TOPIC_ALIASES, name)) return TOPIC_ALIASES[name];
	if (name.includes(".") && Object.hasOwn(ACTION_TOPICS, family)) return family;
	return undefined;
}

function actionTopicText(key: string, action = key): string {
	return `${ACTION_TOPICS[key]!}\nIf your fields arrive missing, pass them inside args: subagent({args:{action:"${action}", …}}).`;
}

const TAUGHT_BY_GUIDE = new Set(["status", "steer", "resume", "stop", "interrupt", "wait", "reply", "list", "guide"]);

function rareActionTopic(action: string): string | undefined {
	return TAUGHT_BY_GUIDE.has(action) ? undefined : actionTopicKey(action);
}

function misplacedGuideCall(action: string): string | undefined {
	const match = /^(?:(.+)\.guide|guide\.(.+))$/.exec(action);
	if (!match) return undefined;
	const topic = match[1] ?? match[2]!;
	return `subagent: '${action}' is not an action. For ${topic}'s fields call subagent({action:"guide", topic:"${topic}"}).`;
}

const LIST_ID_ACTIONS = new Set(["stop", "interrupt", "dismiss"]);

function listedIds(params: Record<string, unknown>): string[] | undefined {
	if (typeof params.action !== "string" || !LIST_ID_ACTIONS.has(params.action)) return undefined;
	const invalid = new Error(`subagent: '${params.action}' takes id as one run id or a list of run ids.`);
	let id = params.id;
	if (typeof id === "string" && /^\s*\[/.test(id)) {
		try {
			id = JSON.parse(id);
		} catch {
			throw invalid;
		}
	}
	if (!Array.isArray(id)) return undefined;
	if (id.length === 0 || !id.every((entry) => typeof entry === "string" && /^\S+$/.test(entry))) throw invalid;
	return id;
}

function listedIdsResult(ids: readonly string[], results: readonly AgentToolResult<Details>[]): AgentToolResult<Details> {
	const lines = results.map((result, index) => {
		const text = result.content.map((part) => part.type === "text" ? part.text : "").join(" ").replace(/\s*\n\s*/g, " ").trim();
		return text.includes(ids[index]!) ? text : `${ids[index]}: ${text}`;
	});
	return guideResult(lines.join("\n"), [], {}, results.every((result) => result.isError));
}

function isLaunchRequest(params: Record<string, unknown>): boolean {
	return params.action === undefined && (params.agent !== undefined || params.task !== undefined || params.workflow !== undefined || params.workflowScript !== undefined || params.tasks !== undefined || params.chain !== undefined);
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.lastIndexOf(" ", max);
	return `${flat.slice(0, cut > 0 ? cut : max)}…`;
}

function launchPreview(request: Record<string, unknown>): string {
	const agents = (steps: unknown[]) => steps.map((step) => {
		const { agent, parallel } = (step ?? {}) as { agent?: unknown; parallel?: unknown };
		return typeof agent === "string" ? agent : Array.isArray(parallel) ? "parallel step" : "?";
	});
	const what = request.workflowScript !== undefined ? "a workflow script"
		: request.workflow === true ? "a ```js workflow block"
		: typeof request.workflow === "string" ? `workflow ${request.workflow}`
		: Array.isArray(request.tasks) ? `${request.tasks.length} in parallel: ${agents(request.tasks).join(", ")}`
		: Array.isArray(request.chain) ? `a chain: ${agents(request.chain).join(" → ")}`
		: typeof request.agent === "string" ? request.agent : "a child";
	const parts = [what];
	if (typeof request.task === "string" && request.task.trim()) parts.push(`task "${clip(request.task, 48)}"`);
	if (typeof request.cwd === "string") parts.push(`cwd ${request.cwd}`);
	if (request.worktree === true) parts.push("in a worktree");
	if (request.context === "fork") parts.push("forked context");
	if (typeof request.model === "string") parts.push(`model ${request.model}`);
	return `Would launch ${parts.join(", ")}.`;
}

function holdText(request: Record<string, unknown>, preview: string, sibling: boolean, workflowHint: boolean): string {
	const block = request.workflow === true ? " Repeat the call with its ```js workflow block in that reply." : "";
	const held = sibling
		? `Not launched yet: the guide came back in another subagent call of this same message. Read it, then call again to launch.${block}`
		: `Not launched yet: this is the session's first subagent call, so here is the guide. Call again to launch.${block}`;
	return `${held}\n${preview}${workflowHint ? `\n${BLANK_WORKFLOW_TEXT}` : ""}`;
}

export function nestedSubagentRequest(params: SubagentParamsLike, authorityPolicy: AuthorityPolicyConfig | undefined): SubagentParamsLike | string {
	const action = params.action?.trim();
	if (action === "wait") {
		return "subagent action 'wait' cannot run from a codemode script: the completion notice wakes the session; end the script.";
	}
	if (action === "refine") {
		return "subagent action 'refine' cannot run from a codemode script: it waits for a foreground reviewer child to finish.";
	}
	if (action) {
		const authority = managementActionAuthority(action, params.mode, authorityPolicy);
		return authority?.decision === "confirm"
			? `subagent action '${action}' cannot run from a codemode script: authorityPolicy.${authority.authority} is "confirm", so it would wait for the user to confirm.`
			: params;
	}
	if (params.workflow === true && params.workflowScript === undefined) {
		return "subagent workflow:true reads a ```js block from the reply, which a codemode script has none of. Pass the script source as options.script, or a script path as workflow.";
	}
	if (params.async === false || params.clarify === true || params.foregroundOnly === true) {
		return "subagent launches from a codemode script must be async: omit async or pass async:true. A foreground child would block the script until it finished, and be cancelled when the script ends.";
	}
	return { ...params, async: true };
}

function taughtInContext(ctx: Pick<ExtensionContext, "sessionManager">): Set<string> {
	const taught = new Set<string>();
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		const details = entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : entry.type === "custom_message" ? entry.details : undefined;
		const keys = (details as { taught?: unknown } | undefined)?.taught;
		if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") taught.add(key);
	}
	return taught;
}

export class TaughtState {
	readonly keys = new Set<string>();
	private turn = 0;
	private guideTurn: number | undefined;
	private stale = true;
	private sessionCtx: Pick<ExtensionContext, "sessionManager"> | undefined;

	invalidate(ctx?: Pick<ExtensionContext, "sessionManager">): void {
		this.stale = true;
		if (ctx) this.sessionCtx = ctx;
	}

	ensure(ctx: Pick<ExtensionContext, "sessionManager"> | undefined = this.sessionCtx): void {
		if (!this.stale) return;
		this.stale = false;
		this.keys.clear();
		this.guideTurn = undefined;
		if (ctx) this.sessionCtx = ctx;
		try {
			if (ctx) for (const key of taughtInContext(ctx)) this.keys.add(key);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
		}
	}

	nextTurn(): void {
		this.turn++;
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	teach(...keys: string[]): string[] {
		const fresh = keys.filter((key) => !this.keys.has(key));
		for (const key of fresh) this.keys.add(key);
		if (fresh.includes("guide")) this.guideTurn = this.turn;
		return fresh;
	}

	guideArrivedThisTurn(): boolean {
		return this.turn > 0 && this.guideTurn === this.turn;
	}
}

export const EVENT_NOTES = {
	launch: 'Next: {action:"status", id} checks it; {action:"steer", id, message} redirects it; {action:"wait", id} only if this same turn needs the result.',
	childLaunch: 'Next: {action:"status", id} checks it; {action:"steer", id, message} redirects it. Its result does not wake you: collect it with {action:"wait", id} (or all:true) before you finish.',
	worktree: "Worktree: the child edits its own git worktree, made from a clean checkout (untracked files count). One writer per folder: give each writer its own worktree; parallelize reading and review.",
	workflow: 'Workflow scripts: a statement body with top-level await and an explicit return; no nested async functions or arrows. Every runs.run / runs.all item needs a stable key and a short verb + behavior label. Bind a report to a file with output:"plans/x.md" (a filename in the task text does not route output). runs.all resolves to an ordered array.',
	resume: "resume returns a new id: always use the latest. A finished run takes resume; a live one takes steer.",
	complete: "Results are evidence, not approval: you accept or reject them.",
	review: "Reviewer findings: fix each one (fixes go to a worker) or disprove it with evidence.",
	failed: "A failed run blocks its lane: stop, report the exact failure and the run's state, then retry once the same way. Switching to another tool or CLI needs the user's approval.",
} as const;

function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
	return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function forkNote(fork: { sessionBytes: number; folder: string; freeBytes?: number }): string {
	const free = fork.freeBytes === undefined ? "" : `; ${formatBytes(fork.freeBytes)} free on that disk`;
	return `Fork: the child got a copy of this session (${formatBytes(fork.sessionBytes)}) under ${fork.folder}${free}. Each fork adds one. Once a forked child is accepted or dropped and won't be resumed, delete its <run id> folder there; never one whose run is still active.`;
}

export interface CallFacts {
	liveRunsInCwd?: { cwd: string; runs: Array<{ label: string; id: string }> };
	cappedWriter?: string;
	child?: boolean;
	fork?: { sessionBytes: number; folder: string; freeBytes?: number };
}

export function callNotes(request: SubagentParamsLike, result: AgentToolResult<Details>, facts: CallFacts): TeachingNote[] {
	if (result.isError) return [];
	const notes: TeachingNote[] = [];
	if (isLaunchRequest(request as Record<string, unknown>)) {
		const details = result.details;
		if (details.mode === "single" && details.runId && details.asyncId === undefined && !details.results.some((run) => run.detached)) {
			const id = details.runId.slice(0, 8);
			const state = details.results.some((run) => run.interrupted) ? "paused" : "done";
			notes.push({ text: `Run ${id} is ${state}. To continue it: subagent({action:"resume", id:"${id}", message})` });
		} else {
			notes.push({ key: "event:launch", text: facts.child ? EVENT_NOTES.childLaunch : EVENT_NOTES.launch });
		}
		if (facts.fork) notes.push({ key: "event:fork", text: forkNote(facts.fork) });
		if (request.worktree === true) notes.push({ key: "event:worktree", text: EVENT_NOTES.worktree });
		if (request.workflow !== undefined || request.workflowScript !== undefined) notes.push({ key: "event:workflow", text: EVENT_NOTES.workflow });
		if (facts.liveRunsInCwd && facts.liveRunsInCwd.runs.length > 0) {
			const { cwd, runs } = facts.liveRunsInCwd;
			const listed = runs.slice(0, 5).map((run) => `${run.label} ${run.id}`);
			const more = runs.length > 5 ? `, +${runs.length - 5} more` : "";
			notes.push({ text: `⚠ Also running from ${cwd}: ${listed.join(", ")}${more}.` });
			notes.push({ key: "warn:same-folder", text: "One writer per folder; readers, reviewers and worktree runs can share it." });
		}
		if (facts.cappedWriter) notes.push({ key: `warn:capped:${facts.cappedWriter}`, text: `⚠ ${facts.cappedWriter} is a writer (acceptanceRole: writer) with a toolBudget; a capped writer may stop mid-edit. Launch writers without toolBudget.` });
	}
	if (request.action === "resume" || request.action === "steer") notes.push({ key: "event:resume", text: EVENT_NOTES.resume });
	return notes;
}

export function noticeNotes(runs: ReadonlyArray<{ agent: string; status: string }>, taught: TaughtState): { text: string; taught: string[] } | undefined {
	taught.ensure();
	const notes: Array<[string, string]> = [];
	if (runs.some((run) => run.status === "completed")) notes.push(["notice:complete", EVENT_NOTES.complete]);
	if (runs.some((run) => run.status === "completed" && /review/i.test(run.agent))) notes.push(["notice:review", EVENT_NOTES.review]);
	if (runs.some((run) => run.status === "failed")) notes.push(["notice:failed", EVENT_NOTES.failed]);
	const fresh = notes.filter(([key]) => taught.teach(key).length > 0);
	return fresh.length ? { text: fresh.map(([, text]) => text).join("\n"), taught: fresh.map(([key]) => key) } : undefined;
}

type GuideView = Pick<Details, "guide" | "heldLaunch" | "guideTopic">;

function guideResult(text: string, taught: string[], view: GuideView = {}, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [], ...(taught.length ? { taught } : {}), ...view } };
}

function withTeaching(result: AgentToolResult<Details>, notes: string[], taught: string[]): AgentToolResult<Details> {
	if (notes.length === 0 && taught.length === 0) return result;
	const details = result.details;
	return {
		...result,
		content: notes.length ? [...result.content, ...notes.map((text) => ({ type: "text" as const, text }))] : result.content,
		details: { ...details, taught: [...(details.taught ?? []), ...taught] },
	};
}

interface TeachingNote {
	key?: string;
	text: string;
}

interface GuidedSubagentToolDeps {
	guide(ctx: ExtensionContext): Promise<GuideReply>;
	flatten(params: Record<string, unknown>): SubagentParamsLike;
	run(id: string, request: SubagentParamsLike, nested: boolean, signal: AbortSignal | undefined, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext): Promise<AgentToolResult<Details>>;
	authorityPolicy?: AuthorityPolicyConfig;
	canLaunch?: boolean;
	notes?(request: SubagentParamsLike, result: AgentToolResult<Details>, ctx: ExtensionContext): Promise<TeachingNote[]> | TeachingNote[];
	renderCall?: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>["renderCall"];
	renderResult?: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>["renderResult"];
}

export function createGuidedSubagentTool(pi: ExtensionAPI, deps: GuidedSubagentToolDeps): { tool: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>; taught: TaughtState } {
	const taught = new TaughtState();
	pi.on("session_start", (_event, ctx) => taught.invalidate(ctx));
	pi.on("session_tree", (_event, ctx) => taught.invalidate(ctx));
	pi.on("session_compact", (_event, ctx) => taught.invalidate(ctx));
	pi.on("turn_start", () => taught.nextTurn());
	const nestedCallIds = new Set<string>();
	pi.on("tool_call", (event) => {
		if (event.toolName === "subagent" && event.parentToolCallId) nestedCallIds.add(event.toolCallId);
	});
	const tool: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details> = {
		name: "subagent",
		exposure: "direct",
		label: "Subagent",
		description: SUBAGENT_TOOL_DESCRIPTION,
		parameters: SUBAGENT_TOOL_PARAMETERS,
		prepareArguments: (args) => prepareSubagentToolArguments(args) as Record<string, unknown>,
		async execute(id, rawParams, signal, onUpdate, ctx) {
			const nested = nestedCallIds.delete(id);
			taught.ensure(ctx);
			if (!nested && isBlankCall(rawParams)) {
				if (taught.has("guide")) return guideResult(BLANK_CALL_TEXT, []);
				taught.teach("guide");
				const reply = await deps.guide(ctx);
				return guideResult(`${BLANK_CALL_TEXT}\n\n${reply.text}`, ["guide"], reply.summary ? { guide: reply.summary } : {});
			}
			const prepared = prepareSubagentToolArguments(rawParams) as Record<string, unknown>;
			const lifted = liftArgsFields(prepared);
			const params = lifted === prepared ? prepared : prepareSubagentToolArguments(lifted) as Record<string, unknown>;
			const options = params.options && typeof params.options === "object" ? params.options as Record<string, unknown> : {};
			const rawTopic = params.topic ?? options.topic;
			const topic = rawTopic === "null" ? undefined : rawTopic;
			const empty = Object.keys(params).length === 0;
			if (empty && taught.has("guide")) return guideResult(BLANK_CALL_TEXT, []);
			if (empty || (params.action === "guide" && topic === undefined)) {
				const again = taught.teach("guide").length === 0;
				const reply = await deps.guide(ctx);
				return guideResult(reply.text, ["guide"], reply.summary ? { guide: again ? { ...reply.summary, again } : reply.summary } : {});
			}
			const topicKey = params.action === "guide" && typeof topic === "string" ? actionTopicKey(topic) : undefined;
			if (topicKey) {
				taught.teach(`topic:${topicKey}`);
				return guideResult(actionTopicText(topicKey, topic as string), [`topic:${topicKey}`], { guideTopic: { title: topic as string, lead: ACTION_TOPICS[topicKey]!.split(" Example:")[0]! } });
			}
			const misplaced = typeof params.action === "string" ? misplacedGuideCall(params.action) : undefined;
			if (misplaced) throw new Error(misplaced);
			const firstCall = !taught.has("guide");
			let request: SubagentParamsLike;
			let ids: string[] | undefined;
			try {
				ids = listedIds(params);
				request = deps.flatten(ids ? { ...params, id: ids[0] } : params);
				const conflicts = ids ? (["runId", "dir"] as const).filter((key) => request[key] !== undefined) : [];
				if (conflicts.length) throw new Error(`subagent: a list in id can't be combined with ${conflicts.join(" or ")}; put every target in id.`);
			} catch (error) {
				let message = error instanceof Error ? error.message : String(error);
				const hinted = lifted !== prepared && droppedWorkflowName(params, message);
				if (hinted) message += `\n${BLANK_WORKFLOW_TEXT}`;
				if (!firstCall) throw hinted ? new Error(message) : error;
				taught.teach("guide");
				return guideResult(`${message}\n\n${(await deps.guide(ctx)).text}`, ["guide"], {}, true);
			}
			const record = request as Record<string, unknown>;
			const workflowHint = () => blankedWorkflowName(record) && (!ctx?.sessionManager || "error" in readReplyWorkflowScript(ctx.sessionManager, id));
			if (deps.canLaunch !== false && isLaunchRequest(record)) {
				const preview = launchPreview(record);
				if (firstCall) {
					taught.teach("guide");
					const reply = await deps.guide(ctx);
					return guideResult(`${holdText(record, preview, false, workflowHint())}\n\n${reply.text}`, ["guide"], { guide: reply.summary, heldLaunch: preview });
				}
				if (taught.guideArrivedThisTurn()) return guideResult(holdText(record, preview, true, workflowHint()), [], { heldLaunch: preview });
			}
			let result: AgentToolResult<Details>;
			const rare = request.action ? rareActionTopic(request.action) : undefined;
			const replyHint = request.action === "reply" && (request.replyTo === undefined || request.message === undefined)
				? 'If your fields arrive missing, pass them inside args: subagent({args:{action:"reply", replyTo, message}}).'
				: undefined;
			const runOne = async (one: SubagentParamsLike, runCtx: ExtensionContext = ctx): Promise<AgentToolResult<Details>> => {
				try {
					if (!nested) return await deps.run(id, one, false, signal, onUpdate, runCtx);
					const scriptRequest = nestedSubagentRequest(one, deps.authorityPolicy);
					if (typeof scriptRequest === "string") return guideResult(scriptRequest, [], {}, true);
					if (signal?.aborted) return guideResult("subagent call was cancelled before it started; nothing was launched.", [], {}, true);
					return await deps.run(id, scriptRequest, true, signal, onUpdate, ctx);
				} catch (error) {
					return guideResult(error instanceof Error ? error.message : String(error), [], {}, true);
				}
			};
			if (ids) {
				const action = request.action!;
				const confirm = !nested && ctx?.hasUI === true && managementActionAuthority(action, request.mode, deps.authorityPolicy)?.decision === "confirm";
				if (confirm && !await ctx.ui.confirm(authorityConfirmTitle(action, ids), `Authority policy requires confirmation before '${action}'.`)) {
					result = guideResult(`Action '${action}' canceled; authority was not granted.`, []);
				} else {
					const prompt = authorityConfirmTitle(action);
					const runCtx = confirm
						? Object.create(ctx, { ui: { value: Object.assign(Object.create(ctx.ui) as ExtensionContext["ui"], {
							confirm: (...args: Parameters<ExtensionContext["ui"]["confirm"]>) => args[0] === prompt ? Promise.resolve(true) : ctx.ui.confirm(...args),
						}) } }) as ExtensionContext
						: ctx;
					const results: AgentToolResult<Details>[] = [];
					for (const entry of ids) {
						results.push(signal?.aborted
							? guideResult(`${entry}: skipped, the call was cancelled.`, [], {}, true)
							: await runOne({ ...request, id: entry }, runCtx));
					}
					result = listedIdsResult(ids, results);
				}
			} else {
				result = await runOne(request);
			}
			const notes: string[] = [];
			const keys: string[] = [];
			let attachedGuide: GuideSummary | undefined;
			if (firstCall) {
				const fresh = taught.teach("guide");
				if (fresh.length) {
					const reply = await deps.guide(ctx);
					notes.push(reply.text);
					keys.push(...fresh);
					if (reply.summary) attachedGuide = { ...reply.summary, attached: true };
				}
			}
			const freshTopic = rare ? taught.teach(`topic:${rare}`).length > 0 : false;
			if (rare && (freshTopic || result.isError)) {
				notes.push(actionTopicText(rare, request.action));
				if (freshTopic) keys.push(`topic:${rare}`);
			}
			if (replyHint && result.isError) notes.push(replyHint);
			if (result.isError && workflowHint()) notes.push(BLANK_WORKFLOW_TEXT);
			for (const note of await deps.notes?.(request, result, ctx) ?? []) {
				if (note.key && !taught.teach(note.key).length) continue;
				notes.push(note.text);
				if (note.key) keys.push(note.key);
			}
			const taughtResult = withTeaching(result, notes, keys);
			if (keys.length === 0) return finalizeToolResult(taughtResult);
			return attachedGuide ? { ...taughtResult, details: { ...taughtResult.details, guide: attachedGuide } } : taughtResult;
		},
		...(deps.renderCall ? { renderCall: deps.renderCall } : {}),
		...(deps.renderResult ? { renderResult: deps.renderResult } : {}),
	};
	return { tool, taught };
}
