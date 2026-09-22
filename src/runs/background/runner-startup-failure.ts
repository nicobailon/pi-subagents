import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { readProcessTerminalCandidate, type ProcessTerminalCandidate } from "./process-terminal-candidate.ts";

interface RunnerStartupFailureInput {
	asyncDir: string;
	runId: string;
	runnerProcessInstanceId: string;
	message: string;
	sessionId?: string;
	completionOwnerId?: string;
	candidate?: Partial<Pick<ProcessTerminalCandidate, "sessionFile" | "revivalLeaseToken">>;
}

/** Persist a runner failure that occurred before any child writer could start. */
export function persistRunnerStartupFailure(input: RunnerStartupFailureInput): void {
	const now = Date.now();
	const statusPath = path.join(input.asyncDir, "status.json");
	let status: Partial<AsyncStatus> = {};
	try {
		status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as Partial<AsyncStatus>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const existingProcessTerminal = status.processTerminal?.state === "observed" || status.processTerminal?.state === "unknown"
		? status.processTerminal : undefined;
	writePrivateAtomicJson(statusPath, {
		...status,
		runId: input.runId,
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.completionOwnerId ? { completionOwnerId: input.completionOwnerId } : {}),
		state: "failed",
		lastUpdate: now,
		error: input.message,
		processTerminal: existingProcessTerminal ?? {
			version: 1,
			state: "not-started",
			runId: input.runId,
			runnerProcessInstanceId: input.runnerProcessInstanceId,
		},
	});
	const existingCandidate = readProcessTerminalCandidate(input.asyncDir);
	const stepCount = Math.max(1, status.steps?.length ?? 0);
	writePrivateAtomicJson(path.join(input.asyncDir, "process-terminal-candidate.json"), {
		...existingCandidate,
		version: 1,
		runId: input.runId,
		runnerProcessInstanceId: input.runnerProcessInstanceId,
		writers: {},
		expectedWriters: Object.fromEntries(Array.from({ length: stepCount }, (_, index) => [String(index), 0])),
		...(input.candidate?.sessionFile ? { sessionFile: input.candidate.sessionFile } : {}),
		...(input.candidate?.revivalLeaseToken ? { revivalLeaseToken: input.candidate.revivalLeaseToken } : {}),
	});
}
