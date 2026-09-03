/**
 * Builds the in-process launch for one foreground child: the tool plan, the
 * typed child runtime config the hooks read, and the session launch input.
 * This is the in-process counterpart of `buildPiArgs`, which encodes the same
 * facts as argv and environment for spawned background children.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildWatchdogConfig, ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import { intersectThinkingCeilings } from "../../shared/thinking-ceiling.ts";
import {
	getSubagentDepthEnv,
	type LaunchResolvedChildExtensionsV1,
	type ResolvedToolBudget,
	type RunFanoutBudgetDescriptor,
} from "../../shared/types.ts";
import type { NestedPathEntry } from "../shared/nested-path.ts";
import type { McpRuntimeSnapshotHost } from "../shared/mcp-direct-tool-allowlist.ts";
import type { PermissionRules } from "../shared/permissions.ts";
import type { StructuredOutputRuntime } from "../shared/structured-output.ts";
import type { ChildToolDiagnostic } from "../shared/tool-availability.ts";
import type { RuntimeAcknowledgedChildExtensionsV1 } from "../../shared/types.ts";
import { projectRuntimeAcknowledgedExtensions } from "../shared/runtime-acknowledged-extensions.ts";
import { intersectSubagentCapabilityCeilings, type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "../shared/capability-ceiling.ts";
import {
	isSubagentRuntimeExtensionPath,
	projectLaunchResolvedChildExtensions,
	resolvePiLaunchToolPlan,
	supervisorChannelDir,
	type PiLaunchToolPlan,
} from "../shared/pi-args.ts";
import type { ChildRuntimeConfig } from "../shared/child-runtime-config.ts";
import { createChildHooks } from "../shared/child-hooks.ts";
import type { ChildSessionLaunch, ChildSessionStorage } from "./child-session.ts";

export interface BuildInProcessChildLaunchInput {
	parentSessionId?: string;
	forkCacheKey?: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	/** Model reference with the thinking suffix already applied. */
	model?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritGlobalContext: boolean;
	inheritSkills: boolean;
	requireReadTool?: boolean;
	tools?: string[];
	excludeTools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	cwd: string;
	intercomSessionName?: string;
	sessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName: string;
	childIndex: number;
	nestedRoute?: { rootRunId: string; eventSink: string; controlInbox: string; capabilityToken: string };
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	structuredOutput?: StructuredOutputRuntime;
	fast?: boolean;
	modelCandidates?: readonly string[];
	toolBudget?: ResolvedToolBudget;
	permissionRules?: PermissionRules;
	permissionAuditPath?: string;
	childWatchdog?: ChildWatchdogConfig;
	watchdogStatus?: (event: ChildWatchdogStatusEvent) => void;
	waitToolEnabled?: boolean;
	waitToolDefaultTimeoutMs?: number;
	allowNestedSubagents?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	thinkingCeiling?: ThinkingLevel;
	maxSubagentDepth?: number;
	runtimeSnapshotHost?: McpRuntimeSnapshotHost;
	/** The launching executor's own child runtime when it is itself an in-process child. */
	inherited?: ChildRuntimeConfig;
}

export interface InProcessChildCapture {
	structuredOutput(): { called: boolean; value?: unknown; acceptanceReport?: unknown; acceptanceReportProvided: boolean };
	toolDiagnostic(): ChildToolDiagnostic | undefined;
	runtimeAcknowledgedExtensions(): RuntimeAcknowledgedChildExtensionsV1 | undefined;
}

export interface InProcessChildLaunch {
	toolPlan: PiLaunchToolPlan;
	config: ChildRuntimeConfig;
	session: Omit<ChildSessionLaunch, "onExtensionError">;
	capture: InProcessChildCapture;
	launchResolvedExtensions: LaunchResolvedChildExtensionsV1;
	warnings: string[];
	capabilityAudit?: SubagentCapabilityAudit;
}

/** Escape XML-significant characters in a string for safe attribute interpolation. */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function inheritedCapabilityCeiling(inherited: ChildRuntimeConfig | undefined): ResolvedSubagentCapabilityCeiling | undefined {
	return inherited?.capabilityCeiling;
}

function childStorage(input: BuildInProcessChildLaunchInput): ChildSessionStorage {
	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		return { kind: "file", sessionFile: input.sessionFile };
	}
	if (!input.sessionEnabled) return { kind: "memory" };
	if (input.sessionDir) {
		fs.mkdirSync(input.sessionDir, { recursive: true });
		return { kind: "dir", sessionDir: input.sessionDir };
	}
	return { kind: "default" };
}

export function buildInProcessChildLaunch(input: BuildInProcessChildLaunchInput): InProcessChildLaunch {
	const toolPlan = resolvePiLaunchToolPlan({
		tools: input.tools,
		excludeTools: input.excludeTools,
		allowNestedSubagents: input.allowNestedSubagents,
		extensions: input.extensions,
		subagentOnlyExtensions: input.subagentOnlyExtensions,
		mcpDirectTools: input.mcpDirectTools,
		cwd: input.cwd,
		requireReadTool: input.requireReadTool,
		structuredOutput: Boolean(input.structuredOutput),
		fast: input.fast,
		model: input.model,
		modelCandidates: input.modelCandidates,
		capabilityCeiling: input.capabilityCeiling,
		inheritedCapabilityCeiling: inheritedCapabilityCeiling(input.inherited),
		agentName: input.childAgentName,
		permissionRules: input.permissionRules,
		runtimeSnapshotHost: input.runtimeSnapshotHost,
	});

	const inherited = input.inherited;
	const fanout = toolPlan.fanoutAuthorized;
	const inheritedRoute = inherited?.nestedRoute;
	const parentRunId = input.runId ?? inherited?.nestedParent?.parentRunId ?? "";
	const parentChildIndex = input.childIndex;
	const parentDepth = inheritedRoute && inherited?.nestedParent ? inherited.nestedParent.depth + 1 : 1;
	const parentPath: NestedPathEntry[] = [
		...(inherited?.nestedParent?.path ?? []),
		...(parentRunId ? [{ runId: parentRunId, stepIndex: parentChildIndex, agent: input.childAgentName }] : []),
	];
	const nestedRoute = fanout ? (input.nestedRoute ?? inheritedRoute) : undefined;
	const depthEnv = getSubagentDepthEnv(input.maxSubagentDepth, inherited);
	const permissions = input.permissionRules && Object.keys(input.permissionRules).length > 0
		? { rules: input.permissionRules, ...(input.permissionAuditPath ? { auditPath: input.permissionAuditPath } : {}) }
		: undefined;
	let supervisorDir: string | undefined;
	if (input.orchestratorIntercomTarget && input.parentSessionId && input.runId) {
		supervisorDir = supervisorChannelDir(input.runId, input.childAgentName, input.childIndex);
		fs.mkdirSync(path.join(supervisorDir, "requests"), { recursive: true });
		fs.mkdirSync(path.join(supervisorDir, "replies"), { recursive: true });
	}
	const thinkingCeiling = intersectThinkingCeilings(input.thinkingCeiling, inherited?.thinkingCeiling);

	let structuredValue: unknown;
	let structuredAcceptanceReport: unknown;
	let structuredCalled = false;
	let structuredAcceptanceProvided = false;
	let toolDiagnostic: ChildToolDiagnostic | undefined;
	let acknowledgedIds: string[] | undefined;

	const config: ChildRuntimeConfig = {
		...(input.runId ? { runId: input.runId } : {}),
		agent: input.childAgentName,
		childIndex: input.childIndex,
		fanoutChild: fanout,
		...(input.sessionName?.trim() ? { sessionName: input.sessionName.trim() } : {}),
		...(input.intercomSessionName ? { intercomSessionName: input.intercomSessionName } : {}),
		...(input.orchestratorIntercomTarget ? { orchestratorTarget: input.orchestratorIntercomTarget } : {}),
		...(input.parentSessionId ? { orchestratorSessionId: input.parentSessionId, parentSessionId: input.parentSessionId } : {}),
		...(supervisorDir ? { supervisorChannelDir: supervisorDir } : {}),
		...(nestedRoute ? { nestedRoute } : {}),
		...(fanout && parentRunId ? { nestedParent: { parentRunId, parentChildIndex, depth: parentDepth, path: parentPath } } : {}),
		...(fanout && (input.runFanoutBudget ?? inherited?.runFanoutBudget) ? { runFanoutBudget: input.runFanoutBudget ?? inherited?.runFanoutBudget } : {}),
		depth: Number(depthEnv.PI_SUBAGENT_DEPTH),
		maxDepth: Number(depthEnv.PI_SUBAGENT_MAX_DEPTH),
		...(toolPlan.capabilityCeiling ? { capabilityCeiling: toolPlan.capabilityCeiling } : {}),
		...(thinkingCeiling ? { thinkingCeiling } : {}),
		inheritProjectContext: input.inheritProjectContext,
		inheritGlobalContext: input.inheritGlobalContext,
		inheritSkills: input.inheritSkills,
		...(input.forkCacheKey?.trim() ? { forkCacheKey: input.forkCacheKey.trim() } : {}),
		...(permissions ? { permissions } : {}),
		...(input.toolBudget ? { toolBudget: input.toolBudget } : {}),
		...(input.childWatchdog ? { childWatchdog: input.childWatchdog } : {}),
		...(input.watchdogStatus ? { watchdogStatus: input.watchdogStatus } : {}),
		waitTool: {
			enabled: input.waitToolEnabled ?? true,
			...(input.waitToolDefaultTimeoutMs !== undefined ? { defaultTimeoutMs: input.waitToolDefaultTimeoutMs } : {}),
		},
		...(input.structuredOutput
			? {
				structuredOutput: {
					schema: input.structuredOutput.schema,
					...(input.structuredOutput.acceptanceReportPath
						? { acceptanceReport: input.structuredOutput.acceptanceReportRequired ? "required" as const : "optional" as const }
						: {}),
					capture: (value: unknown, acceptanceReport: unknown) => {
						structuredCalled = true;
						structuredValue = value;
						structuredAcceptanceProvided = acceptanceReport !== undefined;
						structuredAcceptanceReport = acceptanceReport;
					},
				},
			}
			: {}),
		...(toolPlan.requiredChildTools.length > 0 ? { requiredTools: toolPlan.requiredChildTools } : {}),
		...(toolPlan.effectiveMcpTools.length > 0 ? { mcpDirectTools: toolPlan.effectiveMcpTools } : {}),
		toolDiagnostic: (diagnostic) => { toolDiagnostic = diagnostic; },
		runtimeAcknowledgements: (ids) => { acknowledgedIds = ids; },
		fast: input.fast === true,
	};

	const extensionPaths = toolPlan.extensionArgs.filter((extensionPath) => !isSubagentRuntimeExtensionPath(extensionPath));
	const launchResolvedExtensions = projectLaunchResolvedChildExtensions({
		runtimeExtensions: toolPlan.runtimeExtensions,
		configuredExtensions: toolPlan.configuredExtensions,
		extensionArgs: toolPlan.extensionArgs,
		disableAmbientExtensions: true,
	});
	const taggedPrompt = input.systemPrompt !== undefined && input.systemPrompt !== null
		? `<active_agent name="${escapeXmlAttr(input.childAgentName)}"/>\n\n${input.systemPrompt}`
		: undefined;
	const session: Omit<ChildSessionLaunch, "onExtensionError"> = {
		cwd: input.cwd,
		storage: childStorage(input),
		...(input.model ? { model: input.model } : {}),
		...(toolPlan.explicitToolAllowlist ? { tools: toolPlan.effectiveToolAllowlist } : {}),
		...(!toolPlan.explicitToolAllowlist && toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
		extensionPaths,
		hooks: createChildHooks(config),
		runtime: config,
		noSkills: !input.inheritSkills,
		noContextFiles: !input.inheritProjectContext,
		...(taggedPrompt !== undefined
			? input.systemPromptMode === "replace" ? { systemPrompt: taggedPrompt } : { appendSystemPrompt: taggedPrompt }
			: {}),
	};

	return {
		toolPlan,
		config,
		session,
		capture: {
			structuredOutput: () => ({ called: structuredCalled, value: structuredValue, acceptanceReport: structuredAcceptanceReport, acceptanceReportProvided: structuredAcceptanceProvided }),
			toolDiagnostic: () => toolDiagnostic,
			runtimeAcknowledgedExtensions: () => (acknowledgedIds ? projectRuntimeAcknowledgedExtensions(acknowledgedIds) : undefined),
		},
		launchResolvedExtensions,
		warnings: toolPlan.warnings,
		...(toolPlan.capabilityAudit ? { capabilityAudit: toolPlan.capabilityAudit } : {}),
	};
}

export function intersectInheritedCapabilityCeiling(
	ceiling: ResolvedSubagentCapabilityCeiling | undefined,
	inherited: ChildRuntimeConfig | undefined,
	envCeiling: ResolvedSubagentCapabilityCeiling | undefined,
): ResolvedSubagentCapabilityCeiling | undefined {
	return intersectSubagentCapabilityCeilings(ceiling, inherited ? inherited.capabilityCeiling : envCeiling);
}
