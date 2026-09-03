import type { JsonSchemaObject, ResolvedToolBudget, RunFanoutBudgetDescriptor } from "../../shared/types.ts";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import type { NestedPathEntry } from "./nested-path.ts";
import type { PermissionRules } from "./permissions.ts";
import type { ChildWatchdogConfig, ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import type { ResolvedWaitToolConfig } from "../background/wait-config.ts";
import type { ChildToolDiagnostic } from "./tool-availability.ts";
import type { ResolvedSubagentCapabilityCeiling } from "./capability-ceiling.ts";

/**
 * Set in processes that host child sessions (the async runner). The extension
 * entry point registers nothing when it sees it, so an ambient copy of
 * pi-subagents loaded into a child session stays inert.
 */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Root parent session id the parent publishes for pi-permission-system ask forwarding. */
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

export interface ChildNestedRoute {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface ChildNestedParent {
	parentRunId: string;
	parentChildIndex?: number;
	depth: number;
	path: NestedPathEntry[];
}

export interface ChildPermissions {
	rules: PermissionRules;
	auditPath?: string;
}

export interface ChildStructuredOutput {
	schema: JsonSchemaObject;
	acceptanceReport?: "optional" | "required";
	/** Receives the validated value; `acceptanceReport` is undefined when the child omitted it. */
	capture: (value: unknown, acceptanceReport: unknown | undefined) => void;
}

export interface ChildSupervisorMetadata {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: number;
	orchestratorTarget?: string;
	orchestratorSessionId: string;
	childTarget?: string;
}

/**
 * Everything the child-side hooks need to know about the launch. The process
 * that hosts the child session builds it and passes it to the hooks directly.
 */
export interface ChildRuntimeConfig {
	runId?: string;
	agent?: string;
	childIndex?: number;
	fanoutChild: boolean;
	sessionName?: string;
	intercomSessionName?: string;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	parentSessionId?: string;
	supervisorChannelDir?: string;
	/** Route the child reports nested runs on; set only for fanout-authorized children. */
	nestedRoute?: ChildNestedRoute;
	nestedParent?: ChildNestedParent;
	runFanoutBudget?: RunFanoutBudgetDescriptor;
	/** Nesting depth of this child (1 for a top-level parent's child). */
	depth: number;
	maxDepth?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	thinkingCeiling?: ThinkingLevel;
	inheritProjectContext?: boolean;
	inheritGlobalContext?: boolean;
	inheritSkills?: boolean;
	forkCacheKey?: string;
	permissions?: ChildPermissions;
	toolBudget?: ResolvedToolBudget;
	childWatchdog?: ChildWatchdogConfig;
	/** Receives child watchdog status events. */
	watchdogStatus?: (event: ChildWatchdogStatusEvent) => void;
	waitTool: ResolvedWaitToolConfig;
	structuredOutput?: ChildStructuredOutput;
	requiredTools?: string[];
	mcpDirectTools?: string[];
	/** Receives the tool-availability diagnostic at every agent start; undefined when every required tool is present. */
	toolDiagnostic?: (diagnostic: ChildToolDiagnostic | undefined) => void;
	/** Receives the runtime-acknowledged extension ids when the child run ends. */
	runtimeAcknowledgements?: (ids: string[]) => void;
	fast: boolean;
}

export function childSupervisorMetadata(config: ChildRuntimeConfig): ChildSupervisorMetadata | undefined {
	if (!config.supervisorChannelDir || !config.runId || !config.agent || !config.orchestratorSessionId || config.childIndex === undefined) return undefined;
	return {
		channelDir: config.supervisorChannelDir,
		runId: config.runId,
		agent: config.agent,
		childIndex: config.childIndex,
		...(config.orchestratorTarget ? { orchestratorTarget: config.orchestratorTarget } : {}),
		orchestratorSessionId: config.orchestratorSessionId,
		...(config.intercomSessionName ? { childTarget: config.intercomSessionName } : {}),
	};
}

/** Compute the child tool-availability diagnostic; undefined when every required tool is present. */
export function evaluateChildToolDiagnostic(config: Pick<ChildRuntimeConfig, "agent" | "requiredTools" | "mcpDirectTools">, availableTools: string[]): ChildToolDiagnostic | undefined {
	if (!config.requiredTools) return undefined;
	const available = new Set(availableTools);
	const missing = config.requiredTools.filter((name) => !available.has(name));
	if (missing.length === 0) return undefined;
	const missingMcpDirectTools = config.mcpDirectTools?.length ? missing.filter((name) => config.mcpDirectTools!.includes(name)) : [];
	return {
		...(config.agent ? { agent: config.agent } : {}),
		required: config.requiredTools,
		available: availableTools,
		missing,
		...(missingMcpDirectTools.length > 0 ? { missingMcpDirectTools } : {}),
	};
}
