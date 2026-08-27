import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import type { OutputMode } from "../../shared/types.ts";
import { resolveSingleOutputPath } from "./single-output.ts";

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
	fast?: boolean;
}

export type OutputOverrideInput = string | boolean;

export interface StepOverrides {
	output?: OutputOverrideInput;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
	fast?: boolean;
}

export interface ChildLaunchPlanInput {
	agentConfig: AgentConfig;
	stepOverrides: StepOverrides;
	task?: string;
	originalTask?: string;
	runnerCwd: string;
	runtimeCwd: string;
	stepCwdInput?: string;
	behaviorCwd?: string;
	chainSkills?: string[];
	outputBaseDir?: string;
	parallelOutputNamespace?: { stepIndex: number; taskIndex?: number };
	resolvedBehavior?: ResolvedStepBehavior;
}

export interface ChildLaunchPlan {
	stepCwd: string;
	instructionCwd: string;
	readExistenceCwd: string;
	behavior: ResolvedStepBehavior;
	inheritedRelativeParallelOutput: boolean;
	namespaceOutputPath: boolean;
	outputPath?: string;
	skillNames: string[];
}

export function normalizeOutputOverride(output: unknown): string | false | undefined {
	if (output === false || output === "false") return false;
	if (output === true || output === "true") return undefined;
	return typeof output === "string" && output.length > 0 ? output : undefined;
}

export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output = stepOutput !== undefined
		? stepOutput
		: normalizeOutputOverride(agentConfig.output) ?? false;

	const reads = stepOverrides.reads !== undefined
		? stepOverrides.reads
		: agentConfig.defaultReads ?? false;

	const progress = stepOverrides.progress !== undefined
		? stepOverrides.progress
		: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	}

	const outputMode = stepOverrides.outputMode ?? agentConfig.outputMode ?? "inline";
	const model = stepOverrides.model ?? agentConfig.model;
	const fast = stepOverrides.fast ?? agentConfig.fast;
	return { output, outputMode, reads, progress, skills, model, fast };
}

export function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined {
	if (!task) return originalTask;
	return originalTask ? task.replaceAll("{task}", originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return /\breview[- ]only\b/i.test(task)
		|| /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
		|| /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
		|| /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
		|| /\bleave\s+files?\s+unchanged\b/i.test(task);
}

export function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior {
	const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
	return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}

export function planChildLaunch(input: ChildLaunchPlanInput): ChildLaunchPlan {
	const stepCwd = resolveChildCwd(input.runnerCwd, input.stepCwdInput);
	const instructionCwd = input.behaviorCwd ?? stepCwd;
	const readExistenceCwd = input.behaviorCwd ? stepCwd : instructionCwd;
	let behavior = suppressProgressForReadOnlyTask(
		input.resolvedBehavior ?? resolveStepBehavior(input.agentConfig, input.stepOverrides, input.chainSkills),
		input.task,
		input.originalTask,
	);

	const inheritedRelativeParallelOutput = Boolean(
		input.parallelOutputNamespace
		&& input.stepOverrides.output === undefined
		&& typeof behavior.output === "string"
		&& !path.isAbsolute(behavior.output),
	);
	if (inheritedRelativeParallelOutput && input.parallelOutputNamespace?.taskIndex !== undefined) {
		behavior = {
			...behavior,
			output: path.join(
				`parallel-${input.parallelOutputNamespace.stepIndex}`,
				`${input.parallelOutputNamespace.taskIndex}-${input.agentConfig.name}`,
				behavior.output as string,
			),
		};
	}

	const namespaceOutputPath = inheritedRelativeParallelOutput && input.parallelOutputNamespace?.taskIndex === undefined;
	const skillNames = behavior.skills === false ? [] : behavior.skills;
	const outputPath = resolveSingleOutputPath(behavior.output, input.runtimeCwd, instructionCwd, input.outputBaseDir);

	return { stepCwd, instructionCwd, readExistenceCwd, behavior, inheritedRelativeParallelOutput, namespaceOutputPath, outputPath, skillNames };
}
