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
import { isParallelStep, resolveStepBehavior, type ChainStep, type SequentialStep, type StepOverrides } from "./settings.js";
import { buildSkillInjection, normalizeSkillInput, resolveSkills } from "./skills.js";
import {
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	ASYNC_DIR,
	RESULTS_DIR,
} from "./types.js";

const require = createRequire(import.meta.url);
const jitiCliPath: string | undefined = (() => {
	try {
		return path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs");
	} catch {
		return undefined;
	}
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
	
	// Async mode doesn't support parallel steps (v1 limitation)
	const hasParallelInChain = chain.some(isParallelStep);
	if (hasParallelInChain) {
		return {
			content: [{ type: "text", text: "Async mode doesn't support chains with parallel steps. Use clarify: true (sync mode) for parallel-in-chain." }],
			isError: true,
			details: { mode: "chain" as const, results: [] },
		};
	}

	// At this point, all steps are sequential
	const seqSteps = chain as SequentialStep[];

	// Validate all agents exist before building steps
	for (const s of seqSteps) {
		if (!agents.find((x) => x.name === s.agent)) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${s.agent}` }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch {}

	const steps = seqSteps.map((s) => {
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
		return {
			agent: s.agent,
			// First step validated to have task; others default to {previous} (replaced by runner)
			task: s.task ?? "{previous}",
			cwd: s.cwd,
			model: a.model,
			tools: a.tools,
			systemPrompt,
			// Only track skills that were actually resolved (consistent with single mode)
			skills: resolvedSkills.map((r) => r.name),
		};
	});

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
		},
		id,
		runnerCwd,
	);

	if (pid) {
		const firstAgent = chain[0] as SequentialStep;
		ctx.pi.events.emit("subagent_enhanced:started", {
			id,
			pid,
			agent: firstAgent.agent,
			task: firstAgent.task?.slice(0, 50),
			chain: chain.map((s) => (s as SequentialStep).agent),
			cwd: runnerCwd,
			asyncDir,
		});
		ctx.pi.events.emit("subagent:started", {
			id,
			pid,
			agent: firstAgent.agent,
			task: firstAgent.task?.slice(0, 50),
			chain: chain.map((s) => (s as SequentialStep).agent),
			cwd: runnerCwd,
			asyncDir,
		});
	}

	return {
		content: [
			{ type: "text", text: `Async chain: ${chain.map((s) => (s as SequentialStep).agent).join(" -> ")} [${id}]` },
		],
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
	const pid = spawnRunner(
		{
			id,
			steps: [
				{
					agent,
					task,
					cwd,
					model: agentConfig.model,
					tools: agentConfig.tools,
					systemPrompt,
					// Only track skills that were actually resolved
					skills: resolvedSkills.map((r) => r.name),
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
		},
		id,
		runnerCwd,
	);

	if (pid) {
		ctx.pi.events.emit("subagent_enhanced:started", {
			id,
			pid,
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
		});
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
