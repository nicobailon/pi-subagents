import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { formatDuration, shortenPath } from "../../shared/formatters.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
	TEMP_ROOT_DIR,
	type Details,
	type ExtensionConfig,
} from "../../shared/types.ts";
import type { SubagentParamsLike } from "../foreground/subagent-executor.ts";
import { validateExecutionAcceptance } from "../shared/acceptance.ts";

export const SCHEDULED_RUNS_DIR = path.join(TEMP_ROOT_DIR, "scheduled-subagent-runs");
export const SCHEDULED_RUN_ACTIONS = ["schedule", "schedule-list", "schedule-status", "schedule-cancel"] as const;

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_MAX_LATENESS_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING = 20;

export type ScheduledRunAction = typeof SCHEDULED_RUN_ACTIONS[number];
export type ScheduledRunState = "scheduled" | "running" | "fired" | "canceled" | "missed" | "failed";

type ScheduledRunJob = {
	id: string;
	name: string;
	schedule: string;
	runAt: number;
	state: ScheduledRunState;
	createdAt: number;
	updatedAt: number;
	cwd: string;
	sessionId: string;
	params: SubagentParamsLike;
	lastRunId?: string;
	lastAsyncDir?: string;
	lastError?: string;
	firedAt?: number;
	canceledAt?: number;
};

type ScheduledRunStoreData = {
	version: 1;
	cwd: string;
	sessionId: string;
	jobs: ScheduledRunJob[];
};

type ScheduledRunTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

type ScheduledRunManagerDeps = {
	config: ExtensionConfig;
	launch(params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentToolResult<Details>>;
	storeRoot?: string;
	now?: () => number;
	randomId?: () => string;
	timers?: ScheduledRunTimers;
};

export function isScheduledRunAction(action: unknown): action is ScheduledRunAction {
	return typeof action === "string" && (SCHEDULED_RUN_ACTIONS as readonly string[]).includes(action);
}

export function scheduledRunsEnabled(config: ExtensionConfig): boolean {
	return config.scheduledRuns?.enabled === true;
}

export function scheduledRunStorePath(cwd: string, sessionId: string, root = SCHEDULED_RUNS_DIR): string {
	const digest = createHash("sha256").update(`${path.resolve(cwd)}\0${sessionId}`).digest("hex").slice(0, 20);
	return path.join(root, `${digest}.json`);
}

export function parseScheduledRunTime(schedule: string, now = Date.now()): number {
	const trimmed = schedule.trim();
	const relative = trimmed.match(/^\+(\d+)(s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Invalid schedule "${schedule}". Relative schedules must be positive, such as "+10m".`);
		const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
		const runAt = now + amount * unitMs;
		if (!Number.isSafeInteger(runAt) || Number.isNaN(new Date(runAt).getTime())) throw new Error(`Invalid schedule "${schedule}". Relative delay is too large.`);
		return runAt;
	}
	if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
		const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/);
		if (!iso) throw new Error(`Invalid schedule "${schedule}". Absolute ISO timestamps must include a timezone, such as "2030-01-01T09:00:00Z".`);
		const year = Number(iso[1]);
		const month = Number(iso[2]);
		const day = Number(iso[3]);
		const hour = Number(iso[4]);
		const minute = Number(iso[5]);
		const second = iso[6] === undefined ? 0 : Number(iso[6]);
		const offset = iso[7]!;
		const offsetHour = offset === "Z" ? 0 : Number(offset.slice(1, 3));
		const offsetMinute = offset === "Z" ? 0 : Number(offset.slice(4, 6));
		const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
		if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
			throw new Error(`Invalid schedule "${schedule}". Use a valid future ISO timestamp.`);
		}
		const parsed = new Date(trimmed).getTime();
		if (!Number.isNaN(parsed)) {
			if (parsed <= now) throw new Error(`Scheduled time ${new Date(parsed).toISOString()} is in the past.`);
			return parsed;
		}
	}
	throw new Error(`Invalid schedule "${schedule}". Use a one-shot relative delay like "+10m" or a future ISO timestamp with timezone.`);
}

function readStoreData(filePath: string, cwd: string, sessionId: string): ScheduledRunStoreData {
	if (!fs.existsSync(filePath)) return { version: 1, cwd, sessionId, jobs: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse scheduled subagent store '${filePath}': ${message}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Scheduled subagent store '${filePath}' must be a JSON object.`);
	}
	const data = parsed as Partial<ScheduledRunStoreData>;
	if (data.version !== 1) throw new Error(`Unsupported scheduled subagent store version in '${filePath}'.`);
	if (!Array.isArray(data.jobs)) throw new Error(`Scheduled subagent store '${filePath}' must contain a jobs array.`);
	const jobs: ScheduledRunJob[] = [];
	const validStates = new Set<ScheduledRunState>(["scheduled", "running", "fired", "canceled", "missed", "failed"]);
	for (const [index, job] of data.jobs.entries()) {
		if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} must be an object.`);
		const candidate = job as Partial<ScheduledRunJob>;
		if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.schedule !== "string" || typeof candidate.cwd !== "string" || typeof candidate.sessionId !== "string") {
			throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid string fields.`);
		}
		const timestamps = [candidate.runAt, candidate.createdAt, candidate.updatedAt];
		if (timestamps.some((value) => typeof value !== "number" || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime()))) {
			throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid timestamps.`);
		}
		if (!candidate.state || !validStates.has(candidate.state)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid state.`);
		if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) throw new Error(`Scheduled subagent store '${filePath}' job ${index} has invalid params.`);
		jobs.push(candidate as ScheduledRunJob);
	}
	return {
		version: 1,
		cwd: typeof data.cwd === "string" ? data.cwd : cwd,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : sessionId,
		jobs,
	};
}

class ScheduledRunStore {
	private readonly filePath: string;
	private readonly cwd: string;
	private readonly sessionId: string;

	constructor(filePath: string, cwd: string, sessionId: string) {
		this.filePath = filePath;
		this.cwd = cwd;
		this.sessionId = sessionId;
	}

	list(): ScheduledRunJob[] {
		return readStoreData(this.filePath, this.cwd, this.sessionId).jobs;
	}

	get(id: string): ScheduledRunJob | undefined {
		return this.list().find((job) => job.id === id);
	}

	mutate<T>(fn: (data: ScheduledRunStoreData) => T): T {
		const data = readStoreData(this.filePath, this.cwd, this.sessionId);
		const result = fn(data);
		writeAtomicJson(this.filePath, data);
		return result;
	}
}

function resolveMaxLatenessMs(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxLatenessMs;
	return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_LATENESS_MS;
}

function resolveMaxPending(config: ExtensionConfig): number {
	const value = config.scheduledRuns?.maxPending;
	return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PENDING;
}

function terminalState(state: ScheduledRunState): boolean {
	return state === "fired" || state === "canceled" || state === "missed" || state === "failed";
}

function jobMode(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	return "single";
}

function describeScheduledTarget(params: SubagentParamsLike): string {
	if ((params.chain?.length ?? 0) > 0) return `chain (${params.chain!.length})`;
	if ((params.tasks?.length ?? 0) > 0) return `parallel (${params.tasks!.length})`;
	return params.agent ? `agent ${params.agent}` : "subagent run";
}

function textResult(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function resolveJobById(jobs: ScheduledRunJob[], requestedId: string): ScheduledRunJob {
	const exact = jobs.find((job) => job.id === requestedId);
	if (exact) return exact;
	const matches = jobs.filter((job) => job.id.startsWith(requestedId));
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`Ambiguous scheduled run id prefix '${requestedId}' matched: ${matches.map((job) => job.id).join(", ")}. Provide a longer id.`);
	throw new Error(`Scheduled run '${requestedId}' not found.`);
}

function sanitizeScheduledParams(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: string } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return { error: "action='schedule' requires exactly one execution mode: agent, tasks, or chain." };
	}
	if (!params.schedule?.trim()) return { error: "action='schedule' requires schedule, such as '+10m' or a future ISO timestamp." };
	if (params.context === "fork") return { error: "Scheduled subagent runs require fresh context. Forked parent-session context is not safe at fire time." };
	if (params.async === false) return { error: "Scheduled subagent runs are always async; omit async or set async: true." };
	if (params.clarify === true) return { error: "Scheduled subagent runs cannot open clarify UI; omit clarify or set clarify: false." };
	const acceptanceErrors = validateExecutionAcceptance(params);
	if (acceptanceErrors.length > 0) return { error: acceptanceErrors.join(" ") };

	const {
		action: _action,
		id: _id,
		runId: _runId,
		dir: _dir,
		index: _index,
		message: _message,
		chainName: _chainName,
		config: _config,
		schedule: _schedule,
		scheduleName: _scheduleName,
		...executionParams
	} = params;
	return { params: { ...executionParams, async: true, clarify: false, context: "fresh" } };
}

export class ScheduledRunManager {
	private store: ScheduledRunStore | undefined;
	private ctx: ExtensionContext | undefined;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly storeRoot: string;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly timersApi: ScheduledRunTimers;
	private readonly deps: ScheduledRunManagerDeps;

	constructor(deps: ScheduledRunManagerDeps) {
		this.deps = deps;
		this.storeRoot = deps.storeRoot ?? SCHEDULED_RUNS_DIR;
		this.now = deps.now ?? Date.now;
		this.randomId = deps.randomId ?? (() => randomUUID().slice(0, 8));
		this.timersApi = deps.timers ?? globalThis;
	}

	bindSession(ctx: ExtensionContext): void {
		this.stopTimers();
		this.ctx = ctx;
		if (!scheduledRunsEnabled(this.deps.config)) {
			this.store = undefined;
			return;
		}
		const sessionId = resolveCurrentSessionId(ctx.sessionManager);
		this.store = new ScheduledRunStore(scheduledRunStorePath(ctx.cwd, sessionId, this.storeRoot), ctx.cwd, sessionId);
		this.rearmScheduledJobs();
	}

	stop(): void {
		this.stopTimers();
		this.store = undefined;
		this.ctx = undefined;
	}

	async handleToolCall(params: SubagentParamsLike, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
		this.ctx = ctx;
		try {
			if (!scheduledRunsEnabled(this.deps.config)) {
				return textResult("Scheduled subagent runs are disabled. Set { \"scheduledRuns\": { \"enabled\": true } } in ~/.pi/agent/extensions/subagent/config.json, then reload Pi. Schedule only explicit delayed runs the user asked for.", true);
			}
			if (!this.store) this.bindSession(ctx);
			if (!this.store) return textResult("Scheduled subagent store is unavailable for this session.", true);
			switch (params.action) {
				case "schedule": return this.createJob(params, ctx);
				case "schedule-list": return this.listJobs();
				case "schedule-status": return this.statusJob(params);
				case "schedule-cancel": return this.cancelJob(params);
				default: return textResult(`Unknown scheduled-run action: ${params.action}`, true);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(message, true);
		}
	}

	private createJob(params: SubagentParamsLike, ctx: ExtensionContext): AgentToolResult<Details> {
		const store = this.requireStore();
		const sanitized = sanitizeScheduledParams(params);
		if (sanitized.error) return textResult(sanitized.error, true);
		const scheduleInput = params.schedule!.trim();
		const runAt = parseScheduledRunTime(scheduleInput, this.now());
		const pendingCount = store.list().filter((job) => job.state === "scheduled" || job.state === "running").length;
		const maxPending = resolveMaxPending(this.deps.config);
		if (pendingCount >= maxPending) return textResult(`Scheduled subagent limit reached (${pendingCount}/${maxPending} pending or running). Cancel an existing scheduled run before adding another.`, true);
		const id = this.randomId();
		const sessionId = resolveCurrentSessionId(ctx.sessionManager);
		const scheduleName = params.scheduleName?.trim();
		const executionParams = sanitized.params!;
		const now = this.now();
		const job: ScheduledRunJob = {
			id,
			name: scheduleName || describeScheduledTarget(executionParams),
			schedule: scheduleInput,
			runAt,
			state: "scheduled",
			createdAt: now,
			updatedAt: now,
			cwd: ctx.cwd,
			sessionId,
			params: executionParams,
		};
		store.mutate((data) => {
			data.jobs.push(job);
		});
		this.arm(job);
		return textResult([
			`Scheduled subagent run ${job.id}.`,
			`Name: ${job.name}`,
			`When: ${new Date(job.runAt).toISOString()}`,
			`Mode: ${jobMode(executionParams)}`,
			`Context: fresh (scheduled runs never fork parent-session context)`,
			`Status: subagent({ action: "schedule-status", id: "${job.id}" })`,
			`Cancel before it fires: subagent({ action: "schedule-cancel", id: "${job.id}" })`,
		].join("\n"));
	}

	private listJobs(): AgentToolResult<Details> {
		const jobs = this.requireStore().list().sort((left, right) => left.runAt - right.runAt);
		if (jobs.length === 0) return textResult("No scheduled subagent runs for this session.");
		const lines = [`Scheduled subagent runs: ${jobs.length}`, ""];
		for (const job of jobs) {
			const parts = [job.id, job.state, new Date(job.runAt).toISOString(), job.name];
			if (job.lastRunId) parts.push(`run ${job.lastRunId}`);
			if (job.lastError) parts.push(`error: ${job.lastError}`);
			lines.push(`- ${parts.join(" | ")}`);
		}
		return textResult(lines.join("\n"));
	}

	private statusJob(params: SubagentParamsLike): AgentToolResult<Details> {
		const requestedId = params.id ?? params.runId;
		if (!requestedId) return textResult("action='schedule-status' requires id.", true);
		const job = resolveJobById(this.requireStore().list(), requestedId);
		const lines = [
			`Scheduled run: ${job.id}`,
			`Name: ${job.name}`,
			`State: ${job.state}`,
			`Schedule: ${job.schedule}`,
			`Run at: ${new Date(job.runAt).toISOString()}`,
			`Mode: ${jobMode(job.params)}`,
			`CWD: ${shortenPath(job.cwd)}`,
			`Created: ${new Date(job.createdAt).toISOString()}`,
			`Updated: ${new Date(job.updatedAt).toISOString()}`,
			job.lastRunId ? `Launched async run: ${job.lastRunId}` : undefined,
			job.lastAsyncDir ? `Async dir: ${job.lastAsyncDir}` : undefined,
			job.lastError ? `Error: ${job.lastError}` : undefined,
			job.state === "scheduled" ? `Cancel: subagent({ action: "schedule-cancel", id: "${job.id}" })` : undefined,
			job.lastRunId ? `Async status: subagent({ action: "status", id: "${job.lastRunId}" })` : undefined,
		].filter((line): line is string => Boolean(line));
		return textResult(lines.join("\n"));
	}

	private cancelJob(params: SubagentParamsLike): AgentToolResult<Details> {
		const requestedId = params.id ?? params.runId;
		if (!requestedId) return textResult("action='schedule-cancel' requires id.", true);
		const store = this.requireStore();
		const job = resolveJobById(store.list(), requestedId);
		if (job.state === "running") return textResult(`Scheduled run ${job.id} already launched async run ${job.lastRunId ?? "unknown"}; interrupt that async run instead.`, true);
		if (terminalState(job.state)) return textResult(`Scheduled run ${job.id} is already ${job.state}.`, true);
		const now = this.now();
		this.clearTimer(job.id);
		store.mutate((data) => {
			const stored = data.jobs.find((candidate) => candidate.id === job.id);
			if (!stored) return;
			stored.state = "canceled";
			stored.canceledAt = now;
			stored.updatedAt = now;
		});
		return textResult(`Canceled scheduled subagent run ${job.id}.`);
	}

	private rearmScheduledJobs(): void {
		const store = this.requireStore();
		const now = this.now();
		const maxLatenessMs = resolveMaxLatenessMs(this.deps.config);
		const dueToMiss = store.list().filter((job) => job.state === "scheduled" && job.runAt + maxLatenessMs < now);
		if (dueToMiss.length > 0) {
			store.mutate((data) => {
				for (const missed of dueToMiss) {
					const job = data.jobs.find((candidate) => candidate.id === missed.id);
					if (!job || job.state !== "scheduled") continue;
					job.state = "missed";
					job.updatedAt = now;
					job.lastError = `Missed scheduled time by more than ${formatDuration(maxLatenessMs)} while Pi was not available.`;
				}
			});
		}
		for (const job of store.list()) {
			if (job.state === "scheduled") this.arm(job);
		}
	}

	private arm(job: ScheduledRunJob): void {
		this.clearTimer(job.id);
		const delayMs = Math.max(0, job.runAt - this.now());
		const timer = this.timersApi.setTimeout(() => {
			void this.fire(job.id);
		}, Math.min(delayMs, MAX_TIMER_DELAY_MS));
		timer.unref?.();
		this.timers.set(job.id, timer);
	}

	private async fire(jobId: string): Promise<void> {
		this.clearTimer(jobId);
		const store = this.store;
		const ctx = this.ctx;
		if (!store || !ctx) return;
		let job = store.get(jobId);
		if (!job || job.state !== "scheduled") return;
		const now = this.now();
		// A timer capped at MAX_TIMER_DELAY_MS may fire before runAt for far-future schedules; re-arm and wait.
		if (now < job.runAt) {
			this.arm(job);
			return;
		}
		const maxLatenessMs = resolveMaxLatenessMs(this.deps.config);
		if (job.runAt + maxLatenessMs < now) {
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored || stored.state !== "scheduled") return;
				stored.state = "missed";
				stored.updatedAt = now;
				stored.lastError = `Missed scheduled time by more than ${formatDuration(maxLatenessMs)}.`;
			});
			return;
		}
		store.mutate((data) => {
			const stored = data.jobs.find((candidate) => candidate.id === jobId);
			if (!stored || stored.state !== "scheduled") return;
			stored.state = "running";
			stored.firedAt = now;
			stored.updatedAt = now;
		});
		job = store.get(jobId);
		if (!job || job.state !== "running") return;
		const controller = new AbortController();
		try {
			const result = await this.deps.launch(job.params, ctx, controller.signal);
			const launchRunId = result.details?.asyncId ?? result.details?.runId;
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored) return;
				stored.updatedAt = this.now();
				if (result.isError || !launchRunId) {
					stored.state = "failed";
					stored.lastError = result.content.find((item) => item.type === "text")?.text ?? "Scheduled subagent launch failed.";
					return;
				}
				stored.state = "fired";
				stored.lastRunId = launchRunId;
				stored.lastAsyncDir = result.details?.asyncDir;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.mutate((data) => {
				const stored = data.jobs.find((candidate) => candidate.id === jobId);
				if (!stored) return;
				stored.state = "failed";
				stored.lastError = message;
				stored.updatedAt = this.now();
			});
		}
	}

	private requireStore(): ScheduledRunStore {
		if (!this.store) throw new Error("Scheduled subagent store is not bound to a session.");
		return this.store;
	}

	private clearTimer(jobId: string): void {
		const timer = this.timers.get(jobId);
		if (!timer) return;
		this.timersApi.clearTimeout(timer);
		this.timers.delete(jobId);
	}

	private stopTimers(): void {
		for (const timer of this.timers.values()) this.timersApi.clearTimeout(timer);
		this.timers.clear();
	}
}

export function createScheduledRunManager(deps: ScheduledRunManagerDeps): ScheduledRunManager {
	return new ScheduledRunManager(deps);
}
