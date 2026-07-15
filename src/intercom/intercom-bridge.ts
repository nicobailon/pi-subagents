import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import type { ExtensionConfig, IntercomBridgeConfig, IntercomBridgeMode } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

export const NATIVE_INTERCOM_EXTENSION_DIR = "native:pi-subagents-supervisor-channel";

function defaultAgentDir(): string {
	return getAgentDir();
}

function defaultSubagentConfigDir(agentDir = defaultAgentDir()): string {
	return path.join(agentDir, "extensions", "subagent");
}

const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the supervisor in normal assistant text.

Use contact_supervisor first. It resolves the supervisor session "{orchestratorTarget}" and run metadata automatically.
- Need a decision, blocked, approval, or product/API/scope ambiguity: contact_supervisor({ reason: "need_decision", message: "<question>" })
- Need structured supervisor input rather than a freeform reply: contact_supervisor({ reason: "interview_request", message: "<what input is needed>", interview: { title: "...", questions: [] } })
- After contact_supervisor with reason "need_decision" or "interview_request", stay alive and continue only after the reply arrives. Do not finish your final response with a choose-one question.
- Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions. If an output path is configured but no write-capable tool is available, return the complete artifact in your final response; the runtime will persist it. Do not contact the supervisor merely because you cannot write that output path directly.
- Meaningful progress or unexpected discoveries that change the plan: contact_supervisor({ reason: "progress_update", message: "UPDATE: <summary>" })
- Generic intercom is lower-level plumbing/fallback only: intercom({ action: "ask", to: "{orchestratorTarget}", message: "<question>" })

Do not use contact_supervisor or intercom for routine completion handoffs. If no coordination is needed, return a focused task result.`;

export interface IntercomBridgeState {
	active: boolean;
	mode: IntercomBridgeMode;
	orchestratorTarget?: string;
	extensionDir: string;
	instruction: string;
}

export interface IntercomBridgeDiagnostic {
	active: boolean;
	mode: IntercomBridgeMode;
	wantsIntercom: boolean;
	supervisorChannelAvailable: boolean;
	extensionDir: string;
	orchestratorTarget?: string;
	reason?: string;
}

interface ResolveIntercomBridgeInput {
	config: ExtensionConfig["intercomBridge"];
	context: "fresh" | "fork" | undefined;
	orchestratorTarget?: string;
	settingsDir?: string;
	agentDir?: string;
}

export function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string): string {
	const trimmedName = sessionName?.trim();
	if (trimmedName) return trimmedName;
	const normalizedSessionId = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
	return `${DEFAULT_INTERCOM_TARGET_PREFIX}-${normalizedSessionId.slice(0, 8)}`;
}

function sanitizeIntercomTargetPart(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

export function resolveSubagentIntercomTarget(runId: string, agent: string, index?: number): string {
	const stepSuffix = index !== undefined ? `-${index + 1}` : "";
	return `subagent-${sanitizeIntercomTargetPart(agent)}-${sanitizeIntercomTargetPart(runId)}${stepSuffix}`;
}

export function resolveIntercomBridgeMode(value: unknown): IntercomBridgeMode {
	if (value === "off" || value === "always" || value === "fork-only") return value;
	return "always";
}

function resolveIntercomBridgeConfig(value: ExtensionConfig["intercomBridge"]): Required<IntercomBridgeConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { mode: "always", instructionFile: "" };
	}
	return {
		mode: resolveIntercomBridgeMode(value.mode),
		instructionFile: typeof value.instructionFile === "string" ? value.instructionFile : "",
	};
}

function expandTilde(filePath: string): string {
	return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}

function resolveInstructionTemplate(instructionFile: string, settingsDir: string): string {
	if (!instructionFile) return DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
	const expandedPath = expandTilde(instructionFile);
	const resolvedPath = path.isAbsolute(expandedPath)
		? expandedPath
		: path.resolve(settingsDir, expandedPath);
	try {
		return fs.readFileSync(resolvedPath, "utf-8");
	} catch (error) {
		console.warn(`Failed to read intercom bridge instructionFile at '${resolvedPath}'. Using default instructions.`, error);
		return DEFAULT_INTERCOM_BRIDGE_TEMPLATE;
	}
}

function buildIntercomBridgeInstruction(orchestratorTarget: string, template: string): string {
	const instruction = template.replaceAll("{orchestratorTarget}", orchestratorTarget).trim();
	if (instruction.startsWith(INTERCOM_BRIDGE_MARKER)) return instruction;
	return `${INTERCOM_BRIDGE_MARKER}\n${instruction}`;
}

function inactiveReason(mode: IntercomBridgeMode, context: "fresh" | "fork" | undefined, orchestratorTarget: string | undefined): string | undefined {
	if (mode === "off") return "bridge mode is off";
	if (mode === "fork-only" && context !== "fork") return "bridge mode is fork-only and context is not fork";
	if (!orchestratorTarget) return "orchestrator target is not available";
	return undefined;
}

export function diagnoseIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeDiagnostic {
	const config = resolveIntercomBridgeConfig(input.config);
	const mode = config.mode;
	const orchestratorTarget = input.orchestratorTarget?.trim();
	const wantsIntercom = mode !== "off" && !(mode === "fork-only" && input.context !== "fork");
	const reason = inactiveReason(mode, input.context, orchestratorTarget);
	return {
		active: reason === undefined,
		mode,
		wantsIntercom,
		supervisorChannelAvailable: true,
		extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
		...(orchestratorTarget ? { orchestratorTarget } : {}),
		...(reason ? { reason } : {}),
	};
}

export function resolveIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeState {
	const config = resolveIntercomBridgeConfig(input.config);
	const mode = config.mode;
	const orchestratorTarget = input.orchestratorTarget?.trim();
	const agentDir = path.resolve(input.agentDir ?? defaultAgentDir());
	const settingsDir = path.resolve(input.settingsDir ?? defaultSubagentConfigDir(agentDir));
	const defaultInstruction = buildIntercomBridgeInstruction(
		orchestratorTarget || "{orchestratorTarget}",
		DEFAULT_INTERCOM_BRIDGE_TEMPLATE,
	);
	const reason = inactiveReason(mode, input.context, orchestratorTarget);
	if (reason || !orchestratorTarget) {
		return { active: false, mode, extensionDir: NATIVE_INTERCOM_EXTENSION_DIR, instruction: defaultInstruction };
	}
	return {
		active: true,
		mode,
		orchestratorTarget,
		extensionDir: NATIVE_INTERCOM_EXTENSION_DIR,
		instruction: buildIntercomBridgeInstruction(orchestratorTarget, resolveInstructionTemplate(config.instructionFile, settingsDir)),
	};
}

export function applyIntercomBridgeToAgent(agent: AgentConfig, bridge: IntercomBridgeState): AgentConfig {
	if (!bridge.active || !bridge.orchestratorTarget) return agent;

	const bridgeTools = ["intercom", "contact_supervisor"];
	const tools = agent.tools
		? [...agent.tools, ...bridgeTools.filter((tool) => !agent.tools?.includes(tool))]
		: agent.tools;
	const instruction = bridge.instruction;
	const trimmedPrompt = agent.systemPrompt?.trim() || "";
	const systemPrompt = trimmedPrompt.includes(INTERCOM_BRIDGE_MARKER)
		? trimmedPrompt
		: trimmedPrompt
			? `${trimmedPrompt}\n\n${instruction}`
			: instruction;

	if (tools === agent.tools && systemPrompt === agent.systemPrompt) return agent;
	return {
		...agent,
		tools,
		systemPrompt,
	};
}
