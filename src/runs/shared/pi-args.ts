import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNestedPathEnv, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { resolveMcpDirectToolSelections, type ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-allowlist.ts";
import { resolvePiPackageRoot } from "./pi-spawn.ts";
import { RUNTIME_EXTENSION_ACK_PATH_ENV } from "./runtime-acknowledged-extensions.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.ts";
import { TEMP_ROOT_DIR, type JsonSchemaObject, type LaunchResolvedChildExtensionsV1, type ResolvedToolBudget } from "../../shared/types.ts";
import { THINKING_LEVELS } from "../../shared/model-info.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV, encodeToolBudgetEnv } from "./tool-budget.ts";
import { CHILD_TOOL_DIAGNOSTIC_PATH_ENV, MCP_DIRECT_CHILD_TOOLS_ENV, REQUIRED_CHILD_TOOLS_ENV } from "./tool-availability.ts";
import { CHILD_WATCHDOG_CONFIG_ENV, encodeChildWatchdogConfig, type ChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { WAIT_TOOL_ENABLED_ENV } from "../background/wait-config.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { encodePermissionRules, PERMISSION_AUDIT_PATH_ENV, PERMISSION_POLICY_ENV, type PermissionRules } from "./permissions.ts";
import { SUBAGENT_CAPABILITY_CEILING_ENV, capabilityCeilingAgentRestrictionSources, decodeSubagentCapabilityCeiling, encodeSubagentCapabilityCeiling, intersectSubagentCapabilityCeilings, isAgentAllowedByCapabilityCeiling, type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "./capability-ceiling.ts";

const TASK_ARG_LIMIT = 8000;
const MAX_LAUNCH_RESOLVED_EXTENSION_IDS = 32;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-prompt-runtime.ts");
const FANOUT_CHILD_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "fanout-child.ts");
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID";
export const SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV = "PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
export const SUBAGENT_PARENT_EVENT_SINK_ENV = "PI_SUBAGENT_PARENT_EVENT_SINK";
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = "PI_SUBAGENT_PARENT_CONTROL_INBOX";
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_ROOT_RUN_ID";
export const SUBAGENT_PARENT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_RUN_ID";
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = "PI_SUBAGENT_PARENT_CHILD_INDEX";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN";
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export const SUBAGENT_STEER_INBOX_ENV = "PI_SUBAGENT_STEER_INBOX";
export const SUBAGENT_STEER_CAPABILITY_ENV = "PI_SUBAGENT_STEER_CAPABILITY";
export const SUBAGENT_STEER_ACK_DIR_ENV = "PI_SUBAGENT_STEER_ACK_DIR";
export const PI_INTERCOM_STABLE_ID_ENV = "PI_INTERCOM_STABLE_ID";
export const PI_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";

export interface BuildPiArgsInput {
	parentSessionId?: string;
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string | false;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	requireReadTool?: boolean;
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	parentEventSink?: string;
	parentControlInbox?: string;
	parentRootRunId?: string;
	parentRunId?: string;
	parentChildIndex?: number;
	parentDepth?: number;
	parentPath?: NestedPathEntry[];
	parentCapabilityToken?: string;
	steerInboxDir?: string;
	steerCapabilityPath?: string;
	steerAckDir?: string;
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	toolBudget?: ResolvedToolBudget;
	allowZeroToolBudget?: boolean;
	permissionRules?: PermissionRules;
	permissionAuditPath?: string;
	childWatchdog?: ChildWatchdogConfig;
	waitToolEnabled?: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
	toolDiagnosticPath?: string;
	runtimeAcknowledgedExtensionsPath?: string;
	capabilityAudit?: SubagentCapabilityAudit;
}

function sanitizeSupervisorChannelSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function supervisorChannelDir(runId: string, agent: string, childIndex: number): string {
	return path.join(TEMP_ROOT_DIR, "supervisor-channels", `${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`);
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | false | undefined, replaceExisting = false): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

export interface ResolvePiLaunchToolPlanInput {
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	cwd?: string;
	requireReadTool?: boolean;
	structuredOutput?: boolean | {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	agentName?: string;
}

export interface PiLaunchToolPlan {
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	requestedBuiltinTools: string[];
	declaredBuiltinTools: string[];
	toolExtensionPaths: string[];
	resolvedMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpTools: string[];
	explicitToolAllowlist: boolean;
	internalTools: string[];
	effectiveToolAllowlist: string[];
	requiredChildTools: string[];
	fanoutAuthorized: boolean;
	runtimeExtensions: string[];
	configuredExtensions: string[];
	extensionArgs: string[];
	disableAmbientExtensions: boolean;
	capabilityAudit?: SubagentCapabilityAudit;
}

function extensionIdentifier(value: string): string {
	return `sha256:${createHash("sha256").update(path.normalize(value.trim())).digest("hex").slice(0, 16)}`;
}

function boundedExtensionIdentifiers(values: string[]): { ids: string[]; omitted: number } {
	const ids = [...new Set(values.map(extensionIdentifier))];
	return {
		ids: ids.slice(0, MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
		omitted: Math.max(0, ids.length - MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
	};
}

export function projectLaunchResolvedChildExtensions(toolPlan: Pick<PiLaunchToolPlan, "runtimeExtensions" | "configuredExtensions" | "extensionArgs" | "disableAmbientExtensions">): LaunchResolvedChildExtensionsV1 {
	const runtime = boundedExtensionIdentifiers(toolPlan.runtimeExtensions);
	const configured = boundedExtensionIdentifiers(toolPlan.configuredExtensions);
	const effective = boundedExtensionIdentifiers(toolPlan.extensionArgs);
	return {
		version: 1,
		source: "launch-resolved",
		disableAmbientExtensions: toolPlan.disableAmbientExtensions,
		runtime: runtime.ids,
		configured: configured.ids,
		effective: effective.ids,
		omitted: {
			runtime: runtime.omitted,
			configured: configured.omitted,
			effective: effective.omitted,
		},
	};
}

export function resolvePiLaunchToolPlan(input: ResolvePiLaunchToolPlanInput): PiLaunchToolPlan {
	const capabilityCeiling = intersectSubagentCapabilityCeilings(input.capabilityCeiling, input.inheritedCapabilityCeiling);
	const allowedToolSet = capabilityCeiling?.allowedTools === undefined ? undefined : new Set(capabilityCeiling.allowedTools);
	const requestedBuiltinTools = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	if (input.requireReadTool && allowedToolSet && !allowedToolSet.has("read")) {
		throw new Error(`Capability ceiling from ${capabilityCeiling?.sources.join(", ") || "unknown source"} excludes required tool 'read' for lazy skill loading.`);
	}
	const declaredBuiltinTools = input.tools === undefined
		? (allowedToolSet ? [...allowedToolSet] : [])
		: (input.requireReadTool && requestedBuiltinTools.length > 0 && !requestedBuiltinTools.includes("read") && !allowedToolSet
			? ["read", ...requestedBuiltinTools]
			: requestedBuiltinTools).filter((tool) => !allowedToolSet || allowedToolSet.has(tool));
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = capabilityCeiling?.denyExtensions ? [] : (input.tools ?? []).filter((tool) => !requestedBuiltinTools.includes(tool) && (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")));
	const resolvedMcpSelections = capabilityCeiling?.denyExtensions ? [] : resolveMcpDirectToolSelections(input.mcpDirectTools, input.cwd);
	const effectiveMcpSelections = resolvedMcpSelections.filter((selection) => !allowedToolSet || allowedToolSet.has(selection.name));
	const effectiveMcpTools = effectiveMcpSelections.map((selection) => selection.name);
	const explicitToolAllowlist = input.tools !== undefined || (input.mcpDirectTools?.length ?? 0) > 0 || allowedToolSet !== undefined;
	const internalTools = input.structuredOutput ? ["structured_output"] : [];
	const effectiveToolAllowlist = [...new Set([...declaredBuiltinTools, ...effectiveMcpTools, ...internalTools])];
	const requiredChildTools = explicitToolAllowlist ? [...new Set([
		...(input.tools !== undefined ? declaredBuiltinTools : []),
		...(input.mcpDirectTools?.length ? effectiveMcpTools : []),
		...internalTools,
	])] : [];
	const runtimeExtensions = fanoutAuthorized
		? [PROMPT_RUNTIME_EXTENSION_PATH, FANOUT_CHILD_EXTENSION_PATH]
		: [PROMPT_RUNTIME_EXTENSION_PATH];
	const disableAmbientExtensions = capabilityCeiling?.denyExtensions === true || input.extensions !== undefined;
	const configuredExtensions = capabilityCeiling?.denyExtensions ? [] : [...toolExtensionPaths, ...(input.extensions ?? []), ...(input.subagentOnlyExtensions ?? [])];
	const extensionArgs = disableAmbientExtensions
		? [...new Set([...runtimeExtensions, ...configuredExtensions])]
		: [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...(input.subagentOnlyExtensions ?? [])])];
	const requestedToolNames = input.tools !== undefined
		? [...new Set([...requestedBuiltinTools, ...resolvedMcpSelections.map((selection) => selection.name)])]
		: undefined;
	const capabilityAudit = capabilityCeiling ? {
		ceiling: capabilityCeiling,
		...(requestedToolNames ? { requestedTools: requestedToolNames } : {}),
		effectiveTools: effectiveToolAllowlist,
		removedTools: requestedToolNames?.filter((tool) => !effectiveToolAllowlist.includes(tool)) ?? [],
		internalTools,
		extensionsDenied: capabilityCeiling.denyExtensions,
		removedExtensionCount: capabilityCeiling.denyExtensions ? (input.extensions?.length ?? 0) + (input.subagentOnlyExtensions?.length ?? 0) + ((input.tools ?? []).filter((tool) => tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")).length) : 0,
		requestedMcpToolCount: input.mcpDirectTools?.length ?? 0,
		effectiveMcpTools,
		agentAllowed: input.agentName === undefined ? true : isAgentAllowedByCapabilityCeiling(input.agentName, capabilityCeiling),
		...(capabilityCeilingAgentRestrictionSources(capabilityCeiling) ? { agentRestrictionSources: capabilityCeilingAgentRestrictionSources(capabilityCeiling) } : {}),
	} satisfies SubagentCapabilityAudit : undefined;
	return {
		...(capabilityCeiling ? { capabilityCeiling } : {}),
		requestedBuiltinTools,
		declaredBuiltinTools,
		toolExtensionPaths,
		resolvedMcpSelections,
		effectiveMcpSelections,
		effectiveMcpTools,
		explicitToolAllowlist,
		internalTools,
		effectiveToolAllowlist,
		requiredChildTools,
		fanoutAuthorized,
		runtimeExtensions,
		configuredExtensions,
		extensionArgs,
		disableAmbientExtensions,
		...(capabilityAudit ? { capabilityAudit } : {}),
	};
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	const toolPlan = resolvePiLaunchToolPlan({
		tools: input.tools,
		extensions: input.extensions,
		subagentOnlyExtensions: input.subagentOnlyExtensions,
		mcpDirectTools: input.mcpDirectTools,
		cwd: input.cwd,
		requireReadTool: input.requireReadTool,
		structuredOutput: input.structuredOutput,
		capabilityCeiling: input.capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
		agentName: input.childAgentName,
	});
	if (toolPlan.explicitToolAllowlist) {
		args.push(toolPlan.effectiveToolAllowlist.length > 0 ? "--tools" : "--no-tools");
		if (toolPlan.effectiveToolAllowlist.length > 0) args.push(toolPlan.effectiveToolAllowlist.join(","));
	}
	if (toolPlan.disableAmbientExtensions) {
		args.push("--no-extensions");
	}
	for (const extPath of toolPlan.extensionArgs) args.push("--extension", extPath);

	if (!input.inheritProjectContext) {
		args.push("--no-context-files");
	}
	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	const piPackageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] ?? resolvePiPackageRoot();
	if (piPackageRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = piPackageRoot;
	if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const runtimeAcknowledgedExtensionsPath = path.join(tempDir, "runtime-acknowledged-extensions.json");
	env[RUNTIME_EXTENSION_ACK_PATH_ENV] = runtimeAcknowledgedExtensionsPath;
	let toolDiagnosticPath: string | undefined;
	if (toolPlan.requiredChildTools.length > 0) {
		if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		toolDiagnosticPath = path.join(tempDir, "tool-diagnostic.json");
		env[REQUIRED_CHILD_TOOLS_ENV] = JSON.stringify(toolPlan.requiredChildTools);
		env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV] = toolDiagnosticPath;
	}
	env[MCP_DIRECT_CHILD_TOOLS_ENV] = toolPlan.effectiveMcpTools.length > 0 ? JSON.stringify(toolPlan.effectiveMcpTools) : undefined;
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = toolPlan.fanoutAuthorized ? "1" : "0";
	if (input.waitToolEnabled !== undefined) {
		env[WAIT_TOOL_ENABLED_ENV] = input.waitToolEnabled ? "true" : "false";
	}
	const inheritedNestedRoute = Boolean(process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] && process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] && process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]);
	const parentRunId = input.parentRunId ?? input.runId ?? (inheritedNestedRoute ? process.env[SUBAGENT_RUN_ID_ENV] : undefined) ?? process.env[SUBAGENT_PARENT_RUN_ID_ENV] ?? "";
	const parentChildIndex = input.parentChildIndex !== undefined
		? String(input.parentChildIndex)
		: input.childIndex !== undefined
			? String(input.childIndex)
			: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] ?? "";
	const inheritedDepth = Number(process.env[SUBAGENT_PARENT_DEPTH_ENV]);
	const parentDepth = input.parentDepth ?? (inheritedNestedRoute && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : 1);
	const parentPath = input.parentPath ?? [
		...parseNestedPathEnv(process.env[SUBAGENT_PARENT_PATH_ENV]),
		...(parentRunId ? [{
			runId: parentRunId,
			...(parentChildIndex && /^\d+$/.test(parentChildIndex) ? { stepIndex: Number(parentChildIndex) } : {}),
			...(input.childAgentName ? { agent: input.childAgentName } : {}),
		}] : []),
	];
	env[SUBAGENT_PARENT_EVENT_SINK_ENV] = toolPlan.fanoutAuthorized
		? input.parentEventSink ?? process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] ?? ""
		: "";
	env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = toolPlan.fanoutAuthorized
		? input.parentControlInbox ?? process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] ?? ""
		: "";
	env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = toolPlan.fanoutAuthorized
		? input.parentRootRunId ?? process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] ?? input.runId ?? ""
		: "";
	env[SUBAGENT_PARENT_RUN_ID_ENV] = toolPlan.fanoutAuthorized ? parentRunId : "";
	env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = toolPlan.fanoutAuthorized ? parentChildIndex : "";
	env[SUBAGENT_PARENT_DEPTH_ENV] = toolPlan.fanoutAuthorized ? String(parentDepth) : "";
	env[SUBAGENT_PARENT_PATH_ENV] = toolPlan.fanoutAuthorized ? encodeNestedPathEnv(parentPath) : "";
	env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = toolPlan.fanoutAuthorized
		? input.parentCapabilityToken ?? process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] ?? ""
		: "";
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
	env[PI_INTERCOM_STABLE_ID_ENV] = input.intercomSessionName || undefined;
	env[PI_INTERCOM_SESSION_ID_ENV] = undefined;
	if (input.intercomSessionName) {
		env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	if (input.parentSessionId) {
		env[SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV] = input.parentSessionId;
	}
	const encodedPermissionRules = encodePermissionRules(input.permissionRules);
	if (input.orchestratorIntercomTarget && input.parentSessionId && input.runId && input.childAgentName) {
		const childIndex = input.childIndex ?? 0;
		const channelDir = supervisorChannelDir(input.runId, input.childAgentName, childIndex);
		fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true });
		fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true });
		env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
	}
	if (encodedPermissionRules) env[PERMISSION_AUDIT_PATH_ENV] = input.permissionAuditPath ?? path.join(tempDir, "permission-audit.jsonl");
	if (input.runId) {
		env[SUBAGENT_RUN_ID_ENV] = input.runId;
	}
	if (input.childAgentName) {
		env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
	}
	if (input.childIndex !== undefined) {
		env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	}
	if (!toolPlan.capabilityCeiling && input.mcpDirectTools?.length) env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	else if (toolPlan.capabilityCeiling && toolPlan.effectiveMcpSelections.length && !toolPlan.capabilityCeiling.denyExtensions) env.MCP_DIRECT_TOOLS = toolPlan.effectiveMcpSelections.map((selection) => selection.selector).join(",");
	else env.MCP_DIRECT_TOOLS = "__none__";
	const encodedCapabilityCeiling = encodeSubagentCapabilityCeiling(toolPlan.capabilityCeiling);
	if (encodedCapabilityCeiling) env[SUBAGENT_CAPABILITY_CEILING_ENV] = encodedCapabilityCeiling;
	if (encodedPermissionRules) env[PERMISSION_POLICY_ENV] = encodedPermissionRules;
	if (input.structuredOutput) {
		env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
		env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
	}
	if (input.steerInboxDir) {
		env[SUBAGENT_STEER_INBOX_ENV] = input.steerInboxDir;
	}
	if (input.steerCapabilityPath) env[SUBAGENT_STEER_CAPABILITY_ENV] = input.steerCapabilityPath;
	if (input.steerAckDir) env[SUBAGENT_STEER_ACK_DIR_ENV] = input.steerAckDir;
	const encodedToolBudget = encodeToolBudgetEnv(input.toolBudget);
	if (encodedToolBudget) env[TOOL_BUDGET_ENV] = encodedToolBudget;
	env[TOOL_BUDGET_ZERO_AUTH_ENV] = input.allowZeroToolBudget ? "1" : undefined;
	const encodedChildWatchdog = encodeChildWatchdogConfig(input.childWatchdog);
	if (encodedChildWatchdog) env[CHILD_WATCHDOG_CONFIG_ENV] = encodedChildWatchdog;

	env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId ?? process.env[SUBAGENT_PARENT_SESSION_ENV] ?? "";

	return { args, env, tempDir, toolDiagnosticPath, runtimeAcknowledgedExtensionsPath, capabilityAudit: toolPlan.capabilityAudit };
}

export const parseParentPathEnv = parseNestedPathEnv;

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
