import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import type { ControlEvent, SubagentState } from "../shared/types.ts";

export const SUBAGENT_SUPERVISOR_MESSAGE_TYPE = "subagent_supervisor_request";

export interface ChildPresentationDetails {
	label: string;
	role: string;
	logicalStep?: number;
	totalSteps?: number;
}

export interface SupervisorRequestMessageDetails extends ChildPresentationDetails {
	id: string;
	reason: "need_decision" | "interview_request" | "progress_update";
	expectsReply: boolean;
	runId: string;
	agent: string;
	childIndex: number;
	question?: string;
	interview?: unknown;
}

export interface HumanControlMessageDetails extends ChildPresentationDetails {
	event: ControlEvent;
}

export function shortRunId(runId: string): string {
	return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function logicalPosition(details: Pick<ChildPresentationDetails, "logicalStep" | "totalSteps">): string | undefined {
	if (details.logicalStep === undefined) return undefined;
	return details.totalSteps !== undefined
		? `Step ${details.logicalStep}/${details.totalSteps}`
		: `Step ${details.logicalStep}`;
}

export function resolveChildPresentation(
	state: Pick<SubagentState, "asyncJobs" | "foregroundRuns">,
	runId: string,
	agent: string,
	childIndex: number | undefined,
): ChildPresentationDetails {
	const fallback: ChildPresentationDetails = {
		label: agent,
		role: agent,
		...(childIndex !== undefined ? { logicalStep: childIndex + 1 } : {}),
	};
	if (childIndex === undefined) return fallback;

	const asyncJob = state.asyncJobs.get(runId);
	if (asyncJob) {
		const step = asyncJob.steps?.find((candidate) => candidate.index === childIndex) ?? asyncJob.steps?.[childIndex];
		const totalSteps = asyncJob.chainStepCount ?? asyncJob.stepsTotal ?? asyncJob.steps?.length;
		const logicalIndex = asyncJob.mode === "chain" && asyncJob.chainStepCount !== undefined
			? flatToLogicalStepIndex(childIndex, asyncJob.chainStepCount, asyncJob.parallelGroups ?? [])
			: childIndex;
		return {
			label: step?.label ?? step?.agent ?? agent,
			role: step?.agent ?? agent,
			logicalStep: logicalIndex + 1,
			...(totalSteps !== undefined ? { totalSteps } : {}),
		};
	}

	const foreground = state.foregroundRuns?.get(runId);
	if (foreground) {
		const child = foreground.children.find((candidate) => candidate.index === childIndex) ?? foreground.children[childIndex];
		return {
			label: child?.agent ?? agent,
			role: child?.agent ?? agent,
			logicalStep: childIndex + 1,
			totalSteps: foreground.children.length,
		};
	}
	return fallback;
}

function durationLabel(durationMs: number): string {
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

function roleLabel(details: ChildPresentationDetails): string {
	return details.label === details.role ? details.label : `${details.label} [${details.role}]`;
}

function expandHint(expandKey: string): string {
	return `${expandKey} for details`;
}

export function formatHumanControlNotice(
	details: HumanControlMessageDetails,
	expanded: boolean,
	expandKey: string,
): string {
	const { event } = details;
	const position = logicalPosition(details);
	const run = `run ${shortRunId(event.runId)}`;
	const subject = roleLabel(details);
	const elapsed = event.elapsedMs !== undefined ? durationLabel(event.elapsedMs) : undefined;
	const heading = event.reason === "completion_guard"
		? `✗ ${subject} failed`
		: event.type === "active_long_running"
			? `⚠ ${subject} is still working`
			: `⚠ ${subject} may be stuck${elapsed ? ` · no activity for ${elapsed}` : ""}`;
	const location = [position, run].filter(Boolean).join(" · ");
	if (!expanded) return `${heading}\n${location} · ${expandHint(expandKey)}`;

	const lines = [heading, `${details.label} [${details.role}] · ${location}`];
	if (event.message.trim()) lines.push(`Observed: ${event.message.trim()}`);
	if (event.currentTool) {
		const toolDuration = event.currentToolDurationMs !== undefined ? ` for ${durationLabel(event.currentToolDurationMs)}` : "";
		lines.push(`Current activity: ${event.currentTool}${toolDuration}`);
	}
	if (event.currentPath) lines.push(`Working in: ${event.currentPath}`);
	if (event.recentFailureSummary) lines.push(`Recent failures: ${event.recentFailureSummary}`);
	const facts = [
		event.turns !== undefined ? `${event.turns} turns` : undefined,
		event.tokens !== undefined ? `${event.tokens} tokens` : undefined,
		event.toolCount !== undefined ? `${event.toolCount} tools` : undefined,
	].filter((value): value is string => Boolean(value));
	if (facts.length > 0) lines.push(`Diagnostics: ${facts.join(" · ")}`);
	if (event.reason !== "completion_guard") lines.push("Recommendation: inspect current status before nudging or interrupting the child.");
	return lines.join("\n");
}

function compactSummary(value: string | undefined): string | undefined {
	const firstLine = value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	if (!firstLine) return undefined;
	if (/\b(?:subagent|intercom)\s*\(|\{\s*"?(?:action|replyTo)"?\s*:/i.test(firstLine)) return undefined;
	const sanitized = firstLine
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8))
		.replace(/\b[A-Za-z]:\\[^\s]+|(?:^|\s)\/(?:[^\s/]+\/)*[^\s]+/g, " [path hidden]")
		.replace(/\b(?:child\s+)?intercom\s+target\b[^·|]*/gi, "coordination details hidden")
		.trim();
	return sanitized.length > 100 ? `${sanitized.slice(0, 99)}…` : sanitized;
}

function humanizeKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function formatStructuredValue(value: unknown, indent = ""): string[] {
	if (value === null || value === undefined) return [];
	if (typeof value !== "object") return [`${indent}${String(value)}`];
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			const lines = formatStructuredValue(entry, `${indent}  `);
			if (lines.length === 0) return [];
			return [`${indent}- ${lines[0]!.trimStart()}`, ...lines.slice(1)];
		});
	}
	return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
		if (entry === null || entry === undefined) return [];
		if (typeof entry !== "object") return [`${indent}${humanizeKey(key)}: ${String(entry)}`];
		return [`${indent}${humanizeKey(key)}:`, ...formatStructuredValue(entry, `${indent}  `)];
	});
}

export function formatHumanSupervisorRequest(
	details: SupervisorRequestMessageDetails,
	expanded: boolean,
	expandKey: string,
): string {
	const position = logicalPosition(details);
	const run = `run ${shortRunId(details.runId)}`;
	const subject = roleLabel(details);
	const heading = details.reason === "progress_update"
		? `↗ ${subject} · progress update`
		: details.reason === "interview_request"
			? `⚠ Supervisor interview needed · ${subject}`
			: `⚠ Supervisor decision needed · ${subject}`;
	const summary = compactSummary(details.question)
		?? (details.reason === "interview_request" ? "Structured input requested" : undefined);
	const location = [position, run].filter(Boolean).join(" · ");
	if (!expanded) {
		const secondLine = [summary, location, expandHint(expandKey)].filter(Boolean).join(" · ");
		return secondLine ? `${heading}\n${secondLine}` : heading;
	}

	const lines = [
		heading,
		`${details.label} [${details.role}] · ${location} · ${details.expectsReply ? "Reply required" : "No reply required"}`,
	];
	if (details.question?.trim()) lines.push("", details.question.trim());
	const interviewLines = formatStructuredValue(details.interview);
	if (interviewLines.length > 0) lines.push("", "Structured interview:", ...interviewLines);
	return lines.join("\n");
}
