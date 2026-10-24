import * as fs from "node:fs";
import * as path from "node:path";
import type { ForegroundResumeChild, ForegroundResumeRun, SubagentState } from "../../shared/types.ts";
import { DIRS } from "../../shared/types.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { utf8Tail } from "../../shared/utf8.ts";
import { validateAcceptanceInput } from "../shared/acceptance.ts";
import { validateModelResponseAliases } from "../../shared/model-response-aliases.ts";
import { checkRecordedPidLiveness } from "../background/stale-run-reconciler.ts";
import { currentPidNamespaceScope } from "../background/pid-namespace.ts";
import { currentBootId } from "../background/boot-id.ts";
import { encodeIndexSegment } from "../background/index-segment.ts";

export const MAX_REMEMBERED_FOREGROUND_RUNS = 50;
export const FOREGROUND_OWNER_EXITED_STOP_ERROR = "Subagent stopped because the Pi process that ran it exited before the run finished.";
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const MAX_RESUME_CONTRACT_BYTES = 64 * 1024;

// One file per run, so Pi processes sharing the results dir never rewrite each other's records.
function historyDir(resultsDir: string): string {
	return path.join(resultsDir, "foreground-history");
}

function runHistoryPath(resultsDir: string, runId: string): string {
	return path.join(historyDir(resultsDir), `${encodeIndexSegment(runId)}.json`);
}

function boundedTail(value: string): string {
	return utf8Tail(value, MAX_INLINE_OUTPUT_BYTES).text;
}

function compactChild(child: ForegroundResumeChild): ForegroundResumeChild {
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	return {
		agent: child.agent,
		index: child.index,
		...(child.sessionName ? { sessionName: child.sessionName } : {}),
		...(child.context ? { context: child.context } : {}),
		...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
		...(child.model ? { model: child.model } : {}),
		...(child.thinking ? { thinking: child.thinking } : {}),
		status: child.status,
		...(child.activityState ? { activityState: child.activityState } : {}),
		...(child.lastActivityAt !== undefined ? { lastActivityAt: child.lastActivityAt } : {}),
		...(child.currentTool ? { currentTool: child.currentTool } : {}),
		...(child.currentToolStartedAt !== undefined ? { currentToolStartedAt: child.currentToolStartedAt } : {}),
		...(child.currentPath ? { currentPath: child.currentPath } : {}),
		...(child.turnCount !== undefined ? { turnCount: child.turnCount } : {}),
		...(child.tokens !== undefined ? { tokens: child.tokens } : {}),
		...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
		...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
		...(child.error ? { error: child.error } : {}),
		...(!outputPath && child.finalOutput ? { finalOutput: boundedTail(child.finalOutput) } : {}),
		...(child.outputState ? { outputState: child.outputState } : {}),
		...(child.outputPartial ? { outputPartial: true } : {}),
		...(child.outputMode ? { outputMode: child.outputMode } : {}),
		...(child.savedOutputPath ? { savedOutputPath: child.savedOutputPath } : {}),
		...(child.outputSaveError ? { outputSaveError: child.outputSaveError } : {}),
		...(child.artifactPaths ? { artifactPaths: child.artifactPaths } : {}),
		...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
		...(child.transcriptError ? { transcriptError: child.transcriptError } : {}),
		...(child.acceptance ? { acceptance: child.acceptance } : {}),
		...(child.resumeContract ? { resumeContract: child.resumeContract } : {}),
		...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
		...(child.extensionBindings ? { extensionBindings: child.extensionBindings } : {}),
		...(child.requiredExtensions ? { requiredExtensions: child.requiredExtensions } : {}),
		...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
		...(child.updatedAt !== undefined ? { updatedAt: child.updatedAt } : {}),
	};
}

function isRestorableForegroundStatus(status: unknown): status is ForegroundResumeChild["status"] {
	return status === "completed" || status === "failed" || status === "paused" || status === "stopped";
}

function hasRunningChild(run: Pick<ForegroundResumeRun, "children">): boolean {
	return run.children.some((child) => child.status === "running");
}

function isOwnerPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A `running` record is kept only for a single run whose owning Pi process can be probed later. */
function isAdmittedChildStatus(run: Partial<ForegroundResumeRun>, status: unknown): boolean {
	return isRestorableForegroundStatus(status) || (status === "running" && run.mode === "single" && isOwnerPid(run.ownerPid));
}

function isRestorableResumeContract(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESUME_CONTRACT_BYTES) return false;
		validateModelResponseAliases((value as ForegroundResumeChild["resumeContract"])?.modelResponseAliases);
	} catch {
		return false;
	}
	const contract = value as NonNullable<ForegroundResumeChild["resumeContract"]>;
	if (Object.keys(contract).some((key) => !["modelResponseAliases", "outputSchema", "agentContract", "acceptance", "output", "outputMode"].includes(key))) return false;
	if (contract.outputSchema !== undefined && contract.outputSchema !== false && (!contract.outputSchema || typeof contract.outputSchema !== "object" || Array.isArray(contract.outputSchema))) return false;
	if (contract.agentContract !== undefined && (!contract.agentContract || typeof contract.agentContract !== "object" || Array.isArray(contract.agentContract) || contract.agentContract.version !== 1)) return false;
	if (validateAcceptanceInput(contract.acceptance).length > 0) return false;
	if (contract.output !== undefined && typeof contract.output !== "string" && typeof contract.output !== "boolean") return false;
	return contract.outputMode === undefined || contract.outputMode === "inline" || contract.outputMode === "file-only";
}

function compactRun(run: ForegroundResumeRun): ForegroundResumeRun | undefined {
	if (!run.sessionId) return undefined;
	if (run.children.length === 0 || !run.children.every((child) => isAdmittedChildStatus(run, child.status) && isRestorableResumeContract(child.resumeContract))) return undefined;
	const running = hasRunningChild(run);
	return {
		runId: run.runId,
		mode: run.mode,
		cwd: run.cwd,
		sessionId: run.sessionId,
		updatedAt: run.updatedAt,
		children: run.children.map(compactChild),
		...(running ? { ownerPid: run.ownerPid } : {}),
		...(running && run.ownerPidNamespaceScope ? { ownerPidNamespaceScope: run.ownerPidNamespaceScope } : {}),
		...(running && run.ownerBootId ? { ownerBootId: run.ownerBootId } : {}),
		...(run.parentWorkflowRunId ? { parentWorkflowRunId: run.parentWorkflowRunId } : {}),
	};
}

/** One saved run, or undefined when the file is missing, unreadable or invalid. */
function readRunFile(filePath: string): ForegroundResumeRun | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
		return isRestorableRun(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function historyFiles(dir: string): string[] {
	try {
		return fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

function isRestorableRun(value: unknown): value is ForegroundResumeRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const run = value as Partial<ForegroundResumeRun>;
	return typeof run.runId === "string" && Boolean(run.runId)
		&& (run.mode === "single" || run.mode === "parallel" || run.mode === "chain")
		&& typeof run.cwd === "string" && Boolean(run.cwd)
		&& typeof run.sessionId === "string" && Boolean(run.sessionId)
		&& typeof run.updatedAt === "number" && Number.isFinite(run.updatedAt)
		&& Array.isArray(run.children)
		&& run.children.length > 0
		&& (run.ownerPidNamespaceScope === undefined || typeof run.ownerPidNamespaceScope === "string")
		&& (run.ownerBootId === undefined || typeof run.ownerBootId === "string")
		&& (run.parentWorkflowRunId === undefined || typeof run.parentWorkflowRunId === "string")
		&& run.children.every((child) => Boolean(child && typeof child === "object" && !Array.isArray(child)
			&& typeof (child as Partial<ForegroundResumeChild>).agent === "string"
			&& typeof (child as Partial<ForegroundResumeChild>).index === "number"
			&& isRestorableResumeContract((child as Partial<ForegroundResumeChild>).resumeContract)
			&& isAdmittedChildStatus(run, (child as Partial<ForegroundResumeChild>).status)));
}

function sortAndBound(runs: ForegroundResumeRun[], limit: number): ForegroundResumeRun[] {
	return [...runs].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

/** Deletes the oldest final run files beyond the cap; running records stay, so the cap can be exceeded while runs are live. */
function pruneHistory(dir: string, limit: number): void {
	const files = historyFiles(dir);
	if (files.length <= limit) return;
	const byAge = files.flatMap((name) => {
		try {
			return [{ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }];
		} catch {
			return [];
		}
	}).sort((left, right) => left.mtimeMs - right.mtimeMs);
	for (const { name, mtimeMs } of byAge.slice(0, byAge.length - limit)) {
		const filePath = path.join(dir, name);
		// A running record is replaced later by its run's final save, possibly in another Pi process;
		// once its owner is confirmed dead nothing can replace it, so it is final.
		const run = readRunFile(filePath);
		if (run && hasRunningChild(run) && !ownerConfirmedDead(run)) continue;
		// A file rewritten since the snapshot is a fresh record, not the old one judged here.
		try {
			if (fs.statSync(filePath).mtimeMs !== mtimeMs) continue;
		} catch {
			continue;
		}
		fs.rmSync(filePath, { force: true });
	}
}

/**
 * Saves one foreground run to its own history file. A run with a `running` child is a launch-time
 * record; the run's final save replaces it.
 */
export function persistForegroundRun(run: ForegroundResumeRun, options: { resultsDir?: string; limit?: number } = {}): void {
	const compact = compactRun(run);
	if (!compact) return;
	const resultsDir = options.resultsDir ?? DIRS.results;
	const dir = historyDir(resultsDir);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
		// The single shared file used before per-run files is not read or migrated.
		fs.rmSync(path.join(resultsDir, "foreground-history.json"), { force: true });
	}
	writePrivateAtomicJson(runHistoryPath(resultsDir, compact.runId), compact);
	pruneHistory(dir, options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS);
}

/** Drops this process's `running` record for a launch that threw, so it never loads as interrupted. */
export function discardRunningForegroundRun(runId: string, options: { resultsDir?: string } = {}): void {
	const filePath = runHistoryPath(options.resultsDir ?? DIRS.results, runId);
	const run = readRunFile(filePath);
	if (run && hasRunningChild(run) && run.ownerPid === process.pid) fs.rmSync(filePath, { force: true });
}

/** For a record with a `running` child: its owning Pi process is gone. */
export function ownerConfirmedDead(run: ForegroundResumeRun): boolean {
	// readRunFile admits a running child only with a valid ownerPid.
	return checkRecordedPidLiveness({ pid: run.ownerPid!, pidNamespaceScope: run.ownerPidNamespaceScope, bootId: run.ownerBootId }, { observedScope: currentPidNamespaceScope(), observedBootId: currentBootId() }) === "dead";
}

/** A run whose owning Pi process is gone loads as stopped and resumable; one whose owner may be alive is not loaded. */
function restoreInterruptedRun(run: ForegroundResumeRun): ForegroundResumeRun | undefined {
	if (!ownerConfirmedDead(run)) return undefined;
	const { ownerPid: _ownerPid, ownerPidNamespaceScope: _ownerPidNamespaceScope, ownerBootId: _ownerBootId, ...rest } = run;
	return {
		...rest,
		children: run.children.map((child) => {
			if (child.status !== "running") return child;
			const { activityState: _activityState, currentTool: _currentTool, currentToolStartedAt: _currentToolStartedAt, currentPath: _currentPath, sessionFile, ...stopped } = child;
			return {
				...stopped,
				status: "stopped" as const,
				exitCode: 1,
				error: FOREGROUND_OWNER_EXITED_STOP_ERROR,
				finalOutput: FOREGROUND_OWNER_EXITED_STOP_ERROR,
				...(sessionFile && fs.existsSync(sessionFile) ? { sessionFile } : {}),
			};
		}),
	};
}

/** State text for a remembered child; a child cut off by a Pi exit names the resume target. */
export function foregroundChildStateLabel(run: Pick<ForegroundResumeRun, "runId">, child: Pick<ForegroundResumeChild, "status" | "error" | "sessionFile">): string {
	if (child.status !== "stopped" || child.error !== FOREGROUND_OWNER_EXITED_STOP_ERROR) return child.status;
	// Without a transcript there is nothing to resume from.
	return child.sessionFile ? `interrupted when Pi exited · resume ${run.runId}` : "interrupted when Pi exited";
}

export function restoreForegroundRunHistory(state: SubagentState, options: { resultsDir?: string; sessionId?: string | null; limit?: number; observeForeign?: (run: ForegroundResumeRun) => void } = {}): number {
	const sessionId = options.sessionId ?? state.currentSessionId;
	if (!sessionId) return 0;
	const dir = historyDir(options.resultsDir ?? DIRS.results);
	const saved = historyFiles(dir).flatMap((name) => readRunFile(path.join(dir, name)) ?? []);
	// Other sessions' records that may have been cut off, for a read-only pointer to them.
	if (options.observeForeign) for (const run of saved) if (run.sessionId !== sessionId && hasRunningChild(run)) options.observeForeign(run);
	const runs = sortAndBound(saved.filter((run) => run.sessionId === sessionId), options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS);
	state.foregroundRuns ??= new Map();
	let restored = 0;
	for (const run of runs) {
		if (state.foregroundRuns.has(run.runId)) continue;
		const loaded = hasRunningChild(run) ? restoreInterruptedRun(run) : run;
		if (!loaded) continue;
		state.foregroundRuns.set(run.runId, loaded);
		restored += 1;
	}
	return restored;
}
