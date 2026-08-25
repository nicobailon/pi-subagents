/**
 * Chain behavior, template resolution, and directory management
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, formatUnknownAgentError, unknownAgentDiagnosticContext, type AgentConfig, type AgentScope, type UnknownAgentDiagnosticContext } from "../agents/agents.ts";
import { normalizeSkillInput } from "../agents/skills.ts";
import { CHAIN_RUNS_DIR, type AcceptanceInput, type AgentContract, type ChainGateLayer, type JsonSchemaObject, type OutputMode, type ToolBudgetConfig } from "./types.ts";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

// =============================================================================
// Behavior Resolution Types
// =============================================================================

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

function normalizeOutputOverride(output: unknown): string | false | undefined {
	if (output === false || output === "false") return false;
	if (output === true || output === "true") return undefined;
	return typeof output === "string" && output.length > 0 ? output : undefined;
}

// =============================================================================
// Chain Step Types
// =============================================================================

/** Sequential step: single agent execution */
export interface SequentialStep {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	output?: OutputOverrideInput;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	fast?: boolean;
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	gateOn?: ChainGateLayer;
	/** Internal workflow child isolation; public workflowScript supplies this on runs.run. */
	worktree?: boolean;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	count?: number;
	output?: OutputOverrideInput;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	fast?: boolean;
	toolBudget?: ToolBudgetConfig;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	gateOn?: ChainGateLayer;
}

export interface DynamicExpandSpec {
	from: {
		output: string;
		path: string;
	};
	item?: string;
	key?: string;
	maxItems?: number;
	onEmpty?: "skip" | "fail";
}

export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;

export interface DynamicCollectSpec {
	as: string;
	outputSchema?: JsonSchemaObject;
}

export interface DynamicParallelStep {
	expand: DynamicExpandSpec;
	parallel: DynamicParallelTemplate;
	collect: DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	acceptance?: AcceptanceInput;
	agentContract?: AgentContract;
	gateOn?: ChainGateLayer;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
	agentContract?: AgentContract;
	gateOn?: ChainGateLayer;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;

// =============================================================================
// Type Guards
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

export function isDynamicParallelStep(step: ChainStep): step is DynamicParallelStep {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

/** Get all agent names in a step (single for sequential, multiple for parallel) */
export function getStepAgents(step: ChainStep): string[] {
	if (isParallelStep(step)) {
		return step.parallel.map((t) => t.agent);
	}
	if (isDynamicParallelStep(step)) {
		return [step.parallel.agent];
	}
	return [step.agent];
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function createChainDir(runId: string, baseDir?: string): string {
	const chainDir = path.join(baseDir ? path.resolve(baseDir) : CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {
		// Chain cleanup is best-effort. Runs can already have cleaned their temp dir.
	}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
		// Startup cleanup is best-effort. If the scoped temp root is unreadable,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		try {
			const dirPath = path.join(CHAIN_RUNS_DIR, dir);
			const stat = fs.statSync(dirPath);
			if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
				fs.rmSync(dirPath, { recursive: true });
			}
		} catch {
			// Skip directories that can't be processed; continue with others
		}
	}
}

// =============================================================================
// Template Resolution
// =============================================================================

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplates(
	steps: ChainStep[],
): ResolvedTemplates {
	return steps.map((step, i) => {
		if (isParallelStep(step)) {
			// Parallel step: resolve each task's template
			return step.parallel.map((task) => {
				if (task.task) return task.task;
				// Default for parallel tasks is {previous}
				return "{previous}";
			});
		}
		if (isDynamicParallelStep(step)) {
			return step.parallel.task ?? "{previous}";
		}
		// Sequential step: existing logic
		const seq = step as SequentialStep;
		if (seq.task) return seq.task;
		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output =
		stepOutput !== undefined
			? stepOutput
			: normalizeOutputOverride(agentConfig.output) ?? false;

	// Reads: step override > frontmatter defaultReads > false (no reads)
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	// Progress: step override > frontmatter defaultProgress > false
	const progress =
		stepOverrides.progress !== undefined
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

// =============================================================================
// Chain Instruction Injection
// =============================================================================

/**
 * Expand a leading `~`/`~/` to the user's home directory. Other forms (relative,
 * absolute, `~user/`) pass through unchanged.
 */
export function expandHomePath(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

/**
 * Resolve a file path: `~`/`~/` expand to home first, then absolute paths pass
 * through and relative paths get chainDir prepended.
 */
export function resolveChainPath(filePath: string, chainDir: string): string {
	const expanded = expandHomePath(filePath);
	return path.isAbsolute(expanded) ? expanded : path.join(chainDir, expanded);
}

export function resolveExistingReadInstructionPaths(reads: readonly string[], instructionCwd: string, existenceCwd = instructionCwd): string[] {
	return reads.flatMap((filePath) => {
		const instructionPath = resolveChainPath(filePath, instructionCwd);
		const existencePath = resolveChainPath(filePath, existenceCwd);
		return fs.existsSync(existencePath) ? [instructionPath] : [];
	});
}

export function resolveExistingReadPaths(reads: readonly string[], cwd: string): string[] {
	return resolveExistingReadInstructionPaths(reads, cwd);
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function writeInitialProgressFile(progressDir: string): void {
	fs.mkdirSync(progressDir, { recursive: true });
	fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}

export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
	readExistenceDir = chainDir,
): { prefix: string; suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];

	// READS - prepend to override any hardcoded filenames in task text
	if (behavior.reads && behavior.reads.length > 0) {
		const files = resolveExistingReadInstructionPaths(behavior.reads, chainDir, readExistenceDir);
		if (files.length > 0) prefixParts.push(`[Read from: ${files.join(", ")}]`);
	}

	// OUTPUT - prepend so agent knows where to write
	if (behavior.output) {
		const outputPath = resolveChainPath(behavior.output, chainDir);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	// Progress instructions in suffix (less critical)
	if (behavior.progress) {
		const progressPath = path.join(chainDir, "progress.md");
		if (isFirstProgressAgent) {
			suffixParts.push(`Create and maintain progress at: ${progressPath}`);
		} else {
			suffixParts.push(`Update progress at: ${progressPath}`);
		}
	}

	// Include previous step's summary in suffix if available
	if (previousSummary && previousSummary.trim()) {
		suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
	}

	const prefix = prefixParts.length > 0 
		? prefixParts.join("\n") + "\n\n"
		: "";
	
	const suffix = suffixParts.length > 0
		? "\n\n---\n" + suffixParts.join("\n")
		: "";

	return { prefix, suffix };
}

// =============================================================================
// Parallel Step Support
// =============================================================================

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
/** Exact discovery context, or explicit input for defensive fallback discovery. */
export type ParallelBehaviorDiagnostics = UnknownAgentDiagnosticContext | { cwd: string; scope?: AgentScope };

export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	agentConfigs: AgentConfig[],
	stepIndex: number,
	chainSkills?: string[],
	diagnostics?: ParallelBehaviorDiagnostics,
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		if (!config) {
			if (!diagnostics) throw new Error("resolveParallelBehaviors requires unknown-agent diagnostic context or fallback discovery input.");
			const context = "directories" in diagnostics
				? diagnostics
				: unknownAgentDiagnosticContext(discoverAgents(path.resolve(diagnostics.cwd), diagnostics.scope ?? "both"));
			throw new Error(formatUnknownAgentError(task.agent, context));
		}

		// Build subdirectory path for this parallel task
		const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);

		// Output: task override > agent default (namespaced) > false
		// Absolute paths pass through unchanged; relative paths get namespaced under subdir
		let output: string | false = false;
		const taskOutput = normalizeOutputOverride(task.output);
		const configOutput = normalizeOutputOverride(config.output);
		if (taskOutput !== undefined) {
			if (taskOutput === false) {
				output = false;
			} else if (path.isAbsolute(taskOutput)) {
				output = taskOutput; // Absolute path: use as-is
			} else {
				output = path.join(subdir, taskOutput); // Relative: namespace under subdir
			}
		} else if (configOutput) {
			// Agent defaults are always relative, so namespace them
			output = path.join(subdir, configOutput);
		}

		// Reads: task override > agent default > false
		const reads =
			task.reads !== undefined ? task.reads : config.defaultReads ?? false;

		// Progress: task override > agent default > false
		const progress =
			task.progress !== undefined
				? task.progress
				: config.defaultProgress ?? false;

		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: string[] | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			skills = [...taskSkillInput];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		} else {
			skills = config.skills ? [...config.skills] : [];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		}

		const outputMode = task.outputMode ?? config.outputMode ?? "inline";
		const model = task.model ?? config.model;
		return { output, outputMode, reads, progress, skills, model };
	});
}

/**
 * Create subdirectories for parallel step outputs
 */
export function createParallelDirs(
	chainDir: string,
	stepIndex: number,
	taskCount: number,
	agentNames: string[],
): void {
	for (let i = 0; i < taskCount; i++) {
		const subdir = path.join(chainDir, `parallel-${stepIndex}`, `${i}-${agentNames[i]}`);
		fs.mkdirSync(subdir, { recursive: true });
	}
}

export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
