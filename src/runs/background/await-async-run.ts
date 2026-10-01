import * as fs from "node:fs";
import { readStatus } from "../../shared/utils.ts";
import { workflowAwaitedAsyncResultPath } from "./async-execution.ts";
import { waitForImportedAsyncRoot, type ImportedAsyncRootResult } from "./chain-root-attachment.ts";
import { currentPidNamespaceScope } from "./pid-namespace.ts";
import { resultPayloadPathForSessionRun } from "./result-files.ts";
import { checkPidLiveness } from "./stale-run-reconciler.ts";

type ExistingAsyncRunOutcome =
	| { status: "settled"; result: ImportedAsyncRootResult }
	| { status: "unavailable"; reason: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read-only probe: the runner is gone while status still says it is active and no result was published. */
function runnerExitedWithoutResult(asyncDir: string, runId: string, resultPath: string): boolean {
	const status = readStatus(asyncDir);
	if (!status || (status.state !== "running" && status.state !== "queued") || typeof status.pid !== "number") return false;
	const observedScope = currentPidNamespaceScope();
	if (status.pidNamespaceScope !== undefined && status.pidNamespaceScope !== observedScope) return false;
	const pidScopeVerified = status.pidNamespaceScope !== undefined && status.pidNamespaceScope === observedScope;
	if (checkPidLiveness(status.pid, undefined, pidScopeVerified) !== "dead") return false;
	return !fs.existsSync(resultPath) && !(status.sessionId && resultPayloadPathForSessionRun(asyncDir, status.sessionId, runId));
}

/**
 * Waits for an existing workflow-awaited async child, identified by its async
 * directory and exact run id, and returns its published result without
 * launching, consuming, or rewriting anything. Anything short of a published
 * result file for that exact run is `unavailable`. Rejects with the signal's
 * reason when aborted.
 */
export async function awaitExistingAsyncRun(asyncDir: string, runId: string, signal: AbortSignal): Promise<ExistingAsyncRunOutcome> {
	signal.throwIfAborted();
	let status: ReturnType<typeof readStatus>;
	try {
		status = readStatus(asyncDir);
	} catch (error) {
		return { status: "unavailable", reason: `Async status for run '${runId}' is unreadable: ${errorMessage(error)}` };
	}
	if (!status) return { status: "unavailable", reason: `No async status exists for run '${runId}' at ${asyncDir}.` };
	if (status.runId !== runId) return { status: "unavailable", reason: `Async status at ${asyncDir} belongs to run '${status.runId}', not '${runId}'.` };
	// The launcher's initial status has no workflow identity until the runner starts, so only the
	// mode is checked here; a run that does not publish to the workflow result path stays unavailable.
	if (status.mode !== "single") return { status: "unavailable", reason: `Async run '${runId}' is not a single-agent run.` };
	const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
	let runnerExited = false;
	let completed: ImportedAsyncRootResult;
	try {
		completed = await waitForImportedAsyncRoot({ runId, asyncDir, resultPath, index: 0 }, {
			shouldAbort: () => signal.aborted || (runnerExited = runnerExitedWithoutResult(asyncDir, runId, resultPath)),
		});
	} catch (error) {
		signal.throwIfAborted();
		return { status: "unavailable", reason: `Could not await async run '${runId}': ${errorMessage(error)}` };
	}
	signal.throwIfAborted();
	if (runnerExited) return { status: "unavailable", reason: `Async runner for run '${runId}' exited without publishing a result.` };
	// Only a parsed result file carries importedPublication; status-derived fallbacks do not.
	if (!completed.importedPublication) return { status: "unavailable", reason: `Async run '${runId}' ended without a result file at ${resultPath}.` };
	return { status: "settled", result: completed };
}

/**
 * Renames the published result to a file owned by `claimant`. Only one of several
 * concurrent importers can win the rename; the others get undefined and launch fresh.
 */
export function claimWorkflowAwaitedResult(asyncDir: string, claimant: string): string | undefined {
	const claimedPath = `${workflowAwaitedAsyncResultPath(asyncDir)}.${claimant}.claimed`;
	try {
		fs.renameSync(workflowAwaitedAsyncResultPath(asyncDir), claimedPath);
		return claimedPath;
	} catch {
		return undefined;
	}
}
