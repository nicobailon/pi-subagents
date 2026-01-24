/**
 * Subagent settings, chain behavior, and template management
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
const CHAIN_RUNS_DIR = "/tmp/pi-chain-runs";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// Settings Types
// =============================================================================

export interface ChainTemplates {
	[chainKey: string]: {
		[agentName: string]: string;
	};
}

export interface SubagentSettings {
	chains?: ChainTemplates;
}

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
	output: string | false;
	reads: string[] | false;
	progress: boolean;
}

export interface StepOverrides {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

// =============================================================================
// Chain Step Types
// =============================================================================

/** Sequential step: single agent execution */
export interface SequentialStep {
	agent: string;
	task?: string;
	cwd?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent: string;
	task?: string;
	cwd?: string;
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	concurrency?: number;
	failFast?: boolean;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep;

// =============================================================================
// Type Guards
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

export function isSequentialStep(step: ChainStep): step is SequentialStep {
	return "agent" in step && !("parallel" in step);
}

/** Get all agent names in a step (single for sequential, multiple for parallel) */
export function getStepAgents(step: ChainStep): string[] {
	if (isParallelStep(step)) {
		return step.parallel.map((t) => t.agent);
	}
	return [step.agent];
}

/** Get total task count in a step */
export function getStepTaskCount(step: ChainStep): number {
	if (isParallelStep(step)) {
		return step.parallel.length;
	}
	return 1;
}

// =============================================================================
// Settings Management
// =============================================================================

export function loadSubagentSettings(): SubagentSettings {
	try {
		const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
		return (data.subagent as SubagentSettings) ?? {};
	} catch {
		return {};
	}
}

export function saveChainTemplate(chainKey: string, templates: Record<string, string>): void {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
	} catch {}

	if (!settings.subagent) settings.subagent = {};
	const subagent = settings.subagent as Record<string, unknown>;
	if (!subagent.chains) subagent.chains = {};
	const chains = subagent.chains as Record<string, unknown>;

	chains[chainKey] = templates;

	const dir = path.dirname(SETTINGS_PATH);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export function getChainKey(agents: string[]): string {
	return agents.join("->");
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function createChainDir(runId: string): string {
	const chainDir = path.join(CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
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

/**
 * Resolve templates for each step in a chain.
 * Priority: inline task > saved template > default
 * Default for step 0: "{task}", for others: "{previous}"
 */
export function resolveChainTemplates(
	agentNames: string[],
	inlineTasks: (string | undefined)[],
	settings: SubagentSettings,
): string[] {
	const chainKey = getChainKey(agentNames);
	const savedTemplates = settings.chains?.[chainKey] ?? {};

	return agentNames.map((agent, i) => {
		// Priority: inline > saved > default
		const inline = inlineTasks[i];
		if (inline) return inline;

		const saved = savedTemplates[agent];
		if (saved) return saved;

		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

// =============================================================================
// Parallel-Aware Template Resolution
// =============================================================================

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplatesV2(
	steps: ChainStep[],
	settings: SubagentSettings,
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
		// Sequential step: existing logic
		const seq = step as SequentialStep;
		if (seq.task) return seq.task;
		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

/**
 * Flatten templates for display (TUI navigation needs flat list)
 */
export function flattenTemplates(templates: ResolvedTemplates): string[] {
	const result: string[] = [];
	for (const t of templates) {
		if (Array.isArray(t)) {
			result.push(...t);
		} else {
			result.push(t);
		}
	}
	return result;
}

/**
 * Unflatten templates back to structured form
 */
export function unflattenTemplates(
	flat: string[],
	steps: ChainStep[],
): ResolvedTemplates {
	const result: ResolvedTemplates = [];
	let idx = 0;
	for (const step of steps) {
		if (isParallelStep(step)) {
			const count = step.parallel.length;
			result.push(flat.slice(idx, idx + count));
			idx += count;
		} else {
			result.push(flat[idx]!);
			idx++;
		}
	}
	return result;
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
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const output =
		stepOverrides.output !== undefined
			? stepOverrides.output
			: agentConfig.output ?? false;

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

	return { output, reads, progress };
}

/**
 * Find index of first agent in chain that has progress enabled
 */
export function findFirstProgressAgentIndex(
	agentConfigs: AgentConfig[],
	stepOverrides: StepOverrides[],
): number {
	return agentConfigs.findIndex((config, i) => {
		const override = stepOverrides[i];
		if (override?.progress !== undefined) return override.progress;
		return config.defaultProgress ?? false;
	});
}

// =============================================================================
// Chain Instruction Injection
// =============================================================================

/**
 * Resolve a file path: absolute paths pass through, relative paths get chainDir prepended.
 */
function resolveChainPath(filePath: string, chainDir: string): string {
	return path.isAbsolute(filePath) ? filePath : `${chainDir}/${filePath}`;
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
): string {
	const instructions: string[] = [];

	// Include previous step's summary if available (prose output from prior agent)
	if (previousSummary && previousSummary.trim()) {
		instructions.push(`Previous step summary:\n\n${previousSummary.trim()}`);
	}

	// Reads (supports both absolute and relative paths)
	if (behavior.reads && behavior.reads.length > 0) {
		const files = behavior.reads.map((f) => resolveChainPath(f, chainDir)).join(", ");
		instructions.push(`Read these files: ${files}`);
	}

	// Output (supports both absolute and relative paths)
	if (behavior.output) {
		const outputPath = resolveChainPath(behavior.output, chainDir);
		instructions.push(`Write your output to: ${outputPath}`);
	}

	// Progress
	if (behavior.progress) {
		const progressPath = `${chainDir}/progress.md`;
		if (isFirstProgressAgent) {
			instructions.push(`Create and maintain: ${progressPath}`);
			instructions.push("Format: Status, Tasks (checkboxes), Files Changed, Notes");
		} else {
			instructions.push(`Read and update: ${progressPath}`);
		}
	}

	if (instructions.length === 0) return "";

	return (
		"\n\n---\n**Chain Instructions:**\n" + instructions.map((i) => `- ${i}`).join("\n")
	);
}

// =============================================================================
// Parallel Step Support
// =============================================================================

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	agentConfigs: AgentConfig[],
	stepIndex: number,
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		if (!config) {
			throw new Error(`Unknown agent: ${task.agent}`);
		}

		// Build subdirectory path for this parallel task
		const subdir = `parallel-${stepIndex}/${taskIndex}-${task.agent}`;

		// Output: task override > agent default (namespaced) > false
		// Absolute paths pass through unchanged; relative paths get namespaced under subdir
		let output: string | false = false;
		if (task.output !== undefined) {
			if (task.output === false) {
				output = false;
			} else if (path.isAbsolute(task.output)) {
				output = task.output; // Absolute path: use as-is
			} else {
				output = `${subdir}/${task.output}`; // Relative: namespace under subdir
			}
		} else if (config.output) {
			// Agent defaults are always relative, so namespace them
			output = `${subdir}/${config.output}`;
		}

		// Reads: task override > agent default > false
		const reads =
			task.reads !== undefined ? task.reads : config.defaultReads ?? false;

		// Progress: task override > agent default > false
		const progress =
			task.progress !== undefined
				? task.progress
				: config.defaultProgress ?? false;

		return { output, reads, progress };
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

/** Result from a parallel task (simplified for aggregation) */
export interface ParallelTaskResult {
	agent: string;
	taskIndex: number;
	output: string;
	exitCode: number;
	error?: string;
}

/**
 * Aggregate outputs from parallel tasks into a single string for {previous}.
 * Uses clear separators so the next agent can parse all outputs.
 */
export function aggregateParallelOutputs(results: ParallelTaskResult[]): string {
	return results
		.map((r, i) => {
			const header = `=== Parallel Task ${i + 1} (${r.agent}) ===`;
			return `${header}\n${r.output}`;
		})
		.join("\n\n");
}

/**
 * Check if any parallel task failed
 */
export function hasParallelFailures(results: ParallelTaskResult[]): boolean {
	return results.some((r) => r.exitCode !== 0);
}

/**
 * Get failure summary for parallel step
 */
export function getParallelFailureSummary(results: ParallelTaskResult[]): string {
	const failures = results.filter((r) => r.exitCode !== 0);
	if (failures.length === 0) return "";

	return failures
		.map((f) => `- Task ${f.taskIndex + 1} (${f.agent}): ${f.error || "failed"}`)
		.join("\n");
}
