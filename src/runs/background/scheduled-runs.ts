import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getProjectSubagentsDir } from "../../shared/artifacts.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { shortenPath } from "../../shared/formatters.ts";
import type { AsyncStatus, Details, ExtensionConfig } from "../../shared/types.ts";
import type { SubagentParamsLike } from "../foreground/subagent-executor.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { previewSimpleWorkflowRun } from "../../workflows/scripted-workflow.ts";

export const SCHEDULED_RUN_ACTIONS = [
	"schedule.create",
	"schedule.list",
	"schedule.show",
	"schedule.history",
	"schedule.pause",
	"schedule.resume",
	"schedule.run",
	"schedule.run-due",
	"schedule.delete",
] as const;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_PENDING = 20;
const MAX_HISTORY = 100;
const STALE_LAUNCH_CLAIM_MS = 5 * 60_000;
const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ScheduledRunTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
export type ScheduledRunAction = typeof SCHEDULED_RUN_ACTIONS[number];
export type ScheduleRunState = "running" | "skipped" | "missed" | "completed" | "failed_launch" | "failed_run";
export type ScheduleTrigger =
	| { kind: "once"; at: string; nextRunAt?: string }
	| { kind: "interval"; every: string; everyMs: number; anchorAt: string; nextRunAt: string };
export type ScheduleTarget = { workflowScript: string };

export interface ScheduleRecord {
	schemaVersion: 1;
	id: string;
	name: string;
	cwd: string;
	trigger: ScheduleTrigger;
	target: ScheduleTarget;
	overlap: "skip";
	catchUp: "none" | "latest";
	timeoutMs?: number;
	paused: boolean;
	createdAt: string;
	updatedAt: string;
	activeRunId?: string;
	lastRunId?: string;
}

export interface ScheduleRunRecord {
	schemaVersion: 1;
	id: string;
	scheduleId: string;
	plannedAt: string;
	dueReason: "timer" | "run-due" | "manual";
	state: ScheduleRunState;
	startedAt?: string;
	completedAt?: string;
	asyncId?: string;
	asyncDir?: string;
	error?: string;
}

type ScheduledRunManagerDeps = {
	config: ExtensionConfig;
	launch(params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentToolResult<Details>>;
	storeRoot?: string;
	now?: () => number;
	randomId?: () => string;
	resolveCapabilityCeiling?: (sessionId: string) => ResolvedSubagentCapabilityCeiling | undefined;
	timers?: ScheduledRunTimers;
};

export function isScheduledRunAction(action: unknown): action is ScheduledRunAction {
	return typeof action === "string" && (SCHEDULED_RUN_ACTIONS as readonly string[]).includes(action);
}

export function scheduledRunsEnabled(config: ExtensionConfig): boolean {
	return config.scheduledRuns?.enabled !== false;
}

export function scheduledRunStorePath(cwd: string, _sessionId?: string, root?: string): string {
	if (!root) return path.join(getProjectSubagentsDir(path.resolve(cwd)), "schedules");
	const projectKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
	return path.join(root, projectKey);
}

export function parseScheduledRunTime(at: string, now = Date.now()): number {
	const trimmed = at.trim();
	const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid at value "${at}". Relative delays must be positive, such as "+10m".`);
		const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
		const result = now + amount * unitMs;
		if (!Number.isSafeInteger(result)) throw new Error(`Invalid at value "${at}". Relative delay is too large.`);
		return result;
	}
	const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
	if (!iso) throw new Error(`Invalid at value "${at}". Use a one-shot delay such as "+10m" or an ISO timestamp with timezone.`);
	const year = Number(iso[1]);
	const month = Number(iso[2]);
	const day = Number(iso[3]);
	const hour = Number(iso[4]);
	const minute = Number(iso[5]);
	const second = iso[6] === undefined ? 0 : Number(iso[6]);
	const zone = iso[7]!;
	const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
	const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
	const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
	const parsed = Date.parse(trimmed);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(parsed)) throw new Error(`Invalid at value "${at}". Use a valid ISO timestamp.`);
	if (parsed <= now) throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
	return parsed;
}

export function parseScheduleInterval(every: string): number {
	const match = every.trim().match(/^(\d+)(m|h|d|w)$/);
	if (!match) throw new Error(`Invalid every value "${every}". This first recurring slice supports fixed intervals such as "30m", "6h", "2d", or "2w".`);
	const amount = Number(match[1]);
	if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid every value "${every}". Interval must be positive.`);
	const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m" | "h" | "d" | "w"];
	const result = amount * unitMs;
	if (!Number.isSafeInteger(result)) throw new Error(`Invalid every value "${every}". Interval is too large.`);
	return result;
}

function timestamp(value: number): string {
	return new Date(value).toISOString();
}

function validateScheduleId(id: string): string {
	if (!SCHEDULE_ID.test(id)) throw new Error("Schedule id must be 1-64 characters and contain only letters, numbers, '.', '_', or '-'.");
	return id;
}

function pathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertScheduleRoot(root: string, projectCwd: string | undefined, create: boolean): void {
	if (!projectCwd) {
		if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		return;
	}
	let projectPath: string;
	try {
		projectPath = fs.realpathSync(projectCwd);
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	let existing = root;
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	if (!pathWithin(projectPath, fs.realpathSync(existing))) throw new Error(`Project schedule root '${root}' resolves outside the real project.`);
	if (!create) return;
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	if (!pathWithin(projectPath, fs.realpathSync(root))) throw new Error(`Project schedule root '${root}' resolves outside the real project.`);
}

function scheduleDir(root: string, id: string, create = false, projectCwd?: string): string {
	assertScheduleRoot(root, projectCwd, create);
	const dir = path.join(root, validateScheduleId(id));
	try {
		const stat = fs.lstatSync(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Schedule path '${dir}' must be a real directory.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (!create) return dir;
		fs.mkdirSync(dir, { mode: 0o700 });
	}
	const rootPath = fs.realpathSync(root);
	const dirPath = fs.realpathSync(dir);
	if (dirPath !== path.join(rootPath, id)) throw new Error(`Schedule path '${dir}' escapes the project schedule root.`);
	return dir;
}

function readJson(file: string, label: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (error) {
		throw new Error(`Failed to read ${label} '${file}': ${error instanceof Error ? error.message : String(error)}`, { cause: error instanceof Error ? error : undefined });
	}
}

function parseScheduleTarget(value: unknown, file: string): ScheduleTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Schedule record '${file}' has invalid trigger or target.`);
	const target = value as { workflowScript?: unknown; agent?: unknown; task?: unknown };
	if (typeof target.workflowScript === "string" && target.workflowScript.trim()) return { workflowScript: target.workflowScript.trim() };
	if (target.agent !== undefined || target.task !== undefined) throw new Error(`Schedule record '${file}' uses a removed legacy agent target; recreate it with target.workflowScript.`);
	throw new Error(`Schedule record '${file}' requires a workflowScript target.`);
}

function parseSchedule(value: unknown, file: string): ScheduleRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Schedule record '${file}' must be a JSON object.`);
	const record = value as Partial<ScheduleRecord>;
	if (record.schemaVersion !== 1 || typeof record.id !== "string" || typeof record.name !== "string" || typeof record.cwd !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.paused !== "boolean") throw new Error(`Schedule record '${file}' has invalid required fields.`);
	validateScheduleId(record.id);
	if (!record.trigger || typeof record.trigger !== "object" || !record.target || typeof record.target !== "object") throw new Error(`Schedule record '${file}' has invalid trigger or target.`);
	if (record.overlap !== "skip" || (record.catchUp !== "none" && record.catchUp !== "latest")) throw new Error(`Schedule record '${file}' has unsupported policy fields.`);
	if (record.trigger.kind === "once") {
		if (typeof record.trigger.at !== "string" || (record.trigger.nextRunAt !== undefined && typeof record.trigger.nextRunAt !== "string")) throw new Error(`Schedule record '${file}' has an invalid one-shot trigger.`);
	} else if (record.trigger.kind === "interval") {
		if (typeof record.trigger.every !== "string" || typeof record.trigger.everyMs !== "number" || typeof record.trigger.anchorAt !== "string" || typeof record.trigger.nextRunAt !== "string") throw new Error(`Schedule record '${file}' has an invalid interval trigger.`);
	} else throw new Error(`Schedule record '${file}' has an unsupported trigger.`);
	return { ...record, target: parseScheduleTarget(record.target, file) } as ScheduleRecord;
}

class ScheduleStore {
	readonly root: string;
	private readonly projectCwd?: string;

	constructor(root: string, projectCwd?: string) {
		this.root = root;
		this.projectCwd = projectCwd;
	}

	directory(id: string, create = false): string {
		return scheduleDir(this.root, id, create, this.projectCwd);
	}

	ids(): string[] {
		assertScheduleRoot(this.root, this.projectCwd, false);
		if (!fs.existsSync(this.root)) return [];
		return fs.readdirSync(this.root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && SCHEDULE_ID.test(entry.name))
			.map((entry) => entry.name);
	}

	list(): ScheduleRecord[] {
		return this.ids().map((id) => this.find(id)).filter((record): record is ScheduleRecord => record !== undefined);
	}

	get(id: string): ScheduleRecord {
		const record = this.find(id);
		if (!record) throw new Error(`Schedule '${id}' not found.`);
		return record;
	}

	/** Like {@link get}, but returns undefined when the schedule no longer exists. */
	find(id: string): ScheduleRecord | undefined {
		const file = path.join(scheduleDir(this.root, id, false, this.projectCwd), "schedule.json");
		if (!fs.existsSync(file)) return undefined;
		return parseSchedule(readJson(file, "schedule record"), file);
	}

	write(record: ScheduleRecord): void {
		writePrivateAtomicJson(path.join(scheduleDir(this.root, record.id, true, this.projectCwd), "schedule.json"), record);
	}

	delete(id: string): void {
		fs.rmSync(scheduleDir(this.root, id, false, this.projectCwd), { recursive: true, force: true });
	}

	history(id: string): ScheduleRunRecord[] {
		const file = path.join(scheduleDir(this.root, id, false, this.projectCwd), "history.json");
		if (!fs.existsSync(file)) return [];
		const value = readJson(file, "schedule history") as { schemaVersion?: unknown; runs?: unknown };
		if (value?.schemaVersion !== 1 || !Array.isArray(value.runs)) throw new Error(`Schedule history '${file}' has invalid fields.`);
		return value.runs as ScheduleRunRecord[];
	}

	writeRun(schedule: ScheduleRecord, run: ScheduleRunRecord, event: string): void {
		const dir = scheduleDir(this.root, schedule.id, true, this.projectCwd);
		writePrivateAtomicJson(path.join(dir, "runs", `${run.id}.json`), run);
		const runs = [run, ...this.history(schedule.id).filter((item) => item.id !== run.id)].slice(0, MAX_HISTORY);
		writePrivateAtomicJson(path.join(dir, "history.json"), { schemaVersion: 1, runs });
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id, runId: run.id, state: run.state })}\n`, { encoding: "utf-8", mode: 0o600 });
	}

	appendEvent(schedule: ScheduleRecord, event: string): void {
		const dir = scheduleDir(this.root, schedule.id, true, this.projectCwd);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), event, scheduleId: schedule.id })}\n`, { encoding: "utf-8", mode: 0o600 });
	}
}

function resolveMaxPending(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxPending;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PENDING;
}

function nextAfter(trigger: ScheduleTrigger, plannedAt: number, now: number): string | undefined {
	if (trigger.kind === "once") return undefined;
	let next = plannedAt + trigger.everyMs;
	while (next <= now) next += trigger.everyMs;
	return timestamp(next);
}

function nextRunAt(schedule: ScheduleRecord): number | undefined {
	const value = schedule.trigger.nextRunAt;
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Schedule '${schedule.id}' has invalid nextRunAt.`);
	return parsed;
}

function duePlannedAt(schedule: ScheduleRecord, now: number): number | undefined {
	const next = nextRunAt(schedule);
	if (next === undefined || next > now || schedule.catchUp !== "latest" || schedule.trigger.kind !== "interval") return next;
	return next + Math.floor((now - next) / schedule.trigger.everyMs) * schedule.trigger.everyMs;
}

function textResult(text: string, schedules?: ScheduleRecord[], runs?: ScheduleRunRecord[], isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [], schedules: { ...(schedules ? { records: schedules } : {}), ...(runs ? { runs } : {}) } },
	};
}

function targetLabel(target: ScheduleTarget): string {
	const preview = previewSimpleWorkflowRun(target.workflowScript);
	return preview?.agent ? `workflowScript -> agent ${preview.agent}` : "workflowScript (dynamic)";
}

function sanitizeTarget(params: SubagentParamsLike): { target?: ScheduleTarget; error?: string } {
	if (params.tasks || params.chain) return { error: "Recurring schedules require workflowScript; legacy tasks and chain inputs are unsupported." };
	if (params.agent !== undefined || params.task !== undefined) return { error: "schedule.create requires workflowScript. Use workflowScript: \"return runs.run('main', { agent, task })\"." };
	if (typeof params.workflowScript !== "string" || !params.workflowScript.trim()) return { error: "schedule.create requires a non-empty workflowScript." };
	if (params.context === "fork") return { error: "Scheduled runs require fresh context." };
	if (params.async === false) return { error: "Scheduled runs are always async." };
	const acceptanceErrors = validateExecutionAcceptance(params as Parameters<typeof validateExecutionAcceptance>[0]);
	if (acceptanceErrors.length) return { error: acceptanceErrors.join(" ") };
	return { target: { workflowScript: params.workflowScript.trim() } };
}

function executionParams(schedule: ScheduleRecord): SubagentParamsLike {
	return {
		...schedule.target,
		async: true,
		context: "fresh",
		cwd: schedule.cwd,
		mission: false,
		...(schedule.timeoutMs === undefined ? {} : { timeoutMs: schedule.timeoutMs }),
	};
}

function snapshotContext(ctx: ExtensionContext, cwd: string): ExtensionContext {
	const source = ctx.sessionManager;
	const sessionId = source.getSessionId();
	const sessionFile = source.getSessionFile();
	const sessionManager = new Proxy(source, {
		get(target, property) {
			if (property === "getSessionId") return () => sessionId;
			if (property === "getSessionFile") return () => sessionFile;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { ...ctx, cwd, sessionManager };
}

export function listScheduledRunSummaries(cwd: string, root?: string): ScheduleRecord[] {
	return new ScheduleStore(scheduledRunStorePath(cwd, undefined, root), root === undefined ? path.resolve(cwd) : undefined).list();
}

export class ScheduledRunManager {
	private store?: ScheduleStore;
	private readonly stores = new Map<string, ScheduleStore>();
	private readonly contexts = new Map<string, ExtensionContext>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly observedAsyncIds = new Set<string>();
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly timersApi: ScheduledRunTimers;
	private readonly deps: ScheduledRunManagerDeps;

	constructor(deps: ScheduledRunManagerDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
		this.timersApi = deps.timers ?? globalThis;
	}

	bindSession(ctx: ExtensionContext): void {
		if (!scheduledRunsEnabled(this.deps.config)) return;
		this.selectProject(ctx.cwd, ctx);
	}

	stop(): void {
		this.stopTimers();
		this.store = undefined;
		this.stores.clear();
		this.contexts.clear();
		this.observedAsyncIds.clear();
	}

	async handleToolCall(params: SubagentParamsLike, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
		try {
			if (!scheduledRunsEnabled(this.deps.config)) return textResult("Scheduled runs are disabled by scheduledRuns.enabled=false.", undefined, undefined, true);
			this.selectProject(params.cwd ?? ctx.cwd, ctx);
			switch (params.action) {
				case "schedule.create": return this.create(params, ctx);
				case "schedule.list": return this.list();
				case "schedule.show": return this.show(params);
				case "schedule.history": return this.history(params);
				case "schedule.pause": return this.pause(params, true);
				case "schedule.resume": return this.pause(params, false);
				case "schedule.run": return await this.runManual(params);
				case "schedule.run-due": return await this.runDue();
				case "schedule.delete": return this.remove(params);
				default: return textResult(`Unknown schedule action: ${params.action}`, undefined, undefined, true);
			}
		} catch (error) {
			return textResult(error instanceof Error ? error.message : String(error), undefined, undefined, true);
		}
	}

	observedCompletionRunIds(): Set<string> {
		return new Set(this.observedAsyncIds);
	}

	referencedAsyncRunIds(): Set<string> {
		const runIds = new Set(this.observedAsyncIds);
		for (const store of this.stores.values()) {
			for (const scheduleId of store.ids()) {
				for (const run of store.history(scheduleId)) {
					if (run.asyncId) runIds.add(run.asyncId);
				}
			}
		}
		return runIds;
	}

	handleAsyncCompletion(payload: unknown): void {
		if (!payload || typeof payload !== "object") return;
		const data = payload as { id?: unknown; runId?: unknown; success?: unknown; state?: unknown; summary?: unknown };
		const asyncId = typeof data.runId === "string" ? data.runId : typeof data.id === "string" ? data.id : undefined;
		if (!asyncId) return;
		for (const store of this.stores.values()) {
			let ids: string[];
			try {
				ids = store.ids();
			} catch (error) {
				console.error(`Failed to inspect schedule store '${store.root}' during async completion:`, error);
				continue;
			}
			for (const id of ids) {
				try {
					const schedule = store.get(id);
					const run = store.history(id).find((item) => item.asyncId === asyncId && item.state === "running");
					if (!run) continue;
					this.finishRun(store, schedule, run, data.success === true, typeof data.summary === "string" ? data.summary : undefined);
					return;
				} catch (error) {
					console.error(`Failed to inspect schedule '${id}' in '${store.root}' during async completion:`, error);
				}
			}
		}
	}

	private create(params: SubagentParamsLike, ctx: ExtensionContext): AgentToolResult<Details> {
		const store = this.requireStore();
		const target = sanitizeTarget(params);
		if (target.error) return textResult(target.error, undefined, undefined, true);
		const at = params.at?.trim();
		const every = params.every?.trim();
		if (Boolean(at) === Boolean(every)) return textResult("schedule.create requires exactly one trigger: at or every.", undefined, undefined, true);
		if (params.overlap !== undefined && params.overlap !== "skip") return textResult("This first recurring slice supports overlap='skip' only.", undefined, undefined, true);
		if (params.catchUp !== undefined && params.catchUp !== "none" && params.catchUp !== "latest") return textResult("catchUp must be 'none' or 'latest'.", undefined, undefined, true);
		if (params.missionId !== undefined || params.mission !== undefined || params.missionUpdate !== undefined || params.missionStatus !== undefined || params.missionScope !== undefined) return textResult("Mission attachment is deferred from this first schedule slice.", undefined, undefined, true);
		if (params.on !== undefined || params.timezone !== undefined || every === "day" || every === "week" || every === "month" || every === "year") return textResult("Calendar schedules are deferred from this first safe slice. Use a fixed interval such as every:'24h' or every:'7d'.", undefined, undefined, true);
		const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
		if (this.deps.resolveCapabilityCeiling?.(sessionId)) return textResult("Cannot persist a schedule while a capability ceiling is active.", undefined, undefined, true);
		if (store.list().length >= resolveMaxPending(this.deps.config)) return textResult(`Schedule limit reached (${resolveMaxPending(this.deps.config)}).`, undefined, undefined, true);
		const id = validateScheduleId((params.id?.trim() || this.randomId()));
		if (store.ids().includes(id)) return textResult(`Schedule '${id}' already exists.`, undefined, undefined, true);
		const now = this.now();
		let trigger: ScheduleTrigger;
		if (at) {
			const planned = parseScheduledRunTime(at, now);
			trigger = { kind: "once", at, nextRunAt: timestamp(planned) };
		} else {
			const everyMs = parseScheduleInterval(every!);
			trigger = { kind: "interval", every: every!, everyMs, anchorAt: timestamp(now), nextRunAt: timestamp(now + everyMs) };
		}
		const schedule: ScheduleRecord = {
			schemaVersion: 1,
			id,
			name: params.name?.trim() || targetLabel(target.target!),
			cwd: path.resolve(params.cwd ?? ctx.cwd),
			trigger,
			target: target.target!,
			overlap: "skip",
			catchUp: params.catchUp ?? "latest",
			...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
			paused: false,
			createdAt: timestamp(now),
			updatedAt: timestamp(now),
		};
		store.write(schedule);
		store.appendEvent(schedule, "schedule.created");
		this.arm(schedule, store);
		return textResult(`Created schedule ${id}.\nName: ${schedule.name}\nTrigger: ${at ? `at ${at}` : `every ${every}`}\nNext: ${schedule.trigger.nextRunAt}\nTarget: ${targetLabel(schedule.target)}`, [schedule]);
	}

	private list(): AgentToolResult<Details> {
		const schedules = this.requireStore().list().sort((a, b) => (a.trigger.nextRunAt ?? "").localeCompare(b.trigger.nextRunAt ?? ""));
		if (!schedules.length) return textResult("No project schedules.", []);
		return textResult([`Project schedules: ${schedules.length}`, ...schedules.map((item) => `- ${item.id} | ${item.paused ? "paused" : item.activeRunId ? "running" : "scheduled"} | ${item.trigger.nextRunAt ?? "no next run"} | ${item.name}`)].join("\n"), schedules);
	}

	private show(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		return textResult([`Schedule: ${schedule.id}`, `Name: ${schedule.name}`, `State: ${schedule.paused ? "paused" : schedule.activeRunId ? "running" : "scheduled"}`, `Target: ${targetLabel(schedule.target)}`, `CWD: ${shortenPath(schedule.cwd)}`, `Next: ${schedule.trigger.nextRunAt ?? "none"}`, `Catch up: ${schedule.catchUp}`, schedule.activeRunId ? `Active run: ${schedule.activeRunId}` : undefined].filter(Boolean).join("\n"), [schedule]);
	}

	private history(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		const runs = this.requireStore().history(schedule.id);
		return textResult(runs.length ? [`Schedule history: ${schedule.id}`, ...runs.map((run) => `- ${run.id} | ${run.state} | ${run.plannedAt}${run.asyncId ? ` | async ${run.asyncId}` : ""}`)].join("\n") : `No runs recorded for schedule ${schedule.id}.`, [schedule], runs);
	}

	private pause(params: SubagentParamsLike, paused: boolean): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		if (schedule.paused === paused) return textResult(`Schedule ${schedule.id} is already ${paused ? "paused" : "active"}.`, [schedule]);
		schedule.paused = paused;
		schedule.updatedAt = timestamp(this.now());
		this.requireStore().write(schedule);
		this.requireStore().appendEvent(schedule, paused ? "schedule.paused" : "schedule.resumed");
		const store = this.requireStore();
		if (paused) this.clearTimer(store, schedule.id); else this.restoreOne(store, schedule);
		return textResult(`${paused ? "Paused" : "Resumed"} schedule ${schedule.id}.`, [schedule]);
	}

	private async runManual(params: SubagentParamsLike): Promise<AgentToolResult<Details>> {
		const store = this.requireStore();
		const schedule = this.resolve(params);
		const run = await this.launch(store, schedule, this.now(), "manual", false);
		return textResult(`Manual schedule run ${run.id}: ${run.state}${run.asyncId ? ` (async ${run.asyncId})` : ""}.`, [store.get(schedule.id)], [run], run.state === "failed_launch");
	}

	private async runDue(): Promise<AgentToolResult<Details>> {
		const store = this.requireStore();
		const due = store.list().filter((schedule) => !schedule.paused && nextRunAt(schedule) !== undefined && nextRunAt(schedule)! <= this.now());
		const runs: ScheduleRunRecord[] = [];
		for (const schedule of due) {
			const planned = duePlannedAt(schedule, this.now())!;
			if (!schedule.activeRunId && schedule.catchUp === "none" && planned < this.now()) runs.push(this.recordMissed(store, schedule, planned, "run-due"));
			else runs.push(await this.launch(store, schedule, planned, "run-due", true));
		}
		return textResult(runs.length ? `Processed ${runs.length} due schedule(s).` : "No schedules are due.", store.list(), runs);
	}

	private remove(params: SubagentParamsLike): AgentToolResult<Details> {
		const schedule = this.resolve(params);
		if (schedule.activeRunId) return textResult(`Schedule ${schedule.id} has active run ${schedule.activeRunId}; stop that run before deleting the schedule.`, [schedule], undefined, true);
		const store = this.requireStore();
		this.clearTimer(store, schedule.id);
		store.appendEvent(schedule, "schedule.deleted");
		store.delete(schedule.id);
		return textResult(`Deleted schedule ${schedule.id}.`);
	}

	private restore(store: ScheduleStore): void {
		for (const schedule of store.list()) this.restoreOne(store, schedule);
	}

	private restoreOne(store: ScheduleStore, schedule: ScheduleRecord, notBefore?: number, rearm = true): void {
		if (schedule.activeRunId) {
			const run = store.history(schedule.id).find((item) => item.id === schedule.activeRunId);
			if (run?.state === "running" && run.asyncId) this.observedAsyncIds.add(run.asyncId);
			const startedAt = run?.startedAt ? Date.parse(run.startedAt) : Number.NaN;
			if (run?.state === "running" && run.asyncDir) {
				try {
					const status = readJson(path.join(run.asyncDir, "status.json"), "async status") as Partial<AsyncStatus>;
					if (["complete", "failed", "stopped", "rejected"].includes(String(status.state))) this.finishRun(store, schedule, run, status.state === "complete", typeof status.error === "string" ? status.error : undefined);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof Error && /ENOENT/.test(error.message))) throw error;
				}
			}
			if (schedule.activeRunId && (!run || run.state !== "running" || (!run.asyncId && Number.isFinite(startedAt) && startedAt + STALE_LAUNCH_CLAIM_MS <= this.now()))) {
				if (run?.state === "running") {
					run.state = "failed_launch";
					run.completedAt = timestamp(this.now());
					run.error = "Recovered a stale launch claim before an async run was attached.";
					store.writeRun(schedule, run, "schedule.run.failed");
				}
				schedule.activeRunId = undefined;
				schedule.updatedAt = timestamp(this.now());
				store.write(schedule);
				fs.rmSync(path.join(store.directory(schedule.id), "active.lock"), { force: true });
			}
		}
		if (!rearm || schedule.paused) return;
		const next = nextRunAt(schedule);
		if (next === undefined) return;
		if (!schedule.activeRunId && next < this.now() && schedule.catchUp === "none") {
			try {
				this.recordMissed(store, schedule, next, "timer");
			} catch (error) {
				if (notBefore !== undefined) this.arm(schedule, store, notBefore);
				throw error;
			}
		}
		this.arm(schedule, store, notBefore);
	}

	private arm(schedule: ScheduleRecord, store: ScheduleStore, notBefore?: number): void {
		this.clearTimer(store, schedule.id);
		if (schedule.paused) return;
		const next = nextRunAt(schedule);
		if (next === undefined) return;
		const timer = this.timersApi.setTimeout(() => {
			// A timer callback is outside every caller's try/catch, so an escaping
			// rejection here reaches the process as an uncaught exception and exits
			// Pi. Contain every failure to this one schedule.
			void this.fire(store, schedule.id).catch((error) => {
				console.warn(`[pi-subagents] Scheduled run '${schedule.id}' failed to fire: ${error instanceof Error ? error.message : String(error)}`);
				this.restoreAfterFireError(store, schedule.id);
			});
		}, Math.min(Math.max(0, next - this.now(), (notBefore ?? 0) - this.now()), MAX_TIMER_DELAY_MS));
		timer.unref?.();
		this.timers.set(this.timerKey(store, schedule.id), timer);
	}

	private restoreAfterFireError(store: ScheduleStore, id: string): void {
		try {
			const schedule = store.find(id);
			if (!schedule) return;
			const now = this.now();
			const planned = schedule.trigger.kind === "interval" ? duePlannedAt(schedule, now) : undefined;
			const notBefore = planned !== undefined && planned <= now ? Date.parse(nextAfter(schedule.trigger, planned, now)!) : undefined;
			this.restoreOne(store, schedule, notBefore, schedule.trigger.kind === "interval");
		} catch (error) {
			console.warn(`[pi-subagents] Scheduled run '${id}' could not be restored after fire failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async fire(store: ScheduleStore, id: string): Promise<void> {
		this.clearTimer(store, id);
		// Schedules are project-scoped and shared, and `delete` only clears the
		// timer inside the deleting process. Another session can therefore remove
		// a schedule while this process still holds an armed timer for it; there
		// is then nothing to run and nothing to re-arm.
		const schedule = store.find(id);
		if (!schedule) return;
		const planned = duePlannedAt(schedule, this.now());
		if (planned === undefined || schedule.paused) return;
		if (planned > this.now()) return this.arm(schedule, store);
		await this.launch(store, schedule, planned, "timer", true);
	}

	private async launch(store: ScheduleStore, schedule: ScheduleRecord, planned: number, dueReason: ScheduleRunRecord["dueReason"], advance: boolean): Promise<ScheduleRunRecord> {
		const now = this.now();
		const run: ScheduleRunRecord = { schemaVersion: 1, id: this.randomId(), scheduleId: schedule.id, plannedAt: timestamp(planned), dueReason, state: "running", startedAt: timestamp(now) };
		if (schedule.activeRunId) {
			run.state = "skipped";
			run.completedAt = timestamp(now);
			if (advance) {
				schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
				schedule.updatedAt = timestamp(now);
				store.write(schedule);
			}
			store.writeRun(schedule, run, "schedule.skipped_overlap");
			this.arm(schedule, store);
			return run;
		}
		const lockPath = path.join(store.directory(schedule.id, true), "active.lock");
		fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
		let lock: number;
		try {
			lock = fs.openSync(lockPath, "wx", 0o600);
			fs.writeFileSync(lock, run.id, "utf-8");
			fs.closeSync(lock);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			run.state = "skipped";
			run.completedAt = timestamp(now);
			if (advance) {
				schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
				schedule.updatedAt = timestamp(now);
				store.write(schedule);
			}
			store.writeRun(schedule, run, "schedule.skipped_overlap");
			this.arm(schedule, store);
			return run;
		}
		schedule.activeRunId = run.id;
		schedule.lastRunId = run.id;
		if (advance) schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
		schedule.updatedAt = timestamp(now);
		store.write(schedule);
		store.writeRun(schedule, run, "schedule.run.started");
		try {
			const result = await this.deps.launch(executionParams(schedule), this.requireContext(store), new AbortController().signal);
			const asyncId = result.details?.asyncId ?? result.details?.runId;
			if (result.isError || !asyncId) throw new Error(result.content.find((item) => item.type === "text")?.text ?? "Scheduled launch failed.");
			run.asyncId = asyncId;
			run.asyncDir = result.details?.asyncDir;
			this.observedAsyncIds.add(asyncId);
			store.writeRun(schedule, run, "schedule.run.attached_async");
			this.arm(schedule, store);
			return run;
		} catch (error) {
			run.state = "failed_launch";
			run.completedAt = timestamp(this.now());
			run.error = error instanceof Error ? error.message : String(error);
			schedule.activeRunId = undefined;
			schedule.updatedAt = timestamp(this.now());
			store.write(schedule);
			store.writeRun(schedule, run, "schedule.run.failed");
			fs.rmSync(lockPath, { force: true });
			this.arm(schedule, store);
			return run;
		}
	}

	private finishRun(store: ScheduleStore, schedule: ScheduleRecord, run: ScheduleRunRecord, success: boolean, error?: string): void {
		const now = this.now();
		const next = nextRunAt(schedule);
		if (next !== undefined && next <= now) {
			const planned = duePlannedAt(schedule, now)!;
			const skipped: ScheduleRunRecord = {
				schemaVersion: 1,
				id: this.randomId(),
				scheduleId: schedule.id,
				plannedAt: timestamp(planned),
				dueReason: "timer",
				state: "skipped",
				completedAt: timestamp(now),
			};
			schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, now);
			store.writeRun(schedule, skipped, "schedule.skipped_overlap");
		}
		if (run.asyncId) this.observedAsyncIds.delete(run.asyncId);
		run.state = success ? "completed" : "failed_run";
		run.completedAt = timestamp(now);
		if (!success && error) run.error = error;
		schedule.activeRunId = undefined;
		schedule.updatedAt = timestamp(now);
		store.write(schedule);
		fs.rmSync(path.join(store.directory(schedule.id), "active.lock"), { force: true });
		store.writeRun(schedule, run, success ? "schedule.run.completed" : "schedule.run.failed");
		this.arm(schedule, store);
	}

	private recordMissed(store: ScheduleStore, schedule: ScheduleRecord, planned: number, dueReason: ScheduleRunRecord["dueReason"]): ScheduleRunRecord {
		const run: ScheduleRunRecord = {
			schemaVersion: 1,
			id: this.randomId(),
			scheduleId: schedule.id,
			plannedAt: timestamp(planned),
			dueReason,
			state: "missed",
			completedAt: timestamp(this.now()),
		};
		schedule.trigger.nextRunAt = nextAfter(schedule.trigger, planned, this.now());
		schedule.updatedAt = timestamp(this.now());
		store.write(schedule);
		store.writeRun(schedule, run, "schedule.missed");
		return run;
	}

	private selectProject(cwd: string, ctx: ExtensionContext): void {
		const projectCwd = path.resolve(cwd);
		const root = scheduledRunStorePath(projectCwd, undefined, this.deps.storeRoot);
		if (path.resolve(ctx.cwd) === projectCwd) this.contexts.set(root, snapshotContext(ctx, projectCwd));
		else if (!this.contexts.has(root)) throw new Error(`Cannot use project '${projectCwd}' until that project has been opened in this runtime.`);
		let store = this.stores.get(root);
		if (!store) {
			store = new ScheduleStore(root, this.deps.storeRoot === undefined ? projectCwd : undefined);
			this.stores.set(root, store);
			this.restore(store);
		}
		this.store = store;
	}

	private resolve(params: SubagentParamsLike): ScheduleRecord {
		const id = params.id?.trim();
		if (!id) throw new Error(`${params.action} requires id.`);
		return this.requireStore().get(id);
	}

	private requireStore(): ScheduleStore {
		if (!this.store) throw new Error("Schedule store is unavailable.");
		return this.store;
	}

	private requireContext(store: ScheduleStore): ExtensionContext {
		const ctx = this.contexts.get(store.root);
		if (!ctx) throw new Error("Schedule runtime context is unavailable.");
		return ctx;
	}

	private timerKey(store: ScheduleStore, id: string): string {
		return `${store.root}\0${id}`;
	}

	private clearTimer(store: ScheduleStore, id: string): void {
		const key = this.timerKey(store, id);
		const timer = this.timers.get(key);
		if (!timer) return;
		this.timersApi.clearTimeout(timer);
		this.timers.delete(key);
	}

	private stopTimers(): void {
		for (const timer of this.timers.values()) this.timersApi.clearTimeout(timer);
		this.timers.clear();
	}
}

export function createScheduledRunManager(deps: ScheduledRunManagerDeps): ScheduledRunManager {
	return new ScheduledRunManager(deps);
}
