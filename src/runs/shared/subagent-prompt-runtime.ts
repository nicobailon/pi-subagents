import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { declarationsEqual, getCurrentSystemMessage, getCurrentTools, type AnthropicMessagesCompat, type SystemMessage, type TranscriptMessages } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.ts";
import { permissionDecision } from "./permissions.ts";
import type { SteerRequest } from "../background/control-channel.ts";
import { RUNTIME_EXTENSION_ACK_EVENT, isRuntimeAcknowledgedExtensionId } from "./runtime-acknowledged-extensions.ts";
import { createStructuredOutputToolParameters, MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR, validateStructuredOutputValue } from "./structured-output.ts";
import { validateAcceptanceReport } from "./acceptance.ts";
import { formatChildToolDiagnostic } from "./tool-availability.ts";
import { shouldBlockToolForBudget, toolBudgetBlockedMessage, toolBudgetSoftNudge } from "./tool-budget.ts";
import type { ResolvedToolBudget, SubagentState } from "../../shared/types.ts";
import { INTERCOM_SESSION_IDENTITY_EVENT } from "../../shared/types.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { registerChildWatchdog } from "../../watchdog/register-child.ts";
import type { ChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { requestWatchdogPermission, type WatchdogPermissionRequest, type WatchdogPermissionResult } from "../../watchdog/permission-arbiter.ts";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "../../watchdog/types.ts";
import { captureWatchdogDiffBaseline, createWatchdogDiffTool, WATCHDOG_DIFF_TOOL_NAME } from "../../watchdog/diff-tool.ts";
import { inheritedNestedRouteOf } from "./nested-events.ts";
import { registerWaitTool } from "../background/wait-tool.ts";
import { drainOutstandingWork } from "../background/auto-drain.ts";
import { MODEL_ONLY_TOOL } from "../../shared/extension-context.ts";
import {
	childSupervisorMetadata,
	evaluateChildToolDiagnostic,
	type ChildPermissions,
	type ChildRuntimeConfig,
} from "./child-runtime-config.ts";

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
const PROJECT_CONTEXT_XML_HEADER = "\n\n<project_context>\n\n";
const PROJECT_CONTEXT_LEGACY_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function registerRuntimeExtensionAcknowledgements(pi: ExtensionAPI, sink: ((ids: string[]) => void) | undefined): void {
	if (!sink) return;
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
		sink(ids);
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
	const xmlStartIndex = prompt.indexOf(PROJECT_CONTEXT_XML_HEADER);
	if (xmlStartIndex !== -1) {
		const closingTag = "</project_context>";
		const closingIndex = prompt.indexOf(closingTag, xmlStartIndex + PROJECT_CONTEXT_XML_HEADER.length);
		if (closingIndex !== -1) {
			return `${prompt.slice(0, xmlStartIndex)}${prompt.slice(closingIndex + closingTag.length)}`;
		}
	}
	const legacyStartIndex = prompt.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
	if (legacyStartIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, legacyStartIndex)}${prompt.slice(endIndex)}`;
}

const GLOBAL_CONTEXT_FILE_NAMES = new Set(["agents.md", "agents.override.md", "claude.md"]);

function canonicalDirectory(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return path.resolve(dir);
	}
}

function expandContextPath(filePath: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	return filePath === "~"
		? home ?? filePath
		: /^~[\\/]/.test(filePath)
			? path.join(home ?? "~", filePath.slice(2))
			: filePath;
}

function isContextFilePath(filePath: string): boolean {
	return GLOBAL_CONTEXT_FILE_NAMES.has(path.basename(expandContextPath(filePath)).toLowerCase());
}

function isGlobalContextFile(filePath: string): boolean {
	const expanded = expandContextPath(filePath);
	if (!isContextFilePath(filePath)) return false;
	return canonicalDirectory(path.dirname(expanded)) === canonicalDirectory(getAgentDir());
}

function stripGlobalInstructionsFromXmlContext(context: string): string {
	const block = /<project_instructions\s+path=(["'])(.*?)\1\s*>[\s\S]*?<\/project_instructions>\s*/gi;
	return context.replace(block, (match, _quote: string, filePath: string) => isGlobalContextFile(filePath) ? "" : match);
}

function stripGlobalInstructionsFromLegacyContext(context: string): string {
	const sections = [...context.matchAll(/^## ([^\r\n]+)(?:\r?\n|$)/gm)]
		.filter((match) => isContextFilePath(match[1]!.trim()));
	let rewritten = "";
	let cursor = 0;
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const start = section.index!;
		const end = sections[index + 1]?.index ?? context.length;
		rewritten += context.slice(cursor, start);
		if (!isGlobalContextFile(section[1]!.trim())) rewritten += context.slice(start, end);
		cursor = end;
	}
	return `${rewritten}${context.slice(cursor)}`;
}

export function stripGlobalContext(prompt: string): string {
	const rewrittenXml = prompt.replace(/<project_context>[\s\S]*?<\/project_context>/gi, (context) => {
		const rewritten = stripGlobalInstructionsFromXmlContext(context);
		return /<project_instructions\b/i.test(rewritten) ? rewritten : "";
	});
	const legacyStartIndex = rewrittenXml.indexOf(PROJECT_CONTEXT_LEGACY_HEADER);
	if (legacyStartIndex === -1) return rewrittenXml;
	const legacyEndIndex = findSectionEnd(rewrittenXml, legacyStartIndex + PROJECT_CONTEXT_LEGACY_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	const legacyContext = rewrittenXml.slice(legacyStartIndex, legacyEndIndex);
	return `${rewrittenXml.slice(0, legacyStartIndex)}${stripGlobalInstructionsFromLegacyContext(legacyContext)}${rewrittenXml.slice(legacyEndIndex)}`;
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
	for (const instructions of [CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS, CHILD_FANOUT_BOUNDARY_INSTRUCTIONS, STRUCTURED_OUTPUT_INSTRUCTIONS]) {
		rewritten = rewritten.split(`\n\n${instructions}`).join("").split(instructions).join("");
	}
	return rewritten.replace(/^(?:[ \t]*\r?\n)+/, "");
}

type InheritedPromptOptions = { inheritProjectContext: boolean; inheritGlobalContext: boolean; inheritSkills: boolean };
type ChildBoundaryOptions = { fanoutChild?: boolean; structuredOutput?: boolean };

function stripInheritedPromptText(prompt: string, options: InheritedPromptOptions): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritGlobalContext) {
		rewritten = stripGlobalContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	return stripChildBoundaryInstructions(stripSubagentOrchestrationSkill(rewritten));
}

function childBoundary(options: ChildBoundaryOptions): string {
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	return options.structuredOutput ? `${boundary}\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : boundary;
}

function appendChildBoundary(prompt: string, options: ChildBoundaryOptions): string {
	// Pi's base prompt stays first so providers that recognize it by its opening still do.
	return `${stripChildBoundaryInstructions(prompt)}\n\n${childBoundary(options)}`;
}

export function rewriteSubagentPrompt(prompt: string, options: InheritedPromptOptions & ChildBoundaryOptions): string {
	return appendChildBoundary(stripInheritedPromptText(prompt, options), options);
}

/** In place, so later handlers and the final render never see the removed context. */
function filterChildPromptOptions(options: BeforeAgentStartEvent["systemPromptOptions"], inherited: InheritedPromptOptions): void {
	if (!inherited.inheritProjectContext) options.contextFiles = [];
	else if (!inherited.inheritGlobalContext) options.contextFiles = options.contextFiles.filter((file) => !isGlobalContextFile(file.path));
	options.skills = inherited.inheritSkills ? options.skills.filter((skill) => skill.name !== "pi-subagents") : [];
	// Role prompts can embed context, skill catalogs, or an earlier child's boundary as text.
	if (options.customPrompt) options.customPrompt = stripInheritedPromptText(options.customPrompt, inherited);
	if (options.appendSystemPrompt) options.appendSystemPrompt = stripInheritedPromptText(options.appendSystemPrompt, inherited);
}

function rewritesChildPrompt(config: ChildRuntimeConfig): boolean {
	return config.inheritProjectContext !== undefined || config.inheritGlobalContext !== undefined || config.inheritSkills !== undefined || Boolean(config.fanoutChild);
}

/** Installed after every other extension: a returned prompt freezes out sections added after it. */
export function registerSubagentPromptBoundary(pi: ExtensionAPI, config: ChildRuntimeConfig): void {
	if (!rewritesChildPrompt(config)) return;
	// A returned prompt replaces the whole system prompt of every request. A fork must send its
	// parent's prompt unchanged to reuse its prompt cache, so its boundary goes in its task
	// message instead (see projectForkRequest).
	if (config.forkCacheKey) return;
	pi.on("before_agent_start", (event) => {
		const finalized = appendChildBoundary(event.systemPrompt, { fanoutChild: config.fanoutChild, structuredOutput: Boolean(config.structuredOutput) });
		return finalized === event.systemPrompt ? undefined : { systemPrompt: finalized };
	});
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
	"cursor-native",
	"openai-completions",
	"openai-responses",
]);
const PROMPT_CACHE_KEY_APIS = new Set([
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
]);

const isSystemMessage = <T extends { role: string }>(message: T): message is T & SystemMessage => message.role === "system";
const writtenBefore = (message: { timestamp?: unknown }, forkedAt: number) => typeof message.timestamp === "number" && message.timestamp < forkedAt;
const promptText = (message: SystemMessage | undefined) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((block) => block.text).join("");

/** The system messages older than `forkedAt`: the prompt and tool state a fork inherited. */
export function systemMessagesBefore<T extends { role: string }>(messages: readonly T[], forkedAt: number): T[] {
	return messages.filter((message) => isSystemMessage(message) && writtenBefore(message, forkedAt));
}

/** The model that wrote a fork's inherited history. */
export type InheritedModel = { provider: string; api: string; model: string };

/** The provider, API and model of the last assistant message older than `forkedAt`. */
export function modelBefore(messages: readonly { role: string }[], forkedAt: number): InheritedModel | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role: string; timestamp?: unknown; provider?: unknown; api?: unknown; model?: unknown };
		if (message.role !== "assistant" || !writtenBefore(message, forkedAt)) continue;
		if (typeof message.provider !== "string" || typeof message.api !== "string" || typeof message.model !== "string") return undefined;
		return { provider: message.provider, api: message.api, model: message.model };
	}
	return undefined;
}

/**
 * Sections that describe what a session has (tools, skills, agents, docs, project files) rather
 * than who it is. A fork is told which tools it can call, and it inherited the rest with the
 * parent's prompt, so its own versions of these sections are not repeated in its task message.
 */
const LOADOUT_SECTIONS = new Set(["tools", "rules", "docs", "skills", "advertised_subagents", "mcp_servers", "project_context"]);

/**
 * The child's own instructions, which a fork sends in its task message instead of its system
 * prompt: the text its own system messages (`own`) add, the sections it changed except the loadout
 * ones, the tools it can call, and its boundary. `parent` is the inherited system messages and
 * `child` the whole request.
 */
function forkInstructions(input: { parent: TranscriptMessages; child: TranscriptMessages; own: TranscriptMessages; boundary?: string }): string {
	const parent = getCurrentSystemMessage(input.parent);
	const child = getCurrentSystemMessage(input.child);
	const parts = [
		"The system prompt and tool list of this conversation are the parent session's, sent unchanged so this request reuses the parent's prompt cache. The instructions below are yours and take precedence over the parent's role.",
		`Tools you can call: ${getCurrentTools(input.child).map((tool) => tool.name).join(", ") || "none"}. Any other declared tool belongs to the parent session and fails if called.`,
	];
	const ownPrompt = promptText(getCurrentSystemMessage(input.own));
	if (ownPrompt.length > 0) parts.push(ownPrompt);
	for (const [name, value] of Object.entries(child?.sections ?? {})) {
		if (!LOADOUT_SECTIONS.has(name) && value && parent?.sections?.[name] !== value) parts.push(value);
	}
	if (input.boundary) parts.push(input.boundary);
	return `<subagent_instructions>\n${parts.join("\n\n")}\n</subagent_instructions>`;
}

function prependText<T>(message: T, text: string): T {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return { ...message, content: `${text}\n\n${content}` };
	if (Array.isArray(content)) return { ...message, content: [{ type: "text", text }, ...content] };
	return message;
}

/**
 * A forked child starts with its parent's history, and Anthropic-style providers cache a request
 * as one prefix: tools, then the system prompt, then the messages. The child's own prompt (its
 * role, tool list and boundary) and its own tools changed that prefix right after the tools, so
 * every fork re-read the parent's whole conversation without the prompt cache.
 *
 * A fork's request now starts exactly as its parent's last one did:
 * - The system messages it inherited (`inherited`, older than `forkedAt`) are sent as they are,
 *   and the child's own ones are dropped. When a `context` handler made Pi collapse the request
 *   into one leading system message, that message is rebuilt from `inherited`.
 * - Every tool the parent declared stays declared, with the parent's definition. A tool only the
 *   child has, or one the child defines differently under the parent's name (a `structured_output`
 *   with its own schema, for example), is declared by one system message at the fork point, so the
 *   model sees the definition the child's tool checks.
 * - The child's instructions (its role sections, the boundary, the tools it can call) go first in
 *   its first own user message, after the inherited history.
 *
 * Only what a request sends changes; the session keeps Pi's own record. Once a compaction in the
 * child left no inherited message, there is no parent prefix to match: the child's own prompt is
 * sent, with the boundary added as a section.
 */
export function projectForkRequest<T extends { role: string }>(messages: T[], inherited: readonly T[], forkedAt: number, options: { boundary?: string } = {}): T[] {
	const own = (message: T) => !writtenBefore(message as { timestamp?: unknown }, forkedAt);
	if (inherited.length === 0 || !messages.some((message) => !isSystemMessage(message) && !own(message))) {
		if (!options.boundary) return messages;
		const at = messages.findIndex((message) => !isSystemMessage(message));
		const section = { role: "system", content: "", sections: { subagent_boundary: `<subagent_boundary>\n${options.boundary}\n</subagent_boundary>` }, timestamp: forkedAt } as unknown as T;
		return at === -1 ? [...messages, section] : [...messages.slice(0, at), section, ...messages.slice(at)];
	}
	const instructions = forkInstructions({ parent: inherited, child: messages, own: messages.filter((message) => isSystemMessage(message) && own(message)), boundary: options.boundary });
	const parentTools = new Map(getCurrentTools(inherited).map((tool) => [tool.name, tool]));
	const childTools = getCurrentTools(messages).filter((tool) => {
		const parentTool = parentTools.get(tool.name);
		return !parentTool || !declarationsEqual(parentTool, tool);
	});
	const redefined = childTools.filter((tool) => parentTools.has(tool.name)).map((tool) => ({ name: tool.name }));
	const sentInherited = messages.filter((message) => isSystemMessage(message) && !own(message));
	const uncollapsed = sentInherited.length === inherited.length && sentInherited.every((message, index) => JSON.stringify(message) === JSON.stringify(inherited[index]));
	const conversation = messages.filter((message) => !isSystemMessage(message));
	const head = getCurrentSystemMessage(inherited) as T | undefined;
	const next = uncollapsed
		? messages.filter((message) => !isSystemMessage(message) || !own(message))
		: [...(head ? [head] : []), ...conversation];
	const firstOwn = next.findIndex((message) => !isSystemMessage(message) && own(message));
	const task = next.findIndex((message) => message.role === "user" && own(message));
	const additions: T[] = [];
	if (childTools.length > 0) additions.push({ role: "system", content: "", ...(redefined.length > 0 ? { toolsRemoved: redefined } : {}), toolsAdded: childTools, timestamp: forkedAt } as unknown as T);
	if (task === -1) additions.push({ role: "system", content: "", sections: { subagent_instructions: instructions }, timestamp: forkedAt } as unknown as T);
	else next[task] = prependText(next[task]!, instructions);
	const at = firstOwn === -1 ? next.length : firstOwn;
	return [...next.slice(0, at), ...additions, ...next.slice(at)];
}

/**
 * Pi sends the session id in a session-affinity header to Anthropic-style endpoints that ask for
 * one (`compat.sendSessionAffinityHeaders`), and routers use it to keep a session on the upstream
 * that holds its prompt cache. A fork's request starts with its parent's whole cached prefix, so it
 * names its parent's session to be routed to that cache; otherwise a router with several upstreams
 * may send it to one that never saw the parent. Only the header Pi itself sends is changed, and only
 * when the child runs on the model that wrote its inherited history (`parentModel`, the last
 * inherited assistant message): any other model holds no cache of that prefix.
 */
export function applyForkSessionAffinity(headers: Record<string, string | null | undefined> | undefined, model: ExtensionContext["model"] | undefined, parentSessionId: string | undefined, parentModel: InheritedModel | undefined): void {
	const parent = parentSessionId?.trim();
	if (!headers || !parent || model?.api !== "anthropic-messages") return;
	if (!parentModel || parentModel.provider !== model.provider || parentModel.api !== model.api || parentModel.model !== model.id) return;
	const compat = model.compat as AnthropicMessagesCompat | undefined;
	if (!compat?.sendSessionAffinityHeaders) return;
	headers[compat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity"] = parent;
}

export function rewriteForkCacheProviderRequest(event: BeforeProviderRequestEvent, ctx: Pick<ExtensionContext, "model"> | undefined, forkCacheKey: string | undefined): unknown {
	const key = forkCacheKey?.trim();
	if (!key || !PROMPT_CACHE_KEY_APIS.has(ctx?.model?.api ?? "")) return undefined;
	if (!event || typeof event !== "object") return undefined;
	const payload = event.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	if (typeof (payload as { prompt_cache_key?: unknown }).prompt_cache_key !== "string") return undefined;
	return { ...payload, prompt_cache_key: key };
}

function portableToolId(id: string, preserveBoundedCompositeToolIds = false): string {
	if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return id;
	// Codex splits call_id|item_id on replay; each wire ID must remain portable and bounded.
	if (preserveBoundedCompositeToolIds) {
		const parts = id.split("|");
		if (parts.length === 2 && parts.every((part) => PORTABLE_TOOL_ID_PATTERN.test(part) && part.length <= MAX_PORTABLE_TOOL_ID_LENGTH)) return id;
	}
	const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
	if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return encoded;
	return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}

function sanitizeToolHistoryMessage(message: unknown, preserveBoundedCompositeToolIds = false): unknown {
	const m = message as { role?: string; content?: unknown; toolCallId?: unknown };
	if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
		const toolCallId = portableToolId(m.toolCallId, preserveBoundedCompositeToolIds);
		return toolCallId === m.toolCallId ? message : { ...m, toolCallId };
	}
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	let changed = false;
	const content = m.content.map((block) => {
		const b = block as { type?: string; id?: unknown };
		if (b?.type !== "toolCall" || typeof b.id !== "string") return block;
		const id = portableToolId(b.id, preserveBoundedCompositeToolIds);
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

/**
 * `inheritedBefore`, set in a forked child to the fork's time, keeps the history the child
 * inherited as the parent sent it, so its requests can reuse the parent's prompt cache; only tool
 * ids are still made portable there. The child cannot run `subagent` either way.
 */
export function stripParentOnlySubagentMessages(messages: unknown[], options: { sanitizeToolIds?: boolean; preserveBoundedCompositeToolIds?: boolean; preserveFanoutToolHistory?: boolean; inheritedBefore?: number } = {}): unknown[] {
	const preserveCurrentFanoutToolHistory = options.preserveFanoutToolHistory === true;
	const sanitizeToolIds = options.sanitizeToolIds ?? true;
	const inheritedBefore = options.inheritedBefore;
	// Every message Pi projects from a session has a timestamp, so one without it was added at
	// request time and is treated as the child's own.
	const inherited = (message: unknown) => inheritedBefore !== undefined && typeof (message as { timestamp?: unknown })?.timestamp === "number" && (message as { timestamp: number }).timestamp < inheritedBefore;
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		const keep = inherited(message);
		if (!keep && (isParentOnlySubagentMessage(message) || (!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message)))) {
			changed = true;
			continue;
		}
		const stripped = keep || preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped, options.preserveBoundedCompositeToolIds === true) : stripped;
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
	permissions: ChildPermissions | undefined,
	childWatchdog: ChildWatchdogConfig | undefined,
	requestPermission: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult> = requestWatchdogPermission,
): void {
	const rules = permissions?.rules;
	if (!rules || Object.keys(rules).length === 0) return;
	const rawWatchdogConfig = childWatchdog ? JSON.stringify(childWatchdog) : undefined;
	const timeoutMs = childWatchdog?.agentEndTimeoutMs ?? 30_000;
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: { toolName?: string; input?: unknown }, ctx: ExtensionContext) => unknown) => void;
	onRuntimeEvent("tool_call", async (event, ctx) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
		const decision = permissionDecision(rules, toolName);
		if (decision === "allow") return undefined;
		if (decision === "deny") return { block: true, reason: `Blocked by pi-subagents permission rule: '${toolName}' is denied.` };
		if (ctx.signal?.aborted) return { block: true, reason: "Blocked by pi-subagents permission rule: Watchdog permission decision was cancelled." };
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		let result: WatchdogPermissionResult;
		try {
			result = await Promise.race([
				requestPermission({
					ctx,
					toolName,
					args: event.input ?? {},
					rawWatchdogConfig,
					auditPath: permissions.auditPath,
					...(ctx.signal ? { signal: ctx.signal } : {}),
				}),
				new Promise<WatchdogPermissionResult>((resolve) => {
					if (!ctx.signal) return;
					abort = () => resolve({ approved: false, reason: "Watchdog permission decision was cancelled.", source: "watchdog" });
					ctx.signal.addEventListener("abort", abort, { once: true });
				}),
				new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Watchdog permission decision timed out after ${timeoutMs}ms.`)), timeoutMs); }),
			]);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { block: true, reason: `Blocked by pi-subagents permission rule: Watchdog permission arbiter failed closed: ${reason}` };
		} finally {
			if (timeout) clearTimeout(timeout);
			if (abort) ctx.signal?.removeEventListener("abort", abort);
		}
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

function registerStructuredOutputTool(pi: ExtensionAPI, structured: NonNullable<ChildRuntimeConfig["structuredOutput"]>): void {
	const terminalState = structured.terminalState ??= { captured: false };
	const required = structured.acceptanceReport === "required";
	const parameters = createStructuredOutputToolParameters(structured.schema, { acceptanceReport: structured.acceptanceReport });
	const registerTool = pi.registerTool as unknown as (tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (_id: string, params: { value: unknown; acceptanceReport?: unknown }) => Promise<unknown>;
	}) => void;
	registerTool({
		name: "structured_output",
		...MODEL_ONLY_TOOL,
		label: "Structured Output",
		description: "Submit the required final structured output for this subagent step. This terminates the step.",
		parameters,
		async execute(_id: string, params: { value: unknown; acceptanceReport?: unknown }) {
			const validation = await validateStructuredOutputValue(structured.schema, params.value);
			if (validation.status === "invalid") {
				throw new Error(`Structured output validation failed: ${validation.message}`);
			}
			if (required && params.acceptanceReport === undefined) {
				throw new Error(MISSING_STRUCTURED_ACCEPTANCE_REPORT_ERROR);
			}
			if (required && params.acceptanceReport !== undefined) {
				const acceptanceValidation = validateAcceptanceReport(params.acceptanceReport, "acceptanceReport");
				if (!acceptanceValidation.report) {
					throw new Error(`Invalid structured output acceptance report: ${acceptanceValidation.errors.join("; ")}`);
				}
			}
			structured.capture(params.value, structured.acceptanceReport ? params.acceptanceReport : undefined);
			terminalState.captured = true;
			return {
				content: [{ type: "text", text: "Structured output captured." }],
				details: {},
				terminate: true,
			};
		},
	});
}

/** Register every child-side hook the prompt runtime owns for one child session. */
export default function registerSubagentPromptRuntime(pi: ExtensionAPI, config?: ChildRuntimeConfig, drainObservation?: import("./readonly-drain-observation.ts").ReadonlyDrainObservation): void {
	// A path-based load has no ChildRuntimeConfig. This can happen if an
	// ambient-extension discovery path finds the runtime module in addition to
	// the configured inline factory. It must be inert rather than crashing the
	// child before startup; the inline factory remains the real registration path.
	if (!config) return;
	registerRuntimeExtensionAcknowledgements(pi, config.runtimeAcknowledgements);
	registerPermissionGate(pi, config.permissions, config.childWatchdog);
	registerToolBudget(pi, config.toolBudget);
	if (config.structuredOutput && !config.structuredOutput.terminalState) config.structuredOutput.terminalState = { captured: false };
	registerChildWatchdog(pi, config.childWatchdog, config.watchdogStatus, config.structuredOutput?.terminalState);
	const requestedWatchdogDiff = config.requiredTools?.includes(WATCHDOG_DIFF_TOOL_NAME);
	const reviewerLaunchBaseline = requestedWatchdogDiff && config.cwd
		? captureWatchdogDiffBaseline(config.cwd)
		: undefined;
	if (requestedWatchdogDiff && typeof pi.registerTool === "function") {
		pi.registerTool(createWatchdogDiffTool(reviewerLaunchBaseline, { workingTreeAtLaunch: true }));
	}
	const waitState = config.runtimeState ?? {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
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
	const nestedRootRunId = inheritedNestedRouteOf(config)?.rootRunId;
	if (typeof pi.registerTool === "function") registerWaitTool(pi, waitState, config.waitTool.enabled, undefined, config.waitTool.defaultTimeoutMs, { nestedRootRunId });
	const supervisorMetadata = childSupervisorMetadata(config);
	let nativeSupervisorClientRegistered = false;
	const registerNativeSupervisorClientOnce = (): void => {
		if (nativeSupervisorClientRegistered) return;
		nativeSupervisorClientRegistered = true;
		registerNativeSupervisorClient(pi, supervisorMetadata);
	};
	const onRuntimeEvent = pi.on as unknown as (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => void;
	onRuntimeEvent("session_start", (_event: unknown, ctx?: ExtensionContext) => {
		const sessionManager = (ctx as { sessionManager?: Parameters<typeof resolveCurrentSessionId>[0] } | undefined)?.sessionManager;
		waitState.currentSessionId = sessionManager ? resolveCurrentSessionId(sessionManager) : null;
		registerNativeSupervisorClientOnce();
	});
	onRuntimeEvent("agent_start", () => {
		if (!config.requiredTools) return;
		const diagnostic = evaluateChildToolDiagnostic(config, pi.getAllTools().map((tool) => tool.name));
		config.toolDiagnostic?.(diagnostic);
		if (diagnostic) throw new Error(formatChildToolDiagnostic(diagnostic));
	});
	onRuntimeEvent("agent_end", async (_event: unknown, ctx: unknown) => {
		if ((ctx as { hasUI?: boolean } | undefined)?.hasUI === true) drainObservation?.deny();
		if (drainObservation) {
			try {
				if ((ctx as ExtensionContext)?.sessionManager?.getSessionFile() !== waitState.currentSessionId) drainObservation.deny();
			} catch { drainObservation.deny(); }
		}
		config.holdFinalDrain?.(true);
		try {
			await drainOutstandingWork({ state: waitState, events: pi.events, nestedRootRunId, hasPendingSupervisorRequest: config.hasPendingSupervisorRequest }, drainObservation);
		} finally {
			config.holdFinalDrain?.(false);
		}
	});
	if (config.structuredOutput) registerStructuredOutputTool(pi, config.structuredOutput);

	onRuntimeEvent("before_provider_request", (event: unknown, ctx?: ExtensionContext) => rewriteForkCacheProviderRequest(event as BeforeProviderRequestEvent, ctx, config.forkCacheKey));

	// A fork launch sets forkCacheKey. Pi writes the fork's session header when it copies the
	// parent's branch, so every inherited message is older and every message this child writes,
	// also after a resume, is not.
	// The inherited system messages and model are read from the session once: a request may hold
	// only Pi's collapsed leading message, and what came before the fork never changes.
	let inherited: { session: string; forkedAt: number; system: Array<{ role: string }>; model?: InheritedModel } | undefined;
	const readInherited = (ctx: ExtensionContext | undefined) => {
		const header = ctx?.sessionManager?.getHeader();
		if (!header) return undefined;
		if (inherited?.session !== header.id) {
			const forkedAt = Date.parse(header.timestamp);
			const messages = Number.isFinite(forkedAt) ? ctx!.sessionManager.buildSessionProjection().messages : [];
			inherited = { session: header.id, forkedAt, system: systemMessagesBefore(messages, forkedAt), model: modelBefore(messages, forkedAt) };
		}
		return Number.isFinite(inherited.forkedAt) ? inherited : undefined;
	};
	const boundary = rewritesChildPrompt(config) ? childBoundary({ fanoutChild: config.fanoutChild, structuredOutput: Boolean(config.structuredOutput) }) : undefined;
	if (config.forkCacheKey) onRuntimeEvent("before_provider_headers", (event: unknown, ctx?: ExtensionContext) => {
		applyForkSessionAffinity((event as { headers?: Record<string, string | null | undefined> } | undefined)?.headers, ctx?.model, config.parentSessionId, readInherited(ctx)?.model);
	});
	if (config.forkCacheKey) onRuntimeEvent("context_with_system", (event: unknown, ctx?: ExtensionContext) => {
		if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const fork = readInherited(ctx);
		if (!fork) return undefined;
		const messages = projectForkRequest(event.messages as Array<{ role: string }>, fork.system, fork.forkedAt, { boundary });
		return messages === event.messages ? undefined : { messages };
	});

	onRuntimeEvent("context", (event: unknown, ctx?: ExtensionContext) => {
		if (!event || typeof event !== "object" || !("messages" in event) || !Array.isArray(event.messages)) return undefined;
		const forkedAt = config.forkCacheKey ? Date.parse(ctx?.sessionManager?.getHeader()?.timestamp ?? "") : Number.NaN;
		const messages = stripParentOnlySubagentMessages(event.messages, {
			sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx?.model?.api ?? ""),
			preserveBoundedCompositeToolIds: ctx?.model?.api === "openai-codex-responses",
			preserveFanoutToolHistory: config.fanoutChild,
			...(Number.isFinite(forkedAt) ? { inheritedBefore: forkedAt } : {}),
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	// pi-intercom asks at session start for this session's intercom ID. Claiming
	// the route there frees the session name for the readable label. An older
	// pi-intercom never asks and routes by name, so the route stays the name.
	const routingName = config.intercomSessionName;
	let intercomIdClaimed = false;
	if (routingName) {
		pi.events.on(INTERCOM_SESSION_IDENTITY_EVENT, (request: unknown) => {
			if (!request || typeof request !== "object" || !("version" in request) || request.version !== 1 || !("claim" in request) || typeof request.claim !== "function") return;
			request.claim(routingName);
			intercomIdClaimed = true;
		});
	}

	onRuntimeEvent("before_agent_start", async (event: unknown) => {
		if (!event || typeof event !== "object" || !("systemPrompt" in event) || typeof event.systemPrompt !== "string") return undefined;
		registerNativeSupervisorClientOnce();
		const childSessionName = intercomIdClaimed ? config.sessionName || routingName : routingName || config.sessionName;
		if (childSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(childSessionName);
		}

		// Filter the inputs instead of returning a prompt; the boundary hook appends the boundary last.
		if (!rewritesChildPrompt(config)) return;
		filterChildPromptOptions((event as BeforeAgentStartEvent).systemPromptOptions, {
			inheritProjectContext: config.inheritProjectContext ?? true,
			inheritGlobalContext: config.inheritGlobalContext ?? true,
			inheritSkills: config.inheritSkills ?? true,
		});
	});
}
