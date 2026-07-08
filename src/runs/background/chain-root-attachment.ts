import * as fs from "node:fs";
import * as path from "node:path";
import type { AcceptanceLedger, AsyncStatus, CostSummary, ModelAttempt } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";

export interface ImportedAsyncRoot {
	runId: string;
	asyncDir: string;
	resultPath: string;
	index: number;
}

export interface ImportedAsyncRootResult {
	agent: string;
	output: string;
	success: boolean;
	exitCode: number;
	error?: string;
	sessionFile?: string;
	intercomTarget?: string;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	totalCost?: CostSummary;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
	acceptance?: AcceptanceLedger;
	timedOut?: boolean;
	stopped?: boolean;
}

interface AsyncResultFile {
	state?: string;
	success?: boolean;
	summary?: string;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	results?: Array<{
		agent?: string;
		output?: string;
		error?: string;
		success?: boolean;
		timedOut?: boolean;
		stopped?: boolean;
		sessionFile?: string;
		intercomTarget?: string;
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		totalCost?: CostSummary;
		structuredOutput?: unknown;
		structuredOutputPath?: string;
		structuredOutputSchemaPath?: string;
		acceptance?: AcceptanceLedger;
	}>;
}

const TERMINAL_STATES = new Set(["complete", "failed", "paused", "stopped"]);
const TERMINAL_STEP_STATUSES = new Set(["complete", "completed", "failed", "paused", "stopped"]);

function readResultFile(resultPath: string): AsyncResultFile | undefined {
	try {
		return JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultFile;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function selectedStatusStep(status: AsyncStatus | null, index: number): NonNullable<AsyncStatus["steps"]>[number] | undefined {
	return status?.steps?.[index];
}

function isTerminalStatus(status: AsyncStatus | null, index: number): boolean {
	if (!status) return false;
	const step = selectedStatusStep(status, index);
	if (step && TERMINAL_STEP_STATUSES.has(step.status)) return true;
	return TERMINAL_STATES.has(status.state);
}

function resultState(result: AsyncResultFile | undefined, child: NonNullable<AsyncResultFile["results"]>[number] | undefined): "complete" | "failed" | "paused" | "stopped" | undefined {
	if (!result) return undefined;
	if (child?.stopped === true) return "stopped";
	if (child?.success === true) return "complete";
	if (child?.success === false) return result.state === "stopped" ? "stopped" : result.state === "paused" ? "paused" : "failed";
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "stopped") return result.state;
	if (result.success === true) return "complete";
	if (result.success === false) return "failed";
	return undefined;
}

function outputFromTerminalStatus(root: ImportedAsyncRoot, status: AsyncStatus, step: NonNullable<AsyncStatus["steps"]>[number] | undefined): ImportedAsyncRootResult {
	const agent = step?.agent ?? status.steps?.[root.index]?.agent ?? "subagent";
	const timedOut = step?.timedOut === true || status.timedOut === true;
	const stopped = step?.stopped === true || status.stopped === true || status.state === "stopped";
	const message = step?.error ?? status.error ?? (stopped ? "Subagent stopped by user." : `Attached async root ${root.runId} ended without a result file at ${root.resultPath}.`);
	return {
		agent,
		output: message,
		success: false,
		exitCode: 1,
		error: message,
		...(timedOut ? { timedOut: true } : {}),
		...(stopped ? { stopped: true } : {}),
		...(step?.sessionFile ?? status.sessionFile ? { sessionFile: step?.sessionFile ?? status.sessionFile } : {}),
		...(step?.model ? { model: step.model } : {}),
		...(step?.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
		...(step?.modelAttempts ? { modelAttempts: step.modelAttempts } : {}),
		...(step?.totalCost ? { totalCost: step.totalCost } : {}),
		...(step?.structuredOutput !== undefined ? { structuredOutput: step.structuredOutput } : {}),
		...(step?.structuredOutputPath ? { structuredOutputPath: step.structuredOutputPath } : {}),
		...(step?.structuredOutputSchemaPath ? { structuredOutputSchemaPath: step.structuredOutputSchemaPath } : {}),
		...(step?.acceptance ? { acceptance: step.acceptance } : {}),
	};
}

function outputFromTimeout(root: ImportedAsyncRoot, status: AsyncStatus | null, message: string): ImportedAsyncRootResult {
	const step = selectedStatusStep(status, root.index);
	return {
		agent: step?.agent ?? status?.steps?.[root.index]?.agent ?? "subagent",
		output: message,
		success: false,
		exitCode: 1,
		error: message,
		timedOut: true,
		...(step?.sessionFile ?? status?.sessionFile ? { sessionFile: step?.sessionFile ?? status?.sessionFile } : {}),
		...(step?.model ? { model: step.model } : {}),
		...(step?.attemptedModels ? { attemptedModels: step.attemptedModels } : {}),
		...(step?.modelAttempts ? { modelAttempts: step.modelAttempts } : {}),
		...(step?.totalCost ? { totalCost: step.totalCost } : {}),
	};
}

function buildImportedResult(root: ImportedAsyncRoot, status: AsyncStatus | null, result: AsyncResultFile): ImportedAsyncRootResult {
	const child = result.results?.[root.index];
	const step = selectedStatusStep(status, root.index);
	const state = resultState(result, child);
	const agent = child?.agent ?? step?.agent ?? status?.steps?.[root.index]?.agent ?? "subagent";
	const output = child?.output ?? result.summary ?? "";
	const timedOut = child?.timedOut === true || step?.timedOut === true || result.timedOut === true || status?.timedOut === true;
	const stopped = child?.stopped === true || step?.stopped === true || result.stopped === true || status?.stopped === true || state === "stopped";
	const success = state === "complete" && !timedOut && !stopped;
	const error = child?.error ?? (success ? undefined : stopped ? "Subagent stopped by user." : result.error ?? result.summary ?? status?.error ?? `Attached async root ${root.runId} did not complete successfully.`);
	return {
		agent,
		output: success ? output : (output || error || ""),
		success,
		exitCode: success ? 0 : 1,
		...(error ? { error } : {}),
		...(timedOut ? { timedOut: true } : {}),
		...(stopped ? { stopped: true } : {}),
		...(child?.sessionFile ?? step?.sessionFile ?? status?.sessionFile ? { sessionFile: child?.sessionFile ?? step?.sessionFile ?? status?.sessionFile } : {}),
		...(child?.intercomTarget ? { intercomTarget: child.intercomTarget } : {}),
		...(child?.model ?? step?.model ? { model: child?.model ?? step?.model } : {}),
		...(child?.attemptedModels ?? step?.attemptedModels ? { attemptedModels: child?.attemptedModels ?? step?.attemptedModels } : {}),
		...(child?.modelAttempts ?? step?.modelAttempts ? { modelAttempts: child?.modelAttempts ?? step?.modelAttempts } : {}),
		...(child?.totalCost ?? step?.totalCost ? { totalCost: child?.totalCost ?? step?.totalCost } : {}),
		...(child?.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : step?.structuredOutput !== undefined ? { structuredOutput: step.structuredOutput } : {}),
		...(child?.structuredOutputPath ?? step?.structuredOutputPath ? { structuredOutputPath: child?.structuredOutputPath ?? step?.structuredOutputPath } : {}),
		...(child?.structuredOutputSchemaPath ?? step?.structuredOutputSchemaPath ? { structuredOutputSchemaPath: child?.structuredOutputSchemaPath ?? step?.structuredOutputSchemaPath } : {}),
		...(child?.acceptance ?? step?.acceptance ? { acceptance: child?.acceptance ?? step?.acceptance } : {}),
	};
}

export async function waitForImportedAsyncRoot(
	root: ImportedAsyncRoot,
	options: { pollIntervalMs?: number; terminalResultGraceMs?: number; now?: () => number; shouldAbort?: () => boolean; timeoutMessage?: string } = {},
): Promise<ImportedAsyncRootResult> {
	const pollIntervalMs = options.pollIntervalMs ?? 500;
	const terminalResultGraceMs = options.terminalResultGraceMs ?? 1_000;
	const now = options.now ?? Date.now;
	let terminalSince: number | undefined;
	for (;;) {
		const status = readStatus(root.asyncDir);
		if (options.shouldAbort?.()) return outputFromTimeout(root, status, options.timeoutMessage ?? "Subagent timed out.");
		const result = readResultFile(root.resultPath);
		if (result) return buildImportedResult(root, status, result);
		if (isTerminalStatus(status, root.index)) {
			terminalSince ??= now();
			if (now() - terminalSince >= terminalResultGraceMs) {
				return outputFromTerminalStatus(root, status!, selectedStatusStep(status, root.index));
			}
		} else {
			terminalSince = undefined;
		}
		if (!status && !fs.existsSync(root.asyncDir)) {
			throw new Error(`Attached async root '${root.runId}' directory does not exist: ${root.asyncDir}`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
}

export function resolveAsyncRootResultPath(resultsDir: string, runId: string): string {
	return path.join(resultsDir, `${runId}.json`);
}
