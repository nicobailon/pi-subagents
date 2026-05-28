import type { AgentConfig } from "../agents/agents.ts";
import type { ChainStep, SequentialStep } from "./settings.ts";
import { getStepAgents, isParallelStep } from "./settings.ts";
import { createForkContextResolver, resolveSubagentContext, type ForkContextResolverOptions } from "./fork-context.ts";
import { wrapForkTask } from "./types.ts";

export type SubagentExecutionContext = "fresh" | "fork";

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => { createBranchedSession(leafId: string): string | undefined };
}

export interface SubagentParamsLikeForContext {
	agent?: string;
	tasks?: Array<{ agent: string }>;
	chain?: ChainStep[];
	context?: SubagentExecutionContext;
}

export function resolveAgentContext(
	explicitContext: unknown,
	agentName: string | undefined,
	agents: readonly AgentConfig[],
): SubagentExecutionContext {
	if (explicitContext !== undefined) {
		return resolveSubagentContext(explicitContext);
	}
	if (!agentName) return "fresh";
	const agent = agents.find((entry) => entry.name === agentName);
	return agent?.defaultContext === "fork" ? "fork" : "fresh";
}

export function collectInvocationAgentNames(params: SubagentParamsLikeForContext): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names;
}

export function invocationUsesForkContext(
	explicitContext: unknown,
	agentNames: readonly string[],
	agents: readonly AgentConfig[],
): boolean {
	if (explicitContext !== undefined) {
		return resolveSubagentContext(explicitContext) === "fork";
	}
	return agentNames.some((name) => resolveAgentContext(undefined, name, agents) === "fork");
}

export function buildFlatAgentNameResolver(params: SubagentParamsLikeForContext): (index: number) => string | undefined {
	if (params.agent && !params.tasks?.length && !params.chain?.length) {
		return () => params.agent;
	}
	if (params.tasks?.length) {
		return (index) => params.tasks![index]?.agent;
	}
	if (params.chain?.length) {
		const flatAgents: string[] = [];
		for (const step of params.chain) {
			if (isParallelStep(step)) {
				for (const task of step.parallel) flatAgents.push(task.agent);
				continue;
			}
			flatAgents.push(...getStepAgents(step));
		}
		return (index) => flatAgents[index];
	}
	return () => undefined;
}

export function wrapTaskForAgentContext(
	task: string,
	explicitContext: unknown,
	agentName: string | undefined,
	agents: readonly AgentConfig[],
): string {
	return resolveAgentContext(explicitContext, agentName, agents) === "fork" ? wrapForkTask(task) : task;
}

export function wrapChainTasksForAgentContext(
	chain: ChainStep[],
	explicitContext: unknown,
	agents: readonly AgentConfig[],
): ChainStep[] {
	return chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			return {
				...step,
				parallel: step.parallel.map((task) => ({
					...task,
					task: wrapTaskForAgentContext(task.task ?? "{previous}", explicitContext, task.agent, agents),
				})),
			};
		}
		const sequential = step as SequentialStep;
		const agentName = getStepAgents(step)[0];
		return {
			...sequential,
			task: wrapTaskForAgentContext(
				sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"),
				explicitContext,
				agentName,
				agents,
			),
		};
	});
}

export function createPerAgentForkContextResolver(
	sessionManager: ForkableSessionManager,
	resolveContextForIndex: (index?: number) => SubagentExecutionContext,
	options: ForkContextResolverOptions = {},
): { sessionFileForIndex(index?: number): string | undefined } {
	let forkResolver: ReturnType<typeof createForkContextResolver> | undefined;
	return {
		sessionFileForIndex(index = 0): string | undefined {
			if (resolveContextForIndex(index) !== "fork") return undefined;
			if (!forkResolver) forkResolver = createForkContextResolver(sessionManager, "fork", options);
			return forkResolver.sessionFileForIndex(index);
		},
	};
}
