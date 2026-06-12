import { isDynamicParallelStep, isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { SingleResult, SubagentRunMode, WorkflowGraphNode, WorkflowGraphSnapshot, WorkflowNodeStatus } from "../../shared/types.ts";

export interface WorkflowGraphBuildInput {
	runId: string;
	mode?: SubagentRunMode;
	steps: ChainStep[];
	results?: Array<Pick<SingleResult, "exitCode" | "detached" | "interrupted" | "timedOut" | "error" | "acceptance">>;
	currentFlatIndex?: number;
	currentStepIndex?: number;
	stepStatuses?: Array<{ status?: string; error?: string }>;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: WorkflowNodeStatus; error?: string; acceptance?: SingleResult["acceptance"] }>;
}

function normalizeStatus(status: string | undefined): WorkflowNodeStatus | undefined {
	switch (status) {
		case "complete":
		case "completed":
			return "completed";
		case "running":
			return "running";
		case "failed":
			return "failed";
		case "paused":
			return "paused";
		case "detached":
			return "detached";
		case "timed-out":
			return "timed-out";
		case "pending":
			return "pending";
		default:
			return undefined;
	}
}

function resultStatus(result: Pick<SingleResult, "exitCode" | "detached" | "interrupted" | "timedOut"> | undefined): WorkflowNodeStatus | undefined {
	if (!result) return undefined;
	if (result.detached) return "detached";
	if (result.timedOut) return "timed-out";
	if (result.interrupted) return "paused";
	return result.exitCode === 0 ? "completed" : "failed";
}

function nodeStatus(input: WorkflowGraphBuildInput, flatIndex: number): WorkflowNodeStatus {
	return normalizeStatus(input.stepStatuses?.[flatIndex]?.status)
		?? resultStatus(input.results?.[flatIndex])
		?? (input.currentFlatIndex === flatIndex ? "running" : "pending");
}

function pushPhase(phases: WorkflowGraphSnapshot["phases"], phase: string | undefined, nodeId: string): void {
	if (!phase) return;
	let group = phases.find((candidate) => candidate.title === phase);
	if (!group) {
		group = { title: phase, nodeIds: [] };
		phases.push(group);
	}
	group.nodeIds.push(nodeId);
}

function seqLabel(step: SequentialStep, stepIndex: number): string {
	return step.label?.trim() || step.agent || `Step ${stepIndex + 1}`;
}

function summarizeParallelStatuses(statuses: WorkflowNodeStatus[]): WorkflowNodeStatus {
	if (statuses.some((status) => status === "running")) return "running";
	if (statuses.some((status) => status === "failed")) return "failed";
	if (statuses.some((status) => status === "timed-out")) return "timed-out";
	if (statuses.some((status) => status === "paused")) return "paused";
	if (statuses.some((status) => status === "detached")) return "detached";
	if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
	if (statuses.some((status) => status === "completed")) return "running";
	return "pending";
}

export function buildWorkflowGraphSnapshot(input: WorkflowGraphBuildInput): WorkflowGraphSnapshot {
	const nodes: WorkflowGraphNode[] = [];
	const phases: WorkflowGraphSnapshot["phases"] = [];
	let flatIndex = 0;
	let currentNodeId: string | undefined;

	for (let stepIndex = 0; stepIndex < input.steps.length; stepIndex++) {
		const step = input.steps[stepIndex]!;
		if (isParallelStep(step)) {
			const groupId = `step-${stepIndex}`;
			const children: WorkflowGraphNode[] = [];
			const childStatuses: WorkflowNodeStatus[] = [];
			for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
				const task = step.parallel[taskIndex]!;
				const status = nodeStatus(input, flatIndex);
				childStatuses.push(status);
				const childId = `step-${stepIndex}-agent-${taskIndex}`;
				const child: WorkflowGraphNode = {
					id: childId,
					kind: "agent",
					agent: task.agent,
					phase: task.phase,
					label: task.label?.trim() || task.agent || `Agent ${taskIndex + 1}`,
					status,
					flatIndex,
					stepIndex,
					outputName: task.as,
					structured: Boolean(task.outputSchema),
					acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
					error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
				};
				children.push(child);
				pushPhase(phases, task.phase, childId);
				if (status === "running" || input.currentFlatIndex === flatIndex) currentNodeId = childId;
				flatIndex++;
			}
			const groupStatus = summarizeParallelStatuses(childStatuses);
			if (input.currentStepIndex === stepIndex && !currentNodeId) currentNodeId = groupId;
			nodes.push({
				id: groupId,
				kind: "parallel-group",
				label: step.parallel.length === 1 ? "Parallel task" : `Parallel group (${step.parallel.length})`,
				status: groupStatus,
				stepIndex,
				children,
			});
			continue;
		}

		if (isDynamicParallelStep(step)) {
			const groupId = `step-${stepIndex}`;
			const materialized = input.dynamicChildren?.[stepIndex] ?? [];
			const groupOverride = input.dynamicGroupStatuses?.[stepIndex];
			const children: WorkflowGraphNode[] = [];
			const childStatuses: WorkflowNodeStatus[] = [];
			for (let taskIndex = 0; taskIndex < materialized.length; taskIndex++) {
				const task = materialized[taskIndex]!;
				const status = nodeStatus(input, task.flatIndex);
				childStatuses.push(status);
				const childId = `step-${stepIndex}-item-${task.itemKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
				const child: WorkflowGraphNode = {
					id: childId,
					kind: "agent",
					agent: task.agent,
					phase: step.parallel.phase ?? step.phase,
					label: task.label?.trim() || step.parallel.label?.trim() || `${task.agent} ${task.itemKey}`,
					status,
					flatIndex: task.flatIndex,
					stepIndex,
					itemKey: task.itemKey,
					outputName: task.outputName,
					structured: task.structured,
					acceptanceStatus: input.results?.[task.flatIndex]?.acceptance?.status,
					error: input.stepStatuses?.[task.flatIndex]?.error ?? input.results?.[task.flatIndex]?.error ?? task.error,
				};
				children.push(child);
				pushPhase(phases, child.phase, childId);
				if (status === "running" || input.currentFlatIndex === task.flatIndex) currentNodeId = childId;
			}
			const groupStatus = groupOverride?.status ?? (children.length > 0 ? summarizeParallelStatuses(childStatuses) : (input.currentStepIndex === stepIndex ? "running" : "pending"));
			if (input.currentStepIndex === stepIndex && !currentNodeId) currentNodeId = groupId;
			nodes.push({
				id: groupId,
				kind: "dynamic-parallel-group",
				label: step.label?.trim() || step.parallel.label?.trim() || `Dynamic fanout (${step.collect.as})`,
				status: groupStatus,
				stepIndex,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				acceptanceStatus: groupOverride?.acceptance?.status,
				error: groupOverride?.error,
				dynamic: {
					sourceOutput: step.expand.from.output,
					sourcePath: step.expand.from.path,
					itemName: step.expand.item ?? "item",
					maxItems: step.expand.maxItems,
					collectAs: step.collect.as,
				},
				children,
			});
			if (materialized.length > 0) flatIndex = Math.max(flatIndex, ...materialized.map((child) => child.flatIndex + 1));
			continue;
		}

		const seq = step as SequentialStep;
		const status = nodeStatus(input, flatIndex);
		const id = `step-${stepIndex}`;
		nodes.push({
			id,
			kind: "step",
			agent: seq.agent,
			phase: seq.phase,
			label: seqLabel(seq, stepIndex),
			status,
			flatIndex,
			stepIndex,
			outputName: seq.as,
			structured: Boolean(seq.outputSchema),
			acceptanceStatus: input.results?.[flatIndex]?.acceptance?.status,
			error: input.stepStatuses?.[flatIndex]?.error ?? input.results?.[flatIndex]?.error,
		});
		pushPhase(phases, seq.phase, id);
		if (status === "running" || input.currentFlatIndex === flatIndex || input.currentStepIndex === stepIndex) currentNodeId = id;
		flatIndex++;
	}

	return {
		runId: input.runId,
		mode: input.mode ?? "chain",
		phases,
		nodes,
		currentNodeId,
	};
}
