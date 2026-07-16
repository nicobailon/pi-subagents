import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatAsyncRunList, formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns } from "./async-status.ts";
import { formatAsyncResultTranscript, formatAsyncRunTranscript, formatNestedRunTranscript, inspectSubagentFleet } from "./fleet-view.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import { ASYNC_DIR, RESULTS_DIR, type AsyncStatus, type Details, type ForegroundResumeRun, type NestedRunSummary, type SteeringStatus, type SubagentState } from "../../shared/types.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { attachRootChildrenToSteps, findNestedRouteForRootId, projectNestedRegistryForRoot, type NestedRunResolutionScope } from "../shared/nested-events.ts";

interface RunStatusParams {
	action?: "status";
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
}

interface RunStatusDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	state?: SubagentState;
	nested?: NestedRunResolutionScope;
	sessionRoots?: string[];
}

function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown }>, fallbackSessionFile?: unknown, options: { stopped?: boolean } = {}): string {
	if (options.stopped) return "Resume: unavailable; stopped runs are not resumable. Start a new run instead.";
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

function nestedRunDisplayName(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.join(", ");
	return run.id;
}

function formatSteeringSummary(input: { steering?: SteeringStatus }): string | undefined {
	const steering = input.steering;
	if (!steering || steering.requested === 0) return undefined;
	const lateAcknowledgments = steering.recent.reduce((count, request) => count + request.targets.filter((target) => target.lateDeliveredAt !== undefined).length, 0);
	return `${steering.requested} requested, ${steering.scheduled} scheduled, ${steering.pending} pending, ${steering.delivered} delivered, ${steering.failed} failed, ${steering.recovered} recovered${lateAcknowledgments ? `, ${lateAcknowledgments} late acknowledged` : ""}`;
}

function rememberedForegroundChildOutput(child: ForegroundResumeRun["children"][number]): string {
	const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
	if (outputPath && fs.existsSync(outputPath)) {
		try {
			const artifactOutput = fs.readFileSync(outputPath, "utf-8").trim();
			if (artifactOutput) return artifactOutput;
		} catch {
			// Fall back to the remembered snapshot below.
		}
	}
	return child.finalOutput ?? "";
}

function formatRememberedForegroundStatus(run: ForegroundResumeRun): string {
	const lines = [
		`Run: ${run.runId}`,
		"State: remembered foreground",
		`Mode: ${run.mode}`,
		`Updated: ${new Date(run.updatedAt).toISOString()}`,
		`Cwd: ${run.cwd}`,
	];
	for (const child of run.children) {
		const output = rememberedForegroundChildOutput(child).trim().split(/\r?\n/).find((line) => line.trim());
		const parts = [
			`${child.index + 1}. ${child.agent} ${child.status}`,
			child.exitCode !== undefined ? `exit ${child.exitCode}` : undefined,
			child.detachedReason ? `detached: ${child.detachedReason}` : undefined,
			child.acceptance ? `acceptance: ${child.acceptance.status}` : undefined,
			child.error ? `error: ${child.error}` : undefined,
			output ? `output: ${output.slice(0, 160)}` : undefined,
		].filter(Boolean);
		lines.push(parts.join(", "));
		if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		if (child.transcriptPath) lines.push(`  Transcript: ${child.transcriptPath}`);
		if (child.artifactPaths?.outputPath) lines.push(`  Output: ${child.artifactPaths.outputPath}`);
		if (child.savedOutputPath && child.savedOutputPath !== child.artifactPaths?.outputPath) lines.push(`  Saved output: ${child.savedOutputPath}`);
		if (child.outputSaveError) lines.push(`  Output warning: ${child.outputSaveError}`);
		if (child.transcriptError) lines.push(`  Transcript warning: ${child.transcriptError}`);
	}
	lines.push("", `Status: subagent({ action: "status", id: "${run.runId}" })`);
	if (run.children.length === 1) lines.push(`Transcript: subagent({ action: "status", id: "${run.runId}", view: "transcript" })`);
	else lines.push(`Transcript: subagent({ action: "status", id: "${run.runId}", index: 0, view: "transcript" })`);
	const detached = run.children.some((child) => child.status === "detached");
	const resumable = run.children.find((child) => hasExistingSessionFile(child.sessionFile));
	if (detached) {
		lines.push(`Recovery: reply to the supervisor request first, then wait with subagent_wait({ id: "${run.runId}" }); do not resume or launch a replacement while any child remains detached.`);
	} else if (resumable) {
		lines.push(run.children.length === 1
			? `Revive: subagent({ action: "resume", id: "${run.runId}", message: "..." })`
			: `Revive child: subagent({ action: "resume", id: "${run.runId}", index: ${resumable.index}, message: "..." })`);
	} else {
		lines.push("Resume: unavailable; no child session file was persisted.");
	}
	return lines.join("\n");
}

function formatRememberedForegroundTranscript(run: ForegroundResumeRun, options: { index?: number; lines?: number }): string {
	let index = options.index;
	if (index !== undefined && !Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index === undefined && run.children.length === 1) index = 0;
	if (index === undefined) return `Transcript view requires index for foreground run '${run.runId}' with ${run.children.length} children.`;
	if (index < 0 || index >= run.children.length) throw new Error(`Transcript index ${index} is out of range for ${run.children.length} foreground children.`);
	const child = run.children[index]!;
	const lineLimit = Math.max(1, Math.min(options.lines ?? 80, 1000));
	const outputLines = rememberedForegroundChildOutput(child).split(/\r?\n/).filter((line) => line.trim()).slice(-lineLimit);
	const lines = [
		`Run: ${run.runId}`,
		`State: ${child.status}`,
		`Child: ${index} (${child.agent})`,
		child.sessionFile ? `Session: ${child.sessionFile}` : undefined,
		child.transcriptPath ? `Transcript: ${child.transcriptPath}` : undefined,
		child.artifactPaths?.outputPath ? `Output: ${child.artifactPaths.outputPath}` : undefined,
		child.savedOutputPath && child.savedOutputPath !== child.artifactPaths?.outputPath ? `Saved output: ${child.savedOutputPath}` : undefined,
		child.outputSaveError ? `Output warning: ${child.outputSaveError}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push("Result transcript tail:");
	if (outputLines.length === 0) lines.push("  (no recovered final output available yet)");
	else for (const line of outputLines) lines.push(`  ${line}`);
	return lines.join("\n");
}

function formatNestedExactStatus(rootRunId: string, run: NestedRunSummary): string {
	const lines = [
		`Nested run: ${run.id}`,
		`Root: ${rootRunId}`,
		`Parent: ${run.parentRunId}${run.parentStepIndex !== undefined ? ` step ${run.parentStepIndex + 1}` : ""}`,
		`State: ${run.state}`,
		run.activityState || run.lastActivityAt ? `Activity: ${formatActivityLabel(run.lastActivityAt, run.activityState)}` : undefined,
		run.mode ? `Mode: ${run.mode}` : undefined,
		`Agent: ${nestedRunDisplayName(run)}`,
		run.currentStep !== undefined ? `Progress: step ${run.currentStep + 1}/${run.chainStepCount ?? run.steps?.length ?? 1}` : undefined,
		run.turnBudget ? `Turn budget: ${run.turnBudget.turnCount}/${run.turnBudget.maxTurns}+${run.turnBudget.graceTurns} (${run.turnBudget.outcome})` : undefined,
		run.asyncDir ? `Dir: ${run.asyncDir}` : undefined,
		run.sessionFile ? `Session: ${run.sessionFile}` : undefined,
		run.error ? `Error: ${run.error}` : undefined,
	].filter((line): line is string => Boolean(line));
	if (run.path.length) {
		lines.push(`Path: ${run.path.map((part) => `${part.runId}${part.stepIndex !== undefined ? `:${part.stepIndex + 1}` : ""}${part.agent ? `:${part.agent}` : ""}`).join(" > ")} > ${run.id}`);
	}
	if (run.steps?.length) {
		lines.push("Steps:");
		for (const [index, step] of run.steps.entries()) {
			const activity = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
			const budget = step.turnBudget ? `, turn budget: ${step.turnBudget.turnCount}/${step.turnBudget.maxTurns}+${step.turnBudget.graceTurns} (${step.turnBudget.outcome})` : "";
			lines.push(`  ${index + 1}. ${step.agent} ${step.status}${activity ? `, ${activity}` : ""}${budget}${step.error ? `, error: ${step.error}` : ""}`);
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true }));
		}
	}
	lines.push(...formatNestedRunStatusLines(run.children, { indent: "  ", commandHints: true }));
	lines.push("Commands:", `  Status: subagent({ action: "status", id: "${run.id}" })`, `  Interrupt: subagent({ action: "interrupt", id: "${run.id}" })`, `  Resume: subagent({ action: "resume", id: "${run.id}", message: "..." })`, `  Steer: subagent({ action: "steer", id: "${run.id}", message: "..." })`, `  Root status: subagent({ action: "status", id: "${rootRunId}" })`);
	return lines.join("\n");
}

export function inspectSubagentStatus(params: RunStatusParams, deps: RunStatusDeps = {}): AgentToolResult<Details> {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const currentSessionId = deps.state?.currentSessionId ?? undefined;
	if (params.view && params.view !== "fleet" && params.view !== "transcript") {
		return {
			content: [{ type: "text", text: `Unknown status view: ${params.view}. Valid: fleet, transcript.` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	if (params.view === "fleet") {
		return inspectSubagentFleet(params, { asyncDirRoot, resultsDir, kill: deps.kill, now: deps.now, state: deps.state, childSafe: Boolean(deps.nested) });
	}
	if (!params.id && !params.runId && !params.dir) {
		if (deps.nested) {
			return {
				content: [{ type: "text", text: "Child-safe subagent status requires an id when no foreground run is active." }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		try {
			const runs = listAsyncRuns(asyncDirRoot, { states: ["queued", "running"], sessionId: currentSessionId, resultsDir, kill: deps.kill, now: deps.now });
			if (params.view === "transcript") {
				if (runs.length === 1) return inspectSubagentStatus({ ...params, id: runs[0]!.id }, deps);
				return {
					content: [{ type: "text", text: runs.length === 0 ? "No active async run transcript is available." : `Transcript view requires an id when ${runs.length} active async runs exist. Use subagent({ action: "status", view: "fleet" }) to choose one.` }],
					isError: true,
					details: { mode: "single", results: [] },
				};
			}
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
		const requestedId = params.id ?? params.runId;
		if (!params.dir && requestedId) {
			const resolved = resolveSubagentRunId(requestedId, { asyncDirRoot, resultsDir, state: deps.state, nested: deps.nested });
			if (resolved?.kind === "foreground") {
				const run = deps.state?.foregroundRuns?.get(resolved.id);
				if (run) {
					try {
						return {
							content: [{ type: "text", text: params.view === "transcript" ? formatRememberedForegroundTranscript(run, { index: params.index, lines: params.lines }) : formatRememberedForegroundStatus(run) }],
							details: { mode: "single", results: [] },
						};
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
					}
				}
			}
			if (resolved?.kind === "nested") {
				reconcileNestedAsyncDescendants(resolved.match.route, { resultsDir, kill: deps.kill, now: deps.now });
				const refreshed = resolveSubagentRunId(requestedId, { asyncDirRoot, resultsDir, state: deps.state, nested: deps.nested });
				const nested = refreshed?.kind === "nested" ? refreshed : resolved;
				if (params.view === "transcript") {
					try {
						return { content: [{ type: "text", text: formatNestedRunTranscript(nested.match.run, { index: params.index, lines: params.lines, sessionRoots: deps.sessionRoots }) }], details: { mode: "single", results: [] } };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
					}
				}
				return { content: [{ type: "text", text: formatNestedExactStatus(nested.match.rootRunId, nested.match.run) }], details: { mode: "single", results: [] } };
			}
			if (resolved?.kind === "async") location = resolved.location;
			else location = { asyncDir: null, resultPath: null, resolvedId: requestedId };
		} else {
			location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
		}
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
			if (params.view === "transcript") {
				if (currentSessionId && status.sessionId !== currentSessionId) {
					return {
						content: [{ type: "text", text: "Transcript view is only available for async runs owned by the current session." }],
						isError: true,
						details: { mode: "single", results: [] },
					};
				}
				try {
					return { content: [{ type: "text", text: formatAsyncRunTranscript(status, asyncDir, { index: params.index, lines: params.lines, sessionRoots: deps.sessionRoots }) }], details: { mode: "single", results: [] } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
				}
			}
			let nestedChildren: NestedRunSummary[] = [];
			let nestedWarning: string | undefined;
			try {
				const nestedRoute = findNestedRouteForRootId(status.runId);
				if (nestedRoute) reconcileNestedAsyncDescendants(nestedRoute, { resultsDir, kill: deps.kill, now: deps.now });
				nestedChildren = projectNestedRegistryForRoot(status.runId)?.children ?? [];
				attachRootChildrenToSteps(status.runId, status.steps, nestedChildren);
			} catch (error) {
				nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}
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
			const steeringText = formatSteeringSummary(status);

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				status.error ? `Error: ${status.error}` : undefined,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				steeringText ? `Steering: ${steeringText}` : undefined,
				`Mode: ${status.mode}`,
				`Progress: ${progressLabel}`,
				status.pendingAppends ? `Pending appends: ${status.pendingAppends}` : undefined,
				`Started: ${started}`,
				`Updated: ${updated}`,
				status.turnBudget ? `Turn budget: ${status.turnBudget.turnCount}/${status.turnBudget.maxTurns}+${status.turnBudget.graceTurns} (${status.turnBudget.outcome})` : undefined,
				`Dir: ${asyncDir}`,
				outputPath ? `Output: ${outputPath}` : undefined,
				reconciliation.message ? `Diagnosis: ${reconciliation.message}` : undefined,
				reconciliation.resultPath && fs.existsSync(reconciliation.resultPath) ? `Result: ${reconciliation.resultPath}` : undefined,
			].filter((line): line is string => Boolean(line));
			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText = step.status === "running" ? formatActivityLabel(step.lastActivityAt, step.activityState) : undefined;
				const modelThinking = formatModelThinking(step.model, step.thinking);
				const modelText = modelThinking ? ` (${modelThinking})` : "";
				const steeringText = formatSteeringSummary(step);
				const steeringSuffix = steeringText ? `, steering: ${steeringText}` : "";
				const errorText = step.error ? `, error: ${step.error}` : "";
				const acceptanceText = step.acceptance?.status ? `, acceptance: ${step.acceptance.status}` : "";
				const budgetText = step.turnBudget ? `, turn budget: ${step.turnBudget.turnCount}/${step.turnBudget.maxTurns}+${step.turnBudget.graceTurns} (${step.turnBudget.outcome})` : "";
				const display = step.label ? `${step.label} (${step.agent})` : step.agent;
				const phase = step.phase ? `[${step.phase}] ` : "";
				lines.push(`${stepLineLabel(status, index)}: ${phase}${display} ${step.status}${modelText}${stepActivityText ? `, ${stepActivityText}` : ""}${steeringSuffix}${acceptanceText}${budgetText}${errorText}`);
				lines.push(...formatNestedRunStatusLines(step.children, { indent: "  ", commandHints: true, maxLines: 20 }));
				const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
				if (stepOutputPath !== outputPath && fs.existsSync(stepOutputPath)) lines.push(`  Output: ${stepOutputPath}`);
				if (step.status === "running") {
					lines.push(`  Intercom target: ${resolveSubagentIntercomTarget(status.runId, step.agent, index)} (if registered)`);
					lines.push(`  Steer: subagent({ action: "steer", id: "${status.runId}", index: ${index}, message: "..." })`);
				}
			}
			const attached = new Set((status.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []));
			const unattached = nestedChildren.filter((child) => !attached.has(child.id));
			lines.push(...formatNestedRunStatusLines(unattached, { indent: "", commandHints: true, maxLines: 20 }));
			if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			if (status.state === "running") lines.push(`Steer running child: subagent({ action: "steer", id: "${status.runId}", message: "..." })`);
			if (status.state !== "running") {
				lines.push(formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile, { stopped: status.state === "stopped" || status.stopped === true }));
			}
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [] } };
		}
	}

	if (resultPath) {
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const data = JSON.parse(raw) as { id?: string; runId?: string; agent?: string; success?: boolean; summary?: string; output?: string; exitCode?: number; state?: string; sessionFile?: string; results?: Array<{ agent?: string; output?: string; summary?: string; sessionFile?: string; state?: string; success?: boolean; exitCode?: number | null }> };
			if (params.view === "transcript") {
				try {
					return { content: [{ type: "text", text: formatAsyncResultTranscript(data, resultPath, { index: params.index, lines: params.lines }) }], details: { mode: "single", results: [] } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
				}
			}
			const status = data.state === "stopped" ? "stopped" : data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
			const runId = data.runId ?? data.id ?? resolvedId;
			const lines = [`Run: ${runId}`, `State: ${status}`, `Result: ${resultPath}`];
			const children = Array.isArray(data.results) ? data.results : data.agent ? [{ agent: data.agent, sessionFile: data.sessionFile }] : [];
			lines.push(formatResumeGuidance(runId, children, data.sessionFile, { stopped: status === "stopped" }));
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
