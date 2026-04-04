import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type AgentConfig, type AgentScope } from "./agents.ts";
import { getArtifactsDir } from "./artifacts.ts";
import { ChainClarifyComponent, type ChainClarifyResult, type ModelInfo } from "./chain-clarify.ts";
import { executeChain } from "./chain-execution.ts";
import { resolveExecutionAgentScope } from "./agent-scope.ts";
import { handleManagementAction } from "./agent-management.ts";
import { runSync } from "./execution.ts";
import { resolveModelCandidate } from "./model-fallback.ts";
import { aggregateParallelOutputs } from "./parallel-utils.ts";
import { recordRun } from "./run-history.ts";
import {
	getStepAgents,
	isParallelStep,
	resolveStepBehavior,
	type ChainStep,
	type SequentialStep,
} from "./settings.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "./skills.ts";
import { executeAsyncChain, executeAsyncSingle, isAsyncAvailable } from "./async-execution.ts";
import { createForkContextResolver } from "./fork-context.ts";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget, type IntercomBridgeState } from "./intercom-bridge.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "./subagent-control.ts";
import { finalizeSingleOutput, injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.ts";
import { compactForegroundDetails, findLatestSessionFile, getSingleResultOutput, mapConcurrent, readStatus, resolveChildCwd } from "./utils.ts";
import { inspectSubagentStatus } from "./run-status.ts";
import { applyForceTopLevelAsyncOverride } from "./top-level-async.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "./worktree.ts";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlConfig,
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	type SingleResult,
	type SubagentState,
	DEFAULT_ARTIFACT_CONFIG,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	checkSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	wrapForkTask,
} from "./types.ts";

const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	model?: string;
	skill?: string | string[] | boolean;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	agent?: string;
	task?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	clarify?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	resume?: boolean;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifacts?: boolean;
	includeProgress?: boolean;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	agentScope?: unknown;
	chainDir?: string;
}

interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	config: ExtensionConfig;
	asyncByDefault: boolean;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	discoverAgents: (cwd: string, scope: AgentScope) => { agents: AgentConfig[] };
}

interface ExecutionContextData {
	params: SubagentParamsLike;
	effectiveCwd: string;
	ctx: ExtensionContext;
	signal: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	agents: AgentConfig[];
	runId: string;
	shareEnabled: boolean;
	sessionRoot: string;
	sessionDirForIndex: (idx?: number) => string;
	sessionFileForIndex: (idx?: number) => string | undefined;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	backgroundRequestedWhileClarifying: boolean;
	effectiveAsync: boolean;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
}

function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

function getForegroundControl(state: SubagentState, runId: string | undefined) {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: (SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never) | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function formatForegroundActivity(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): string | undefined {
	if (control.currentTool && control.currentToolStartedAt) {
		return `tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`;
	}
	if (!control.lastActivityAt) return control.currentActivityState === "needs_attention" ? "needs attention" : undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	return control.currentActivityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
}

function foregroundStatusResult(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): AgentToolResult<Details> {
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		formatForegroundActivity(control) ? `Activity: ${formatForegroundActivity(control)}` : undefined,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

function getAsyncInterruptTarget(state: SubagentState, runId: string | undefined): { asyncId: string; asyncDir: string } | undefined {
	if (runId) {
		const direct = state.asyncJobs.get(runId);
		if (direct) return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
	}
	let newest: { asyncId: string; asyncDir: string; updatedAt: number } | undefined;
	for (const job of state.asyncJobs.values()) {
		if (job.status !== "running") continue;
		if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
			newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
		}
	}
	return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}

function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ResolvedControlConfig;
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

function interruptAsyncRun(state: SubagentState, runId: string | undefined): AgentToolResult<Details> | null {
	const target = getAsyncInterruptTarget(state, runId);
	if (!target) return null;
	const status = readStatus(target.asyncDir);
	if (!status || status.state !== "running" || typeof status.pid !== "number") {
		return {
			content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	try {
		process.kill(status.pid, ASYNC_INTERRUPT_SIGNAL);
		const tracked = state.asyncJobs.get(target.asyncId);
		if (tracked) {
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
		return {
			content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}

function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
		pi: deps.pi,
		controlConfig: data.controlConfig,
		intercomBridge: data.intercomBridge,
		event,
	});
}

function validateExecutionInput(
	params: SubagentParamsLike,
	agents: AgentConfig[],
	hasChain: boolean,
	hasTasks: boolean,
	hasSingle: boolean,
	allowClarifyTaskPrompt: boolean,
): AgentToolResult<Details> | null {
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return {
			content: [
				{
					type: "text",
					text: `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
				},
			],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	if (hasChain && params.chain) {
		if (params.chain.length === 0) {
			return {
				content: [{ type: "text", text: "Chain must have at least one step" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) {
				return {
					content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		} else if (!(firstStep as SequentialStep).task && !params.task && !allowClarifyTaskPrompt) {
			return {
				content: [{ type: "text", text: "First step in chain must have a task" }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			const stepAgents = getStepAgents(step);
			for (const agentName of stepAgents) {
				if (!agents.find((a) => a.name === agentName)) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
						isError: true,
						details: { mode: "chain" as const, results: [] },
					};
				}
			}
			if (isParallelStep(step) && step.parallel.length === 0) {
				return {
					content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	return null;
}

function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent && params.task) return "single";
	return "single";
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
			return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		}
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
			expanded.push({ ...concreteTask });
		}
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) {
			expandedChain.push(step);
			continue;
		}
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
				return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			}
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
				expandedParallel.push({ ...concreteTask });
			}
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) {
			return { error: buildRequestedModeError(params, expandedTasks.error) };
		}
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) {
			return { error: buildRequestedModeError(params, expandedChain.error) };
		}
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

function withForkContext(
	result: AgentToolResult<Details>,
	context: SubagentParamsLike["context"],
): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return {
		...result,
		details: {
			...result.details,
			context: "fork",
		},
	};
}

function toExecutionErrorResult(params: SubagentParamsLike, error: unknown): AgentToolResult<Details> {
	const message = error instanceof Error ? error.message : String(error);
	return withForkContext(
		{
			content: [{ type: "text", text: message }],
			isError: true,
			details: { mode: getRequestedModeLabel(params), results: [] },
		},
		params.context,
	);
}

function collectChainSessionFiles(
	chain: ChainStep[],
	sessionFileForIndex: (idx?: number) => string | undefined,
): (string | undefined)[] {
	const sessionFiles: (string | undefined)[] = [];
	let flatIndex = 0;
	for (const step of chain) {
		if (isParallelStep(step)) {
			for (let i = 0; i < step.parallel.length; i++) {
				sessionFiles.push(sessionFileForIndex(flatIndex));
				flatIndex++;
			}
			continue;
		}
		sessionFiles.push(sessionFileForIndex(flatIndex));
		flatIndex++;
	}
	return sessionFiles;
}

function wrapChainTasksForFork(chain: ChainStep[], context: SubagentParamsLike["context"]): ChainStep[] {
	if (context !== "fork") return chain;
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapForkTask(task.task ?? "{previous}"),
				})),
			};
		}
		const sequential = step as SequentialStep;
		return {
			...sequential,
			task: wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}")),
		};
	});
}

function runAsyncPath(data: ExecutionContextData, deps: ExecutorDeps): AgentToolResult<Details> | null {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		shareEnabled,
		sessionRoot,
		sessionFileForIndex,
		artifactConfig,
		artifactsDir,
		effectiveAsync,
		controlConfig,
		intercomBridge,
	} = data;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	if (!effectiveAsync) return null;

	if (hasChain && params.chain) {
		const chainWorktreeTaskCwdError = buildChainWorktreeTaskCwdError(params.chain as ChainStep[], effectiveCwd);
		if (chainWorktreeTaskCwdError) {
			return {
				content: [{ type: "text", text: chainWorktreeTaskCwdError }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	if (hasTasks && params.tasks) {
		const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
		if (params.tasks.length > maxParallelTasks) {
			return buildParallelModeError(`Max ${maxParallelTasks} tasks`);
		}
		if (params.worktree) {
			const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(params.tasks, effectiveCwd);
			if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
		}
	}

	if (!isAsyncAvailable()) {
		return {
			content: [{ type: "text", text: "Async mode requires jiti for TypeScript execution but it could not be found. Install globally: npm install -g jiti" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}
	const id = randomUUID();
	const asyncCtx = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId: deps.state.currentSessionId!,
		currentModelProvider: ctx.model?.provider,
	};
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const currentProvider = ctx.model?.provider;
	const controlIntercomTarget = intercomBridge.active ? intercomBridge.orchestratorTarget : undefined;
	const childIntercomTarget = intercomBridge.active ? (agent: string, index: number) => resolveSubagentIntercomTarget(id, agent, index) : undefined;

	if (hasTasks && params.tasks) {
		const agentConfigs = params.tasks.map((task) => agents.find((agent) => agent.name === task.agent));
		const modelOverrides = params.tasks.map((task, index) =>
			resolveModelCandidate(task.model ?? agentConfigs[index]?.model, availableModels, currentProvider),
		);
		const skillOverrides = params.tasks.map((task) => normalizeSkillInput(task.skill));
		const parallelTasks = params.tasks.map((task, index) => ({
			agent: task.agent,
			task: params.context === "fork" ? wrapForkTask(task.task) : task.task,
			cwd: task.cwd,
			...(modelOverrides[index] ? { model: modelOverrides[index] } : {}),
			...(skillOverrides[index] !== undefined ? { skill: skillOverrides[index] } : {}),
		}));
		return executeAsyncChain(id, {
			chain: [{
				parallel: parallelTasks,
				concurrency: resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency),
				worktree: params.worktree,
			}],
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: [],
			sessionFilesByFlatIndex: params.tasks.map((_, index) => sessionFileForIndex(index)),
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
		});
	}

	if (hasChain && params.chain) {
		const normalized = normalizeSkillInput(params.skill);
		const chainSkills = normalized === false ? [] : (normalized ?? []);
		const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
		return executeAsyncChain(id, {
			chain,
			agents,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(chain, sessionFileForIndex),
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget,
		});
	}

	if (hasSingle) {
		const a = agents.find((x) => x.name === params.agent);
		if (!a) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}
		const rawOutput = params.output !== undefined ? params.output : a.output;
		const effectiveOutput: string | false | undefined = rawOutput === true ? a.output : (rawOutput as string | false | undefined);
		const normalizedSkills = normalizeSkillInput(params.skill);
		const skills = normalizedSkills === false ? [] : normalizedSkills;
		const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
		const modelOverride = resolveModelCandidate((params.model as string | undefined) ?? a.model, availableModels, currentProvider);
		return executeAsyncSingle(id, {
			agent: params.agent!,
			task: params.context === "fork" ? wrapForkTask(params.task!) : params.task!,
			agentConfig: a,
			ctx: asyncCtx,
			availableModels,
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			sessionFile: sessionFileForIndex(0),
			skills,
			output: effectiveOutput,
			modelOverride,
			maxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
		});
	}

	return null;
}

async function runChainPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const normalized = normalizeSkillInput(params.skill);
	const chainSkills = normalized === false ? [] : (normalized ?? []);
	const chain = wrapChainTasksForFork(params.chain as ChainStep[], params.context);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const chainResult = await executeChain({
		chain,
		task: params.task,
		agents,
		ctx,
		signal,
		runId,
		cwd: effectiveCwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress: params.includeProgress,
		clarify: params.clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
		foregroundControl,
		chainSkills,
		chainDir: params.chainDir,
		maxSubagentDepth: currentMaxSubagentDepth,
		worktreeSetupHook: deps.config.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
	});

	if (chainResult.requestedAsync) {
		if (!isAsyncAvailable()) {
			return {
				content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		const id = randomUUID();
		const asyncCtx = {
			pi: deps.pi,
			cwd: ctx.cwd,
			currentSessionId: deps.state.currentSessionId!,
			currentModelProvider: ctx.model?.provider,
		};
		const asyncChain = wrapChainTasksForFork(chainResult.requestedAsync.chain, params.context);
		return executeAsyncChain(id, {
			chain: asyncChain,
			agents,
			ctx: asyncCtx,
			availableModels: ctx.modelRegistry.getAvailable().map((m) => ({
				provider: m.provider,
				id: m.id,
				fullId: `${m.provider}/${m.id}`,
			})),
			cwd: effectiveCwd,
			maxOutput: params.maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			shareEnabled,
			sessionRoot,
			chainSkills: chainResult.requestedAsync.chainSkills,
			sessionFilesByFlatIndex: collectChainSessionFiles(asyncChain, sessionFileForIndex),
			maxSubagentDepth: currentMaxSubagentDepth,
			worktreeSetupHook: deps.config.worktreeSetupHook,
			worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
			controlConfig,
			controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
		});
	}

	return chainResult;
}

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd?: string;
	maxSubagentDepths: number[];
	availableModels: ModelInfo[];
	modelOverrides: (string | undefined)[];
	skillOverrides: (string[] | false | undefined)[];
	behaviors: Array<ReturnType<typeof resolveStepBehavior>>;
	controlConfig: ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: AgentToolResult<Details>) => void;
	worktreeSetup?: WorktreeSetup;
}

function buildParallelModeError(message: string): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode: "parallel" as const, results: [] },
	};
}

function createParallelWorktreeSetup(
	enabled: boolean | undefined,
	cwd: string,
	runId: string,
	tasks: TaskParam[],
	setupHook: ExtensionConfig["worktreeSetupHook"],
	setupHookTimeoutMs: ExtensionConfig["worktreeSetupHookTimeoutMs"],
): { setup?: WorktreeSetup; errorResult?: AgentToolResult<Details> } {
	if (!enabled) return {};
	try {
		return {
			setup: createWorktrees(cwd, runId, tasks.length, {
				agents: tasks.map((task) => task.agent),
				setupHook: setupHook
					? { hookPath: setupHook, timeoutMs: setupHookTimeoutMs }
					: undefined,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { errorResult: buildParallelModeError(message) };
	}
}

function buildParallelWorktreeTaskCwdError(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): string | undefined {
	const conflict = findWorktreeTaskCwdConflict(tasks, sharedCwd);
	if (!conflict) return undefined;
	return formatWorktreeTaskCwdConflict(conflict, sharedCwd);
}

function buildChainWorktreeTaskCwdError(chain: ChainStep[], sharedCwd: string): string | undefined {
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step) || !step.worktree) continue;
		const stepCwd = resolveChildCwd(sharedCwd, step.cwd);
		const conflict = findWorktreeTaskCwdConflict(step.parallel, stepCwd);
		if (!conflict) continue;
		const detail = formatWorktreeTaskCwdConflict(conflict, stepCwd);
		return `parallel chain step ${stepIndex + 1}: ${detail}`;
	}
	return undefined;
}

function resolveParallelTaskCwd(
	task: TaskParam,
	paramsCwd: string | undefined,
	worktreeSetup: WorktreeSetup | undefined,
	index: number,
): string | undefined {
	if (worktreeSetup) return worktreeSetup.worktrees[index]!.agentCwd;
	if (!paramsCwd) return task.cwd;
	return resolveChildCwd(paramsCwd, task.cwd);
}

function buildParallelWorktreeSuffix(
	worktreeSetup: WorktreeSetup | undefined,
	artifactsDir: string,
	tasks: TaskParam[],
): string {
	if (!worktreeSetup) return "";
	const diffsDir = path.join(artifactsDir, "worktree-diffs");
	const diffs = diffWorktrees(worktreeSetup, tasks.map((task) => task.agent), diffsDir);
	return formatWorktreeDiffSummary(diffs);
}

async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const overrideSkills = input.skillOverrides[index];
		const effectiveSkills = overrideSkills === undefined ? input.behaviors[index]?.skills : overrideSkills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = index;
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
		return runSync(input.ctx.cwd, input.agents, task.agent, input.taskTexts[index]!, {
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForIndex(index),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			maxSubagentDepth: input.maxSubagentDepths[index],
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			modelOverride: input.modelOverrides[index],
			availableModels: input.availableModels,
			preferredModelProvider: input.ctx.model?.provider,
			skills: effectiveSkills === false ? [] : effectiveSkills,
				onUpdate: input.onUpdate
					? (progressUpdate) => {
						const stepResults = progressUpdate.details?.results || [];
						const stepProgress = progressUpdate.details?.progress || [];
						if (input.foregroundControl && stepProgress.length > 0) {
							const current = stepProgress[0];
							input.foregroundControl.currentAgent = task.agent;
							input.foregroundControl.currentIndex = index;
							input.foregroundControl.currentActivityState = current?.activityState;
							input.foregroundControl.lastActivityAt = current?.lastActivityAt;
							input.foregroundControl.currentTool = current?.currentTool;
							input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
							input.foregroundControl.updatedAt = Date.now();
						}
						if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
						if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
						const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
						const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
						input.onUpdate?.({
							content: progressUpdate.content,
							details: {
								mode: "parallel",
								results: mergedResults,
								progress: mergedProgress,
								controlEvents: progressUpdate.details?.controlEvents,
								totalSteps: input.tasks.length,
							},
						});
					}
				: undefined,
		}).finally(() => {
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		});
	});
}

async function runParallelPath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		backgroundRequestedWhileClarifying,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const tasks = params.tasks!;
	const maxParallelTasks = resolveTopLevelParallelMaxTasks(deps.config.parallel?.maxTasks);
	const parallelConcurrency = resolveTopLevelParallelConcurrency(params.concurrency, deps.config.parallel?.concurrency);

	if (tasks.length > maxParallelTasks)
		return {
			content: [{ type: "text", text: `Max ${maxParallelTasks} tasks` }],
			isError: true,
			details: { mode: "parallel" as const, results: [] },
		};

	const agentConfigs: AgentConfig[] = [];
	for (const t of tasks) {
		const config = agents.find((a) => a.name === t.agent);
		if (!config) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${t.agent}` }],
				isError: true,
				details: { mode: "parallel" as const, results: [] },
			};
		}
		agentConfigs.push(config);
	}

	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepths = agentConfigs.map((config) =>
		resolveChildMaxSubagentDepth(currentMaxSubagentDepth, config.maxSubagentDepth),
	);

	if (params.worktree) {
		const worktreeTaskCwdError = buildParallelWorktreeTaskCwdError(tasks, effectiveCwd);
		if (worktreeTaskCwdError) return buildParallelModeError(worktreeTaskCwdError);
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	let taskTexts = tasks.map((t) => t.task);
	const modelOverrides: (string | undefined)[] = tasks.map((t, i) =>
		resolveModelCandidate(t.model ?? agentConfigs[i]?.model, availableModels, currentProvider),
	);
	const skillOverrides: (string[] | false | undefined)[] = tasks.map((t) =>
		normalizeSkillInput(t.skill),
	);

	if (params.clarify === true && ctx.hasUI) {
		const behaviors = agentConfigs.map((c, i) =>
			resolveStepBehavior(c, { skills: skillOverrides[i] }),
		);
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					agentConfigs,
					taskTexts,
					"",
					undefined,
					behaviors,
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"parallel",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "parallel", results: [] } };
		}

		taskTexts = result.templates;
		for (let i = 0; i < result.behaviorOverrides.length; i++) {
			const override = result.behaviorOverrides[i];
			if (override?.model) modelOverrides[i] = override.model;
			if (override?.skills !== undefined) skillOverrides[i] = override.skills;
		}

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
					isError: true,
					details: { mode: "parallel" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			const parallelTasks = tasks.map((t, i) => ({
				agent: t.agent,
				task: params.context === "fork" ? wrapForkTask(taskTexts[i]!) : taskTexts[i]!,
				cwd: t.cwd,
				...(modelOverrides[i] ? { model: modelOverrides[i] } : {}),
				...(skillOverrides[i] !== undefined ? { skill: skillOverrides[i] } : {}),
			}));
			return executeAsyncChain(id, {
				chain: [{ parallel: parallelTasks, concurrency: parallelConcurrency, worktree: params.worktree }],
				agents,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				chainSkills: [],
				sessionFilesByFlatIndex: tasks.map((_, index) => sessionFileForIndex(index)),
				maxSubagentDepth: currentMaxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
			});
		}
	}

	const behaviors = agentConfigs.map((config) => resolveStepBehavior(config, {}));
	const liveResults: (SingleResult | undefined)[] = new Array(tasks.length).fill(undefined);
	const liveProgress: (AgentProgress | undefined)[] = new Array(tasks.length).fill(undefined);
	const foregroundControl = deps.state.foregroundControls.get(runId);
	const { setup: worktreeSetup, errorResult } = createParallelWorktreeSetup(
		params.worktree,
		effectiveCwd,
		runId,
		tasks,
		deps.config.worktreeSetupHook,
		deps.config.worktreeSetupHookTimeoutMs,
	);
	if (errorResult) return errorResult;

	try {
		if (params.context === "fork") {
			for (let i = 0; i < taskTexts.length; i++) {
				taskTexts[i] = wrapForkTask(taskTexts[i]!);
			}
		}

		const results = await runForegroundParallelTasks({
			tasks,
			taskTexts,
			agents,
			ctx,
			signal,
			runId,
			sessionDirForIndex,
			sessionFileForIndex,
			shareEnabled,
			artifactConfig,
			artifactsDir,
			maxOutput: params.maxOutput,
			paramsCwd: effectiveCwd,
			availableModels,
			modelOverrides,
			skillOverrides,
			behaviors,
			controlConfig,
			onControlEvent,
			childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(runId, agent, index) : undefined,
			foregroundControl,
			concurrencyLimit: parallelConcurrency,
			maxSubagentDepths,
			liveResults,
			liveProgress,
			onUpdate,
			worktreeSetup,
		});
		for (let i = 0; i < results.length; i++) {
			const run = results[i]!;
			recordRun(run.agent, taskTexts[i]!, run.exitCode, run.progressSummary?.durationMs ?? 0);
		}

		for (const result of results) {
			if (result.progress) allProgress.push(result.progress);
			if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
		}

		const interrupted = results.find((result) => result.interrupted);
		if (interrupted) {
			return {
				content: [{ type: "text", text: `Parallel run paused after interrupt (${interrupted.agent}). Waiting for explicit next action.` }],
				details: compactForegroundDetails({
					mode: "parallel",
					results,
					progress: params.includeProgress ? allProgress : undefined,
					artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				}),
			};
		}

		const worktreeSuffix = buildParallelWorktreeSuffix(worktreeSetup, artifactsDir, tasks);
		const ok = results.filter((result) => result.exitCode === 0).length;
		const downgradeNote = backgroundRequestedWhileClarifying ? " (background requested, but clarify kept this run foreground)" : "";
		const aggregatedOutput = aggregateParallelOutputs(
			results.map((result) => ({
				agent: result.agent,
				output: result.truncation?.text || getSingleResultOutput(result),
				exitCode: result.exitCode,
				error: result.error,
			})),
			(i, agent) => `=== Task ${i + 1}: ${agent} ===`,
		);

		const summary = `${ok}/${results.length} succeeded${downgradeNote}`;
		const fullContent = worktreeSuffix
			? `${summary}\n\n${aggregatedOutput}\n\n${worktreeSuffix}`
			: `${summary}\n\n${aggregatedOutput}`;

		return {
			content: [{ type: "text", text: fullContent }],
			details: compactForegroundDetails({
				mode: "parallel",
				results,
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			}),
		};
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}

async function runSinglePath(data: ExecutionContextData, deps: ExecutorDeps): Promise<AgentToolResult<Details>> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, undefined) : undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map((m) => ({
		provider: m.provider,
		id: m.id,
		fullId: `${m.provider}/${m.id}`,
	}));
	let task = params.task!;
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput: string | false | undefined = rawOutput === true ? agentConfig.output : (rawOutput as string | false | undefined);
	const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) effectiveOutput = override.output;
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: "Background mode requires jiti for TypeScript execution but it could not be found." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
			};
			return executeAsyncSingle(id, {
				agent: params.agent!,
				task: params.context === "fork" ? wrapForkTask(task) : task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForIndex(0),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				modelOverride,
				maxSubagentDepth,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
			});
		}
	}

	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
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

	const forwardSingleUpdate = onUpdate
		? (update: AgentToolResult<Details>) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
				foregroundControl.currentActivityState = firstProgress?.activityState;
				foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
				foregroundControl.currentTool = firstProgress?.currentTool;
				foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
				foregroundControl.updatedAt = Date.now();
			}
			onUpdate(update);
		}
		: undefined;

	const r = await runSync(ctx.cwd, agents, params.agent!, task, {
		cwd: effectiveCwd,
		signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: agentConfig.systemPrompt?.includes("Intercom orchestration channel:") === true,
		intercomEvents: deps.pi.events,
		runId,
		sessionDir: sessionDirForIndex(0),
		sessionFile: sessionFileForIndex(0),
		share: shareEnabled,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput: params.maxOutput,
		outputPath,
		maxSubagentDepth,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		modelOverride,
		availableModels,
		preferredModelProvider: currentProvider,
		skills: effectiveSkills,
	});
	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		saveError: r.outputSaveError,
	});

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}` }],
			details: compactForegroundDetails({
				mode: "single",
				results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details: compactForegroundDetails({
				mode: "single",
				results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
		};
	}

	if (r.exitCode !== 0)
		return {
			content: [{ type: "text", text: r.error || "Failed" }],
			details: compactForegroundDetails({
				mode: "single",
				results: [r],
				progress: params.includeProgress ? allProgress : undefined,
				artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
				truncation: r.truncation,
			}),
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details: compactForegroundDetails({
			mode: "single",
			results: [r],
			progress: params.includeProgress ? allProgress : undefined,
			artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
			truncation: r.truncation,
		}),
	};
}

export function createSubagentExecutor(deps: ExecutorDeps): {
	execute: (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Details>>;
} {
	const execute = async (
		_id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((r: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		const requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd);
		const paramsWithResolvedCwd = params.cwd === undefined ? params : { ...params, cwd: requestCwd };
		if (params.action) {
			if (params.action === "status") {
				const foreground = getForegroundControl(deps.state, paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId);
				if (foreground) return foregroundStatusResult(foreground);
				return inspectSubagentStatus(paramsWithResolvedCwd);
			}
			if (params.action === "interrupt") {
				const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
				const foreground = getForegroundControl(deps.state, targetRunId);
				if (foreground?.interrupt) {
					const interrupted = foreground.interrupt();
					if (interrupted) {
						foreground.updatedAt = Date.now();
						foreground.currentActivityState = undefined;
						return {
							content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
							details: { mode: "management", results: [] },
						};
					}
					return {
						content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
						isError: true,
						details: { mode: "management", results: [] },
					};
				}
				const asyncInterruptResult = interruptAsyncRun(deps.state, targetRunId);
				if (asyncInterruptResult) return asyncInterruptResult;
				return {
					content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
					isError: true,
					details: { mode: "management", results: [] },
				};
			}
			const validActions = ["list", "get", "create", "update", "delete", "status", "interrupt"];
			if (!validActions.includes(params.action)) {
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}. Valid: ${validActions.join(", ")}` }],
					isError: true,
					details: { mode: "management" as const, results: [] },
				};
			}
			return handleManagementAction(params.action, paramsWithResolvedCwd, { ...ctx, cwd: requestCwd });
		}

		const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
		if (blocked) {
			return {
				content: [
					{
						type: "text",
						text:
							`Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
							"You are running at the maximum subagent nesting depth. " +
							"Complete your current task directly without delegating to further subagents.",
					},
				],
				isError: true,
				details: { mode: "single" as const, results: [] },
			};
		}

		const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
		if (normalized.error) return normalized.error;
		const normalizedParams = normalized.params!;

		const effectiveParams = applyForceTopLevelAsyncOverride(
			normalizedParams,
			depth,
			deps.config.forceTopLevelAsync === true,
		);

		const scope: AgentScope = resolveExecutionAgentScope(effectiveParams.agentScope);
		const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
		const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		deps.state.currentSessionId = parentSessionFile ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const discoveredAgents = deps.discoverAgents(effectiveCwd, scope).agents;
		const sessionName = resolveIntercomSessionTarget(deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
		const intercomBridge = resolveIntercomBridge({
			config: deps.config.intercomBridge,
			context: effectiveParams.context,
			orchestratorTarget: sessionName,
		});
		const agents = intercomBridge.active
			? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
			: discoveredAgents;
		const runId = randomUUID().slice(0, 8);
		const shareEnabled = effectiveParams.share === true;
		const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
		const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(effectiveParams.agent && effectiveParams.task);
		const allowClarifyTaskPrompt = hasChain
			&& effectiveParams.clarify === true
			&& ctx.hasUI
			&& !(effectiveParams.chain?.some(isParallelStep) ?? false);

		const validationError = validateExecutionInput(
			effectiveParams,
			agents,
			hasChain,
			hasTasks,
			hasSingle,
			allowClarifyTaskPrompt,
		);
		if (validationError) return validationError;

		let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
		try {
			sessionFileForIndex = createForkContextResolver(ctx.sessionManager, effectiveParams.context).sessionFileForIndex;
		} catch (error) {
			return toExecutionErrorResult(effectiveParams, error);
		}

		// resume: reload the latest session from sessionDir (SINGLE mode only).
		if (effectiveParams.resume) {
			// Requires sessionDir — without it there is no slot to resume from.
			if (!effectiveParams.sessionDir) {
				return {
					content: [{ type: "text", text: "resume requires sessionDir. Provide the same sessionDir used in the prior call." }],
					isError: true,
					details: { mode: getRequestedModeLabel(effectiveParams), results: [] },
				};
			}
			// Reject non-SINGLE modes — resume loads a single conversation history;
			// chain and parallel runs each maintain their own per-step sessions via sessionDir.
			if (!hasSingle) {
				return {
					content: [{ type: "text", text: "resume is only supported in SINGLE mode (agent + task). Chain and parallel modes manage their own per-step sessions via sessionDir." }],
					isError: true,
					details: { mode: getRequestedModeLabel(effectiveParams), results: [] },
				};
			}
			// Reject fork + resume — fork branches from the parent leaf session;
			// combining with resume produces contradictory semantics.
			if (effectiveParams.context === "fork") {
				return {
					content: [{ type: "text", text: "resume and context: 'fork' cannot be used together. Use one or the other." }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			// Look for an existing session in the run-0 sub-dir (where SINGLE stores sessions).
			// On first call the dir is empty — silently start fresh rather than error.
			const singleRunDir = path.join(path.resolve(deps.expandTilde(effectiveParams.sessionDir)), "run-0");
			const existingSession = findLatestSessionFile(singleRunDir);
			if (existingSession) {
				sessionFileForIndex = (idx?: number) => (idx === 0 ? existingSession : undefined);
			}
			// else: no prior session yet — sessionFileForIndex stays as () => undefined (fresh start)
		}
		const requestedAsync = effectiveParams.async ?? deps.asyncByDefault;
		const backgroundRequestedWhileClarifying = hasTasks && requestedAsync && effectiveParams.clarify === true;
		const effectiveAsync = requestedAsync
			&& (hasChain ? effectiveParams.clarify === false : effectiveParams.clarify !== true);
		const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);

		const artifactConfig: ArtifactConfig = {
			...DEFAULT_ARTIFACT_CONFIG,
			enabled: effectiveParams.artifacts !== false,
		};
		const artifactsDir = effectiveAsync ? deps.tempArtifactsDir : getArtifactsDir(parentSessionFile);

		let sessionRoot: string;
		if (effectiveParams.sessionDir) {
			sessionRoot = path.resolve(deps.expandTilde(effectiveParams.sessionDir));
		} else {
			const baseSessionRoot = deps.config.defaultSessionDir
				? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
				: deps.getSubagentSessionRoot(parentSessionFile);
			sessionRoot = path.join(baseSessionRoot, runId);
		}
		try {
			fs.mkdirSync(sessionRoot, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return toExecutionErrorResult(
				effectiveParams,
				new Error(`Failed to create session directory '${sessionRoot}': ${message}`),
			);
		}
		const sessionDirForIndex = (idx?: number) =>
			path.join(sessionRoot, `run-${idx ?? 0}`);

		const onUpdateWithContext = onUpdate
			? (r: AgentToolResult<Details>) => onUpdate(withForkContext(r, effectiveParams.context))
			: undefined;

		const execData: ExecutionContextData = {
			params: effectiveParams,
			effectiveCwd,
			ctx,
			signal,
			onUpdate: onUpdateWithContext,
			agents,
			runId,
			shareEnabled,
			sessionRoot,
			sessionDirForIndex,
			sessionFileForIndex,
			artifactConfig,
			artifactsDir,
			backgroundRequestedWhileClarifying,
			effectiveAsync,
			controlConfig,
			intercomBridge,
		};

		const foregroundMode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const foregroundControl = effectiveAsync
			? undefined
			: {
				runId,
				mode: foregroundMode,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				currentAgent: undefined,
				currentIndex: undefined,
				currentActivityState: undefined,
				interrupt: undefined,
			};
		if (foregroundControl) {
			deps.state.foregroundControls.set(runId, foregroundControl);
			deps.state.lastForegroundControlId = runId;
		}

		try {
			const asyncResult = runAsyncPath(execData, deps);
			if (asyncResult) return withForkContext(asyncResult, effectiveParams.context);

			if (hasChain && effectiveParams.chain) {
				return withForkContext(await runChainPath(execData, deps), effectiveParams.context);
			}

			if (hasTasks && effectiveParams.tasks) {
				return withForkContext(await runParallelPath(execData, deps), effectiveParams.context);
			}

			if (hasSingle) {
				return withForkContext(await runSinglePath(execData, deps), effectiveParams.context);
			}
		} catch (error) {
			return toExecutionErrorResult(normalizedParams, error);
		} finally {
			if (foregroundControl) {
				deps.state.foregroundControls.delete(runId);
				if (deps.state.lastForegroundControlId === runId) {
					deps.state.lastForegroundControlId = null;
				}
			}
		}

		return withForkContext({
			content: [{ type: "text", text: "Invalid params" }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		}, effectiveParams.context);
	};

	return { execute };
}
