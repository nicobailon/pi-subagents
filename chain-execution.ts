/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride } from "./chain-clarify.js";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	resolveParallelBehaviors,
	buildChainInstructions,
	createParallelDirs,
	aggregateParallelOutputs,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type SequentialStep,
	type ParallelTaskResult,
	type ResolvedTemplates,
} from "./settings.js";
import { runSync } from "./execution.js";
import { buildChainSummary } from "./formatters.js";
import { getFinalOutput, mapConcurrent } from "./utils.js";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type Details,
	type SingleResult,
	MAX_CONCURRENCY,
} from "./types.js";

export interface ChainExecutionParams {
	chain: ChainStep[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
}

export interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

/**
 * Execute a chain of subagent steps
 */
export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		clarify,
		onUpdate,
	} = params;

	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];

	// Compute chain metadata for observability
	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;

	// Get original task from first step
	const firstStep = chainSteps[0]!;
	const originalTask = isParallelStep(firstStep)
		? firstStep.parallel[0]!.task!
		: (firstStep as SequentialStep).task!;

	// Create chain directory
	const chainDir = createChainDir(runId);

	// Check if chain has any parallel steps
	const hasParallelSteps = chainSteps.some(isParallelStep);

	// Resolve templates (parallel-aware)
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);

	// For TUI: only show if no parallel steps (TUI v1 doesn't support parallel display)
	const shouldClarify = clarify !== false && ctx.hasUI && !hasParallelSteps;

	// Behavior overrides from TUI (set if TUI is shown, undefined otherwise)
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;

	if (shouldClarify) {
		// Sequential-only chain: use existing TUI
		const seqSteps = chainSteps as SequentialStep[];

		// Load agent configs for sequential steps
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
			agentConfigs.push(config);
		}

		// Build step overrides
		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			reads: step.reads,
			progress: step.progress,
		}));

		// Pre-resolve behaviors for TUI display
		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!),
		);

		// Flatten templates for TUI (all strings for sequential)
		const flatTemplates = templates as string[];

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui,
					theme,
					agentConfigs,
					flatTemplates,
					originalTask,
					chainDir,
					resolvedBehaviors,
					done,
				),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
			},
		);

		if (!result || !result.confirmed) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: { mode: "chain", results: [] },
			};
		}
		// Update templates from TUI result
		templates = result.templates;
		// Store behavior overrides from TUI (used below in sequential step execution)
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	// Execute chain (handles both sequential and parallel steps)
	const results: SingleResult[] = [];
	let prev = "";
	let globalTaskIndex = 0; // For unique artifact naming
	let progressCreated = false; // Track if progress.md has been created

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;

		if (isParallelStep(step)) {
			// === PARALLEL STEP EXECUTION ===
			const parallelTemplates = stepTemplates as string[];
			const concurrency = step.concurrency ?? MAX_CONCURRENCY;
			const failFast = step.failFast ?? false;

			// Create subdirectories for parallel outputs
			const agentNames = step.parallel.map((t) => t.agent);
			createParallelDirs(chainDir, stepIndex, step.parallel.length, agentNames);

			// Resolve behaviors for parallel tasks
			const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex);

			// If any parallel task has progress enabled and progress.md hasn't been created,
			// create it now to avoid race conditions
			const anyNeedsProgress = parallelBehaviors.some((b) => b.progress);
			if (anyNeedsProgress && !progressCreated) {
				const progressPath = path.join(chainDir, "progress.md");
				fs.writeFileSync(progressPath, "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n");
				progressCreated = true;
			}

			// Track if we should abort remaining tasks (for fail-fast)
			let aborted = false;

			// Execute parallel tasks
			const parallelResults = await mapConcurrent(
				step.parallel,
				concurrency,
				async (task, taskIndex) => {
					if (aborted && failFast) {
						// Return a placeholder for skipped tasks
						return {
							agent: task.agent,
							task: "(skipped)",
							exitCode: -1,
							messages: [],
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							error: "Skipped due to fail-fast",
						} as SingleResult;
					}

					// Build task string
					const taskTemplate = parallelTemplates[taskIndex] ?? "{previous}";
					const templateHasPrevious = taskTemplate.includes("{previous}");
					let taskStr = taskTemplate;
					taskStr = taskStr.replace(/\{task\}/g, originalTask);
					taskStr = taskStr.replace(/\{previous\}/g, prev);
					taskStr = taskStr.replace(/\{chain_dir\}/g, chainDir);

					// Add chain instructions (include previous summary only if not already in template)
					const behavior = parallelBehaviors[taskIndex]!;
					// For parallel, no single "first progress" - each manages independently
					taskStr += buildChainInstructions(behavior, chainDir, false, templateHasPrevious ? undefined : prev);

					const r = await runSync(ctx.cwd, agents, task.agent, taskStr, {
						cwd: task.cwd ?? cwd,
						signal,
						runId,
						index: globalTaskIndex + taskIndex,
						sessionDir: sessionDirForIndex(globalTaskIndex + taskIndex),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						onUpdate: onUpdate
							? (p) => {
									// Use concat instead of spread for better performance
									const stepResults = p.details?.results || [];
									const stepProgress = p.details?.progress || [];
									onUpdate({
										...p,
										details: {
											mode: "chain",
											results: results.concat(stepResults),
											progress: allProgress.concat(stepProgress),
											chainAgents,
											totalSteps,
											currentStepIndex: stepIndex,
										},
									});
								}
							: undefined,
					});

					if (r.exitCode !== 0 && failFast) {
						aborted = true;
					}

					return r;
				},
			);

			// Update global task index
			globalTaskIndex += step.parallel.length;

			// Collect results and progress
			for (const r of parallelResults) {
				results.push(r);
				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);
			}

			// Check for failures (track original task index for better error messages)
			const failures = parallelResults
				.map((r, originalIndex) => ({ ...r, originalIndex }))
				.filter((r) => r.exitCode !== 0 && r.exitCode !== -1);
			if (failures.length > 0) {
				const failureSummary = failures
					.map((f) => `- Task ${f.originalIndex + 1} (${f.agent}): ${f.error || "failed"}`)
					.join("\n");
				const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: errorMsg,
				});
				return {
					content: [{ type: "text", text: summary }],
					details: {
						mode: "chain",
						results,
						progress: includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					},
					isError: true,
				};
			}

			// Aggregate outputs for {previous}
			const taskResults: ParallelTaskResult[] = parallelResults.map((r, i) => ({
				agent: r.agent,
				taskIndex: i,
				output: getFinalOutput(r.messages),
				exitCode: r.exitCode,
				error: r.error,
			}));
			prev = aggregateParallelOutputs(taskResults);
		} else {
			// === SEQUENTIAL STEP EXECUTION ===
			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			// Get agent config
			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}

			// Build task string (check if template has {previous} before replacement)
			const templateHasPrevious = stepTemplate.includes("{previous}");
			let stepTask = stepTemplate;
			stepTask = stepTask.replace(/\{task\}/g, originalTask);
			stepTask = stepTask.replace(/\{previous\}/g, prev);
			stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);

			// Resolve behavior (TUI overrides take precedence over step config)
			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
			};
			const behavior = resolveStepBehavior(agentConfig, stepOverride);

			// Determine if this is the first agent to create progress.md
			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			// Add chain instructions (include previous summary only if not already in template)
			stepTask += buildChainInstructions(behavior, chainDir, isFirstProgress, templateHasPrevious ? undefined : prev);

			// Run step
			const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
				cwd: seqStep.cwd ?? cwd,
				signal,
				runId,
				index: globalTaskIndex,
				sessionDir: sessionDirForIndex(globalTaskIndex),
				share: shareEnabled,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				onUpdate: onUpdate
					? (p) => {
							// Use concat instead of spread for better performance
							const stepResults = p.details?.results || [];
							const stepProgress = p.details?.progress || [];
							onUpdate({
								...p,
								details: {
									mode: "chain",
									results: results.concat(stepResults),
									progress: allProgress.concat(stepProgress),
									chainAgents,
									totalSteps,
									currentStepIndex: stepIndex,
								},
							});
						}
					: undefined,
			});

			globalTaskIndex++;
			results.push(r);
			if (r.progress) allProgress.push(r.progress);
			if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

			// On failure, leave chain_dir for debugging
			if (r.exitCode !== 0) {
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: r.error || "Chain failed",
				});
				return {
					content: [{ type: "text", text: summary }],
					details: {
						mode: "chain",
						results,
						progress: includeProgress ? allProgress : undefined,
						artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					},
					isError: true,
				};
			}

			prev = getFinalOutput(r.messages);
		}
	}

	// Chain complete - return summary with paths
	// Chain dir left for inspection (cleaned up after 24h)
	const summary = buildChainSummary(chainSteps, results, chainDir, "completed");

	return {
		content: [{ type: "text", text: summary }],
		details: {
			mode: "chain",
			results,
			progress: includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			chainAgents,
			totalSteps,
			// currentStepIndex omitted for completed chains
		},
	};
}
