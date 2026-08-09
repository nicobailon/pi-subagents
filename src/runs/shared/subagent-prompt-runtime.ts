import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.ts";
import { decodePermissionRules, permissionDecision, PERMISSION_AUDIT_PATH_ENV, PERMISSION_POLICY_ENV } from "./permissions.ts";
import { consumeSteerRequestsFromDir, MAX_STEER_QUEUE_SIZE, steerAckPathFromDir, writeSteerAckAt, writeSteerCapabilityAt, writeSteerRequestToDir, type SteerDeliveryStatus, type SteerRequest } from "../background/control-channel.ts";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_CHILD_INDEX_ENV, SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_STEER_ACK_DIR_ENV, SUBAGENT_STEER_CAPABILITY_ENV, SUBAGENT_STEER_INBOX_ENV } from "./pi-args.ts";
import { RUNTIME_EXTENSION_ACK_EVENT, RUNTIME_EXTENSION_ACK_PATH_ENV, isRuntimeAcknowledgedExtensionId, writeRuntimeAcknowledgedExtensions } from "./runtime-acknowledged-extensions.ts";
import { createStructuredOutputToolParameters, STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue } from "./structured-output.ts";
import {
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	MCP_DIRECT_CHILD_TOOLS_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
	writeChildToolDiagnostic,
	type ChildToolDiagnostic,
} from "./tool-availability.ts";
import { TOOL_BUDGET_ENV, TOOL_BUDGET_ZERO_AUTH_ENV, decodeToolBudgetEnv, shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.ts";
import type { JsonSchemaObject, ResolvedToolBudget, SubagentState } from "../../shared/types.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { resolveWatchPath } from "../../shared/utils.ts";
import { registerChildWatchdog } from "../../watchdog/register-child.ts";
import { CHILD_WATCHDOG_CONFIG_ENV } from "../../watchdog/child-status.ts";
import { requestWatchdogPermission, type WatchdogPermissionRequest, type WatchdogPermissionResult } from "../../watchdog/permission-arbiter.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../watchdog/types.ts";
import { resolveWaitToolConfig } from "../background/wait-config.ts";
import { registerWaitTool } from "../background/wait-tool.ts";
import { drainOutstandingWork } from "../background/auto-drain.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";
const STEERING_LEGACY_SETTLE_FALLBACK_MS = 1000;

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
	"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
	"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
	"The maxSubagentDepth cap still applies and may block further fanout.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function readRequiredChildTools(): string[] | undefined {
	const encoded = process.env[REQUIRED_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	const required = JSON.parse(encoded) as unknown;
	if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || !name)) {
		throw new Error(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);
	}
	return required;
}

function readMcpDirectChildTools(): string[] | undefined {
	const encoded = process.env[MCP_DIRECT_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	try {
		const tools = JSON.parse(encoded) as unknown;
		if (!Array.isArray(tools) || tools.some((name) => typeof name !== "string" || !name)) return undefined;
		return tools;
	} catch {
		return undefined;
	}
}

function refreshChildToolDiagnostic(pi: ExtensionAPI): ChildToolDiagnostic | undefined {
	const filePath = process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]?.trim();
	const required = readRequiredChildTools();
	if (!filePath || !required) return undefined;
	const available = pi.getAllTools().map((tool) => tool.name);
	return writeChildToolDiagnostic(filePath, required, available, process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim(), readMcpDirectChildTools());
}

function registerRuntimeExtensionAcknowledgements(pi: ExtensionAPI): void {
	const outputPath = process.env[RUNTIME_EXTENSION_ACK_PATH_ENV]?.trim();
	if (!outputPath) return;
	const ids: string[] = [];
	let finalized = false;
	const acknowledge = (payload: unknown): undefined => {
		if (finalized || !payload || typeof payload !== "object") return undefined;
		const id = (payload as { id?: unknown }).id;
		if (isRuntimeAcknowledgedExtensionId(id)) ids.push(id);
		return undefined;
	};
	const finalize = (): undefined => {
		if (finalized) return undefined;
		finalized = true;
		writeRuntimeAcknowledgedExtensions(outputPath, ids);
		return undefined;
	};
	try {
		const events = (pi as { events?: { on?: (event: string, handler: (payload: unknown) => unknown) => unknown } }).events;
		events?.on?.(RUNTIME_EXTENSION_ACK_EVENT, acknowledge);
		const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
		onRuntimeEvent("agent_end", finalize);
		onRuntimeEvent("session_shutdown", finalize);
	} catch {
		// Acknowledgement collection is optional observability and must not affect child execution.
	}
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return prompt
		.replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}

function stripChildBoundaryInstructions(prompt: string): string {
	let rewritten = prompt;
	for (const boundary of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS]) {
		rewritten = rewritten.split(boundary).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritSkills: boolean; fanoutChild?: boolean },
): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	rewritten = stripSubagentOrchestrationSkill(rewritten);
	rewritten = stripChildBoundaryInstructions(rewritten);
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
	return `${boundary}${structured}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	if (m?.role !== "custom" || typeof m.customType !== "string") return false;
	if (m.customType === SUBAGENT_WATCHDOG_WARNING_TYPE) return true;
	return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

const PORTABLE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PORTABLE_TOOL_ID_LENGTH = 64;
const COMPOSITE_TOOL_ID_APIS = new Set([
	"azure-openai-responses",
	"openai-completions",
	"openai-responses",
]);

function portableToolId(id: string): string {
	if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return id;
	const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
	if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return encoded;
	return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}

function sanitizeToolHistoryMessage(message: unknown): unknown {
	const m = message as { role?: string; content?: unknown; toolCallId?: unknown };
	if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
		const toolCallId = portableToolId(m.toolCallId);
		return toolCallId === m.toolCallId ? message : { ...m, toolCallId };
	}
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	let changed = false;
	const content = m.content.map((block) => {
		const b = block as { type?: string; id?: unknown };
		if (b?.type !== "toolCall" || typeof b.id !== "string") return block;
		const id = portableToolId(b.id);
		if (id === b.id) return block;
		changed = true;
		return { ...b, id };
	});
	return changed ? { ...m, content } : message;
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[], options: { sanitizeToolIds?: boolean } = {}): unknown[] {
	const preserveCurrentFanoutToolHistory = process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1";
	const sanitizeToolIds = options.sanitizeToolIds ?? true;
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))) {
			changed = true;
			continue;
		}
		const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped) : stripped;
		if (stripped !== message || sanitized !== stripped) changed = true;
		filtered.push(sanitized);
	}
	return changed ? filtered : messages;
}

export function formatSteerMessage(request: SteerRequest): string {
	return [
		request.mode === "follow_up" ? "Queued follow-up from the parent orchestrator:" : "Mid-run steering from the parent orchestrator:",
		"",
		request.message,
		"",
		"Incorporate this guidance at the next safe point. Do not restart the task unless the guidance explicitly asks you to.",
	].join("\n");
}

export function registerPermissionGate(
	pi: ExtensionAPI,
	requestPermission: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult> = requestWatchdogPermission,
): void {
	const rules = decodePermissionRules(process.env[PERMISSION_POLICY_ENV]);
	if (!rules) return;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("tool_call", async (event, ctx) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const decision = permissionDecision(rules, toolName);
		if (decision === "allow") return undefined;
		if (decision === "deny") return { block: true, reason: `Blocked by pi-subagents permission rule: '${toolName}' is denied.` };
		const result = await requestPermission({
			ctx,
			toolName,
			args: event.input ?? {},
			rawWatchdogConfig: process.env[CHILD_WATCHDOG_CONFIG_ENV],
			auditPath: process.env[PERMISSION_AUDIT_PATH_ENV],
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (result.approved) return undefined;
		return { block: true, reason: `Blocked by pi-subagents permission rule: ${result.reason}` };
	});
}

function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
	if (!budget) return;
	let toolCount = 0;
	let softNudged = false;
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown }).sendUserMessage;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string }) => unknown) => void;
	onRuntimeEvent("tool_call", (event) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		toolCount++;
		if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
			softNudged = true;
			try {
				sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
			} catch {
				// Budget nudges are advisory; blocking below remains authoritative.
			}
		}
		if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
		return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
	});
}

export function registerSteeringInbox(
	pi: ExtensionAPI,
	deps: { watch?: typeof fs.watch; nativeRealpath?: (filePath: string) => string; legacySettleFallbackMs?: number } = {},
): void {
	const steerInbox = process.env[SUBAGENT_STEER_INBOX_ENV]?.trim();
	if (!steerInbox) return;
	const capabilityPath = process.env[SUBAGENT_STEER_CAPABILITY_ENV]?.trim();
	const ackDir = process.env[SUBAGENT_STEER_ACK_DIR_ENV]?.trim();
	const sendUserMessage = (pi as { sendUserMessage?: (content: string, options?: { deliverAs: "steer" | "followUp" }) => unknown }).sendUserMessage;
	const childIndex = Number(process.env[SUBAGENT_CHILD_INDEX_ENV]);
	const pending = new Map<string, Array<{ request: SteerRequest; deliveryStatus: SteerDeliveryStatus }>>();
	const queued: Array<{ request: SteerRequest; ready: boolean }> = [];
	let disposed = false;
	let agentRunning = false;
	let inTurn = false;
	let awaitingSettlement = false;
	let flushing = false;
	let started = false;
	let canSteer = typeof sendUserMessage === "function";
	let watcher: fs.FSWatcher | undefined;
	let interval: NodeJS.Timeout | undefined;
	let settleFallback: NodeJS.Timeout | undefined;
	const legacySettleFallbackMs = deps.legacySettleFallbackMs ?? STEERING_LEGACY_SETTLE_FALLBACK_MS;
	const acknowledge = (request: SteerRequest, state: "delivered" | "queued" | "failed", message: string, deliveryStatus?: SteerDeliveryStatus): void => {
		if (!ackDir || !Number.isInteger(childIndex) || childIndex < 0) return;
		writeSteerAckAt(steerAckPathFromDir(ackDir, request.id), {
			requestId: request.id,
			index: childIndex,
			ts: Date.now(),
			state,
			...(deliveryStatus ? { deliveryStatus } : {}),
			message,
		});
	};
	const publishCapability = (): void => {
		if (!capabilityPath || !Number.isInteger(childIndex) || childIndex < 0) return;
		writeSteerCapabilityAt(capabilityPath, { index: childIndex, pid: process.pid, readyAt: Date.now(), supported: canSteer });
	};
	const flush = (): void => {
		if (disposed || flushing) return;
		flushing = true;
		try {
			const requests = consumeSteerRequestsFromDir(steerInbox);
			for (let index = 0; index < requests.length; index++) {
				const request = requests[index]!;
				if (!canSteer || typeof sendUserMessage !== "function") {
					acknowledge(request, "failed", "Child Pi session does not support sendUserMessage steering.");
					continue;
				}
				const requestedMode = request.mode ?? "steer";
				const autoCanUseIdle = requestedMode === "auto" && !agentRunning && !awaitingSettlement;
				const delivery = requestedMode === "follow_up" || (requestedMode === "auto" && (inTurn || awaitingSettlement)) ? "followUp" as const : "steer" as const;
				const pendingFollowUps = [...pending.values()].reduce((count, entries) => count + entries.filter((entry) => entry.deliveryStatus === "queued").length, 0);
				if (delivery === "followUp" && queued.length + pendingFollowUps >= MAX_STEER_QUEUE_SIZE) {
					acknowledge(request, "failed", `Follow-up queue is full (${MAX_STEER_QUEUE_SIZE} messages).`);
					continue;
				}
				const formatted = formatSteerMessage(request);
				const entries = pending.get(formatted) ?? [];
				entries.push({ request, deliveryStatus: delivery === "followUp" ? "queued" : "delivered" });
				pending.set(formatted, entries);
				try {
					sendUserMessage(formatted, autoCanUseIdle ? undefined : { deliverAs: delivery });
				} catch (error) {
					entries.pop();
					if (entries.length === 0) pending.delete(formatted);
					acknowledge(request, "failed", error instanceof Error ? error.message : String(error));
					for (const retry of requests.slice(index + 1)) writeSteerRequestToDir(steerInbox, retry);
					break;
				}
			}
		} finally {
			flushing = false;
		}
	};
	const onInput = (event: unknown): undefined => {
		if (disposed || !event || typeof event !== "object") return undefined;
		const input = event as { source?: unknown; streamingBehavior?: unknown; text?: unknown; content?: unknown };
		if (input.source !== "extension") return undefined;
		const text = typeof input.text === "string" ? input.text : typeof input.content === "string" ? input.content : undefined;
		if (!text) return undefined;
		const entries = pending.get(text);
		const entry = entries?.shift();
		if (!entry) return undefined;
		if (entries?.length === 0) pending.delete(text);
		if (entry.deliveryStatus === "queued") {
			queued.push({ request: entry.request, ready: !inTurn });
			acknowledge(entry.request, "queued", "Pi queued the correlated follow-up input.", "queued");
		} else {
			acknowledge(entry.request, "delivered", "Pi accepted the correlated steering input.", "delivered");
		}
		return undefined;
	};
	const start = (): void => {
		if (started || disposed) return;
		try {
			fs.mkdirSync(steerInbox, { recursive: true });
			publishCapability();
		} catch {
			return;
		}
		started = true;
		try {
			watcher = (deps.watch ?? fs.watch)(resolveWatchPath(steerInbox, deps.nativeRealpath), () => flush());
			watcher.on("error", () => {});
		} catch {
			watcher = undefined;
		}
		interval = setInterval(flush, 250);
		interval.unref?.();
	};
	const activate = (): undefined => {
		start();
		flush();
		return undefined;
	};
	const clearSettleFallback = (): void => {
		if (!settleFallback) return;
		clearTimeout(settleFallback);
		settleFallback = undefined;
	};
	const markSettled = (): undefined => {
		clearSettleFallback();
		agentRunning = false;
		inTurn = false;
		awaitingSettlement = false;
		return activate();
	};
	const armLegacySettleFallback = (): void => {
		clearSettleFallback();
		settleFallback = setTimeout(() => {
			settleFallback = undefined;
			if (disposed || !awaitingSettlement) return;
			agentRunning = false;
			inTurn = false;
			awaitingSettlement = false;
			activate();
		}, legacySettleFallbackMs);
		settleFallback.unref?.();
	};

	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => void;
	// Register input before the watcher so an accepted extension input cannot race request dispatch.
	onRuntimeEvent("input", onInput);
	onRuntimeEvent("session_start", () => start());
	onRuntimeEvent("agent_start", () => {
		clearSettleFallback();
		agentRunning = true;
		awaitingSettlement = false;
		return activate();
	});
	onRuntimeEvent("agent_end", (event) => {
		inTurn = false;
		if ((event as { willRetry?: unknown } | undefined)?.willRetry === true) {
			clearSettleFallback();
			agentRunning = true;
			awaitingSettlement = true;
			return activate();
		}
		agentRunning = true;
		awaitingSettlement = true;
		armLegacySettleFallback();
		return activate();
	});
	onRuntimeEvent("agent_settled", markSettled);
	onRuntimeEvent("session_compact", () => {
		const unresolved = [...pending.values()].flat();
		pending.clear();
		for (const entry of unresolved) {
			try {
				writeSteerRequestToDir(steerInbox, { ...entry.request, mode: "follow_up" });
			} catch (error) {
				acknowledge(entry.request, "failed", `Could not retry steering after compaction: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return activate();
	});
	onRuntimeEvent("turn_start", () => {
		clearSettleFallback();
		agentRunning = true;
		awaitingSettlement = false;
		inTurn = true;
		const next = queued.findIndex((entry) => entry.ready);
		if (next >= 0) {
			const [entry] = queued.splice(next, 1);
			if (entry) acknowledge(entry.request, "delivered", "Pi delivered the queued follow-up at a turn boundary.", "delivered");
		}
		return activate();
	});
	onRuntimeEvent("turn_end", () => {
		inTurn = false;
		for (const entry of queued) entry.ready = true;
		return activate();
	});
	for (const eventName of ["message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"] as const) {
		onRuntimeEvent(eventName, activate);
	}
	onRuntimeEvent("session_shutdown", () => {
		for (const entry of queued) acknowledge(entry.request, "failed", "Run ended before queued follow-up delivery.", "queued");
		for (const entries of pending.values()) {
			for (const entry of entries) acknowledge(entry.request, "failed", "Run ended before Pi confirmed steering input delivery.");
		}
		disposed = true;
		clearSettleFallback();
		try { watcher?.close(); } catch {}
		if (interval) clearInterval(interval);
	});
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	registerRuntimeExtensionAcknowledgements(pi);
	registerSteeringInbox(pi);
	registerPermissionGate(pi);
	registerToolBudget(pi, decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV], { allowZero: process.env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" }));
	registerChildWatchdog(pi);
	const waitToolEnabled = resolveWaitToolConfig().enabled;
	const waitState = {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
	if (typeof pi.registerTool === "function") registerWaitTool(pi, waitState, waitToolEnabled);
	let nativeSupervisorClientRegistered = false;
	let nativeSupervisorFallbackRegistered = false;
	const registerNativeSupervisorClientOnce = (): void => {
		if (nativeSupervisorClientRegistered) return;
		nativeSupervisorClientRegistered = true;
		registerNativeSupervisorClient(pi, { includeIntercomFallback: false });
	};
	const registerNativeSupervisorFallbackOnce = (): void => {
		registerNativeSupervisorClientOnce();
		if (nativeSupervisorFallbackRegistered) return;
		nativeSupervisorFallbackRegistered = true;
		registerNativeSupervisorClient(pi);
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", (_event: unknown, ctx?: ExtensionContext) => {
		const sessionManager = (ctx as { sessionManager?: Parameters<typeof resolveCurrentSessionId>[0] } | undefined)?.sessionManager;
		waitState.currentSessionId = sessionManager ? resolveCurrentSessionId(sessionManager) : null;
		registerNativeSupervisorClientOnce();
		if (readRequiredChildTools()?.includes("intercom")) registerNativeSupervisorFallbackOnce();
	});
	onRuntimeEvent("agent_start", () => {
		refreshChildToolDiagnostic(pi);
	});
	onRuntimeEvent("agent_end", async (_event: unknown, ctx: unknown) => {
		if ((ctx as { hasUI?: boolean } | undefined)?.hasUI === true) return;
		await drainOutstandingWork({ state: waitState, events: pi.events });
	});
	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		const parameters = createStructuredOutputToolParameters(schema);
		const registerTool = pi.registerTool as unknown as (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
		}) => void;
		registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final structured output for this subagent step. This terminates the step.",
			parameters: parameters as never,
			async execute(_id: string, params: { value: unknown }) {
				const validation = await validateStructuredOutputValue(schema, params.value);
				if (validation.status === "invalid") {
					throw new Error(`Structured output validation failed: ${validation.message}`);
				}
				fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
				fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: structuredOutputPath },
					terminate: true,
				};
			},
		});
	}

	onRuntimeEvent("context", (event: unknown, ctx?: ExtensionContext) => {
		if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const messages = stripParentOnlySubagentMessages(event.messages, {
			sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx?.model?.api ?? ""),
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	onRuntimeEvent("before_agent_start", async (event: unknown) => {
		if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof event.systemPrompt !== "string") return undefined;
		registerNativeSupervisorFallbackOnce();
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		let rewritten = event.systemPrompt;
		if (inheritProjectContext !== undefined || inheritSkills !== undefined || fanoutChild !== undefined) {
			rewritten = rewriteSubagentPrompt(event.systemPrompt, {
				inheritProjectContext: inheritProjectContext ?? true,
				inheritSkills: inheritSkills ?? true,
				fanoutChild: fanoutChild === true,
			});
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
