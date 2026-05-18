import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatAsyncRunList, formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns } from "./async-status.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus, type Details } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

interface RunStatusParams {
	action?: "status";
	id?: string;
	runId?: string;
	dir?: string;
}

interface RunStatusDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown }>, fallbackSessionFile?: unknown): string {
	const knownChildren = children
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => typeof child.agent === "string");
	if (!runId || knownChildren.length === 0) return "Resume: unavailable; no child session file was persisted.";
	const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
	if (children.length === 1 && knownChildren.length === 1 && hasExistingSessionFile(singleSessionFile)) {
		return `Revive: subagent({ action: "resume", id: "${runId}", message: "..." })`;
	}
	const childWithSession = knownChildren.find(({ child }) => hasExistingSessionFile(child.sessionFile));
	if (childWithSession) {
		return `Revive child: subagent({ action: "resume", id: "${runId}", index: ${childWithSession.index}, message: "..." })`;
	}
	return "Resume: unavailable; no child session file was persisted.";
}

function stepLineLabel(status: AsyncStatus, index: number): string {
	const steps = status.steps ?? [];
	if (status.mode === "parallel") return `Agent ${index + 1}/${steps.length || 1}`;
	if (status.mode === "chain") {
		const chainStepCount = status.chainStepCount ?? (steps.length || 1);
		const groups = normalizeParallelGroups(status.parallelGroups, steps.length, chainStepCount);
		const group = groups.find((candidate) => index >= candidate.start && index < candidate.start + candidate.count);
		if (group) return `Step ${group.stepIndex + 1}/${chainStepCount} Agent ${index - group.start + 1}/${group.count}`;
		return `Step ${flatToLogicalStepIndex(index, chainStepCount, groups) + 1}/${chainStepCount}`;
	}
	return `Step ${index + 1}`;
}

export function inspectSubagentStatus(params: RunStatusParams, deps: RunStatusDeps = {}): AgentToolResult<Details> {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	if (!params.id && !params.runId && !params.dir) {
		try {
			const runs = listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], resultsDir, kill: deps.kill, now: deps.now });
			return {
				content: [{ type: "text", text: formatAsyncRunList(runs) }],
				details: { mode: "single", results: [] },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	let location;
	try {
		location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	const { asyncDir, resultPath, resolvedId } = location;

	if (!asyncDir && !resultPath) {
		return {
			content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	if (asyncDir) {
		let reconciliation;
		try {
			reconciliation = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const status = reconciliation.status;
		const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
		const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		if (status) {
			const outputPath = formatAsyncRunOutputPath({ asyncDir, outputFile: status.outputFile });
			const progressLabel = formatAsyncRunProgressLabel({
				mode: status.mode,
				state: status.state,
				currentStep: status.currentStep,
				chainStepCount: status.chainStepCount,
				parallelGroups: status.parallelGroups,
				steps: (status.steps ?? []).map((step, index) => ({ index, agent: step.agent, status: step.status })),
			});
			const started = new Date(status.startedAt).toISOString();
			const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
			const statusActivityText = status.state === "running" ? formatActivityLabel(status.lastActivityAt, status.activityState) : undefined;

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				`Mode: ${status.mode}`,
				`Progress: ${progressLabel}`,
				`Started: ${started}`,
				`Updated: ${updated}`,
				`Dir: ${asyncDir}`,
				outputPath ? `Output: ${outputPath}` : undefined,
				reconciliation.message ? `Diagnosis: ${reconciliation.message}` : undefined,
				reconciliation.resultPath && fs.existsSync(reconciliation.resultPath) ? `Result: ${reconciliation.resultPath}` : undefined,
			].filter((line): line is string => Boolean(line));
			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
				const modelThinking = formatModelThinking(step.model, step.thinking);
				const modelText = modelThinking ? ` (${modelThinking})` : "";
				const errorText = step.error ? `, error: ${step.error}` : "";
				lines.push(`${stepLineLabel(status, index)}: ${step.agent} ${step.status}${modelText}${stepActivityText ? `, ${stepActivityText}` : ""}${errorText}`);
				const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
				if (stepOutputPath !== outputPath && fs.existsSync(stepOutputPath)) lines.push(`  Output: ${stepOutputPath}`);
				if (step.status === "running") {
					lines.push(`  Intercom target: ${resolveSubagentIntercomTarget(status.runId, step.agent, index)} (if registered)`);
				}
			}
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			if (status.state !== "running") {
				lines.push(formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile));
			}
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	if (resultPath) {
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const data = JSON.parse(raw) as { id?: string; runId?: string; agent?: string; success?: boolean; summary?: string; exitCode?: number; state?: string; sessionFile?: string; results?: Array<{ agent?: string; sessionFile?: string }> };
			const status = data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
			const runId = data.runId ?? data.id ?? resolvedId;
			const lines = [`Run: ${runId}`, `State: ${status}`, `Result: ${resultPath}`];
			const children = Array.isArray(data.results) ? data.results : data.agent ? [{ agent: data.agent, sessionFile: data.sessionFile }] : [];
			lines.push(formatResumeGuidance(runId, children, data.sessionFile));
			if (data.summary) lines.push("", data.summary);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	return {
		content: [{ type: "text", text: "Status file not found." }],
		isError: true,
		details: { mode: "single", results: [] },
	};
}
