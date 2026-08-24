import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { safeTerminalText } from "../../shared/display-text.ts";
import { formatAsyncRunList, formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns } from "./async-status.ts";
import { formatAsyncResultTranscript, formatAsyncRunTranscript, formatNestedRunTranscript, inspectSubagentFleet } from "./fleet-view.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatModelThinking } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import { DIRS, type AsyncStatus, type Details, type ForegroundResumeRun, type NestedRunSummary, type SteeringStatus, type SubagentState } from "../../shared/types.ts";
import { inspectActiveAsyncCapacityOwner, type ActiveAsyncCapacityInspection } from "./active-async-capacity.ts";
import { readStatus } from "../../shared/utils.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { normalizeExternalCliRunnerStatus } from "../shared/external-cli-contract.ts";
import { resolveSubagentResultStatus } from "../../intercom/result-intercom.ts";
import { readProcessTerminal, sanitizeProcessTerminal } from "./process-terminal.ts";
import { formatWaitSubscriptions } from "./wait-subscriptions.ts";
import { resolveAsyncRunLocation } from "./async-resume.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import { flatToLogicalStepIndex, normalizeParallelGroups } from "./parallel-groups.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";
import { attachRootChildrenToSteps, findNestedRouteForRootId, projectNestedRegistryForRoot, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { readMissionBinding } from "../../missions/lifecycle.ts";
import { formatWorkflowJsonPreview } from "../../workflows/scripted-workflow.ts";
import { formatRunFanoutBudget, getRunFanoutBudgetSnapshot, readRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.ts";
import { getExternalJobProvider } from "../../api/external-job-provider.ts";

interface RunStatusParams {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	view?: "fleet" | "transcript";
	lines?: number;
}

function formatProcessTerminal(value: AsyncStatus["processTerminal"] | undefined): string {
	if (!value) return "missing";
	return `${value.state}${value.reason ? ` (${value.reason})` : ""}${value.runnerProcessInstanceId ? ` · runner ${value.runnerProcessInstanceId}` : ""}`;
}

function debugProcessTerminal(asyncDir: string, status: AsyncStatus): { sidecar?: AsyncStatus["processTerminal"]; overlay?: AsyncStatus["processTerminal"] } {
	const expected = { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId };
	return {
		sidecar: readProcessTerminal(asyncDir, expected),
		overlay: sanitizeProcessTerminal(status.processTerminal, expected, path.join(asyncDir, "status.json")),
	};
}

function formatCapacityOwner(inspect: ActiveAsyncCapacityInspection): string[] {
	if (!inspect.owner) return [`Active capacity: ${inspect.release.state} — ${inspect.release.reason}`];
	const owner = inspect.owner;
	return [
		`Active capacity: ${inspect.release.state} — ${inspect.release.reason}`,
		`Capacity owner: ${inspect.relation} slot ${owner.slot}, ${owner.kind}, generation ${owner.generation}`,
		`Capacity session: ${owner.ownerSessionId}`,
		owner.sourceRunId ? `Capacity source run: ${owner.sourceRunId}` : undefined,
		`Capacity async dir: ${owner.asyncDir}`,
		owner.runnerProcessInstanceId ? `Capacity runner: ${owner.runnerProcessInstanceId}` : undefined,
		owner.runnerStartedAt !== undefined ? `Capacity runner started: ${new Date(owner.runnerStartedAt).toISOString()}` : undefined,
	].filter((line): line is string => line !== undefined);
}

function formatWorkflowDebug(status: AsyncStatus): string[] {
	if (status.mode !== "workflow" && !status.parentWorkflowRunId && !status.workflowKey) return [];
	const lines = [
		status.parentWorkflowRunId ? `Workflow parent: ${status.parentWorkflowRunId}${status.workflowKey ? ` (${status.workflowKey})` : ""}` : undefined,
		status.mode === "workflow" ? `Workflow children: ${(status.steps ?? []).length}` : undefined,
	].filter((line): line is string => line !== undefined);
	for (const [index, step] of (status.steps ?? []).entries()) {
		lines.push(`  ${index + 1}. key ${step.workflowKey ?? "n/a"} · ${step.agent} · ${step.status} · async ${step.async === undefined ? "unknown" : step.async ? "yes" : "no"}${step.runId ? ` · run ${step.runId}` : ""}`);
	}
	return lines;
}

function formatRunLifecycleDebug(input: { status: AsyncStatus; asyncDir: string; sidecarProcessTerminal: AsyncStatus["processTerminal"] | undefined; overlayProcessTerminal: AsyncStatus["processTerminal"] | undefined; capacity: ActiveAsyncCapacityInspection }): string {
	const { status, asyncDir, sidecarProcessTerminal, overlayProcessTerminal, capacity } = input;
	const lines = [
		"Run lifecycle debug",
		`Run: ${status.runId}`,
		`Dir: ${asyncDir}`,
		`Status file: ${path.join(asyncDir, "status.json")}`,
		`Process terminal file: ${path.join(asyncDir, "process-terminal.json")}`,
		`Session: ${status.sessionId ?? "unknown"}`,
		`State: ${status.state}`,
		`Mode: ${status.mode}`,
		status.parentWorkflowRunId ? `Workflow parent: ${status.parentWorkflowRunId}` : undefined,
		status.workflowKey ? `Workflow key: ${status.workflowKey}` : undefined,
		`Status process terminal: ${formatProcessTerminal(overlayProcessTerminal)}`,
		`Sidecar process terminal: ${formatProcessTerminal(sidecarProcessTerminal)}`,
		...formatCapacityOwner(capacity),
		...formatWorkflowDebug(status),
	].filter((line): line is string => line !== undefined);
	return lines.join("\n");
}

interface RunStatusDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	state?: SubagentState;
	nested?: NestedRunResolutionScope;
	sessionRoots?: string[];
	activeCapacityRoot?: string;
}

function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown; runId?: unknown; workflowKey?: unknown; status?: unknown; activityState?: unknown }>, fallbackSessionFile?: unknown, options: { stopped?: boolean } = {}): string {
	if (options.stopped) return "Resume: unavailable; stopped runs are not resumable. Start a new run instead.";
	const knownChildren = children
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => typeof child.agent === "string");
	if (!runId || knownChildren.length === 0) return "Resume: unavailable; no child session file was persisted.";
	const workflowChildren = knownChildren.filter(({ child }) => typeof child.runId === "string" && child.runId.trim() && hasExistingSessionFile(child.sessionFile));
	const supervisorDetachedWorkflowChildren = workflowChildren.filter(({ child }) => child.status === "paused" && child.activityState === "needs_attention");
	const resumableWorkflowChildren = workflowChildren.filter(({ child }) => !(child.status === "paused" && child.activityState === "needs_attention"));
	if (workflowChildren.length > 0) {
		return [
			...supervisorDetachedWorkflowChildren.map(({ child }) => `Recovery workflow child${typeof child.workflowKey === "string" && child.workflowKey.trim() ? ` '${child.workflowKey}'` : ""}: reply to the supervisor request first, then wait with subagent_wait({ id: "${child.runId}" }). Use subagent({ action: "status", id: "${child.runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.`),
			...resumableWorkflowChildren.map(({ child }) => `Revive workflow child${typeof child.workflowKey === "string" && child.workflowKey.trim() ? ` '${child.workflowKey}'` : ""}: subagent({ action: "resume", id: "${child.runId}", message: "..." })`),
		].join("\n");
	}
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
	if (status.mode === "workflow") return `Workflow child ${steps[index]?.workflowKey ?? index + 1}`;
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

function externalJobFollowUpSupported(provider: string): boolean {
	try {
		return typeof getExternalJobProvider(provider)?.followUp === "function";
	} catch {
		return false;
	}
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
	return lines.map((line) => safeTerminalText(line)).join("\n");
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
	const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
	const resultsDir = deps.resultsDir ?? DIRS.results;
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
			const waitSubscriptions = deps.state ? formatWaitSubscriptions(deps.state, deps.now?.() ?? Date.now()) : undefined;
			return {
				content: [{ type: "text", text: [formatAsyncRunList(runs), waitSubscriptions].filter(Boolean).join("\n\n") }],
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
		if (params.action === "debug.run") {
			location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
		} else if (!params.dir && requestedId) {
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
		const diskStatus = readStatus(asyncDir);
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
		if (!status && diskStatus?.displayDismissedAt !== undefined) {
			if (params.action === "debug.run") {
				const { sidecar, overlay } = debugProcessTerminal(asyncDir, diskStatus);
				const capacity = inspectActiveAsyncCapacityOwner({ runId: diskStatus.runId, sessionId: diskStatus.sessionId, asyncDir }, { rootDir: deps.activeCapacityRoot, liveWorkflowRunIds: new Set(deps.state?.workflowControllers?.keys() ?? []) });
				return {
					content: [{ type: "text", text: formatRunLifecycleDebug({ status: diskStatus, asyncDir, sidecarProcessTerminal: sidecar, overlayProcessTerminal: overlay, capacity }) }],
					details: { mode: "single", results: [], ...((sidecar ?? overlay) ? { lifecycleStatus: { processTerminal: sidecar ?? overlay } } : {}) },
				};
			}
			if (params.view === "transcript") {
				if (currentSessionId && diskStatus.sessionId !== currentSessionId) {
					return {
						content: [{ type: "text", text: "Transcript view is only available for async runs owned by the current session." }],
						isError: true,
						details: { mode: "single", results: [] },
					};
				}
				return { content: [{ type: "text", text: formatAsyncRunTranscript(diskStatus, asyncDir, { index: params.index, lines: params.lines, sessionRoots: deps.sessionRoots }) }], details: { mode: "single", results: [] } };
			}
			return {
				content: [{ type: "text", text: `Run: ${diskStatus.runId}\nState: display-dismissed\nDismissed: ${new Date(diskStatus.displayDismissedAt).toISOString()}\nNo running work was terminated.` }],
				details: { mode: "single", results: [] },
			};
		}
		const effectiveRunId = status?.runId ?? resolvedId ?? "unknown";
		const logPath = path.join(asyncDir, `subagent-log-${effectiveRunId}.md`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		if (status) {
			if (params.action === "debug.run") {
				const { sidecar, overlay } = debugProcessTerminal(asyncDir, status);
				const capacity = inspectActiveAsyncCapacityOwner({ runId: status.runId, sessionId: status.sessionId, asyncDir }, { rootDir: deps.activeCapacityRoot, liveWorkflowRunIds: new Set(deps.state?.workflowControllers?.keys() ?? []) });
				return {
					content: [{ type: "text", text: formatRunLifecycleDebug({ status, asyncDir, sidecarProcessTerminal: sidecar, overlayProcessTerminal: overlay, capacity }) }],
					details: { mode: "single", results: [], ...((sidecar ?? overlay) ? { lifecycleStatus: { processTerminal: sidecar ?? overlay } } : {}) },
				};
			}
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
			const processTerminal = readProcessTerminal(asyncDir, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId })
				?? sanitizeProcessTerminal(status.processTerminal, { runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId }, path.join(asyncDir, "status.json"));
			const runFanoutBudgetDescriptor = readRunFanoutBudgetDescriptor(asyncDir);
			const runFanoutBudget = runFanoutBudgetDescriptor ? getRunFanoutBudgetSnapshot(runFanoutBudgetDescriptor) : status.runFanoutBudget;
			let missionId: string | undefined;
			try {
				missionId = readMissionBinding(asyncDir)?.missionId;
			} catch (error) {
				nestedWarning = `${nestedWarning ? `${nestedWarning}; ` : ""}Mission binding unavailable: ${error instanceof Error ? error.message : String(error)}`;
			}

			const workflowReturnPreview = status.workflow?.value !== undefined ? formatWorkflowJsonPreview(status.workflow.value, 240) : undefined;
			const workflowEmitPreview = status.workflow?.emits.length ? formatWorkflowJsonPreview(status.workflow.emits.at(-1), 240) : undefined;
			const lines = [
				`Run: ${status.runId}`,
				status.toolCallId ? `Tool call: ${status.toolCallId}` : undefined,
				missionId ? `Mission: ${missionId}` : undefined,
				`State: ${status.state}`,
				processTerminal ? `Process terminal: ${processTerminal.state}${processTerminal.reason ? ` (${processTerminal.reason})` : ""}` : undefined,
				status.capabilityCeiling ? `Capability ceiling: ${status.capabilityCeiling.allowedTools === undefined ? "names unrestricted" : status.capabilityCeiling.allowedTools.length === 0 ? "none" : status.capabilityCeiling.allowedTools.join(", ")}\nExtensions denied: ${status.capabilityCeiling.denyExtensions ? "yes" : "no"} (sources: ${status.capabilityCeiling.sources.join(", ")})` : undefined,
				status.capabilityAudit ? `Capability audit: ${status.capabilityAudit.removedTools.length} tools removed, ${status.capabilityAudit.removedExtensionCount} extension entries removed` : undefined,
				status.error ? `Error: ${status.error}` : undefined,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				steeringText ? `Steering: ${steeringText}` : undefined,
				`Mode: ${status.mode}`,
				runFanoutBudget ? formatRunFanoutBudget(runFanoutBudget) : undefined,
				status.parentWorkflowRunId ? `Workflow parent: ${status.parentWorkflowRunId}${status.workflowKey ? ` (${status.workflowKey})` : ""}` : undefined,
				status.mode === "workflow" && workflowReturnPreview !== undefined ? `Return: ${workflowReturnPreview}` : undefined,
				status.mode === "workflow" && workflowEmitPreview !== undefined ? `Latest emit: ${workflowEmitPreview}` : undefined,
				`Progress: ${progressLabel}`,
				status.pendingAppends ? `Pending appends: ${status.pendingAppends}` : undefined,
				`Started: ${started}`,
				`Updated: ${updated}`,
				status.turnBudget ? `Turn budget: ${status.turnBudget.turnCount}/${status.turnBudget.maxTurns}+${status.turnBudget.graceTurns} (${status.turnBudget.outcome})` : undefined,
				`Dir: ${asyncDir}`,
				outputPath ? `Output: ${outputPath}` : undefined,
				status.parallelHandoff ? `Parallel handoff: ${status.parallelHandoff.path}` : undefined,
				reconciliation.message ? `Diagnosis: ${reconciliation.message}` : undefined,
				reconciliation.resultPath && fs.existsSync(reconciliation.resultPath) ? `Result: ${reconciliation.resultPath}` : undefined,
			].filter((line): line is string => Boolean(line));
			const liveWorkflowControls = status.mode === "workflow" && deps.state?.currentSessionId === status.sessionId && deps.state?.workflowControllers?.has(status.runId)
				? [...(deps.state?.foregroundControls.values() ?? [])].filter((control) => control.parentWorkflowRunId === status.runId
					&& control.sessionId === status.sessionId
					&& Boolean(control.workflowSteeringDir && fs.existsSync(control.workflowSteeringDir))
					&& (control.activeChildren?.size ?? 0) > 0)
				: [];
			let hasExternalJobFollowUpHint = false;
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
				if (step.runner?.type === "external-cli") {
					const runner = normalizeExternalCliRunnerStatus(step.runner);
					if (runner) {
						lines.push(`  Runner: external-cli (${runner.command}${runner.args.length ? ` ${runner.args.join(" ")}` : ""})`);
						lines.push(`  Adapter: ${runner.adapter.id} v${runner.adapter.version} (${runner.adapter.executionMode})`);
						if (runner.safety) {
							if ("approvalPolicy" in runner.safety) lines.push(`  Safety: ${"access" in runner.safety ? `access=${runner.safety.access}, ` : ""}sandbox=${runner.safety.sandbox}, approval=${runner.safety.approvalPolicy}, ephemeral=${runner.safety.ephemeral}`);
							else if ("mode" in runner.safety) lines.push(`  Safety: access=${runner.safety.access}, auth=${runner.safety.authentication}, mode=${runner.safety.mode}, sandbox=${runner.safety.sandbox}, workspaceTrust=${runner.safety.workspaceTrust}, sessionReuse=${runner.safety.sessionReuse}`);
							else if ("authentication" in runner.safety) lines.push(`  Safety: access=${runner.safety.access}, auth=${runner.safety.authentication}, permission=${runner.safety.permissionMode}, tools=${runner.safety.tools}, mcp=${runner.safety.mcp}, settings=${runner.safety.settingSources}, settingsTrust=${runner.safety.userSettingsTrust}, persistence=${runner.safety.sessionPersistence}`);
							else lines.push(`  Safety: access=read-only, permission=${runner.safety.permissionMode}, tools=${runner.safety.tools}, mcp=${runner.safety.mcp}, settings=${runner.safety.settingSources}, persistence=${runner.safety.sessionPersistence}`);
						}
						lines.push(`  Capabilities: stop=${runner.capabilities.stop}, steer=false, resume=false, structuredOutput=false, toolEvents=false, supervisor=unsupported, forkContext=false, extensionBindings=false`);
						lines.push(`  Unsupported steer: ${runner.unsupportedReasons.steer}`);
						lines.push(`  Unsupported resume: ${runner.nonResumableReason}`);
						lines.push(`  Unsupported supervisor: ${runner.unsupportedReasons.supervisor}`);
						lines.push(`  Context handoff: fresh only (${runner.unsupportedReasons.forkContext})`);
					} else {
						lines.push("  Runner: external-cli (invalid persisted runner metadata)");
					}
					if (step.externalProcess?.pid !== undefined) lines.push(`  Process: ${step.externalProcess.pid}`);
					if (step.externalProcess) {
						lines.push(`  Stdout: ${step.externalProcess.stdoutPath}`, `  Stderr: ${step.externalProcess.stderrPath}`);
						if (step.externalProcess.finalOutputPath) lines.push(`  Final output: ${step.externalProcess.finalOutputPath}`);
					}
				} else if (step.runner?.type === "external-job") {
					lines.push(`  Runner: external-job (${step.runner.provider})`);
					if (step.externalJob?.providerJobId) lines.push(`  Provider job: ${step.externalJob.providerJobId}`);
					if (step.externalJob?.state) lines.push(`  Provider state: ${step.externalJob.state}`);
					if (step.externalJob?.conversationUrl) lines.push(`  Conversation: ${step.externalJob.conversationUrl}`);
					if (step.externalJob?.resultArtifactPath) lines.push(`  Result artifact: ${step.externalJob.resultArtifactPath}`);
					if ((step.status === "complete" || step.status === "completed") && step.externalJob?.state === "completed" && step.externalJob.providerJobId && externalJobFollowUpSupported(step.runner.provider)) {
						hasExternalJobFollowUpHint = true;
						lines.push(`  Follow-up: subagent({ action: "resume", id: "${status.runId}", index: ${index}, message: "..." })`);
					}
				}
				lines.push(...formatNestedRunStatusLines(step.children, { indent: "  ", commandHints: true, maxLines: 20 }));
				const stepOutputPath = path.join(asyncDir, `output-${index}.log`);
				if (stepOutputPath !== outputPath && fs.existsSync(stepOutputPath)) lines.push(`  Output: ${stepOutputPath}`);
				if (step.status === "running" && step.runner?.type !== "external-cli" && step.runner?.type !== "external-job" && status.mode !== "workflow") {
					lines.push(`  Intercom target: ${resolveSubagentIntercomTarget(status.runId, step.agent, index)} (if registered)`);
					lines.push(`  Steer: subagent({ action: "steer", id: "${status.runId}", index: ${index}, message: "..." })`);
				} else if (step.status === "running" && (step.runner?.type === "external-cli" || step.runner?.type === "external-job")) {
					lines.push("  Steer: unavailable; external runners do not accept live messages.");
				}
			}
			const attached = new Set((status.steps ?? []).flatMap((step) => step.children?.map((child) => child.id) ?? []));
			const unattached = nestedChildren.filter((child) => !attached.has(child.id));
			lines.push(...formatNestedRunStatusLines(unattached, { indent: "", commandHints: true, maxLines: 20 }));
			if (status.mode === "workflow" && status.state === "running") {
				if (liveWorkflowControls.length === 0) lines.push("Steer: unavailable; no live foreground route is registered in the active session.");
				else for (const control of liveWorkflowControls) {
					for (const index of [...control.activeChildren!.keys()].sort((left, right) => left - right)) {
						lines.push(`Steer live foreground child: subagent({ action: "steer", id: "${control.runId}", index: ${index}, message: "..." })`);
					}
				}
			}
			if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			const allExternal = (status.steps?.length ?? 0) > 0 && status.steps!.every((step) => step.runner?.type === "external-cli" || step.runner?.type === "external-job");
			if (status.state === "running" && !allExternal && status.mode !== "workflow") lines.push(`Steer running child: subagent({ action: "steer", id: "${status.runId}", message: "..." })`);
			if (status.state !== "running") {
				lines.push(allExternal
					? hasExternalJobFollowUpHint ? "Resume: use the external-job follow-up hint above." : "Resume: unavailable; external runners do not persist Pi sessions."
					: formatResumeGuidance(status.runId, status.steps ?? [], status.sessionFile, { stopped: status.state === "stopped" || status.stopped === true }));
			}
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "single", results: [], ...(runFanoutBudget ? { runFanoutBudget } : {}), ...(processTerminal ? { lifecycleStatus: { processTerminal } } : {}) } };
		}
	}

	if (resultPath) {
		if (params.action === "debug.run") {
			return {
				content: [{ type: "text", text: "Run lifecycle debug needs an async run directory with status.json." }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const data = JSON.parse(raw) as { id?: string; runId?: string; toolCallId?: string; agent?: string; success?: boolean; summary?: string; output?: string; exitCode?: number; state?: string; stopped?: boolean; timedOut?: boolean; turnBudgetExceeded?: boolean; processSignal?: string | null; sessionFile?: string; parallelHandoff?: { path?: string }; results?: Array<{ agent?: string; runId?: string; workflowKey?: string; output?: string; summary?: string; sessionFile?: string; state?: string; success?: boolean; exitCode?: number | null; stopped?: boolean; timedOut?: boolean; turnBudgetExceeded?: boolean; interrupted?: boolean; processSignal?: string | null }> };
			if (params.view === "transcript") {
				try {
					return { content: [{ type: "text", text: formatAsyncResultTranscript(data, resultPath, { index: params.index, lines: params.lines }) }], details: { mode: "single", results: [] } };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } };
				}
			}
			const childStatuses = Array.isArray(data.results)
				? data.results.map((child) => resolveSubagentResultStatus({
					success: child.success,
					state: child.state,
					interrupted: child.interrupted,
					timedOut: child.timedOut,
					stopped: child.stopped,
					turnBudgetExceeded: child.turnBudgetExceeded,
					processSignal: child.processSignal,
					exitCode: typeof child.exitCode === "number" ? child.exitCode : undefined,
				}))
				: [];
			const status = data.state === "stopped" || data.stopped === true || childStatuses.includes("stopped")
				? "stopped"
				: data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
			const runId = data.runId ?? data.id ?? resolvedId;
			const lines = [`Run: ${runId}`, data.toolCallId ? `Tool call: ${data.toolCallId}` : undefined, `State: ${status}`, `Result: ${resultPath}`].filter((line): line is string => Boolean(line));
			if (data.parallelHandoff?.path) lines.push(`Parallel handoff: ${data.parallelHandoff.path}`);
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
