/** Native runner construction, separate from its executable entrypoint and attempt loop. */
import * as path from "node:path";
import { buildInProcessChildLaunch, type BuildInProcessChildLaunchInput, type InheritedChildRuntime } from "../shared/child-launch.ts";
import { deriveForkPromptCacheKey } from "../shared/child-tool-plan.ts";
import { normalizeExtensionBindings } from "../shared/extension-bindings.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";

export interface RunnerChildLaunchContext {
	cwd: string;
	id: string;
	flatIndex: number;
	artifactsDir?: string;
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	nestedRoute?: BuildInProcessChildLaunchInput["nestedRoute"];
	runFanoutBudget?: BuildInProcessChildLaunchInput["runFanoutBudget"];
	capabilityCeiling?: BuildInProcessChildLaunchInput["capabilityCeiling"];
	inheritedChildRuntime?: InheritedChildRuntime;
}

export function buildRunnerChildLaunch(step: RunnerSubagentStep, ctx: RunnerChildLaunchContext, attempt: {
	model?: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionName?: string;
	structuredOutput?: BuildInProcessChildLaunchInput["structuredOutput"];
	childWatchdog?: BuildInProcessChildLaunchInput["childWatchdog"];
	watchdogStatus: NonNullable<BuildInProcessChildLaunchInput["watchdogStatus"]>;
}) {
	return buildInProcessChildLaunch({
		parentSessionId: step.parentSessionId,
		forkCacheKey: step.context === "fork" ? deriveForkPromptCacheKey(step.parentSessionId) : undefined,
		sessionEnabled: attempt.sessionEnabled,
		sessionDir: attempt.sessionDir,
		sessionFile: step.sessionFile,
		model: attempt.model,
		inheritProjectContext: step.inheritProjectContext,
		inheritGlobalContext: step.inheritGlobalContext,
		inheritSkills: step.inheritSkills,
		requireReadTool: Boolean(step.skills?.length),
		tools: step.tools,
		excludeTools: step.excludeTools,
		allowNestedSubagents: step.allowNestedSubagents,
		extensions: step.extensions,
		subagentOnlyExtensions: step.subagentOnlyExtensions,
		fast: step.fast,
		modelCandidates: step.modelCandidates,
		systemPrompt: step.systemPrompt ?? "",
		systemPromptMode: step.systemPromptMode,
		mcpDirectTools: step.mcpDirectTools,
		extensionBindings: normalizeExtensionBindings(step.extensionBindings)?.value,
		capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
		cwd: step.cwd ?? ctx.cwd,
		intercomSessionName: ctx.childIntercomTarget,
		sessionName: attempt.sessionName,
		orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
		runId: ctx.id,
		childAgentName: step.agent,
		childIndex: ctx.flatIndex,
		nestedRoute: ctx.nestedRoute,
		runFanoutBudget: ctx.runFanoutBudget ? {
			...ctx.runFanoutBudget,
			...(step.runFanoutPath ? { parentPath: `${ctx.runFanoutBudget.parentPath ? `${ctx.runFanoutBudget.parentPath}/` : ""}${step.runFanoutPath}` } : {}),
		} : undefined,
		structuredOutput: attempt.structuredOutput,
		toolBudget: step.toolBudget,
		permissionRules: step.permissionRules,
		permissionAuditPath: step.permissionRules && ctx.artifactsDir
			? path.join(ctx.artifactsDir, "permission-audit", `${ctx.id}-${ctx.flatIndex}.jsonl`) : undefined,
		childWatchdog: attempt.childWatchdog,
		// registerChildWatchdog returns before reading the sink when unconfigured.
		...(attempt.childWatchdog ? { watchdogStatus: attempt.watchdogStatus } : {}),
		waitToolEnabled: step.waitToolEnabled,
		waitToolDefaultTimeoutMs: step.waitToolDefaultTimeoutMs,
		thinkingCeiling: step.thinkingCeiling,
		maxSubagentDepth: step.maxSubagentDepth,
		inherited: ctx.inheritedChildRuntime,
		host: "runner",
	});
}
