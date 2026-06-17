/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type BehaviorOverride } from "./chain-clarify.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	resolveParallelBehaviors,
	buildChainInstructions,
	writeInitialProgressFile,
	createParallelDirs,
	suppressProgressForReadOnlyTask,
	aggregateParallelOutputs,
	isDynamicParallelStep,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type ParallelStep,
	type SequentialStep,
	type ParallelTaskResult,
	type ResolvedStepBehavior,
	type ResolvedTemplates,
} from "../../shared/settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { runSync } from "./execution.ts";
import { writeStepContextFile } from "../shared/step-context.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type ActivityState,
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type IntercomEventBus,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SingleResult,
	MAX_CONCURRENCY,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, outputEntryFromResult, resolveOutputReferences, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection, type DynamicCollectedResult } from "../shared/dynamic-fanout.ts";
import { acceptanceFailureMessage, aggregateAcceptanceReport, evaluateAcceptance, resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import type { ChainOutputMap } from "../../shared/types.ts";

interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir: string;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	currentStepIndex?: number;
	runId: string;
	outputs?: ChainOutputMap;
	currentFlatIndex?: number;
	dynamicChildren?: Record<number, Array<{ agent: string; label?: string; flatIndex: number; itemKey: string; outputName?: string; structured?: boolean; error?: string }>>;
	dynamicGroupStatuses?: Record<number, { status: "pending" | "running" | "completed" | "failed" | "paused" | "detached"; error?: string; acceptance?: SingleResult["acceptance"] }>;
}

interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	chainDir: string;
	prev: string;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	globalTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	};
	results: SingleResult[];
	allProgress: AgentProgress[];
	outputs: ChainOutputMap;
	chainAgents: string[];
	chainSteps: ChainStep[];
	totalSteps: number;
	dynamicChildren?: ChainExecutionDetailsInput["dynamicChildren"];
	dynamicGroupStatuses?: ChainExecutionDetailsInput["dynamicGroupStatuses"];
	worktreeSetup?: WorktreeSetup;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
}

function buildChainExecutionDetails(input: ChainExecutionDetailsInput): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length ? { dir: input.artifactsDir, files: input.allArtifactPaths } : undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		outputs: input.outputs,
	workflowGraph: buildWorkflowGraphSnapshot({
			runId: input.runId,
			mode: "chain",
			steps: input.chainSteps,
			results: input.results,
			currentStepIndex: input.currentStepIndex,
			currentFlatIndex: input.currentFlatIndex,
			dynamicChildren: input.dynamicChildren,
			dynamicGroupStatuses: input.dynamicGroupStatuses,
		}),
	});
}

function buildChainExecutionErrorResult(message: string, input: ChainExecutionDetailsInput): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

function appendParallelWorktreeSummary(
	output: string,
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return output;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return output;
	return `${output}\n\n${diffSummary}`;
}

async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	const parallelResults = await mapConcurrent(
		input.step.parallel,
		concurrency,
		async (task, taskIndex) => {
			if (aborted && failFast) {
				return {
					agent: task.agent,
					task: "(skipped)",
					exitCode: -1,
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					error: "Skipped due to fail-fast",
				} as SingleResult;
			}

			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
			const templateHasPrevious = taskTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
				templateHasPrevious ? undefined : input.prev,
			);

			let taskStr = resolveOutputReferences(taskTemplate, input.outputs);
			taskStr = taskStr.replace(/\{task\}/g, input.originalTask);
			taskStr = taskStr.replace(/\{previous\}/g, input.prev);
			taskStr = taskStr.replace(/\{chain_dir\}/g, input.chainDir);
			const cleanTask = taskStr;
			taskStr = prefix + taskStr + suffix;

			const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
			const effectiveModel =
				(task.model ? resolveModelCandidate(task.model, input.availableModels, input.ctx.model?.provider) : null)
				?? resolveModelCandidate(taskAgentConfig?.model, input.availableModels, input.ctx.model?.provider);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);

			const taskCwd = input.worktreeSetup
				? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
				: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
				: undefined;
			const interruptController = new AbortController();
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				input.foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					input.foregroundControl!.currentActivityState = undefined;
					input.foregroundControl!.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = task.outputSchema
				? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
				: undefined;
			const parallelStepIndex = input.globalTaskIndex + taskIndex;
			const stepContext = {
				chain_dir: input.chainDir,
				step_index: parallelStepIndex,
				agent: task.agent,
				task: cleanTask,
				output: outputPath,
				reads: typeof behavior.reads === "boolean" ? [] : (behavior.reads ?? []),
				inputs: JSON.parse(JSON.stringify(input.outputs)),
				run_id: input.runId,
				artifacts_dir: input.artifactsDir,
			};
			writeStepContextFile(input.artifactsDir, stepContext);
			writeStepContextFile(input.chainDir, stepContext);
			const result = await runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
				cwd: taskCwd,
				signal: input.signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents: input.intercomEvents,
				runId: input.runId,
				index: input.globalTaskIndex + taskIndex,
				sessionDir: input.sessionDirForIndex(input.globalTaskIndex + taskIndex),
				sessionFile: input.sessionFileForIndex?.(input.globalTaskIndex + taskIndex),
				share: input.shareEnabled,
				artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
				artifactConfig: input.artifactConfig,
				outputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig: input.controlConfig,
				onControlEvent: input.onControlEvent,
				intercomSessionName: input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex),
				orchestratorIntercomTarget: input.orchestratorIntercomTarget,
				nestedRoute: input.nestedRoute,
				modelOverride: effectiveModel,
				availableModels: input.availableModels,
				preferredModelProvider: input.ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: task.acceptance,
				acceptanceContext: { mode: "chain" },
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.currentPath = current?.currentPath;
							input.foregroundControl.turnCount = current?.turnCount;
							input.foregroundControl.tokens = current?.tokens;
							input.foregroundControl.toolCount = current?.toolCount;
							input.foregroundControl.updatedAt = Date.now();
						}
						input.onUpdate?.({
							...progressUpdate,
							details: {
								mode: "chain",
								results: input.results.concat(stepResults),
								progress: input.allProgress.concat(stepProgress),
								controlEvents: progressUpdate.details?.controlEvents,
								chainAgents: input.chainAgents,
								totalSteps: input.totalSteps,
								currentStepIndex: input.stepIndex,
								outputs: input.outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId: input.runId,
									mode: "chain",
									steps: input.chainSteps,
									results: input.results.concat(stepResults),
									currentStepIndex: input.stepIndex,
									currentFlatIndex: input.globalTaskIndex + taskIndex,
									dynamicChildren: input.dynamicChildren,
									dynamicGroupStatuses: input.dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			if (input.foregroundControl?.currentIndex === input.globalTaskIndex + taskIndex) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}

			if (result.exitCode !== 0 && failFast) {
				aborted = true;
			}
			recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
			return result;
		},
	);

	return parallelResults;
}

interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	};
	chainSkills?: string[];
	chainDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	nestedRoute?: NestedRouteInfo;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
}

interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
	/** User requested async execution via TUI - caller should dispatch to executeAsyncChain */
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
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
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
	} = params;
	const chainSkills = chainSkillsParam ?? [];

	const results: SingleResult[] = [];
	const outputs: ChainOutputMap = {};
	const dynamicChildren: ChainExecutionDetailsInput["dynamicChildren"] = {};
	const dynamicGroupStatuses: ChainExecutionDetailsInput["dynamicGroupStatuses"] = {};
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];

	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `expand:${step.parallel.agent}`
			: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;

	const makeDetailsInput = (overrides: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex"> = {}): ChainExecutionDetailsInput => ({
		results,
		...(includeProgress !== undefined ? { includeProgress } : {}),
		allProgress,
		allArtifactPaths,
		artifactsDir,
		chainAgents,
		chainSteps,
		totalSteps,
		runId,
		outputs,
		dynamicChildren,
		dynamicGroupStatuses,
		...overrides,
	});

	const firstStep = chainSteps[0]!;
	const originalTask = params.task
		?? (isParallelStep(firstStep)
			? firstStep.parallel[0]!.task!
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task!
				: (firstStep as SequentialStep).task!);
	try {
		validateChainOutputBindings(chainSteps, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}
		throw error;
	}

	const chainDir = createChainDir(runId, chainDirBase);
	const hasParallelSteps = chainSteps.some((step) => isParallelStep(step) || isDynamicParallelStep(step));
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const shouldClarify = clarify !== false && ctx.hasUI && !hasParallelSteps;
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const availableSkills = discoverAvailableSkills(cwd ?? ctx.cwd);

	if (shouldClarify) {
		const seqSteps = chainSteps as SequentialStep[];
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: seqSteps.indexOf(step) })),
				};
			}
			agentConfigs.push(config);
		}

		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
		}));

		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
		);
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
					ctx.model?.provider,
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
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}

		if (result.runInBackground) {
			removeChainDir(chainDir);
			const updatedChain: ChainStep[] = chainSteps.map((step, i) => {
				if (isParallelStep(step)) return step;
				const override = result.behaviorOverrides[i];
				return {
					...step,
					task: result.templates[i]!,
					...(override?.model ? { model: override.model } : {}),
					...(override?.output !== undefined ? { output: override.output } : {}),
					...("outputMode" in step && step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
					...(override?.reads !== undefined ? { reads: override.reads } : {}),
					...(override?.progress !== undefined ? { progress: override.progress } : {}),
					...(override?.skills !== undefined ? { skill: override.skills } : {}),
				};
			});
			return {
				content: [{ type: "text", text: "Launching in background..." }],
				details: buildChainExecutionDetails(makeDetailsInput()),
				requestedAsync: { chain: updatedChain, chainSkills },
			};
		}

		templates = result.templates;
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	let prev = "";
	let globalTaskIndex = 0;
	let progressCreated = false;

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;

		if (isParallelStep(step)) {
			const parallelTemplates = stepTemplates as string[];
			const parallelCwd = resolveChildCwd(cwd ?? ctx.cwd, step.cwd);
			let worktreeSetup: WorktreeSetup | undefined;
			if (step.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(step.parallel, parallelCwd);
				if (worktreeTaskCwdConflict) {
					return buildChainExecutionErrorResult(
						`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
						makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }),
					);
				}
				try {
					worktreeSetup = createWorktrees(parallelCwd, `${runId}-s${stepIndex}`, step.parallel.length, {
						agents: step.parallel.map((task) => task.agent),
						setupHook: params.worktreeSetupHook
							? { hookPath: params.worktreeSetupHook, timeoutMs: params.worktreeSetupHookTimeoutMs }
							: undefined,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
			}

			try {
				const agentNames = step.parallel.map((task) => task.agent);
				const parallelBehaviors = resolveParallelBehaviors(step.parallel, agents, stepIndex, chainSkills)
					.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task, originalTask));
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const behavior = parallelBehaviors[taskIndex]!;
					const outputPath = typeof behavior.output === "string"
						? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
						: undefined;
					const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]!.agent})`);
					if (validationError) return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
				progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
				createParallelDirs(chainDir, stepIndex, step.parallel.length, agentNames);

				const parallelResults = await runParallelChainTasks({
					step,
					parallelTemplates,
					parallelBehaviors,
					agents,
					stepIndex,
					availableModels,
					chainDir,
					prev,
					originalTask,
					ctx,
					intercomEvents,
					cwd,
					runId,
					globalTaskIndex,
					sessionDirForIndex,
					sessionFileForIndex,
					shareEnabled,
					artifactConfig,
					artifactsDir,
					signal,
					onUpdate,
					results,
					allProgress,
					outputs,
					chainAgents,
					chainSteps,
					totalSteps,
					dynamicChildren,
					dynamicGroupStatuses,
					controlConfig,
					onControlEvent,
					childIntercomTarget,
					orchestratorIntercomTarget,
					foregroundControl,
					nestedRoute: params.nestedRoute,
					worktreeSetup,
					maxSubagentDepth: params.maxSubagentDepth,
				});
				globalTaskIndex += step.parallel.length;

				for (const result of parallelResults) {
					results.push(result);
					if (result.progress) allProgress.push(result.progress);
					if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
				}
				const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
				const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
				if (interrupted) {
					return {
						content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + interruptedIndexInStep,
						})),
					};
				}
				const detachedIndexInStep = parallelResults.findIndex((result) => result.detached);
				const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
				if (detached) {
					return {
						content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + detachedIndexInStep,
						})),
					};
				}

				const failures = parallelResults
					.map((result, originalIndex) => ({ ...result, originalIndex }))
					.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
				if (failures.length > 0) {
					const failureSummary = failures
						.map((failure) => `- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`)
						.join("\n");
					const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
					const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
						index: stepIndex,
						error: errorMsg,
					});
					return {
						content: [{ type: "text", text: summary }],
						isError: true,
						details: buildChainExecutionDetails(makeDetailsInput({
							currentStepIndex: stepIndex,
							currentFlatIndex: globalTaskIndex - step.parallel.length + failures[0]!.originalIndex,
						})),
					};
				}

				for (let taskIndex = 0; taskIndex < parallelResults.length; taskIndex++) {
					const outputName = step.parallel[taskIndex]?.as;
					if (outputName) outputs[outputName] = outputEntryFromResult(parallelResults[taskIndex]!, stepIndex);
				}

				const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => {
					const outputTarget = parallelBehaviors[i]?.output;
					const outputTargetPath = typeof outputTarget === "string"
						? (path.isAbsolute(outputTarget) ? outputTarget : path.join(chainDir, outputTarget))
						: undefined;
					return {
						agent: result.agent,
						taskIndex: i,
						output: getSingleResultOutput(result),
						exitCode: result.exitCode,
						error: result.error,
						outputTargetPath,
						outputTargetExists: outputTargetPath ? fs.existsSync(outputTargetPath) : undefined,
					};
				});
				prev = aggregateParallelOutputs(taskResults);
				prev = appendParallelWorktreeSummary(
					prev,
					worktreeSetup,
					path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
					agentNames,
				);
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
		} else if (isDynamicParallelStep(step)) {
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(step, outputs, stepIndex, { maxItems: params.dynamicFanoutMaxItems });
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}

			dynamicChildren[stepIndex] = materialized.items.map((item, itemIndex) => ({
				agent: step.parallel.agent,
				label: materialized.parallel[itemIndex]?.label,
				flatIndex: globalTaskIndex + itemIndex,
				itemKey: item.key,
				structured: Boolean(step.parallel.outputSchema),
			}));

			if (materialized.parallel.length === 0) {
				const collection: DynamicCollectedResult[] = [];
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
					return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
				}
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				dynamicGroupStatuses[stepIndex] = { status: "completed" };
				if (step.acceptance !== undefined) {
					const effectiveGroupAcceptance = resolveEffectiveAcceptance({
						explicit: step.acceptance,
						agentName: step.parallel.agent,
						task: step.parallel.task ?? originalTask,
						mode: "chain",
						dynamicGroup: true,
					});
					const groupAcceptance = await evaluateAcceptance({
						acceptance: effectiveGroupAcceptance,
						output: "",
						report: aggregateAcceptanceReport({
							results: [],
							notes: "Dynamic fanout produced 0 results.",
						}),
						cwd: cwd ?? ctx.cwd,
					});
					dynamicGroupStatuses[stepIndex].acceptance = groupAcceptance;
					const groupAcceptanceFailure = acceptanceFailureMessage(groupAcceptance);
					if (groupAcceptanceFailure) {
						dynamicGroupStatuses[stepIndex] = { status: "failed", error: groupAcceptanceFailure, acceptance: groupAcceptance };
						return buildChainExecutionErrorResult(groupAcceptanceFailure, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
					}
				}
				prev = "Dynamic fanout produced 0 results.";
				continue;
			}

			const dynamicParallelStep: ParallelStep = {
				parallel: materialized.parallel,
				concurrency: step.concurrency,
				failFast: step.failFast,
			};
			const parallelTemplates = materialized.parallel.map((task) => task.task ?? "{previous}");
			const parallelBehaviors = resolveParallelBehaviors(dynamicParallelStep.parallel, agents, stepIndex, chainSkills)
				.map((behavior, taskIndex) => suppressProgressForReadOnlyTask(behavior, parallelTemplates[taskIndex] ?? dynamicParallelStep.parallel[taskIndex]?.task, originalTask));

			for (let taskIndex = 0; taskIndex < dynamicParallelStep.parallel.length; taskIndex++) {
				const behavior = parallelBehaviors[taskIndex]!;
				const outputPath = typeof behavior.output === "string"
					? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
					: undefined;
				const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${dynamicParallelStep.parallel[taskIndex]!.agent})`);
				if (validationError) {
					dynamicGroupStatuses[stepIndex] = { status: "failed", error: validationError };
					return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex + taskIndex }));
				}
			}

			progressCreated = ensureParallelProgressFile(chainDir, progressCreated, parallelBehaviors);
			createParallelDirs(chainDir, stepIndex, dynamicParallelStep.parallel.length, dynamicParallelStep.parallel.map((task) => task.agent));
			const parallelResults = await runParallelChainTasks({
				step: dynamicParallelStep,
				parallelTemplates,
				parallelBehaviors,
				agents,
				stepIndex,
				availableModels,
				chainDir,
				prev,
				originalTask,
				ctx,
				intercomEvents,
				cwd,
				runId,
				globalTaskIndex,
				sessionDirForIndex,
				sessionFileForIndex,
				shareEnabled,
				artifactConfig,
				artifactsDir,
				signal,
				onUpdate,
				results,
				allProgress,
				outputs,
				chainAgents,
				chainSteps,
				totalSteps,
				dynamicChildren,
				dynamicGroupStatuses,
				controlConfig,
				onControlEvent,
				childIntercomTarget,
				orchestratorIntercomTarget,
				foregroundControl,
				nestedRoute: params.nestedRoute,
				maxSubagentDepth: params.maxSubagentDepth,
			});
			globalTaskIndex += dynamicParallelStep.parallel.length;

			for (const result of parallelResults) {
				results.push(result);
				if (result.progress) allProgress.push(result.progress);
				if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
			}
			const collected = collectDynamicResults(step, materialized.items, parallelResults);
			const interruptedIndexInStep = parallelResults.findIndex((result) => result.interrupted);
			const interrupted = interruptedIndexInStep >= 0 ? parallelResults[interruptedIndexInStep] : undefined;
			if (interrupted) {
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + interruptedIndexInStep,
					})),
				};
			}
			const detachedIndexInStep = parallelResults.findIndex((result) => result.detached);
			const detached = detachedIndexInStep >= 0 ? parallelResults[detachedIndexInStep] : undefined;
			if (detached) {
				return {
					content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + detachedIndexInStep,
					})),
				};
			}
			const failures = parallelResults
				.map((result, originalIndex) => ({ ...result, originalIndex }))
				.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length > 0) {
				const failureSummary = failures
					.map((failure) => `- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`)
					.join("\n");
				const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: errorMsg };
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: errorMsg,
				});
				return {
					content: [{ type: "text", text: summary }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({
						currentStepIndex: stepIndex,
						currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length + failures[0]!.originalIndex,
					})),
				};
			}
			try {
				validateDynamicCollection(step.collect.outputSchema, collected);
			} catch (error) {
				const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: message };
				return buildChainExecutionErrorResult(message, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length }));
			}
			outputs[step.collect.as] = {
				text: JSON.stringify(collected),
				structured: collected,
				agent: step.parallel.agent,
				stepIndex,
			};
			dynamicGroupStatuses[stepIndex] = { status: "completed" };
			const effectiveGroupAcceptance = resolveEffectiveAcceptance({
				explicit: step.acceptance,
				agentName: step.parallel.agent,
				task: step.parallel.task ?? originalTask,
				mode: "chain",
				dynamicGroup: true,
			});
			const groupAcceptance = await evaluateAcceptance({
				acceptance: effectiveGroupAcceptance,
				output: "",
				report: aggregateAcceptanceReport({
					results: parallelResults,
					notes: `Dynamic fanout collected ${collected.length} result(s) into ${step.collect.as}.`,
				}),
				cwd: cwd ?? ctx.cwd,
			});
			dynamicGroupStatuses[stepIndex].acceptance = groupAcceptance;
			const groupAcceptanceFailure = acceptanceFailureMessage(groupAcceptance);
			if (groupAcceptanceFailure) {
				dynamicGroupStatuses[stepIndex] = { status: "failed", error: groupAcceptanceFailure, acceptance: groupAcceptance };
				return buildChainExecutionErrorResult(groupAcceptanceFailure, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - dynamicParallelStep.parallel.length }));
			}
			const taskResults: ParallelTaskResult[] = parallelResults.map((result, i) => ({
				agent: result.agent,
				taskIndex: i,
				output: getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			}));
			prev = aggregateParallelOutputs(taskResults, (i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`);
		} else {
			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex })),
				};
			}

			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
				outputMode: seqStep.outputMode,
				reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agentConfig, stepOverride, chainSkills), stepTemplate, originalTask);

			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			const templateHasPrevious = stepTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				chainDir,
				isFirstProgress,
				templateHasPrevious ? undefined : prev,
			);

			let stepTask = resolveOutputReferences(stepTemplate, outputs);
			stepTask = stepTask.replace(/\{task\}/g, originalTask);
			stepTask = stepTask.replace(/\{previous\}/g, prev);
			stepTask = stepTask.replace(/\{chain_dir\}/g, chainDir);
			const cleanTask = stepTask;
			stepTask = prefix + stepTask + suffix;

			const effectiveModel =
				tuiOverride?.model
				?? (seqStep.model ? resolveModelCandidate(seqStep.model, availableModels, ctx.model?.provider) : null)
				?? resolveModelCandidate(agentConfig.model, availableModels, ctx.model?.provider);

			const outputPath = typeof behavior.output === "string"
				? (path.isAbsolute(behavior.output) ? behavior.output : path.join(chainDir, behavior.output))
				: undefined;
			const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Chain step ${stepIndex + 1} (${seqStep.agent})`);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex }));
			}
			const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agentConfig.maxSubagentDepth);
			const interruptController = new AbortController();
			if (foregroundControl) {
				foregroundControl.currentAgent = seqStep.agent;
				foregroundControl.currentIndex = globalTaskIndex;
				foregroundControl.currentActivityState = undefined;
				foregroundControl.updatedAt = Date.now();
				foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					foregroundControl.currentActivityState = undefined;
					foregroundControl.updatedAt = Date.now();
					return true;
				};
			}

			const structuredRuntime = seqStep.outputSchema
				? createStructuredOutputRuntime(seqStep.outputSchema, path.join(chainDir, "structured-output"))
				: undefined;
			const stepContext = {
				chain_dir: chainDir,
				step_index: globalTaskIndex,
				agent: seqStep.agent,
				task: cleanTask,
				output: outputPath,
				reads: typeof behavior.reads === "boolean" ? [] : (behavior.reads ?? []),
				inputs: JSON.parse(JSON.stringify(outputs)),
				run_id: runId,
				artifacts_dir: artifactsDir,
			};
			writeStepContextFile(artifactsDir, stepContext);
			writeStepContextFile(chainDir, stepContext);
			const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
				cwd: resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd),
				signal,
				interruptSignal: interruptController.signal,
				allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
				intercomEvents,
				runId,
				index: globalTaskIndex,
				sessionDir: sessionDirForIndex(globalTaskIndex),
				sessionFile: sessionFileForIndex?.(globalTaskIndex),
				share: shareEnabled,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				outputPath,
				outputMode: behavior.outputMode,
				maxSubagentDepth,
				controlConfig,
				onControlEvent,
				intercomSessionName: childIntercomTarget?.(seqStep.agent, globalTaskIndex),
				orchestratorIntercomTarget,
				nestedRoute: params.nestedRoute,
				modelOverride: effectiveModel,
				availableModels,
				preferredModelProvider: ctx.model?.provider,
				skills: behavior.skills === false ? [] : behavior.skills,
				structuredOutput: structuredRuntime,
				acceptance: seqStep.acceptance,
				acceptanceContext: { mode: "chain" },
				onUpdate: onUpdate
					? (p) => {
						const stepResults = p.details?.results || [];
						const stepProgress = p.details?.progress || [];
						if (foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							foregroundControl.currentAgent = seqStep.agent;
							foregroundControl.currentIndex = globalTaskIndex;
							foregroundControl.currentActivityState = current?.activityState;
							foregroundControl.lastActivityAt = current?.lastActivityAt;
							foregroundControl.currentTool = current?.currentTool;
							foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							foregroundControl.currentPath = current?.currentPath;
							foregroundControl.turnCount = current?.turnCount;
							foregroundControl.tokens = current?.tokens;
							foregroundControl.toolCount = current?.toolCount;
							foregroundControl.updatedAt = Date.now();
						}
						onUpdate({
							...p,
							details: {
								mode: "chain",
								results: results.concat(stepResults),
								progress: allProgress.concat(stepProgress),
								controlEvents: p.details?.controlEvents,
								chainAgents,
								totalSteps,
								currentStepIndex: stepIndex,
								outputs,
								workflowGraph: buildWorkflowGraphSnapshot({
									runId,
									mode: "chain",
									steps: chainSteps,
									results: results.concat(stepResults),
									currentStepIndex: stepIndex,
									currentFlatIndex: globalTaskIndex,
									dynamicChildren,
									dynamicGroupStatuses,
								}),
							},
						});
					}
					: undefined,
			});
			if (foregroundControl?.currentIndex === globalTaskIndex) {
				foregroundControl.interrupt = undefined;
				foregroundControl.updatedAt = Date.now();
			}
			recordRun(seqStep.agent, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

			globalTaskIndex++;
			results.push(r);
			if (r.progress) allProgress.push(r.progress);
			if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

			if (r.interrupted) {
				return {
					content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${r.agent}). Waiting for explicit next action.` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}
			if (r.detached) {
				return {
					content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${r.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
				};
			}

			if (r.exitCode !== 0) {
				const summary = buildChainSummary(chainSteps, results, chainDir, "failed", {
					index: stepIndex,
					error: r.error || "Chain failed",
				});
				return {
					content: [{ type: "text", text: summary }],
					details: buildChainExecutionDetails(makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: globalTaskIndex - 1 })),
					isError: true,
				};
			}

			if (behavior.output) {
				try {
					const expectedPath = path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(chainDir, behavior.output);
					if (!fs.existsSync(expectedPath)) {
						const dirFiles = fs.readdirSync(chainDir);
						const mdFiles = dirFiles.filter((file) => file.endsWith(".md") && file !== "progress.md");
						const warning = mdFiles.length > 0
							? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
							: `Agent did not create expected output file: ${behavior.output}`;
						r.error = r.error ? `${r.error}\n${warning}` : warning;
					}
				} catch {
					// Ignore validation errors; this diagnostic should not mask successful chain output.
				}
			}

			if (seqStep.as) outputs[seqStep.as] = outputEntryFromResult(r, stepIndex);
			prev = getSingleResultOutput(r);
		}
	}

	const summary = buildChainSummary(chainSteps, results, chainDir, "completed");

	return {
		content: [{ type: "text", text: summary }],
		details: buildChainExecutionDetails(makeDetailsInput()),
	};
}
