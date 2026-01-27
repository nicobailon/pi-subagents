/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride, type ModelInfo } from "./chain-clarify.js";
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
import { discoverAvailableSkills, normalizeSkillInput } from "./skills.js";
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

/** Resolve a model name to its full provider/model format */
function resolveModelFullId(modelName: string | undefined, availableModels: ModelInfo[]): string | undefined {
	if (!modelName) return undefined;
	// If already in provider/model format, return as-is
	if (modelName.includes("/")) return modelName;
	
	// Handle thinking level suffixes (e.g., "claude-sonnet-4-5:high")
	// Strip the suffix for lookup, then add it back
	const colonIdx = modelName.lastIndexOf(":");
	const baseModel = colonIdx !== -1 ? modelName.substring(0, colonIdx) : modelName;
	const thinkingSuffix = colonIdx !== -1 ? modelName.substring(colonIdx) : "";
	
	// Look up base model in available models to find provider
	const match = availableModels.find(m => m.id === baseModel);
	if (match) {
		return thinkingSuffix ? `${match.fullId}${thinkingSuffix}` : match.fullId;
	}
	
	// Fallback: return as-is
	return modelName;
}

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
	chainSkills?: string[];
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
		chainSkills: chainSkillsParam,
	} = params;
	const chainSkills = chainSkillsParam ?? [];

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

	// Get available models for model resolution (used in TUI and execution)
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	const availableSkills = discoverAvailableSkills(ctx.cwd);

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
			skills: normalizeSkillInput(step.skill),
		}));

		// Pre-resolve behaviors for TUI display
		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
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
					availableModels,
					availableSkills,
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
			const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex, chainSkills);

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

					// Resolve behavior for this parallel task
					const behavior = parallelBehaviors[taskIndex]!;

					// Build chain instructions (prefix goes BEFORE task, suffix goes AFTER)
					const taskTemplate = parallelTemplates[taskIndex] ?? "{previous}";
					const templateHasPrevious = taskTemplate.includes("{previous}");
					const { prefix, suffix } = buildChainInstructions(
						behavior, 
						chainDir, 
						false, // parallel tasks don't create progress (pre-created above)
						templateHasPrevious ? undefined : prev
					);

					// Build task string with variable substitution
					let taskStr = taskTemplate;
					taskStr = taskStr.replace(/\{task\}/g, originalTask);
					taskStr = taskStr.replace(/\{previous\}/g, prev);
					taskStr = taskStr.replace(/\{chain_dir\}/g, chainDir);

					// Assemble final task: prefix (READ/WRITE instructions) + task + suffix
					taskStr = prefix + taskStr + suffix;

					// Resolve model to full provider/model format for consistent display
					const taskAgentConfig = agents.find((a) => a.name === task.agent);
					const effectiveModel = resolveModelFullId(taskAgentConfig?.model, availableModels);

					const r = await runSync(ctx.cwd, agents, task.agent, taskStr, {
						cwd: task.cwd ?? cwd,
						signal,
						runId,
						index: globalTaskIndex + taskIndex,
						sessionDir: sessionDirForIndex(globalTaskIndex + taskIndex),
						share: shareEnabled,
						artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
						artifactConfig,
						modelOverride: effectiveModel,
						skills: behavior.skills === false ? [] : behavior.skills,
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

			// Resolve behavior first (TUI overrides take precedence over step config)
			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = resolveStepBehavior(agentConfig, stepOverride, chainSkills);

			// Determine if this is the first agent to create progress.md
			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			// Build chain instructions (prefix goes BEFORE task, suffix goes AFTER)
			const templateHasPrevious = stepTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior, 
				chainDir, 
				isFirstProgress, 
				templateHasPrevious ? undefined : prev
			);

			// Build task string with variable substitution
			let stepTask = stepTemplate;
			stepTask = stepTask.replace(/\{task\}/g, originalTask);
			stepTask = stepTask.replace(/\{previous\}/g, prev);
			stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);

			// Assemble final task: prefix (READ/WRITE instructions) + task + suffix (progress, previous summary)
			stepTask = prefix + stepTask + suffix;

			// Resolve model: TUI override (already full format) or agent's model resolved to full format
			const effectiveModel = tuiOverride?.model ?? resolveModelFullId(agentConfig.model, availableModels);

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
				modelOverride: effectiveModel,
				skills: behavior.skills === false ? [] : behavior.skills,
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

			// Validate expected output file was created
			if (behavior.output && r.exitCode === 0) {
				try {
					const expectedPath = behavior.output.startsWith("/") 
						? behavior.output 
						: path.join(chainDir, behavior.output);
					if (!fs.existsSync(expectedPath)) {
						// Look for similar files that might have been created instead
						const dirFiles = fs.readdirSync(chainDir);
						const mdFiles = dirFiles.filter(f => f.endsWith(".md") && f !== "progress.md");
						const warning = mdFiles.length > 0 
							? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
							: `Agent did not create expected output file: ${behavior.output}`;
						// Add warning to result but don't fail
						r.error = r.error ? `${r.error}\n⚠️ ${warning}` : `⚠️ ${warning}`;
					}
				} catch {
					// Ignore validation errors - this is just a diagnostic
				}
			}

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
