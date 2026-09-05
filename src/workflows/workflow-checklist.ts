import type { AsyncJobStep, HostStepNode, WorkflowGraphNode, WorkflowGraphSnapshot, WorkflowPreflightLane, WorkflowPreflight } from "../shared/types.ts";
import { sanitizeDisplayText } from "../shared/display-text.ts";
import { workflowPreflightLaneForRuntimeKey } from "./workflow-preflight.ts";

export type WorkflowChecklistState = "complete" | "running" | "queued" | "blocked" | "failed" | "paused" | "stopped";

export interface WorkflowChecklistStep {
	key?: string;
	workflowKey?: string;
	runId?: string;
	label?: string;
	description?: string;
	phase?: string;
	agent?: string;
	status: string;
	context?: "fresh" | "fork";
	activityState?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	outputName?: string;
	error?: string;
	toolBudgetBlocked?: boolean;
	turnBudgetExceeded?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	acceptance?: { status?: string; reviewResult?: { status?: string } };
	review?: { status?: string };
	watchdog?: { phase?: string };
}

export interface WorkflowChecklistTraceEntry {
	operation?: string;
	key: string;
	state: string;
	agent?: string;
	runId?: string;
	phase?: string;
	label?: string;
	generatedLaneKey?: string;
	durationMs?: number;
	error?: string;
}

export interface WorkflowChecklistItem {
	key: string;
	label: string;
	phase: string;
	state: WorkflowChecklistState;
	agent?: string;
	context?: "fresh" | "fork";
	startedAt?: number;
	durationMs?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	toolCount?: number;
	outputName?: string;
	error?: string;
	preflight?: WorkflowPreflightLane;
	kind?: "child" | "host";
	monitorKind?: HostStepNode["monitorKind"];
	provider?: string;
	role?: string;
	verdict?: HostStepNode["verdict"];
	target?: string;
	reasonCode?: string;
	stale?: boolean;
	reportPath?: string;
}

export interface WorkflowChecklistPhase {
	key: string;
	label: string;
	state: WorkflowChecklistState;
	items: WorkflowChecklistItem[];
	total: number;
	done: number;
	running: number;
	queued: number;
	blocked: number;
	failed: number;
	paused: number;
	stopped: number;
	parallel: boolean;
}

export interface WorkflowChecklistProjection {
	phases: WorkflowChecklistPhase[];
	total: number;
	done: number;
	running: number;
	queued: number;
	blocked: number;
	failed: number;
	paused: number;
	stopped: number;
	bottleneck?: WorkflowChecklistItem;
}

export interface WorkflowChecklistInput {
	graph?: WorkflowGraphSnapshot;
	steps?: readonly WorkflowChecklistStep[] | readonly AsyncJobStep[];
	hostSteps?: readonly HostStepNode[];
	preflight?: WorkflowPreflight;
	trace?: readonly WorkflowChecklistTraceEntry[];
	now?: number;
}

const MAX_TEXT = 160;
const TERMINAL_STATES = new Set<WorkflowChecklistState>(["complete", "blocked", "failed", "paused", "stopped"]);

function text(value: unknown, fallback?: string): string | undefined {
	if (typeof value !== "string") return fallback;
	const clean = sanitizeDisplayText(value).replace(/\s+/g, " ").trim();
	return clean ? clean.slice(0, MAX_TEXT) : fallback;
}

function keyText(value: unknown, fallback: string): string {
	return text(value, fallback) ?? fallback;
}

function normalizedStatus(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase() : "queued";
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
	const number = finite(value);
	return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

function explicitBlocked(source: Pick<WorkflowChecklistStep, "activityState" | "toolBudgetBlocked" | "turnBudgetExceeded" | "timedOut" | "acceptance" | "review" | "watchdog"> & { verdict?: unknown; stale?: unknown }): boolean {
	const acceptance = normalizedStatus(source.acceptance?.status);
	const review = normalizedStatus(source.review?.status ?? source.acceptance?.reviewResult?.status);
	return source.toolBudgetBlocked === true
		|| source.turnBudgetExceeded === true
		|| source.activityState === "needs_attention"
		|| source.timedOut === true
		|| source.watchdog?.phase === "stale"
		|| source.stale === true
		|| source.verdict === "inconclusive"
		|| acceptance === "rejected"
		|| acceptance === "blockers"
		|| review === "blockers"
		|| review === "review-required";
}

function checklistState(source: Pick<WorkflowChecklistStep, "status" | "activityState" | "toolBudgetBlocked" | "turnBudgetExceeded" | "timedOut" | "acceptance" | "review" | "watchdog"> & { verdict?: unknown; stale?: unknown }): WorkflowChecklistState {
	if (explicitBlocked(source)) return "blocked";
	switch (normalizedStatus(source.status)) {
		case "complete":
		case "completed":
		case "done":
		case "pass":
		case "accepted": return "complete";
		case "running":
		case "started":
		case "active": return "running";
		case "failed":
		case "error":
		case "fail": return "failed";
		case "blocked":
		case "rejected":
		case "partial":
		case "needs_attention": return "blocked";
		case "paused":
		case "detached": return "paused";
		case "stopped":
		case "cancelled":
		case "canceled": return "stopped";
		default: return "queued";
	}
}

function duration(step: Pick<WorkflowChecklistStep, "durationMs" | "startedAt" | "endedAt">, now: number | undefined, state: WorkflowChecklistState): number | undefined {
	const explicit = finite(step.durationMs);
	const startedAt = finite(step.startedAt);
	if (explicit !== undefined) return Math.max(0, explicit);
	if (startedAt === undefined) return undefined;
	const end = state === "running" ? now : finite(step.endedAt) ?? now;
	return end === undefined ? undefined : Math.max(0, end - startedAt);
}

function laneFor(preflight: WorkflowPreflight | undefined, key: string, preferredKeys: readonly (string | undefined)[] = []): WorkflowPreflightLane | undefined {
	return workflowPreflightLaneForRuntimeKey(preflight, key, preferredKeys);
}

function stepKey(step: WorkflowChecklistStep): string | undefined {
	return step.key ?? step.workflowKey ?? step.runId;
}

function stepItem(step: WorkflowChecklistStep, index: number, phase: string, key = stepKey(step) ?? `step-${index + 1}`, label = step.label ?? step.description ?? stepKey(step) ?? step.agent ?? key, preflight?: WorkflowPreflightLane): WorkflowChecklistItem {
	const state = checklistState(step);
	return {
		key: keyText(key, `step-${index + 1}`),
		label: keyText(label, key),
		phase,
		state,
		...(text(step.agent) ? { agent: text(step.agent) } : {}),
		...(step.context ? { context: step.context } : {}),
		...(finite(step.startedAt) !== undefined ? { startedAt: finite(step.startedAt) } : {}),
		...(duration(step, undefined, state) !== undefined ? { durationMs: duration(step, undefined, state) } : {}),
		...(text(step.currentTool) ? { currentTool: text(step.currentTool) } : {}),
		...(finite(step.currentToolStartedAt) !== undefined ? { currentToolStartedAt: finite(step.currentToolStartedAt) } : {}),
		...(text(step.currentPath) ? { currentPath: text(step.currentPath) } : {}),
		...(count(step.toolCount) !== undefined ? { toolCount: count(step.toolCount) } : {}),
		...(text(step.outputName) ? { outputName: text(step.outputName) } : {}),
		...(text(step.error) ? { error: text(step.error) } : {}),
		...(preflight ? { preflight } : {}),
	};
}

function hostItem(host: HostStepNode, phase: string, key = host.id): WorkflowChecklistItem {
	const state = checklistState({ status: host.state, verdict: host.verdict, stale: host.freshness?.stale });
	return {
		key: keyText(key, "host-step"),
		label: keyText(host.label, "host step"),
		phase,
		state,
		kind: "host",
		monitorKind: host.monitorKind,
		...(text(host.provider) ? { provider: text(host.provider) } : {}),
		...(text(host.role) ? { role: text(host.role) } : {}),
		...(host.verdict ? { verdict: host.verdict } : {}),
		...(text(host.target) ? { target: text(host.target) } : {}),
		...(text(host.reasonCode) ? { reasonCode: text(host.reasonCode) } : {}),
		...(text(host.detail) ? { error: text(host.detail) } : {}),
		...(host.freshness?.stale !== undefined ? { stale: host.freshness.stale } : {}),
		...(text(host.reportPath) ? { reportPath: text(host.reportPath) } : {}),
	};
}

function graphNodes(graph: WorkflowGraphSnapshot | undefined): WorkflowGraphNode[] {
	const out: WorkflowGraphNode[] = [];
	const visit = (node: WorkflowGraphNode): void => {
		if (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") {
			for (const child of node.children ?? []) visit(child);
			if (!node.children?.length) out.push(node);
		} else {
			out.push(node);
		}
	};
	for (const node of graph?.nodes ?? []) visit(node);
	return out;
}

function traceSources(trace: readonly WorkflowChecklistTraceEntry[] | undefined): WorkflowChecklistTraceEntry[] {
	const latest = new Map<string, WorkflowChecklistTraceEntry>();
	for (const entry of trace ?? []) {
		const state = normalizedStatus(entry.state);
		if ((entry.operation !== undefined && entry.operation !== "run" && entry.operation !== "host") || !entry.key || state === "delivered" || state === "missed") continue;
		const existing = latest.get(entry.key);
		latest.set(entry.key, state === "reused" && existing ? { ...existing, ...entry, state: existing.state } : { ...existing, ...entry });
	}
	return [...latest.values()];
}

function traceItem(entry: WorkflowChecklistTraceEntry, index: number, preflight: WorkflowPreflightLane | undefined): WorkflowChecklistItem {
	const phase = keyText(preflight?.key ?? entry.generatedLaneKey ?? entry.phase, "Workflow");
	const item = stepItem({ key: entry.key, label: entry.label, phase, agent: entry.agent, status: entry.state === "started" ? "running" : entry.state, durationMs: entry.durationMs, error: entry.error }, index, phase, entry.key, entry.label ?? entry.key, preflight);
	if (entry.operation === "host") item.kind = "host";
	return item;
}

function phaseFor(phases: Map<string, WorkflowChecklistPhase>, label: string): WorkflowChecklistPhase {
	let phase = phases.get(label);
	if (!phase) {
		phase = { key: label, label, state: "queued", items: [], total: 0, done: 0, running: 0, queued: 0, blocked: 0, failed: 0, paused: 0, stopped: 0, parallel: false };
		phases.set(label, phase);
	}
	return phase;
}

function add(phases: Map<string, WorkflowChecklistPhase>, phase: string, item: WorkflowChecklistItem): void {
	phaseFor(phases, phase).items.push(item);
}

function mergeNodeStep(node: WorkflowGraphNode, step: WorkflowChecklistStep, phase: string, trace: WorkflowChecklistTraceEntry | undefined, preflight: WorkflowPreflightLane | undefined): WorkflowChecklistItem {
	const state = checklistState(step);
	const nodeState = checklistState({ status: node.status, acceptance: node.acceptanceStatus ? { status: node.acceptanceStatus } : undefined });
	const status = TERMINAL_STATES.has(nodeState) && !TERMINAL_STATES.has(state)
		? nodeState
		: trace && !TERMINAL_STATES.has(state)
		? (trace.state === "started" ? "running" : trace.state)
		: normalizedStatus(step.status) === "pending" && normalizedStatus(node.status) !== "pending" ? node.status : step.status;
	return stepItem({ ...step, status, key: node.id, label: step.label ?? node.label, phase: step.phase ?? phase, agent: step.agent ?? node.agent, outputName: step.outputName ?? node.outputName, error: step.error ?? trace?.error ?? node.error, acceptance: step.acceptance ?? (node.acceptanceStatus ? { status: node.acceptanceStatus } : undefined), durationMs: step.durationMs ?? trace?.durationMs }, node.flatIndex ?? 0, phase, node.id, step.label ?? node.label, preflight);
}

function priority(item: WorkflowChecklistItem): number {
	return item.state === "blocked" ? 0 : item.state === "failed" ? 1 : item.state === "running" ? 2 : item.state === "paused" ? 3 : item.state === "stopped" ? 4 : item.state === "queued" ? 5 : 6;
}

function applyNow(item: WorkflowChecklistItem, now: number | undefined): WorkflowChecklistItem {
	return item.durationMs === undefined && item.startedAt !== undefined && now !== undefined ? { ...item, durationMs: Math.max(0, now - item.startedAt) } : item;
}

function finalize(phase: WorkflowChecklistPhase): void {
	phase.total = phase.items.length;
	phase.done = phase.items.filter((item) => item.state === "complete").length;
	phase.running = phase.items.filter((item) => item.state === "running").length;
	phase.queued = phase.items.filter((item) => item.state === "queued").length;
	phase.blocked = phase.items.filter((item) => item.state === "blocked").length;
	phase.failed = phase.items.filter((item) => item.state === "failed").length;
	phase.paused = phase.items.filter((item) => item.state === "paused").length;
	phase.stopped = phase.items.filter((item) => item.state === "stopped").length;
	phase.parallel = phase.total > 1;
	phase.state = phase.blocked ? "blocked" : phase.failed ? "failed" : phase.running ? "running" : phase.paused ? "paused" : phase.stopped ? "stopped" : phase.queued ? "queued" : "complete";
}

export function projectWorkflowChecklist(input: WorkflowChecklistInput): WorkflowChecklistProjection {
	const phases = new Map<string, WorkflowChecklistPhase>();
	const steps = (input.steps ?? []) as readonly WorkflowChecklistStep[];
	const nodes = graphNodes(input.graph);
	const trace = traceSources(input.trace);
	const traceByKey = new Map(trace.map((entry) => [entry.key, entry]));
	const phaseByNode = new Map<string, string>();
	for (const phase of input.graph?.phases ?? []) {
		const title = keyText(phase.title, "Workflow");
		phaseFor(phases, title);
		for (const nodeId of phase.nodeIds) if (!phaseByNode.has(nodeId)) phaseByNode.set(nodeId, title);
	}

	const stepsByKey = new Map<string, Array<{ step: WorkflowChecklistStep; index: number }>>();
	for (const [index, step] of steps.entries()) {
		const key = stepKey(step);
		if (!key) continue;
		stepsByKey.set(key, [...(stepsByKey.get(key) ?? []), { step, index }]);
	}

	const usedSteps = new Set<number>();
	const hostById = new Map((input.hostSteps ?? []).map((host) => [host.id, host]));
	const graphKeys = new Set(nodes.map((node) => node.id));
	const stepKeys = new Set([...stepsByKey.keys()]);
	const hostKeys = new Set(hostById.keys());

	for (const node of nodes) {
		const host = node.hostStep ?? hostById.get(node.id);
		const phase = keyText(phaseByNode.get(node.id) ?? node.phase ?? (host ? host.label : node.label), "Workflow");
		if (host) {
			add(phases, phase, hostItem(host, phase, node.id));
			hostById.delete(node.id);
			continue;
		}
		const matches = (stepsByKey.get(node.id) ?? []).filter(({ index }) => !usedSteps.has(index));
		if (matches.length) {
			for (const match of matches) {
				usedSteps.add(match.index);
				add(phases, phase, applyNow(mergeNodeStep(node, match.step, phase, traceByKey.get(stepKey(match.step) ?? node.id), laneFor(input.preflight, node.id, [phase])), input.now));
			}
			continue;
		}
		add(phases, phase, applyNow(mergeNodeStep(node, { key: node.id, label: node.label, phase, agent: node.agent, status: node.status, outputName: node.outputName, error: node.error, acceptance: node.acceptanceStatus ? { status: node.acceptanceStatus } : undefined }, phase, traceByKey.get(node.id), laneFor(input.preflight, node.id, [phase])), input.now));
	}

	for (const [index, step] of steps.entries()) {
		if (usedSteps.has(index)) continue;
		const key = keyText(stepKey(step), `step-${index + 1}`);
		const traceEntry = traceByKey.get(key);
		const lane = laneFor(input.preflight, key, [step.phase, traceEntry?.generatedLaneKey, traceEntry?.phase]);
		const phase = keyText(lane?.key ?? step.phase ?? traceEntry?.generatedLaneKey ?? traceEntry?.phase, "Workflow");
		add(phases, phase, applyNow(stepItem(step, index, phase, key, step.label ?? step.key ?? step.agent, lane), input.now));
	}

	for (const host of hostById.values()) add(phases, keyText(host.label, "Host"), hostItem(host, keyText(host.label, "Host")));
	for (const entry of trace) {
		if (graphKeys.has(entry.key) || stepKeys.has(entry.key) || hostKeys.has(entry.key)) continue;
		const item = traceItem(entry, phases.size, laneFor(input.preflight, entry.key, [entry.generatedLaneKey, entry.phase]));
		add(phases, item.phase, item);
	}

	const finalized = [...phases.values()].filter((phase) => phase.items.length > 0);
	for (const phase of finalized) {
		phase.items = phase.items.map((item) => applyNow(item, input.now));
		finalize(phase);
	}
	const all = finalized.flatMap((phase) => phase.items);
	const counts = (state: WorkflowChecklistState): number => all.filter((item) => item.state === state).length;
	const bottleneck = [...all].sort((left, right) => priority(left) - priority(right))[0];
	return { phases: finalized, total: all.length, done: counts("complete"), running: counts("running"), queued: counts("queued"), blocked: counts("blocked"), failed: counts("failed"), paused: counts("paused"), stopped: counts("stopped"), ...(bottleneck && bottleneck.state !== "complete" ? { bottleneck } : {}) };
}

function stateLabel(state: WorkflowChecklistState): string {
	return state === "running" ? "active" : state;
}

export function formatWorkflowChecklistSummary(projection: WorkflowChecklistProjection): string {
	if (!projection.total) return "";
	return [`${projection.done}/${projection.total} done`, projection.running ? `${projection.running} active` : undefined, projection.queued ? `${projection.queued} queued` : undefined, projection.blocked ? `${projection.blocked} blocked` : undefined, projection.failed ? `${projection.failed} failed` : undefined, projection.paused ? `${projection.paused} paused` : undefined, projection.stopped ? `${projection.stopped} stopped` : undefined].filter((value): value is string => Boolean(value)).join(" · ");
}

export function formatWorkflowChecklistPhase(phase: WorkflowChecklistPhase): string {
	const counts = [phase.total > 1 && phase.done ? `${phase.done} done` : undefined, phase.running ? `${phase.running} active` : undefined, phase.queued ? `${phase.queued} queued` : undefined, phase.blocked ? `${phase.blocked} blocked` : undefined, phase.failed ? `${phase.failed} failed` : undefined, phase.paused ? `${phase.paused} paused` : undefined, phase.stopped ? `${phase.stopped} stopped` : undefined].filter((value): value is string => Boolean(value));
	return counts.length ? `${phase.label} ${counts.join(" · ")}` : phase.label;
}

export function formatWorkflowChecklistBottleneck(item: WorkflowChecklistItem | undefined, options: { includeOutput?: boolean; includeError?: boolean } = {}): string | undefined {
	if (!item) return undefined;
	const identity = [item.label, item.agent && item.agent !== item.label ? item.agent : undefined].filter((value): value is string => Boolean(value)).join(" · ") || item.key;
	const includeOutput = options.includeOutput ?? true;
	const includeError = options.includeError ?? true;
	const details = [item.context ? `(${item.context})` : undefined, item.currentTool ? `${item.currentTool}${item.durationMs !== undefined ? ` ${formatDurationText(item.durationMs)}` : ""}` : undefined, !item.currentTool && item.currentPath ? item.currentPath : undefined, !item.currentTool && item.durationMs !== undefined ? formatDurationText(item.durationMs) : undefined, item.toolCount !== undefined ? `${item.toolCount} tools` : undefined, includeOutput && item.outputName ? `out:${item.outputName}` : undefined, includeError && item.error ? `error:${item.error.replace(/\bOutput:/g, "output:")}` : undefined].filter((value): value is string => Boolean(value));
	return [identity, ...details].join(" · ");
}

function formatWorkflowChecklistItem(item: WorkflowChecklistItem): string {
	const identity = [item.label, item.agent && item.agent !== item.label ? item.agent : undefined].filter((value): value is string => Boolean(value)).join(" · ") || item.key;
	const details = [item.kind && item.monitorKind ? item.monitorKind : undefined, item.provider ? `provider:${item.provider}` : undefined, item.role ? `role:${item.role}` : undefined, item.target, item.currentTool, !item.currentTool && item.currentPath ? item.currentPath : undefined, item.durationMs !== undefined ? formatDurationText(item.durationMs) : undefined, item.toolCount !== undefined ? `${item.toolCount} tools` : undefined, item.outputName ? `out:${item.outputName}` : undefined, item.reportPath ? `out:${item.reportPath}` : undefined, item.stale ? "stale" : undefined, item.reasonCode ? `reason:${item.reasonCode}` : undefined, item.error ? `error:${item.error.replace(/\bOutput:/g, "output:")}` : undefined].filter((value): value is string => Boolean(value));
	return `${identity}${item.context ? ` (${item.context})` : ""}${item.state === "complete" ? "" : ` · ${stateLabel(item.state)}`}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function formatDurationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatWorkflowChecklistText(projection: WorkflowChecklistProjection, indent = "", options: { includeItems?: boolean } = {}): string[] {
	if (!projection.total) return [];
	const lines = [`${indent}Workflow checklist: ${formatWorkflowChecklistSummary(projection)}`];
	for (const phase of projection.phases) {
		const phaseMarker = phase.state === "complete" ? "✓" : phase.state === "running" ? "⠼" : phase.state === "blocked" ? "!" : phase.state === "failed" ? "✗" : phase.state === "paused" || phase.state === "stopped" ? "■" : "◦";
		lines.push(`${indent}  ${phaseMarker} ${formatWorkflowChecklistPhase(phase)}`);
		if (options.includeItems === false) continue;
		for (const item of phase.items) {
			const marker = item.state === "complete" ? "✓" : item.state === "running" ? "⠼" : item.state === "blocked" ? "!" : item.state === "failed" ? "✗" : item.state === "paused" || item.state === "stopped" ? "■" : "◦";
			lines.push(`${indent}    ${marker} ${formatWorkflowChecklistItem(item)}`);
		}
	}
	const bottleneck = formatWorkflowChecklistBottleneck(projection.bottleneck, { includeError: options.includeItems === false });
	if (bottleneck) lines.push(`${indent}  bottleneck · ${bottleneck}`);
	return lines;
}
