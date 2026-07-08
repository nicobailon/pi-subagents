import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { RESULTS_DIR, type AsyncParallelGroupStatus, type AsyncStatus, type NestedRunSummary, type SubagentRunMode } from "../../shared/types.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent, type NestedRoute } from "../shared/nested-events.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string;
	kill?: KillFn;
	now?: () => number;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
	const stderrPath = path.join(asyncDir, "runner.stderr.log");
	const maxBytes = 64 * 1024;
	let content: string;
	try {
		const stat = fs.statSync(stderrPath);
		if (stat.size <= 0) return undefined;
		const fd = fs.openSync(stderrPath, "r");
		try {
			const bytesToRead = Math.min(stat.size, maxBytes);
			const start = Math.max(0, stat.size - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			fs.readSync(fd, buffer, 0, bytesToRead, start);
			content = buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(-30).join("\n");
	return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function appendJsonlBestEffort(filePath: string, payload: object): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
	} catch {
		// Repair status/result writes are the important path. A broken or full
		// diagnostic event log must not make stale-run reconciliation fail.
	}
}

function readStatusFile(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");
	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

interface ResultChildOutcome {
	agent?: string;
	success?: boolean;
	error?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	modelAttempts?: NonNullable<AsyncStatus["steps"]>[number]["modelAttempts"];
}

interface ResultRepairData {
	state: "complete" | "failed" | "paused" | "stopped";
	results?: ResultChildOutcome[];
}

function readResultRepairData(resultPath: string): ResultRepairData | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { success?: boolean; state?: string; exitCode?: number; results?: unknown };
		const state = data.success ? "complete" : data.state === "stopped" ? "stopped" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
		const results = Array.isArray(data.results)
			? data.results.map((entry, index) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
				const child = entry as ResultChildOutcome;
				if (child.model !== undefined && typeof child.model !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].model must be a string.`);
				if (child.thinking !== undefined && typeof child.thinking !== "string") throw new Error(`Invalid async result file '${resultPath}': results[${index}].thinking must be a string.`);
				return child;
			})
			: undefined;
		return { state, ...(results ? { results } : {}) };
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(overallState: ResultRepairData["state"], child: ResultChildOutcome | undefined): "complete" | "failed" | "paused" | "stopped" {
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

function terminalStatusFromResult(status: AsyncStatus, resultPath: string, now: number): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath);
	if (!repair) return undefined;
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		const model = child?.model ?? step.model;
		const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
		return {
			...step,
			status: state === "complete" ? "complete" as const : state,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
			error: state === "failed" || state === "stopped" ? step.error ?? child?.error : step.error,
			stopped: state === "stopped" ? true : step.stopped,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model,
			thinking,
			attemptedModels: child?.attemptedModels ?? step.attemptedModels,
			modelAttempts: child?.modelAttempts ?? step.modelAttempts,
		};
	});
	return {
		...status,
		state: repair.state,
		...(repair.state === "stopped" ? { stopped: true } : {}),
		activityState: undefined,
		lastUpdate: now,
		endedAt: status.endedAt ?? now,
		steps,
	};
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const chainStepCount = startedRun.chainStepCount;
	const parallelGroups = chainStepCount !== undefined
		? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
		: [];
	return {
		runId: startedRun.runId || path.basename(asyncDir),
		...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
		mode: startedRun.mode ?? "single",
		state: "running",
		pid: startedRun.pid,
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		...(chainStepCount !== undefined ? { chainStepCount } : {}),
		...(parallelGroups.length ? { parallelGroups } : {}),
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
		...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
	};
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string): { status: AsyncStatus; result: object; message: string } {
	const runId = status.runId || path.basename(asyncDir);
	const pid = typeof status.pid === "number" ? status.pid : "unknown";
	const baseMessage = reason ?? `Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const diagnostics = readRunnerStartupDiagnostics(asyncDir);
	const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
		? {
			...step,
			status: "failed" as const,
			activityState: undefined,
			endedAt: step.endedAt ?? now,
			durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
			exitCode: step.exitCode ?? 1,
			error: step.error ?? message,
		}
		: step);
	const repairedStatus: AsyncStatus = {
		...status,
		state: "failed",
		activityState: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	return {
		status: repairedStatus,
		message,
		result: {
			id: runId,
			agent: resultAgent,
			mode: status.mode,
			success: false,
			state: "failed",
			summary: message,
			results: repairedSteps.map((step) => ({
				agent: step.agent,
				output: step.status === "complete" || step.status === "completed" ? "" : message,
				error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
				success: step.status === "complete" || step.status === "completed",
				model: step.model,
				attemptedModels: step.attemptedModels,
				modelAttempts: step.modelAttempts,
				sessionFile: step.sessionFile,
			})),
			exitCode: 1,
			timestamp: now,
			durationMs: Math.max(0, now - status.startedAt),
			asyncDir,
			sessionId: status.sessionId,
			sessionFile: status.sessionFile,
		},
	};
}

function writeFailedRepair(asyncDir: string, status: AsyncStatus, resultPath: string, now: number, reason?: string): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

function terminal(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "stopped";
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state)) continue;
		const ts = options.now?.() ?? Date.now();
		writeNestedEvent(route, {
			type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			parentStepIndex: run.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(status, asyncDir, {
				id: run.id,
				parentRunId: run.parentRunId,
				parentStepIndex: run.parentStepIndex,
				depth: run.depth,
				path: run.path,
				mode: run.mode,
				ts,
			}),
		});
	}
}

export function checkPidLiveness(pid: number, kill: KillFn = process.kill): PidLiveness {
	try {
		kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as NodeJS.ErrnoException).code
			: undefined;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "unknown";
		return "unknown";
	}
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatusFile(asyncDir);
	const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };
	const statusPath = path.join(asyncDir, "status.json");
	for (const [index, step] of (effectiveStatus.steps ?? []).entries()) {
		const stepRecord = step as Record<string, unknown>;
		if (stepRecord.model !== undefined && typeof stepRecord.model !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
		if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string") throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
	}

	const runId = effectiveStatus.runId || path.basename(asyncDir);
	const resultPath = path.join(options.resultsDir ?? RESULTS_DIR, `${runId}.json`);
	if (fs.existsSync(resultPath)) {
		const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
			? terminalStatusFromResult(effectiveStatus, resultPath, now)
			: undefined;
		if (terminalStatus) {
			writeAtomicJson(path.join(asyncDir, "status.json"), terminalStatus);
			return { status: terminalStatus, repaired: true, resultPath, message: "Existing async result file was used to repair stale running status." };
		}
		return { status: effectiveStatus, repaired: false, resultPath };
	}

	if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
		return { status: status ?? null, repaired: false, resultPath };
	}

	if (!status) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
			return { status: null, repaired: false, resultPath };
		}
	}

	const liveness = checkPidLiveness(effectiveStatus.pid, options.kill);
	if (liveness !== "dead") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return { status: status ?? null, repaired: false, resultPath };
		const message = `Async runner process ${effectiveStatus.pid} still has a live PID, but status has not updated for ${now - lastUpdate}ms. Marked run failed by stale-run reconciliation because PID ownership cannot be verified.`;
		return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
	}

	return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
