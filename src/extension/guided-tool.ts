import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { managementActionAuthority, type AuthorityPolicyConfig } from "../policy/authority.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { disabledFeatureSectionNotice, type DisabledFeatureSurface } from "../shared/disabled-features.ts";
import type { Details } from "../shared/types.ts";
import { finalizeToolResult } from "./tool-result.ts";
import { isSubagentFieldName, prepareSubagentToolArguments } from "./subagent-options.ts";

// The model sees this name, description and the 13 main fields, without descriptions; the guide (the reply to the
// session's first call) and later replies teach everything else, so the declaration never changes and the prompt
// cache holds on every model. The fields are declared because some providers drop or blank undeclared ones; other
// fields are still accepted, and rare-action fields can ride inside `args`.
export const SUBAGENT_TOOL_DESCRIPTION = "Delegate work to child agents and manage their runs. Call subagent({}) first for the guide: agents, fields, all actions.";
const declaredString = { type: "string" } as const;
// `output:false` and `workflow:true` still work: Pi's validation turns them into "false"/"true", which execute converts back.
export const SUBAGENT_TOOL_PARAMETERS = Type.Unsafe<Record<string, unknown>>({
	type: "object",
	properties: {
		action: declaredString, agent: declaredString, task: declaredString, id: declaredString, message: declaredString,
		cwd: declaredString, context: { type: "string", enum: ["fresh", "fork"] }, model: declaredString, output: declaredString,
		label: declaredString, worktree: { type: "boolean" }, workflow: declaredString, args: { type: "object", additionalProperties: true },
	},
	additionalProperties: true,
});

export interface GuideAgent {
	name: string;
	description?: string;
}

const AGENT_SUMMARY_MAX_CHARS = 32;
// A summary cut mid-phrase must not end on a word that needs the rest of the phrase.
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
- model: "provider/id", optional thinking suffix :low|medium|high|xhigh, e.g. "anthropic/claude-opus-5-5:high"
- output: file for the child's report, or false
- label: 2-4 words for run lists
- worktree: true isolates it in a git worktree (needs a clean checkout)

Parallel: subagent({workflow:"parallel", args:{tasks:[{agent, task, cwd?, model?, label?}]}, worktree?})
Dependent steps: {action:"guide", topic:"workflows"}
`;

// With workflow scripts disabled by config, the top-level tasks and chain fields replace them.
const NO_SCRIPTS_GUIDE = `
Parallel: subagent({tasks:[{agent, task, cwd?, model?}]})
Dependent steps: subagent({task, chain:[{agent, task?, as?}]}); a step's task can use {task}, {previous}, {outputs.<as>}
`;

const MANAGE_GUIDE = `Manage (id from the launch reply, or a prefix):
- {action:"status"} lists all runs and child questions; with id, one run
- {action:"steer", id, message} redirects a live run
- {action:"resume", id, message} continues a finished run; returns a new id
- {action:"stop", id} ends it; interrupt pauses it
- {action:"reply", replyTo, message} answers a child's question
- {action:"wait", id} (or all:true) blocks, only when this same turn needs the result
- also: list, get, models, doctor, validate, create, update, delete, dismiss
- families: schedule, mission, worktree, lane, inspector, project, watchdog, command, refine
- an action's fields: {action:"guide", topic:"<action or family>"}`;

/** The reply to the session's first call. A child that cannot launch learns only what it can do. */
export function formatGuide(agents: readonly GuideAgent[], options: { canLaunch: boolean; child?: boolean; disabled?: DisabledFeatureSurface }): string {
	if (!options.canLaunch) {
		return `subagent guide (child run). This child cannot launch runs. {action:"wait"} (or all:true) blocks until this child's own background work finishes; {action:"status"} lists it. Ask your parent with contact_supervisor.`;
	}
	const intro = `subagent guide. Children run in the background; a finished child's result wakes you: keep working or end your turn. Don't poll.${options.child ? " You are a child run: your launches are your own children; agent changes (create, update, delete …) are blocked here." : ""}`;
	// An "<agent>-writer" variant shares its base agent's line, so the guide grows by agent, not by mode.
	const names = new Set(agents.map((agent) => agent.name));
	const writerVariant = (name: string) => name.endsWith("-writer") && names.has(name.slice(0, -"-writer".length));
	const agentLines = agents.filter((agent) => !writerVariant(agent.name)).map((agent) => {
		const summary = agentSummary(agent.description);
		const writer = names.has(`${agent.name}-writer`) ? `; ${agent.name}-writer edits` : "";
		return `- ${agent.name}${summary ? `: ${summary}` : ""}${writer}`;
	});
	const launch = options.disabled?.features.has("workflow-scripts") ? LAUNCH_GUIDE.replace(/\nParallel:[^]*$/, NO_SCRIPTS_GUIDE) : LAUNCH_GUIDE;
	const notice = options.disabled ? disabledFeatureSectionNotice(options.disabled) : undefined;
	return [intro, `${launch}\n${MANAGE_GUIDE}`, ...(notice ? [notice] : []), agentLines.length ? `Agents:\n${agentLines.join("\n")}` : "Agents: none found; {action:\"list\"} shows why."].join("\n\n");
}

/** Fields and one example per action family, returned for {action:"guide", topic} and with a rare action's first use. */
const ACTION_TOPICS: Record<string, string> = {
	status: 'status: no id lists all runs and child questions; id (a prefix works) shows one run; view:"fleet"|"transcript" with index, lines. Example: subagent({action:"status", id:"r-1f3"})',
	steer: 'steer: id, message; a live run only (a finished run needs resume). Example: subagent({action:"steer", id:"r-1f3", message:"focus on ..."})',
	resume: 'resume: id, message; continues a finished or paused run and returns a new id: use the latest. Example: subagent({action:"resume", id:"r-1f3", message:"..."})',
	stop: 'stop: id; ends the run, not resumable. interrupt: id; pauses its current turn. Example: subagent({action:"stop", id:"r-1f3"})',
	interrupt: 'interrupt: id; pauses the current turn, resumable. Example: subagent({action:"interrupt", id:"r-1f3"})',
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
	other: 'children.list: id. dismiss: id. debug.run: id. doctor: no fields. grant-spawn-budget: additional (asks the user). Example: subagent({action:"doctor"})',
};

const TOPIC_ALIASES: Record<string, string> = {
	get: "list", models: "list", update: "create", delete: "create", eject: "create", disable: "create", enable: "create", reset: "create",
	"children.list": "other", dismiss: "other", "debug.run": "other", doctor: "other", "grant-spawn-budget": "other",
};

/** The help topic for an action or family name, or undefined when the name is neither. */
export function actionTopicKey(name: string): string | undefined {
	const family = name.includes(".") ? name.slice(0, name.indexOf(".")) : name;
	if (Object.hasOwn(ACTION_TOPICS, name)) return name;
	if (Object.hasOwn(TOPIC_ALIASES, name)) return TOPIC_ALIASES[name];
	if (name.includes(".") && Object.hasOwn(ACTION_TOPICS, family)) return family;
	return undefined;
}

/** An action's fields and example, and how to send them when a provider drops undeclared fields. */
export function actionTopicText(key: string, action = key): string {
	return `${ACTION_TOPICS[key]!}\nIf your fields arrive missing, pass them inside args: subagent({action:"${action}", args:{…}}).`;
}

/**
 * A call that is not a workflow launch reads its fields from `args` too (top-level wins): some providers drop
 * undeclared fields. An action that also runs a workflow (schedule.create, validate) keeps `args` as script input
 * and lifts only the tool's own field names from it.
 */
export function liftArgsFields(params: Record<string, unknown>): Record<string, unknown> {
	const options = params.options && typeof params.options === "object" ? params.options as Record<string, unknown> : {};
	const args = params.args;
	if (!args || typeof args !== "object" || Array.isArray(args)) return params;
	const runsWorkflow = params.workflow !== undefined || options.script !== undefined;
	if (runsWorkflow && params.action === undefined) return params;
	if (runsWorkflow) {
		const lifted = Object.entries(args).filter(([key]) => isSubagentFieldName(key) && key !== "args" && params[key] === undefined);
		return lifted.length ? { ...Object.fromEntries(lifted), ...params } : params;
	}
	const { args: _args, ...rest } = params;
	return { ...(args as Record<string, unknown>), ...rest };
}

export const EMPTY_CALL_TEXT = 'This call arrived with no fields. If you sent fields, this provider may drop them; pass the fields an action needs inside args. The full guide: subagent({action:"guide"}).';

// Actions the guide itself teaches; any other action's first use adds its fields to the reply.
const TAUGHT_BY_GUIDE = new Set(["status", "steer", "resume", "stop", "interrupt", "wait", "reply", "list", "guide"]);

export function rareActionTopic(action: string): string | undefined {
	return TAUGHT_BY_GUIDE.has(action) ? undefined : actionTopicKey(action);
}

/** `{action:"schedule.guide"}`-style calls: the right call, or undefined when the action is not that mistake. */
export function misplacedGuideCall(action: string): string | undefined {
	const match = /^(?:(.+)\.guide|guide\.(.+))$/.exec(action);
	if (!match) return undefined;
	const topic = match[1] ?? match[2]!;
	return `subagent: '${action}' is not an action. For ${topic}'s fields call subagent({action:"guide", topic:"${topic}"}).`;
}

/** A launch: no action, and a child or workflow to start. */
export function isLaunchRequest(params: Record<string, unknown>): boolean {
	return params.action === undefined && (params.agent !== undefined || params.task !== undefined || params.workflow !== undefined || params.tasks !== undefined || params.chain !== undefined);
}

export function holdText(params: Record<string, unknown>, sibling: boolean): string {
	const block = params.workflow === true || params.workflow === "true" ? " Repeat the call with its ```js workflow block in that reply." : "";
	return sibling
		? `Not launched yet: the guide came back in another subagent call of this same message. Read it, then call again to launch.${block}`
		: `Not launched yet: this is the session's first subagent call, so here is the guide. Call again to launch.${block}`;
}

/**
 * The request a call from a codemode script (or any other tool) runs, or why it cannot run. Pi cancels a script's
 * calls when the script ends, so a call must not wait on a child or the user: launches run async, even for an agent
 * whose frontmatter defaults to foreground.
 */
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
	if ((params.workflow === true || params.workflow === "true") && params.workflowScript === undefined) {
		return "subagent workflow:true reads a ```js block from the reply, which a codemode script has none of. Pass the script source as options.script, or a script path as workflow.";
	}
	if (params.async === false || params.clarify === true || params.foregroundOnly === true) {
		return "subagent launches from a codemode script must be async: omit async or pass async:true. A foreground child would block the script until it finished, and be cancelled when the script ends.";
	}
	return { ...params, async: true };
}

/** What replies still in the model's context taught: each teaching reply lists its keys in `details.taught`. */
export function taughtInContext(ctx: Pick<ExtensionContext, "sessionManager">): Set<string> {
	const taught = new Set<string>();
	// Compaction-aware: entries a compaction summarized are gone from the model's context, and so is what they taught.
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		const details = entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : entry.type === "custom_message" ? entry.details : undefined;
		const keys = (details as { taught?: unknown } | undefined)?.taught;
		if (Array.isArray(keys)) for (const key of keys) if (typeof key === "string") taught.add(key);
	}
	return taught;
}

/**
 * What this session's model has been taught, and in which turn the guide arrived. Rebuilt from the session's
 * context on the first call after session start, tree navigation or compaction, so a guide lost to compaction is
 * shown again.
 */
export class TaughtState {
	readonly keys = new Set<string>();
	private turn = 0;
	private guideTurn: number | undefined;
	private stale = true;
	private sessionCtx: Pick<ExtensionContext, "sessionManager"> | undefined;

	/** Rebuild on next use, from `ctx` when given (notices have no call ctx of their own). */
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
		let keys = new Set<string>();
		// A replaced session's ctx throws; then nothing counts as taught and a note is shown again.
		try { if (ctx) keys = taughtInContext(ctx); } catch {}
		for (const key of keys) this.keys.add(key);
	}

	nextTurn(): void {
		this.turn++;
	}

	has(key: string): boolean {
		return this.keys.has(key);
	}

	/** Marks keys taught; returns the ones that were new. */
	teach(...keys: string[]): string[] {
		const fresh = keys.filter((key) => !this.keys.has(key));
		for (const key of fresh) this.keys.add(key);
		if (fresh.includes("guide")) this.guideTurn = this.turn;
		return fresh;
	}

	/**
	 * The guide arrived in this turn's batch: the model has not read it yet. Pi starts a turn before any model tool
	 * call, so with no turn seen the call did not come from a model's batch.
	 */
	guideArrivedThisTurn(): boolean {
		return this.turn > 0 && this.guideTurn === this.turn;
	}
}

// Event guidance: each note is added once while it is still in the chat, to the reply about its event.
export const EVENT_NOTES = {
	launch: 'Next: {action:"status", id} checks it; {action:"steer", id, message} redirects it; {action:"wait", id} only if this same turn needs the result. Completion wakes you: keep working or end your turn.',
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

export function forkNote(fork: { sessionBytes: number; folder: string; freeBytes?: number }): string {
	const free = fork.freeBytes === undefined ? "" : `; ${formatBytes(fork.freeBytes)} free on that disk`;
	return `Fork: the child got a copy of this session (${formatBytes(fork.sessionBytes)}) under ${fork.folder}${free}. Each fork adds one. Once a forked child is accepted or dropped and won't be resumed, delete its <run id> folder there; never one whose run is still active.`;
}

/** What a call's notes need to know beyond the call and its result. */
export interface CallFacts {
	/** Other live runs in the launch's cwd. */
	liveRunsInCwd?: { cwd: string; count: number };
	/** The launched agent when it is a writer (acceptanceRole: writer) given a toolBudget. */
	cappedWriter?: string;
	fork?: { sessionBytes: number; folder: string; freeBytes?: number };
}

/** Event guidance (keyed, once) and warnings (every time) for a model's call. Checks read fields and run state only. */
export function callNotes(request: SubagentParamsLike, result: AgentToolResult<Details>, facts: CallFacts): TeachingNote[] {
	if (result.isError) return [];
	const notes: TeachingNote[] = [];
	const params = request as Record<string, unknown>;
	if (isLaunchRequest(params)) {
		notes.push({ key: "event:launch", text: EVENT_NOTES.launch });
		if (facts.fork) notes.push({ key: "event:fork", text: forkNote(facts.fork) });
		if (params.worktree === true) notes.push({ key: "event:worktree", text: EVENT_NOTES.worktree });
		if (params.workflow !== undefined || params.workflowScript !== undefined) notes.push({ key: "event:workflow", text: EVENT_NOTES.workflow });
		if (facts.liveRunsInCwd && facts.liveRunsInCwd.count > 0) {
			notes.push({ text: `⚠ ${facts.liveRunsInCwd.count === 1 ? "Another run is" : `${facts.liveRunsInCwd.count} other runs are`} live in ${facts.liveRunsInCwd.cwd}. One writer per folder: if they could both edit, use worktree:true.` });
		}
		if (facts.cappedWriter) notes.push({ text: `⚠ ${facts.cappedWriter} is a writer (acceptanceRole: writer) with a toolBudget; a capped writer may stop mid-edit. Launch writers without toolBudget.` });
	}
	if (request.action === "resume" || request.action === "steer") notes.push({ key: "event:resume", text: EVENT_NOTES.resume });
	return notes;
}

/** Event guidance for a completion notice, each note once while in the chat. */
export function noticeNotes(runs: ReadonlyArray<{ agent: string; status: string }>, taught: TaughtState): { text: string; taught: string[] } | undefined {
	taught.ensure();
	const notes: Array<[string, string]> = [];
	if (runs.some((run) => run.status === "completed")) notes.push(["notice:complete", EVENT_NOTES.complete]);
	if (runs.some((run) => run.status === "completed" && /review/i.test(run.agent))) notes.push(["notice:review", EVENT_NOTES.review]);
	if (runs.some((run) => run.status === "failed")) notes.push(["notice:failed", EVENT_NOTES.failed]);
	const fresh = notes.filter(([key]) => taught.teach(key).length > 0);
	return fresh.length ? { text: fresh.map(([, text]) => text).join("\n"), taught: fresh.map(([key]) => key) } : undefined;
}

export function guideResult(text: string, taught: string[], isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [], ...(taught.length ? { taught } : {}) } };
}

/** Adds a teaching note to a result and records what it taught. */
export function withTeaching(result: AgentToolResult<Details>, notes: string[], taught: string[]): AgentToolResult<Details> {
	if (notes.length === 0 && taught.length === 0) return result;
	const details = result.details ?? { mode: "management", results: [] };
	return {
		...result,
		content: notes.length ? [...result.content, { type: "text", text: notes.join("\n\n") }] : result.content,
		details: { ...details, taught: [...(details.taught ?? []), ...taught] },
	};
}

/** A note a reply adds: with a key, once while it is in the chat (event guidance); without one, every time (a warning). */
export interface TeachingNote {
	key?: string;
	text: string;
}

export interface GuidedSubagentToolDeps {
	/** The guide for this session's agents and what this runtime can do. */
	guide(ctx: ExtensionContext): Promise<string>;
	/** Lowers and checks the call's fields; throws with the fix. */
	flatten(params: Record<string, unknown>): SubagentParamsLike;
	/** Runs the call. `nested` calls come from a codemode script and already passed the script guard. */
	run(id: string, request: SubagentParamsLike, nested: boolean, signal: AbortSignal | undefined, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext): Promise<AgentToolResult<Details>>;
	authorityPolicy?: AuthorityPolicyConfig;
	/** Event guidance and warnings for this call's result, each note once while it is in the chat. */
	notes?(request: SubagentParamsLike, result: AgentToolResult<Details>, ctx: ExtensionContext): Promise<TeachingNote[]> | TeachingNote[];
	renderCall?: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>["renderCall"];
	renderResult?: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>["renderResult"];
}

/**
 * The `subagent` tool every runtime declares: the same name, description and empty schema. The first call of any
 * kind returns the guide; a first launch is held once until the guide is in the chat. Only this model-facing path
 * holds: slash commands, RPC and prompt templates call the executor directly.
 */
export function createGuidedSubagentTool(pi: ExtensionAPI, deps: GuidedSubagentToolDeps): { tool: ToolDefinition<typeof SUBAGENT_TOOL_PARAMETERS, Details>; taught: TaughtState } {
	const taught = new TaughtState();
	pi.on("session_start", (_event, ctx) => taught.invalidate(ctx));
	pi.on("session_tree", (_event, ctx) => taught.invalidate(ctx));
	pi.on("session_compact", (_event, ctx) => taught.invalidate(ctx));
	pi.on("turn_start", () => taught.nextTurn());
	// Pi passes parentToolCallId only to tool_call handlers, so record which calls another tool (a codemode script) made.
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
			// Again after Pi's validation, which turns output:false and workflow:true into text for the declared strings.
			const params = liftArgsFields(prepareSubagentToolArguments(rawParams) as Record<string, unknown>);
			const options = params.options && typeof params.options === "object" ? params.options as Record<string, unknown> : {};
			const topic = params.topic ?? options.topic;
			const empty = Object.keys(params).length === 0;
			// A provider that drops fields can loop on empty calls; once the guide is in the chat, answer with one line.
			if (empty && taught.has("guide")) return guideResult(EMPTY_CALL_TEXT, []);
			if (empty || (params.action === "guide" && topic === undefined)) {
				taught.teach("guide");
				return guideResult(await deps.guide(ctx), ["guide"]);
			}
			const topicKey = params.action === "guide" && typeof topic === "string" ? actionTopicKey(topic) : undefined;
			if (topicKey) {
				taught.teach(`topic:${topicKey}`);
				return guideResult(actionTopicText(topicKey, topic as string), [`topic:${topicKey}`]);
			}
			const misplaced = typeof params.action === "string" ? misplacedGuideCall(params.action) : undefined;
			if (misplaced) throw new Error(misplaced);
			const firstCall = !taught.has("guide");
			let request: SubagentParamsLike;
			try {
				request = deps.flatten(params);
			} catch (error) {
				if (!firstCall) throw error;
				taught.teach("guide");
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${await deps.guide(ctx)}`);
			}
			if (isLaunchRequest(request as Record<string, unknown>)) {
				if (firstCall) {
					taught.teach("guide");
					return guideResult(`${await deps.guide(ctx)}\n\n${holdText(params, false)}`, ["guide"]);
				}
				if (taught.guideArrivedThisTurn()) return guideResult(holdText(params, true), []);
			}
			let result: AgentToolResult<Details>;
			const rare = request.action ? rareActionTopic(request.action) : undefined;
			try {
				if (nested) {
					const scriptRequest = nestedSubagentRequest(request, deps.authorityPolicy);
					result = typeof scriptRequest === "string"
						? { content: [{ type: "text", text: scriptRequest }], isError: true, details: { mode: "management", results: [] } }
						: signal?.aborted
							? { content: [{ type: "text", text: "subagent call was cancelled before it started; nothing was launched." }], isError: true, details: { mode: "management", results: [] } }
							: await deps.run(id, scriptRequest, true, signal, onUpdate, ctx);
				} else {
					result = await deps.run(id, request, false, signal, onUpdate, ctx);
				}
			} catch (error) {
				// A rare action's failure (often a missing field) shows that action's fields and the args fallback.
				if (!rare) throw error;
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${actionTopicText(rare, request.action)}`);
			}
			const notes: string[] = [];
			const keys: string[] = [];
			if (firstCall) {
				notes.push(await deps.guide(ctx));
				keys.push(...taught.teach("guide"));
			}
			const freshTopic = rare ? taught.teach(`topic:${rare}`).length > 0 : false;
			if (rare && (freshTopic || result.isError)) {
				notes.push(actionTopicText(rare, request.action));
				if (freshTopic) keys.push(`topic:${rare}`);
			}
			for (const note of await deps.notes?.(request, result, ctx) ?? []) {
				if (note.key && !taught.teach(note.key).length) continue;
				notes.push(note.text);
				if (note.key) keys.push(note.key);
			}
			return finalizeToolResult(withTeaching(result, notes, keys));
		},
		...(deps.renderCall ? { renderCall: deps.renderCall } : {}),
		...(deps.renderResult ? { renderResult: deps.renderResult } : {}),
	};
	return { tool, taught };
}
