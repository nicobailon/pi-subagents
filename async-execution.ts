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
import type { AgentConfig } from "./agents.js";
import { applyThinkingSuffix } from "./execution.js";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.js";
import { isParallelStep, resolveStepBehavior, type ChainStep, type ParallelStep, type SequentialStep, type StepOverrides } from "./settings.js";
import type { RunnerStep } from "./parallel-utils.js";
import { resolvePiPackageRoot } from "./pi-spawn.js";
import { buildSkillInjection, normalizeSkillInput, resolveSkills } from "./skills.js";
import { validatePiArgs } from "./pi-args-validation.js";
import {
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	ASYNC_DIR,
	RESULTS_DIR,
} from "./types.js";

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
		} catch {}
	}
	return undefined;
})();

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
}

export interface AsyncChainParams {
	chain: ChainStep[];
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
}

export interface AsyncSingleParams {
	agent: string;
	task: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	skills?: string[];
	output?: string | false;
	piArgs?: string[];
}

export interface AsyncExecutionResult {
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
function spawnRunner(cfg: object, suffix: string, cwd: string): number | undefined {
	if (!jitiCliPath) return undefined;
	
	const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${suffix}.json`);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	
	const proc = spawn("node", [jitiCliPath, runner, cfgPath], {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.unref();
	return proc.pid;
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const { chain, agents, ctx, cwd, maxOutput, artifactsDir, artifactConfig, shareEnabled, sessionRoot } = params;
	const chainSkills = params.chainSkills ?? [];

	// Validate all agents exist before building steps
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
	} catch {}

	/** Build a resolved runner step from a SequentialStep */
	const buildSeqStep = (s: SequentialStep) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepSkillInput = normalizeSkillInput(s.skill);
		const stepOverrides: StepOverrides = { skills: stepSkillInput };
		const behavior = resolveStepBehavior(a, stepOverrides, chainSkills);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills } = resolveSkills(skillNames, ctx.cwd);

		let systemPrompt = a.systemPrompt?.trim() || null;
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		// Resolve output path and inject instruction into task
		// Use step's cwd if specified, otherwise fall back to chain-level cwd
		const outputPath = resolveSingleOutputPath(s.output, ctx.cwd, s.cwd ?? cwd);
		const task = injectSingleOutputInstruction(s.task ?? "{previous}", outputPath);

		return {
			agent: s.agent,
			task,
			cwd: s.cwd,
			model: applyThinkingSuffix(s.model ?? a.model, a.thinking),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			skills: resolvedSkills.map((r) => r.name),
			piArgs: s.piArgs,
			outputPath,
		};
	};

	// Build runner steps — sequential steps become flat objects,
	// parallel steps become { parallel: [...], concurrency?, failFast? }
	const steps: RunnerStep[] = chain.map((s) => {
		if (isParallelStep(s)) {
			return {
				parallel: s.parallel.map((t) => buildSeqStep({
					agent: t.agent,
					task: t.task,
					cwd: t.cwd,
					skill: t.skill,
					model: t.model,
					output: t.output,
				})),
				concurrency: s.concurrency,
				failFast: s.failFast,
			};
		}
		return buildSeqStep(s as SequentialStep);
	});

	// Validate piArgs before spawning
	for (const s of steps) {
		if (s.piArgs?.length) {
			validatePiArgs(s.piArgs);
		}
	}

	const runnerCwd = cwd ?? ctx.cwd;
	const pid = spawnRunner(
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
		},
		id,
		runnerCwd,
	);

	if (pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: [(firstStep as SequentialStep).agent];
		ctx.pi.events.emit("subagent:started", {
			id,
			pid,
			agent: firstAgents[0],
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
			),
			cwd: runnerCwd,
			asyncDir,
		});
	}

	// Build chain description with parallel groups shown as [agent1+agent2]
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
	const { agent, task, agentConfig, ctx, cwd, maxOutput, artifactsDir, artifactConfig, shareEnabled, sessionRoot } = params;
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const { resolved: resolvedSkills } = resolveSkills(skillNames, ctx.cwd);
	let systemPrompt = agentConfig.systemPrompt?.trim() || null;
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch {}

	const runnerCwd = cwd ?? ctx.cwd;
	const outputPath = resolveSingleOutputPath(params.output, ctx.cwd, cwd);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);

	// Validate piArgs before spawning
	if (params.piArgs?.length) {
		validatePiArgs(params.piArgs);
	}

	const pid = spawnRunner(
		{
			id,
			steps: [
				{
					agent,
					task: taskWithOutputInstruction,
					cwd,
					model: applyThinkingSuffix(agentConfig.model, agentConfig.thinking),
					tools: agentConfig.tools,
					extensions: agentConfig.extensions,
					mcpDirectTools: agentConfig.mcpDirectTools,
					systemPrompt,
					skills: resolvedSkills.map((r) => r.name),
					piArgs: params.piArgs,
					outputPath,
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
		},
		id,
		runnerCwd,
	);

	if (pid) {
		ctx.pi.events.emit("subagent:started", {
			id,
			pid,
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
