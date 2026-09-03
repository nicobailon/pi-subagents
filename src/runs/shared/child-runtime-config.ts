import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonSchemaObject, ResolvedToolBudget, RunFanoutBudgetDescriptor } from "../../shared/types.ts";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import { decodeThinkingCeiling, SUBAGENT_THINKING_CEILING_ENV } from "../../shared/thinking-ceiling.ts";
import { parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { decodeRunFanoutBudgetDescriptor, RUN_FANOUT_BUDGET_ENV } from "./run-fanout-budget.ts";
import { decodePermissionRules, PERMISSION_AUDIT_PATH_ENV, PERMISSION_POLICY_ENV, type PermissionRules } from "./permissions.ts";
import { decodeToolBudgetEnv, TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV } from "./tool-budget.ts";
import { CHILD_WATCHDOG_CONFIG_ENV, decodeChildWatchdogConfig, type ChildWatchdogConfig, type ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import { resolveWaitToolConfig, type ResolvedWaitToolConfig } from "../background/wait-config.ts";
import {
	STRUCTURED_OUTPUT_ACCEPTANCE_CAPTURE_ENV,
	STRUCTURED_OUTPUT_ACCEPTANCE_REQUIRED_ENV,
	STRUCTURED_OUTPUT_CAPTURE_ENV,
	STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "./structured-output.ts";
import { CHILD_TOOL_DIAGNOSTIC_PATH_ENV, MCP_DIRECT_CHILD_TOOLS_ENV, REQUIRED_CHILD_TOOLS_ENV, type ChildToolDiagnostic } from "./tool-availability.ts";
import { RUNTIME_EXTENSION_ACK_PATH_ENV, writeRuntimeAcknowledgedExtensions } from "./runtime-acknowledged-extensions.ts";
import { decodeSubagentCapabilityCeiling, SUBAGENT_CAPABILITY_CEILING_ENV, type ResolvedSubagentCapabilityCeiling } from "./capability-ceiling.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_FORK_CACHE_KEY_ENV,
	SUBAGENT_INHERIT_GLOBAL_CONTEXT_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_CAPABILITY_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "./pi-args.ts";

export const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
export const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
/** Human-readable child display name (agent + task excerpt) set by the parent
 *  at launch; applied via pi.setSessionName when no intercom target exists. */
export const SUBAGENT_SESSION_NAME_ENV = "PI_SUBAGENT_SESSION_NAME";
export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";

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

export interface ChildSteerInbox {
	inboxDir: string;
	capabilityPath?: string;
	ackDir?: string;
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
 * Everything the child-side hooks need to know about the launch. Spawned
 * children read it from their environment once; in-process children receive it
 * from the parent directly.
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
	/** File inbox for steering; only spawned children have one. In-process children are steered through their session. */
	steerInbox?: ChildSteerInbox;
	permissions?: ChildPermissions;
	toolBudget?: ResolvedToolBudget;
	childWatchdog?: ChildWatchdogConfig;
	/** Receives child watchdog status; spawned children write it to stdout when unset. */
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

function text(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function index(env: NodeJS.ProcessEnv, name: string): number | undefined {
	const value = text(env, name);
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

function stringList(env: NodeJS.ProcessEnv, name: string, strict: boolean): string[] | undefined {
	const encoded = text(env, name);
	if (!encoded) return undefined;
	try {
		const parsed = JSON.parse(encoded) as unknown;
		if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry)) throw new Error(`Invalid ${name} payload.`);
		return parsed;
	} catch (error) {
		if (strict) throw error instanceof Error && error.message.startsWith("Invalid") ? error : new Error(`Invalid ${name} payload.`);
		return undefined;
	}
}

function nestedRouteFromEnv(env: NodeJS.ProcessEnv): ChildNestedRoute | undefined {
	const rootRunId = text(env, SUBAGENT_PARENT_ROOT_RUN_ID_ENV);
	const eventSink = text(env, SUBAGENT_PARENT_EVENT_SINK_ENV);
	const controlInbox = text(env, SUBAGENT_PARENT_CONTROL_INBOX_ENV);
	const capabilityToken = text(env, SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV);
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	return { rootRunId, eventSink, controlInbox, capabilityToken };
}

function nestedParentFromEnv(env: NodeJS.ProcessEnv): ChildNestedParent | undefined {
	const parentRunId = text(env, SUBAGENT_PARENT_RUN_ID_ENV);
	if (!parentRunId) return undefined;
	const parentChildIndex = index(env, SUBAGENT_PARENT_CHILD_INDEX_ENV);
	const rawDepth = Number(env[SUBAGENT_PARENT_DEPTH_ENV]);
	return {
		parentRunId,
		...(parentChildIndex !== undefined ? { parentChildIndex } : {}),
		depth: Number.isFinite(rawDepth) && rawDepth >= 1 ? rawDepth : 1,
		path: parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]),
	};
}

function structuredOutputFromEnv(env: NodeJS.ProcessEnv): ChildStructuredOutput | undefined {
	const outputPath = env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const schemaPath = env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (!outputPath || !schemaPath) return undefined;
	const acceptancePath = env[STRUCTURED_OUTPUT_ACCEPTANCE_CAPTURE_ENV];
	const acceptanceRequired = env[STRUCTURED_OUTPUT_ACCEPTANCE_REQUIRED_ENV] === "1";
	const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as JsonSchemaObject;
	return {
		schema,
		...(acceptancePath ? { acceptanceReport: acceptanceRequired ? "required" : "optional" } : {}),
		capture: (value, acceptanceReport) => {
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			if (acceptancePath && acceptanceReport !== undefined) {
				fs.mkdirSync(path.dirname(acceptancePath), { recursive: true });
				fs.writeFileSync(acceptancePath, JSON.stringify(acceptanceReport), { mode: 0o600 });
			} else if (acceptancePath && fs.existsSync(acceptancePath)) {
				fs.unlinkSync(acceptancePath);
			}
			fs.writeFileSync(outputPath, JSON.stringify(value), { mode: 0o600 });
		},
	};
}

/** Whether this process is a spawned pi-subagents child. */
export function isSpawnedChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

/**
 * Build the child runtime configuration from the environment a spawned child
 * received at launch. Background children call this once when their runtime
 * extension loads.
 */
export function readChildRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChildRuntimeConfig {
	const steerInboxDir = text(env, SUBAGENT_STEER_INBOX_ENV);
	const permissionRules = decodePermissionRules(env[PERMISSION_POLICY_ENV]);
	const permissionAuditPath = text(env, PERMISSION_AUDIT_PATH_ENV);
	const toolDiagnosticPath = text(env, CHILD_TOOL_DIAGNOSTIC_PATH_ENV);
	const runtimeAckPath = text(env, RUNTIME_EXTENSION_ACK_PATH_ENV);
	const rawDepth = Number(env[SUBAGENT_DEPTH_ENV]);
	const rawMaxDepth = Number(env[SUBAGENT_MAX_DEPTH_ENV]);
	const agent = text(env, SUBAGENT_CHILD_AGENT_ENV);
	const childIndex = index(env, SUBAGENT_CHILD_INDEX_ENV);
	const structuredOutput = structuredOutputFromEnv(env);
	return {
		...(text(env, SUBAGENT_RUN_ID_ENV) ? { runId: text(env, SUBAGENT_RUN_ID_ENV) } : {}),
		...(agent ? { agent } : {}),
		...(childIndex !== undefined ? { childIndex } : {}),
		fanoutChild: env[SUBAGENT_FANOUT_CHILD_ENV] === "1",
		...(text(env, SUBAGENT_SESSION_NAME_ENV) ? { sessionName: text(env, SUBAGENT_SESSION_NAME_ENV) } : {}),
		...(text(env, SUBAGENT_INTERCOM_SESSION_NAME_ENV) ? { intercomSessionName: text(env, SUBAGENT_INTERCOM_SESSION_NAME_ENV) } : {}),
		...(text(env, SUBAGENT_ORCHESTRATOR_TARGET_ENV) ? { orchestratorTarget: text(env, SUBAGENT_ORCHESTRATOR_TARGET_ENV) } : {}),
		...(text(env, SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV) ? { orchestratorSessionId: text(env, SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV) } : {}),
		...(text(env, SUBAGENT_PARENT_SESSION_ENV) ? { parentSessionId: text(env, SUBAGENT_PARENT_SESSION_ENV) } : {}),
		...(text(env, SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV) ? { supervisorChannelDir: text(env, SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV) } : {}),
		...(nestedRouteFromEnv(env) ? { nestedRoute: nestedRouteFromEnv(env) } : {}),
		...(nestedParentFromEnv(env) ? { nestedParent: nestedParentFromEnv(env) } : {}),
		...(decodeRunFanoutBudgetDescriptor(env[RUN_FANOUT_BUDGET_ENV]) ? { runFanoutBudget: decodeRunFanoutBudgetDescriptor(env[RUN_FANOUT_BUDGET_ENV]) } : {}),
		depth: Number.isFinite(rawDepth) ? rawDepth : 0,
		...(Number.isFinite(rawMaxDepth) ? { maxDepth: rawMaxDepth } : {}),
		...(decodeSubagentCapabilityCeiling(env[SUBAGENT_CAPABILITY_CEILING_ENV]) ? { capabilityCeiling: decodeSubagentCapabilityCeiling(env[SUBAGENT_CAPABILITY_CEILING_ENV]) } : {}),
		...(decodeThinkingCeiling(env[SUBAGENT_THINKING_CEILING_ENV]) ? { thinkingCeiling: decodeThinkingCeiling(env[SUBAGENT_THINKING_CEILING_ENV]) } : {}),
		...(flag(env, SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV) !== undefined ? { inheritProjectContext: flag(env, SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV) } : {}),
		...(flag(env, SUBAGENT_INHERIT_GLOBAL_CONTEXT_ENV) !== undefined ? { inheritGlobalContext: flag(env, SUBAGENT_INHERIT_GLOBAL_CONTEXT_ENV) } : {}),
		...(flag(env, SUBAGENT_INHERIT_SKILLS_ENV) !== undefined ? { inheritSkills: flag(env, SUBAGENT_INHERIT_SKILLS_ENV) } : {}),
		...(text(env, SUBAGENT_FORK_CACHE_KEY_ENV) ? { forkCacheKey: text(env, SUBAGENT_FORK_CACHE_KEY_ENV) } : {}),
		...(steerInboxDir
			? {
				steerInbox: {
					inboxDir: steerInboxDir,
					...(text(env, SUBAGENT_STEER_CAPABILITY_ENV) ? { capabilityPath: text(env, SUBAGENT_STEER_CAPABILITY_ENV) } : {}),
					...(text(env, SUBAGENT_STEER_ACK_DIR_ENV) ? { ackDir: text(env, SUBAGENT_STEER_ACK_DIR_ENV) } : {}),
				},
			}
			: {}),
		...(permissionRules ? { permissions: { rules: permissionRules, ...(permissionAuditPath ? { auditPath: permissionAuditPath } : {}) } } : {}),
		...(decodeToolBudgetEnv(env[TOOL_BUDGET_ENV], { allowZero: env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" })
			? { toolBudget: decodeToolBudgetEnv(env[TOOL_BUDGET_ENV], { allowZero: env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" }) }
			: {}),
		...(decodeChildWatchdogConfig(env[CHILD_WATCHDOG_CONFIG_ENV]) ? { childWatchdog: decodeChildWatchdogConfig(env[CHILD_WATCHDOG_CONFIG_ENV]) } : {}),
		waitTool: resolveWaitToolConfig(undefined, env),
		...(structuredOutput ? { structuredOutput } : {}),
		...(stringList(env, REQUIRED_CHILD_TOOLS_ENV, true) ? { requiredTools: stringList(env, REQUIRED_CHILD_TOOLS_ENV, true) } : {}),
		...(stringList(env, MCP_DIRECT_CHILD_TOOLS_ENV, false) ? { mcpDirectTools: stringList(env, MCP_DIRECT_CHILD_TOOLS_ENV, false) } : {}),
		...(toolDiagnosticPath
			? {
				toolDiagnostic: (diagnostic: ChildToolDiagnostic | undefined) => {
					if (!diagnostic) {
						fs.rmSync(toolDiagnosticPath, { force: true });
						return;
					}
					fs.mkdirSync(path.dirname(toolDiagnosticPath), { recursive: true });
					fs.writeFileSync(toolDiagnosticPath, JSON.stringify(diagnostic), { mode: 0o600 });
				},
			}
			: {}),
		...(runtimeAckPath ? { runtimeAcknowledgements: (ids: string[]) => writeRuntimeAcknowledgedExtensions(runtimeAckPath, ids) } : {}),
		fast: false,
	};
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
