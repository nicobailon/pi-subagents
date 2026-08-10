import * as fs from "node:fs";
import type { AsyncRunSummary } from "./async-status.ts";

export function formatAsyncReviveCommand(run: AsyncRunSummary): string | undefined {
	const step = run.steps.find((candidate) => candidate.status === "failed" && candidate.sessionFile && fs.existsSync(candidate.sessionFile));
	if (!step) {
		if (run.steps.length === 1 && run.sessionFile && fs.existsSync(run.sessionFile)) {
			return `subagent({ action: "resume", id: "${run.id}", message: "Continue from the persisted child session and report the result." })`;
		}
		return undefined;
	}
	const index = run.steps.length === 1 ? "" : `, index: ${step.index}`;
	return `subagent({ action: "resume", id: "${run.id}"${index}, message: "Continue from the persisted child session and report the result." })`;
}

export function formatResumeFirstFailedRunDetail(run: AsyncRunSummary): string | undefined {
	if (run.state !== "failed") return undefined;
	const command = formatAsyncReviveCommand(run);
	if (!command) return undefined;
	return `Resume-first: failed run "${run.id}" has a persisted child session. Revive the original run with ${command} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
}

export function formatResumeFirstFailedRunsNote(runs: AsyncRunSummary[]): string {
	const resumable = runs
		.filter((run) => run.state === "failed")
		.map((run) => ({ run, command: formatAsyncReviveCommand(run) }))
		.filter((entry): entry is { run: AsyncRunSummary; command: string } => Boolean(entry.command));
	if (resumable.length === 0) return "";
	const guidance = resumable.length === 1
		? `failed run "${resumable[0]!.run.id}" has a persisted child session. Revive the original run with ${resumable[0]!.command}`
		: `${resumable.length} failed runs have persisted child sessions. Inspect status and revive each original run before retrying`;
	return ` Resume-first: ${guidance} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
}
