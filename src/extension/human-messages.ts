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
	legacyContent?: string,
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

	const legacy = extractLegacyControlContent(legacyContent);
	const lines = [heading, `${details.label} [${details.role}] · ${location}`];
	const observed = substantiveText(event.message) ?? legacy.observed;
	if (observed) lines.push(`Observed: ${observed}`);
	if (event.currentTool) {
		const toolDuration = event.currentToolDurationMs !== undefined ? ` for ${durationLabel(event.currentToolDurationMs)}` : "";
		lines.push(`Current activity: ${event.currentTool}${toolDuration}`);
	}
	if (event.currentPath) lines.push(`Working in: ${event.currentPath}`);
	const recentFailures = substantiveText(event.recentFailureSummary) ?? legacy.recentFailures;
	if (recentFailures) lines.push(`Recent failures: ${recentFailures}`);
	const facts = [
		event.turns !== undefined ? `${event.turns} turns` : undefined,
		event.tokens !== undefined ? `${event.tokens} tokens` : undefined,
		event.toolCount !== undefined ? `${event.toolCount} tools` : undefined,
	].filter((value): value is string => Boolean(value));
	if (facts.length > 0) lines.push(`Diagnostics: ${facts.join(" · ")}`);
	else if (legacy.diagnostics) lines.push(`Diagnostics: ${legacy.diagnostics}`);
	const recommendation = legacy.recommendation
		?? (event.reason !== "completion_guard" ? "inspect current status before nudging or interrupting the child." : undefined);
	if (recommendation) lines.push(`Recommendation: ${recommendation}`);
	return lines.join("\n");
}

function hasInternalCommand(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasInternalCommand);
	const record = value as Record<string, unknown>;
	if ("replyTo" in record || ("action" in record && typeof record.action === "string")) return true;
	return Object.values(record).some(hasInternalCommand);
}

function isInternalLine(line: string): boolean {
	return /\b(?:subagent(?:_supervisor)?|intercom)\s*\(\s*\{/i.test(line)
		|| /"(?:action|replyTo)"\s*:/i.test(line)
		|| /^\s*(?:Reply with|Nudge|Status|Interrupt):/i.test(line)
		|| /^\s*(?:Child|Direct|Run) intercom target\s*:/i.test(line);
}

function withoutInternalJsonBlocks(lines: string[]): string[] {
	const safe: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!/^[{[]/.test(lines[index]!.trim())) {
			safe.push(lines[index]!);
			continue;
		}
		for (let end = index; end < lines.length; end += 1) {
			try {
				const parsed = JSON.parse(lines.slice(index, end + 1).join("\n"));
				if (hasInternalCommand(parsed)) {
					index = end;
					break;
				}
				safe.push(...lines.slice(index, end + 1));
				index = end;
				break;
			} catch {
				if (end === lines.length - 1) safe.push(lines[index]!);
			}
		}
	}
	return safe;
}

function substantiveText(value: string | undefined): string | undefined {
	const lines = withoutInternalJsonBlocks(value?.split(/\r?\n/) ?? [])
		.filter((line) => !isInternalLine(line))
		.filter((line) => !/^\s*[{}[\],]+\s*$/.test(line))
		.map((line) => line.trimEnd());
	const text = lines?.join("\n").trim();
	return text || undefined;
}

function compactSummary(value: string | undefined): string | undefined {
	const firstLine = substantiveText(value)?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
	if (!firstLine) return undefined;
	const sanitized = firstLine
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (id) => id.slice(0, 8))
		.replace(/\b[A-Za-z]:\\[^\s]+|(?:^|\s)\/(?:[^\s/]+\/)*[^\s]+/g, " [path hidden]")
		.replace(/\b(?:child\s+)?intercom\s+target\b[^·|]*/gi, "coordination details hidden")
		.trim();
	return sanitized.length > 100 ? `${sanitized.slice(0, 99)}…` : sanitized;
}

interface LegacySupervisorContent {
	question?: string;
	interview?: unknown;
}

function extractLegacySupervisorContent(content: string | undefined): LegacySupervisorContent {
	if (!content?.trim()) return {};
	const lines = content.split(/\r?\n/);
	const structuredIndex = lines.findIndex((line) => /^Structured response requested\./i.test(line.trim()));
	const replyIndex = lines.findIndex((line) => /^Reply with:/i.test(line.trim()));
	const questionEnd = structuredIndex >= 0 ? structuredIndex : replyIndex >= 0 ? replyIndex : lines.length;
	const question = substantiveText(lines.slice(0, questionEnd)
		.filter((line) => !/^Subagent (?:requests|progress update|needs)/i.test(line.trim()))
		.filter((line) => !/^(?:Run|Agent|Child index|Child intercom target):/i.test(line.trim()))
		.join("\n"));

	let interview: unknown;
	if (structuredIndex >= 0) {
		const serialized = lines.slice(structuredIndex + 1, replyIndex >= 0 ? replyIndex : lines.length).join("\n").trim();
		if (serialized) {
			try {
				interview = JSON.parse(serialized);
			} catch {
				// Legacy content is untrusted display data. Never fall back to showing raw JSON.
			}
		}
	}
	return { ...(question ? { question } : {}), ...(interview !== undefined ? { interview } : {}) };
}

interface LegacyControlContent {
	observed?: string;
	recentFailures?: string;
	diagnostics?: string;
	recommendation?: string;
}

function extractLegacyControlContent(content: string | undefined): LegacyControlContent {
	if (!content?.trim()) return {};
	const result: LegacyControlContent = {};
	for (const line of content.split(/\r?\n/)) {
		if (isInternalLine(line)) continue;
		const match = line.match(/^\s*(Signal|Recent failures|Facts|Hint|Next):\s*(.+?)\s*$/i);
		if (!match) continue;
		const value = substantiveText(match[2]);
		if (!value) continue;
		switch (match[1]?.toLowerCase()) {
			case "signal": result.observed = value; break;
			case "recent failures": result.recentFailures = value; break;
			case "facts": result.diagnostics = value; break;
			case "hint":
			case "next": result.recommendation = value; break;
		}
	}
	return result;
}

function humanizeKey(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function formatStructuredValue(value: unknown, indent = ""): string[] {
	if (value === null || value === undefined) return [];
	if (typeof value !== "object") {
		const text = substantiveText(String(value));
		return text ? [`${indent}${text}`] : [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			const lines = formatStructuredValue(entry, `${indent}  `);
			if (lines.length === 0) return [];
			return [`${indent}- ${lines[0]!.trimStart()}`, ...lines.slice(1)];
		});
	}
	const record = value as Record<string, unknown>;
	return Object.entries(record).flatMap(([key, entry]) => {
		if (entry === null || entry === undefined || key === "childTarget") return [];
		if (typeof entry !== "object") {
			const text = substantiveText(String(entry));
			return text ? [`${indent}${humanizeKey(key)}: ${text}`] : [];
		}
		const lines = formatStructuredValue(entry, `${indent}  `);
		return lines.length > 0 ? [`${indent}${humanizeKey(key)}:`, ...lines] : [];
	});
}

export function formatHumanSupervisorRequest(
	details: SupervisorRequestMessageDetails,
	expanded: boolean,
	expandKey: string,
	legacyContent?: string,
): string {
	const position = logicalPosition(details);
	const run = `run ${shortRunId(details.runId)}`;
	const subject = roleLabel(details);
	const heading = details.reason === "progress_update"
		? `↗ ${subject} · progress update`
		: details.reason === "interview_request"
			? `⚠ Supervisor interview needed · ${subject}`
			: `⚠ Supervisor decision needed · ${subject}`;
	const legacy = extractLegacySupervisorContent(legacyContent);
	const question = substantiveText(details.question) ?? legacy.question;
	const interview = details.interview ?? legacy.interview;
	const summary = compactSummary(question)
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
	if (question) lines.push("", question);
	const interviewLines = formatStructuredValue(interview);
	if (interviewLines.length > 0) lines.push("", "Structured interview:", ...interviewLines);
	return lines.join("\n");
}
