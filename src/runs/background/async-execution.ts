/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { injectSingleOutputInstruction, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isParallelStep, resolveStepBehavior, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveModelCandidate, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import {
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();
const jitiCliPath: string | undefined = (() => {
	const candidates: Array<() => string> = [
		() => path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs"),
		() => path.join(path.dirname(require.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs"),
		() => {
			const piEntry = fs.realpathSync(process.argv[1]);
			const piRequire = createRequire(piEntry);
			return path.join(path.dirname(piRequire.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs");
		},
	];
	for (const candidate of candidates) {
		try {
			const p = candidate();
			if (fs.existsSync(p)) return p;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
})();

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
}

interface AsyncChainParams {
	chain: ChainStep[];
	resultMode?: "parallel" | "chain";
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | false;
	outputMode?: "inline" | "file-only";
	modelOverride?: string;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

/**
 * Spawn the async runner process
 */
function spawnRunner(cfg: object, suffix: string, cwd: string): { pid?: number; error?: string } {
	if (!jitiCliPath) {
		return { error: "jiti for TypeScript execution could not be found" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	const proc = spawn(process.execPath, [jitiCliPath, runner, cfgPath], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.on("error", (error) => {
		console.error(`[pi-subagents] async spawn failed: ${error.message}`);
	});
	if (typeof proc.pid !== "number") {
		return { error: `async runner did not produce a pid for cwd: ${cwd}` };
	}
	proc.unref();
	return { pid: proc.pid };
}

function formatAsyncStartError(mode: "single" | "chain", message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "chain" as const, results: [] },
		};
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const behavior = resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, runnerCwd, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${s.task ?? "{previous}"}${progressInstructions.suffix}`, outputPath);

		const primaryModel = resolveModelCandidate(behavior.model ?? a.model, availableModels, ctx.currentModelProvider);
		return {
			agent: s.agent,
			task,
			cwd: stepCwd,
			model: applyThinkingSuffix(primaryModel, a.thinking),
			modelCandidates: buildModelCandidates(behavior.model ?? a.model, a.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
				applyThinkingSuffix(candidate, a.thinking),
			),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	let steps: RunnerStep[];
	try {
		steps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return resolveStepBehavior(agent, buildStepOverrides(task), chainSkills);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree) writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex);
							} catch {
								behaviorCwd = undefined;
							}
						}
						return buildSeqStep(t, nextSessionFile(), behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex]);
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			return buildSeqStep(s as SequentialStep, nextSessionFile());
		});
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return formatAsyncStartError("chain", error.message);
		throw error;
	}
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if ("parallel" in step) {
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode: params.resultMode ?? "chain",
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("chain", `Failed to start async chain '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("chain", `Failed to start async chain '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: [(firstStep as SequentialStep).agent];
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			agent: firstAgents[0],
			agents: flatAgents,
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
			),
			chainStepCount: chain.length,
			parallelGroups,
			cwd: runnerCwd,
			asyncDir,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: `Async chain: ${chainDesc} [${id}]` }],
		details: { mode: "chain", results: [], asyncId: id, asyncDir },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const outputPath = resolveSingleOutputPath(params.output, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model: applyThinkingSuffix(resolveModelCandidate(params.modelOverride ?? agentConfig.model, availableModels, ctx.currentModelProvider), agentConfig.thinking),
						modelCandidates: buildModelCandidates(params.modelOverride ?? agentConfig.model, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
							applyThinkingSuffix(candidate, agentConfig.thinking),
						),
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						mcpDirectTools: agentConfig.mcpDirectTools,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
					},
				],
				resultPath: path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
		});
	}

	return {
		content: [{ type: "text", text: `Async: ${agent} [${id}]` }],
		details: { mode: "single", results: [], asyncId: id, asyncDir },
	};
}
