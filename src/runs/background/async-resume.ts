import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export type AsyncResumeTarget = {
	kind: "live" | "revive";
	runId: string;
	asyncDir?: string;
	state: AsyncStatus["state"];
	agent: string;
	index: number;
	intercomTarget: string;
	cwd?: string;
	sessionFile?: string;
};

interface AsyncResultFile {
	id?: string;
	runId?: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	cwd?: string;
	sessionFile?: string;
	results?: Array<{ agent?: string; success?: boolean; intercomTarget?: string }>;
}

export interface AsyncRunLocation {
	asyncDir: string | null;
	resultPath: string | null;
	resolvedId?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Async result file '${source}' must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function validateOptionalString(value: Record<string, unknown>, field: string, source: string): string | undefined {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string") throw new Error(`Invalid async result file '${source}': ${field} must be a string.`);
	return fieldValue;
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
	const data = ensureObject(value, resultPath);
	const resultsValue = data.results;
	let results: AsyncResultFile["results"];
	if (resultsValue !== undefined) {
		if (!Array.isArray(resultsValue)) throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
		results = resultsValue.map((entry, index) => {
			const child = ensureObject(entry, `${resultPath} results[${index}]`);
			const agent = validateOptionalString(child, "agent", `${resultPath} results[${index}]`);
			const intercomTarget = validateOptionalString(child, "intercomTarget", `${resultPath} results[${index}]`);
			const success = child.success;
			if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
			return { agent, intercomTarget, ...(typeof success === "boolean" ? { success } : {}) };
		});
	}
	const success = data.success;
	if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
	return {
		id: validateOptionalString(data, "id", resultPath),
		runId: validateOptionalString(data, "runId", resultPath),
		agent: validateOptionalString(data, "agent", resultPath),
		mode: validateOptionalString(data, "mode", resultPath),
		state: validateOptionalString(data, "state", resultPath),
		cwd: validateOptionalString(data, "cwd", resultPath),
		sessionFile: validateOptionalString(data, "sessionFile", resultPath),
		...(typeof success === "boolean" ? { success } : {}),
		...(results ? { results } : {}),
	};
}

function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return validateResultFile(JSON.parse(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new Error(`${field} must not be empty.`);
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
		throw new Error(`${field} must be an async run id or prefix, not a path.`);
	}
	return value;
}

function assertInsideRoot(root: string, target: string, label: string): void {
	const rootPath = path.resolve(root);
	const targetPath = path.resolve(target);
	const relative = path.relative(rootPath, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error(`${label} must be inside ${rootPath}.`);
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
		.map((entry) => suffix ? entry.slice(0, -suffix.length) : entry)
		.sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	assertInsideRoot(resultsDir, resultPath, "Async result file");
	return fs.existsSync(resultPath) ? resultPath : null;
}

export function resolveAsyncRunLocation(params: AsyncResumeParams, asyncDirRoot: string, resultsDir: string): AsyncRunLocation {
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		const resolvedId = requestedId ?? path.basename(asyncDir);
		if (requestedId && requestedId !== path.basename(asyncDir)) {
			throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
		}
		return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
	}
	if (!requestedId) return { asyncDir: null, resultPath: null };

	const directAsyncDir = path.join(asyncRoot, requestedId);
	assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
	const directResultPath = exactResultPath(resultRoot, requestedId);
	if (fs.existsSync(directAsyncDir) || directResultPath) {
		return {
			asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
			resultPath: directResultPath,
			resolvedId: requestedId,
		};
	}

	const matchingIds = [...new Set([
		...prefixedRunIds(asyncRoot, requestedId),
		...prefixedRunIds(resultRoot, requestedId, ".json"),
	])].sort();
	if (matchingIds.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	if (matchingIds.length > 1) {
		throw new Error(`Ambiguous async run id prefix '${requestedId}' matched: ${matchingIds.join(", ")}. Provide a longer id.`);
	}
	const resolvedId = matchingIds[0]!;
	const asyncDir = path.join(asyncRoot, resolvedId);
	assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
	return {
		asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
		resultPath: exactResultPath(resultRoot, resolvedId),
		resolvedId,
	};
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "running" || result.state === "queued") {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (typeof status.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && typeof status.cwd !== "string") throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && typeof status.sessionFile !== "string") throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		status.steps.forEach((step, index) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			if (typeof step.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
		});
	}
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!fs.existsSync(resolved)) throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
	return resolved;
}

export function resolveAsyncResumeTarget(params: AsyncResumeParams, deps: AsyncResumeDeps = {}): AsyncResumeTarget {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	const reconciliation = location.asyncDir
		? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
		: undefined;
	const status = reconciliation?.status ?? null;
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	const runId = status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);

	const statusSteps = status?.steps ?? [];
	const resultSteps = result?.results ?? [];
	const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
	const requestedIndex = params.index;

	if (state === "running") {
		const running = statusSteps
			.map((step, index) => ({ step, index }))
			.filter(({ step }) => step.status === "running");
		const selected = requestedIndex !== undefined
			? running.find(({ index }) => index === requestedIndex)
			: running.length === 1 ? running[0] : undefined;
		if (!selected) {
			throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
		}
		return {
			kind: "live",
			runId,
			asyncDir: location.asyncDir ?? undefined,
			state,
			agent: selected.step.agent,
			index: selected.index,
			intercomTarget: resolveSubagentIntercomTarget(runId, selected.step.agent, selected.index),
			cwd: status?.cwd ?? result?.cwd,
			sessionFile: status?.sessionFile ?? result?.sessionFile,
		};
	}

	if (stepCount !== 1) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Resume currently supports single-child async runs because per-child session files are not persisted.`);
	}
	const index = requestedIndex ?? 0;
	const agent = statusSteps[index]?.agent ?? resultSteps[index]?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	const sessionFile = status?.sessionFile ?? result?.sessionFile;
	if (!sessionFile) throw new Error(`Async run '${runId}' does not have a persisted child session file to resume from.`);
	const resolvedSessionFile = validateResumeSessionFile(runId, sessionFile);

	return {
		kind: "revive",
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		index,
		intercomTarget: resolveSubagentIntercomTarget(runId, agent, index),
		cwd: status?.cwd ?? result?.cwd,
		sessionFile: resolvedSessionFile,
	};
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a completed async subagent conversation.",
		"",
		`Original async run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	].filter((line): line is string => line !== undefined).join("\n");
}
