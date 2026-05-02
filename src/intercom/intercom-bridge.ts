import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import type { ExtensionConfig, IntercomBridgeConfig, IntercomBridgeMode } from "../shared/types.ts";

function defaultIntercomExtensionDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "pi-intercom");
}

function defaultIntercomConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "intercom", "config.json");
}

function defaultSubagentConfigDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");
}

const DEFAULT_INTERCOM_TARGET_PREFIX = "subagent-chat";
export const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
const DEFAULT_INTERCOM_BRIDGE_TEMPLATE = `The inherited thread is reference-only. Do not continue that conversation or send questions, status updates, or completion handoffs to the orchestrator in normal assistant text.

Use intercom only for coordination with the orchestrator session "{orchestratorTarget}".
- Need a decision or blocked: intercom({ action: "ask", to: "{orchestratorTarget}", message: "<question>" })
- After intercom ask, stay alive and continue only after the reply arrives. Do not finish your final response with a choose-one question.
- Non-blocking progress update: intercom({ action: "send", to: "{orchestratorTarget}", message: "UPDATE: <summary>" })

Do not send routine completion handoffs through intercom. If no coordination is needed, return a focused task result.`;

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
	piIntercomAvailable: boolean;
	extensionDir: string;
	configPath?: string;
	orchestratorTarget?: string;
	reason?: string;
	intercomConfigEnabled?: boolean;
	intercomConfigError?: string;
}

interface ResolveIntercomBridgeInput {
	config: ExtensionConfig["intercomBridge"];
	context: "fresh" | "fork" | undefined;
	orchestratorTarget?: string;
	hasIntercom: () => boolean;
	extensionDir?: string;
	configPath?: string;
	settingsDir?: string;
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
		return {
			mode: "always",
			instructionFile: "",
		};
	}
	return {
		mode: resolveIntercomBridgeMode(value.mode),
		instructionFile: typeof value.instructionFile === "string" ? value.instructionFile : "",
	};
}

function intercomConfigStatus(configPath: string): { enabled: boolean; error?: unknown } {
	if (!fs.existsSync(configPath)) return { enabled: true };
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { enabled?: unknown };
		return { enabled: parsed.enabled !== false };
	} catch (error) {
		return { enabled: true, error };
	}
}

function extensionSandboxAllowsIntercom(extensions: string[] | undefined, extensionDir: string): boolean {
	if (extensions === undefined) return true;

	const intercomDir = path.resolve(extensionDir).replaceAll("\\", "/").toLowerCase();
	for (const entry of extensions) {
		const normalized = entry.trim().replaceAll("\\", "/").toLowerCase();
		if (normalized === "pi-intercom") return true;
		if (normalized === intercomDir) return true;
		if (normalized.startsWith(`${intercomDir}/`)) return true;
		if (normalized.endsWith("/pi-intercom")) return true;
		if (normalized.includes("/pi-intercom/")) return true;
	}
	return false;
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
	return `${INTERCOM_BRIDGE_MARKER}
${instruction}`;
}

export function diagnoseIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeDiagnostic {
	const config = resolveIntercomBridgeConfig(input.config);
	const mode = config.mode;
	const extensionDir = path.resolve(input.extensionDir ?? defaultIntercomExtensionDir());
	const orchestratorTarget = input.orchestratorTarget?.trim();
	const configPath = path.resolve(input.configPath ?? defaultIntercomConfigPath());
	const wantsIntercom = mode !== "off" && !(mode === "fork-only" && input.context !== "fork");
	const piIntercomAvailable = input.hasIntercom();
	let configStatus: ReturnType<typeof intercomConfigStatus> | undefined;
	let reason: string | undefined;
	if (mode === "off") reason = "bridge mode is off";
	else if (mode === "fork-only" && input.context !== "fork") reason = "bridge mode is fork-only and context is not fork";
	else if (!orchestratorTarget) reason = "orchestrator target is not available";
	else if (!piIntercomAvailable) reason = "pi-intercom extension is not loaded";
	else {
		configStatus = intercomConfigStatus(configPath);
		if (!configStatus.enabled) reason = "intercom config is disabled";
	}
	let intercomConfigError: string | undefined;
	if (configStatus?.error) {
		const error = configStatus.error;
		intercomConfigError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	}

	return {
		active: reason === undefined,
		mode,
		wantsIntercom,
		piIntercomAvailable,
		extensionDir,
		configPath,
		...(orchestratorTarget ? { orchestratorTarget } : {}),
		...(reason ? { reason } : {}),
		...(configStatus ? { intercomConfigEnabled: configStatus.enabled } : {}),
		...(intercomConfigError ? { intercomConfigError } : {}),
	};
}

export function resolveIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeState {
	const config = resolveIntercomBridgeConfig(input.config);
	const mode = config.mode;
	const extensionDir = path.resolve(input.extensionDir ?? defaultIntercomExtensionDir());
	const orchestratorTarget = input.orchestratorTarget?.trim();
	const settingsDir = path.resolve(input.settingsDir ?? defaultSubagentConfigDir());
	const defaultInstruction = buildIntercomBridgeInstruction(
		orchestratorTarget || "{orchestratorTarget}",
		DEFAULT_INTERCOM_BRIDGE_TEMPLATE,
	);

	if (mode === "off") {
		return { active: false, mode, extensionDir, instruction: defaultInstruction };
	}
	if (mode === "fork-only" && input.context !== "fork") {
		return { active: false, mode, extensionDir, instruction: defaultInstruction };
	}
	if (!orchestratorTarget) {
		return { active: false, mode, extensionDir, instruction: defaultInstruction };
	}
	if (!input.hasIntercom()) {
		return { active: false, mode, extensionDir, instruction: defaultInstruction };
	}

	const configPath = path.resolve(input.configPath ?? defaultIntercomConfigPath());
	const intercomStatus = intercomConfigStatus(configPath);
	if (intercomStatus.error) console.warn(`Failed to parse intercom config at '${configPath}'. Assuming enabled.`, intercomStatus.error);
	if (!intercomStatus.enabled) {
		return { active: false, mode, extensionDir, instruction: defaultInstruction };
	}

	const instruction = buildIntercomBridgeInstruction(
		orchestratorTarget,
		resolveInstructionTemplate(config.instructionFile, settingsDir),
	);

	return {
		active: true,
		mode,
		orchestratorTarget,
		extensionDir,
		instruction,
	};
}

export function applyIntercomBridgeToAgent(agent: AgentConfig, bridge: IntercomBridgeState): AgentConfig {
	if (!bridge.active || !bridge.orchestratorTarget) return agent;
	if (!extensionSandboxAllowsIntercom(agent.extensions, bridge.extensionDir)) return agent;

	const tools = agent.tools && !agent.tools.includes("intercom")
		? [...agent.tools, "intercom"]
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
