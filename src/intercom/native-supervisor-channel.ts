import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildSupervisorMetadata } from "../runs/shared/child-runtime-config.ts";
import { INTERCOM_DETACH_REQUEST_EVENT, POLL_INTERVAL_MS, TEMP_ROOT_DIR, type ControlEvent, type IntercomEventBus, type SubagentState } from "../shared/types.ts";
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { shouldUseNativeFsWatch } from "../shared/watch-strategy.ts";
import {
	SUPERVISOR_REQUEST_MESSAGE_TYPE,
	SUPERVISOR_REPLY_ENTRY_TYPE,
	supervisorReplyHint,
	type SupervisorReason,
	type SupervisorReplyEntryData,
} from "./supervisor-ui.ts";

const SUPERVISOR_CHANNEL_ROOT = path.join(TEMP_ROOT_DIR, "supervisor-channels");
const REQUESTS_DIR = "requests";
const REPLIES_DIR = "replies";
export const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const CHANNEL_POLL_MS = Math.min(POLL_INTERVAL_MS, 500);
const CHANNEL_SAFETY_POLL_MS = 5000;
const STALE_EMPTY_CHANNEL_AGE_MS = 60 * 1000;
const STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_SUPERVISOR_REQUEST_CORRELATIONS = 256;
const SUPERVISOR_REQUEST_CORRELATION_RETENTION_MS = 10 * 60 * 1000;

export type SupervisorRequestState = "pending" | "resolved" | "unknown";

interface SupervisorRequest {
	type: "subagent.supervisor.request";
	id: string;
	createdAt: number;
	expiresAt?: number;
	reason: SupervisorReason;
	message: string;
	expectsReply: boolean;
	orchestratorTarget?: string;
	orchestratorSessionId?: string;
	runId: string;
	agent: string;
	childIndex: number;
	toolCallId?: string;
	childTarget?: string;
	interview?: unknown;
}

interface PendingSupervisorRequest extends SupervisorRequest {
	channelDir: string;
	requestFile: string;
}

interface SupervisorRequestCorrelation {
	request: PendingSupervisorRequest;
	state: Exclude<SupervisorRequestState, "unknown">;
	updatedAt: number;
}

interface SupervisorReply {
	type: "subagent.supervisor.reply";
	requestId: string;
	createdAt: number;
	message: string;
}

interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

interface IntercomParams {
	action: "list" | "send" | "ask" | "reply" | "pending" | "status";
	to?: string;
	message?: string;
	replyTo?: string;
}

type SupervisorWatch = (filename: fs.PathLike, listener: fs.WatchListener<string>) => fs.FSWatcher;

interface NativeSupervisorChannelDeps {
	/** Retained scheduled states for the current runtime owner, never foreign owners. */
	getCurrentOwnerStates?: () => Iterable<SubagentState>;
	platform?: NodeJS.Platform;
	watch?: SupervisorWatch;
	timers?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setImmediate" | "clearImmediate">;
}

const ContactSupervisorParamsSchema = Type.Object({
	reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
	message: Type.Optional(Type.String()),
	interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
}, { additionalProperties: false });

const IntercomParamsSchema = Type.Object({
	action: Type.String({ enum: ["list", "send", "ask", "reply", "pending", "status"] }),
	to: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
}, { additionalProperties: false });

function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function resolveSupervisorChannelDir(runId: string, agent: string, childIndex: number): string {
	return path.join(SUPERVISOR_CHANNEL_ROOT, `${safeSegment(runId)}-${safeSegment(agent)}-${childIndex}`);
}

export function ensureSupervisorChannelDir(channelDir: string): void {
	fs.mkdirSync(path.join(channelDir, REQUESTS_DIR), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, REPLIES_DIR), { recursive: true, mode: 0o700 });
}

function requestPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REQUESTS_DIR, `${safeSegment(requestId)}.json`);
}

function replyPath(channelDir: string, requestId: string): string {
	return path.join(channelDir, REPLIES_DIR, `${safeSegment(requestId)}.json`);
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function parseStructuredReply(message: string): { value?: unknown; error?: string } {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Supervisor request cancelled."));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error("Supervisor request cancelled."));
		};
		timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForReply(channelDir: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<SupervisorReply> {
	const file = replyPath(channelDir, requestId);
	while (Date.now() <= deadline) {
		if (signal?.aborted) throw new Error("Supervisor request cancelled.");
		if (fs.existsSync(file)) {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorReply>;
			if (parsed.type === "subagent.supervisor.reply" && parsed.requestId === requestId && typeof parsed.message === "string") {
				return parsed as SupervisorReply;
			}
		}
		await delay(250, signal);
	}
	throw new Error("Timed out waiting for supervisor reply.");
}

async function sendSupervisorRequest(params: ContactSupervisorParams, metadata: ChildSupervisorMetadata, signal?: AbortSignal, toolCallId?: string): Promise<AgentToolResult<Record<string, unknown>>> {
	if (!params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions and progress updates.");
	}
	ensureSupervisorChannelDir(metadata.channelDir);
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const replyDeadline = createdAt + askTimeoutMs();
	const expiresAt = expectsReply ? replyDeadline : undefined;
	const message = params.message?.trim() ?? "";
	const requestToolCallId = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		...(expiresAt !== undefined ? { expiresAt } : {}),
		reason: params.reason,
		message,
		expectsReply,
		...(metadata.orchestratorTarget ? { orchestratorTarget: metadata.orchestratorTarget } : {}),
		...(metadata.orchestratorSessionId ? { orchestratorSessionId: metadata.orchestratorSessionId } : {}),
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
		...(requestToolCallId ? { toolCallId: requestToolCallId } : {}),
		...(metadata.childTarget ? { childTarget: metadata.childTarget } : {}),
		...(params.interview !== undefined ? { interview: params.interview } : {}),
	};
	const serialized = JSON.stringify(request, null, "\t");
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MESSAGE_BYTES) throw new Error("Supervisor request is too large.");
	writeAtomicJson(requestPath(metadata.channelDir, requestId), request);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	try {
		const reply = await waitForReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: Record<string, unknown> = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply.message);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		removeRequestFile(requestPath(metadata.channelDir, requestId));
		throw error;
	}
}

function hasTool(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

/**
 * Register the child-side `contact_supervisor` tool. The host passes the
 * channel metadata in the child runtime config.
 */
export function registerNativeSupervisorClient(pi: ExtensionAPI, metadata: ChildSupervisorMetadata | undefined): void {
	if (!metadata || hasTool(pi, "contact_supervisor")) return;
	const tool: ToolDefinition<typeof ContactSupervisorParamsSchema, Record<string, unknown>> = {
		name: "contact_supervisor",
		label: "Contact Supervisor",
		description: "Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
		parameters: ContactSupervisorParamsSchema,
		execute(id, params, signal) {
			return sendSupervisorRequest(params as ContactSupervisorParams, metadata, signal, id);
		},
	};
	pi.registerTool(tool);
}

function parseRequestFile(file: string, channelDir: string): PendingSupervisorRequest | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<SupervisorRequest>;
		if (parsed.type !== "subagent.supervisor.request") return undefined;
		if (typeof parsed.id !== "string" || !parsed.id) return undefined;
		if (parsed.reason !== "need_decision" && parsed.reason !== "interview_request" && parsed.reason !== "progress_update") return undefined;
		if (typeof parsed.message !== "string" || (!parsed.message.trim() && parsed.reason !== "interview_request")) return undefined;
		if (typeof parsed.runId !== "string" || typeof parsed.agent !== "string" || typeof parsed.childIndex !== "number") return undefined;
		return {
			...parsed as SupervisorRequest,
			...(typeof parsed.toolCallId === "string" && parsed.toolCallId.length > 0 ? { toolCallId: parsed.toolCallId } : { toolCallId: undefined }),
			channelDir,
			requestFile: file,
		};
	} catch {
		return undefined;
	}
}

function listRequestFiles(): Array<{ channelDir: string; file: string }> {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files: Array<{ channelDir: string; file: string }> = [];
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		const channelDir = path.join(SUPERVISOR_CHANNEL_ROOT, entry.name);
		const requestsDir = path.join(channelDir, REQUESTS_DIR);
		let requestEntries: fs.Dirent[];
		try {
			requestEntries = fs.readdirSync(requestsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const requestEntry of requestEntries) {
			if (requestEntry.isFile() && requestEntry.name.endsWith(".json")) files.push({ channelDir, file: path.join(requestsDir, requestEntry.name) });
		}
	}
	return files;
}

function readDirectoryEntries(dir: string): fs.Dirent[] | undefined {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
}

function directoryMtimeMs(dir: string): number {
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return 0;
	}
}

function removeEmptyDirectory(dir: string): boolean {
	try {
		fs.rmdirSync(dir);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return true;
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EBUSY") return false;
		throw error;
	}
}

function removeStaleEmptySupervisorChannel(channelDir: string, nowMs: number): boolean {
	const requestsDir = path.join(channelDir, REQUESTS_DIR);
	const repliesDir = path.join(channelDir, REPLIES_DIR);
	const newestKnownMtimeMs = Math.max(
		directoryMtimeMs(channelDir),
		directoryMtimeMs(requestsDir),
		directoryMtimeMs(repliesDir),
	);
	if (nowMs - newestKnownMtimeMs < STALE_EMPTY_CHANNEL_AGE_MS) return false;

	const requestEntries = readDirectoryEntries(requestsDir);
	if (!requestEntries || requestEntries.length > 0) return false;
	const replyEntries = readDirectoryEntries(repliesDir);
	if (!replyEntries || replyEntries.length > 0) return false;

	if (!removeEmptyDirectory(requestsDir)) return false;
	if (!removeEmptyDirectory(repliesDir)) return false;
	if (!removeEmptyDirectory(channelDir)) return false;
	return true;
}

function cleanupStaleEmptySupervisorChannels(nowMs = Date.now()): number {
	let channelEntries: fs.Dirent[];
	try {
		channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}

	let removed = 0;
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		try {
			if (removeStaleEmptySupervisorChannel(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name), nowMs)) removed++;
		} catch {
			// Cleanup is opportunistic; active writers can race with us and will be picked up by a later pass.
		}
	}
	return removed;
}

function requestMatchesOwner(request: SupervisorRequest, state: Pick<SubagentState, "supervisorOwnerSessionId">): boolean {
	const currentSessionId = state.supervisorOwnerSessionId;
	return Boolean(currentSessionId && request.orchestratorSessionId === currentSessionId);
}

function rememberedForegroundChild(request: SupervisorRequest, state: SubagentState) {
	const run = state.foregroundRuns?.get(request.runId);
	const child = run?.children.find((candidate) => candidate.index === request.childIndex && candidate.agent === request.agent)
		?? run?.children[request.childIndex];
	return run && child ? { run, child } : undefined;
}

function markForegroundSupervisorAttention(request: SupervisorRequest, state: SubagentState): void {
	const remembered = rememberedForegroundChild(request, state);
	if (!remembered || remembered.child.status !== "detached") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = "needs_attention";
	remembered.child.lastActivityAt = request.createdAt;
	remembered.child.currentTool = "contact_supervisor";
	remembered.child.currentToolStartedAt = request.createdAt;
	remembered.child.updatedAt = updatedAt;
}

function clearForegroundSupervisorAttention(request: SupervisorRequest, pending: Map<string, PendingSupervisorRequest>, state: SubagentState): void {
	if ([...pending.values()].some((candidate) =>
		candidate.expectsReply
		&& candidate.runId === request.runId
		&& candidate.agent === request.agent
		&& candidate.childIndex === request.childIndex
	)) return;
	const remembered = rememberedForegroundChild(request, state);
	if (!remembered || remembered.child.status !== "detached") return;
	const updatedAt = Date.now();
	remembered.run.updatedAt = updatedAt;
	remembered.child.activityState = undefined;
	remembered.child.lastActivityAt = updatedAt;
	remembered.child.currentTool = undefined;
	remembered.child.currentToolStartedAt = undefined;
	remembered.child.updatedAt = updatedAt;
}

function removeRequestFile(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// Request cleanup is best-effort; reply files and timeout errors remain authoritative.
	}
}

type SupervisorRequestLifecycle = "pending" | "resolved" | "expired" | "inactive" | "missing" | "wrong-session";
type SupervisorRequestLifecycleObserver = (request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle) => void;

function requestExpiresAt(request: SupervisorRequest, now: number): number {
	const expiresAt = (request as { expiresAt?: unknown }).expiresAt;
	if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) return expiresAt;
	return Number.isFinite(request.createdAt) ? request.createdAt + askTimeoutMs() : now;
}

function requestRunInactive(request: SupervisorRequest, state: SubagentState): boolean {
	if (state.foregroundControls.has(request.runId)) return false;
	const foreground = rememberedForegroundChild(request, state);
	if (foreground) return foreground.child.status !== "detached";

	const asyncJob = state.asyncJobs.get(request.runId);
	if (!asyncJob) return false;
	if (asyncJob.status === "complete" || asyncJob.status === "failed" || asyncJob.status === "paused") return true;
	const stepStatus = asyncJob.steps?.[request.childIndex]?.status;
	return stepStatus === "complete" || stepStatus === "completed" || stepStatus === "failed" || stepStatus === "paused";
}

function requestLifecycle(request: PendingSupervisorRequest, state: SubagentState, now: number, runState: SubagentState): SupervisorRequestLifecycle {
	if (!requestMatchesOwner(request, state)) return "wrong-session";
	if (!fs.existsSync(request.requestFile)) return "missing";
	if (request.expectsReply && fs.existsSync(replyPath(request.channelDir, request.id))) return "resolved";
	if (request.expectsReply && now > requestExpiresAt(request, now)) return "expired";
	if (request.expectsReply && requestRunInactive(request, runState)) return "inactive";
	return "pending";
}

function cleanupRequestLifecycle(request: PendingSupervisorRequest, lifecycle: SupervisorRequestLifecycle): void {
	if (lifecycle === "resolved" || lifecycle === "expired" || lifecycle === "inactive") removeRequestFile(request.requestFile);
}

function refreshPendingRequests(pending: Map<string, PendingSupervisorRequest>, state: SubagentState, onLifecycle: SupervisorRequestLifecycleObserver, runState: (request: SupervisorRequest) => SubagentState): void {
	const now = Date.now();
	for (const request of pending.values()) {
		const lifecycle = requestLifecycle(request, state, now, runState(request));
		if (lifecycle === "pending") continue;
		pending.delete(request.id);
		onLifecycle(request, lifecycle);
		cleanupRequestLifecycle(request, lifecycle);
	}
}

function formatPendingLine(request: PendingSupervisorRequest): string {
	const replyHint = request.expectsReply ? ` Reply: ${supervisorReplyHint(request.id)}` : "";
	return `- ${request.id}: ${request.agent} [${request.runId}#${request.childIndex}] ${request.reason}.${replyHint}`;
}

function requestVisibleText(request: PendingSupervisorRequest): string {
	const lines = [
		reasonHeading(request.reason),
		`Run: ${request.runId}`,
		`Agent: ${request.agent}`,
		`Child index: ${request.childIndex}`,
	];
	if (request.childTarget) lines.push(`Child intercom target: ${request.childTarget}`);
	lines.push("");
	if (request.message) lines.push(request.message);
	if (request.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (request.interview !== undefined) lines.push(JSON.stringify(request.interview, null, "\t"));
	}
	if (request.expectsReply) lines.push("", `Reply with: ${supervisorReplyHint(request.id)}`);
	return lines.join("\n").trimEnd();
}

function writeReply(request: PendingSupervisorRequest, message: string): SupervisorReply {
	if (!message.trim()) throw new Error("message is required for supervisor replies.");
	const reply: SupervisorReply = {
		type: "subagent.supervisor.reply",
		requestId: request.id,
		createdAt: Date.now(),
		message: message.trim(),
	};
	writeAtomicJson(replyPath(request.channelDir, request.id), reply);
	removeRequestFile(request.requestFile);
	return reply;
}

function appendSupervisorReplyEntry(pi: ExtensionAPI, request: PendingSupervisorRequest, reply: SupervisorReply): void {
	const appendEntry = (pi as unknown as {
		appendEntry?: (customType: string, data?: SupervisorReplyEntryData) => void;
	}).appendEntry;
	if (typeof appendEntry !== "function") return;
	try {
		appendEntry.call(pi, SUPERVISOR_REPLY_ENTRY_TYPE, {
			requestId: request.id,
			reason: request.reason,
			runId: request.runId,
			agent: request.agent,
			childIndex: request.childIndex,
			...(request.childTarget ? { childTarget: request.childTarget } : {}),
			message: reply.message,
			createdAt: reply.createdAt,
		});
	} catch (error) {
		// The reply file is authoritative; a UI journal failure must not undo a delivered reply.
		console.error("Failed to journal native supervisor reply:", error);
	}
}

function resolvePendingRequest(pending: Map<string, PendingSupervisorRequest>, params: IntercomParams): PendingSupervisorRequest {
	if (params.replyTo) {
		const request = pending.get(params.replyTo);
		if (!request) throw new Error(`No pending supervisor request found for replyTo '${params.replyTo}'.`);
		return request;
	}
	const requests = [...pending.values()].filter((request) => request.expectsReply);
	if (params.to) {
		const normalizedTo = params.to.toLowerCase();
		const matches = requests.filter((request) =>
			request.id.toLowerCase().startsWith(normalizedTo)
			|| request.agent.toLowerCase() === normalizedTo
			|| request.childTarget?.toLowerCase() === normalizedTo,
		);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Multiple pending supervisor requests match '${params.to}'. Use replyTo.`);
		throw new Error(`No pending supervisor request matches '${params.to}'. Use replyTo.`);
	}
	if (requests.length === 1) return requests[0]!;
	if (requests.length === 0) throw new Error("No pending supervisor requests need a reply.");
	throw new Error("Multiple pending supervisor requests need replies. Use replyTo.");
}

function publicPendingRequests(pending: Map<string, PendingSupervisorRequest>): Array<Record<string, unknown>> {
	return [...pending.values()].map((request) => ({
		id: request.id,
		runId: request.runId,
		agent: request.agent,
		childIndex: request.childIndex,
		reason: request.reason,
		expectsReply: request.expectsReply,
	}));
}

function buildParentSupervisorTool(pi: ExtensionAPI, pending: Map<string, PendingSupervisorRequest>, state: SubagentState, onLifecycle: SupervisorRequestLifecycleObserver, discover: () => void, runState: (request: SupervisorRequest) => SubagentState): ToolDefinition<typeof IntercomParamsSchema, Record<string, unknown>> {
	return {
		name: NATIVE_SUPERVISOR_TOOL_NAME,
		label: "Subagent Supervisor",
		description: "Native pi-subagents supervisor channel. Use reply/pending/status to answer child subagent requests without overriding pi-intercom.",
		parameters: IntercomParamsSchema,
		async execute(_id, params) {
			// Scan the channel root before answering. `refreshPendingRequests` only re-evaluates asks
			// ALREADY in `pending`; it never reads the filesystem. Because no fs watcher is installed on
			// darwin and the 500ms poller is demand-gated and self-cancelling, an ask written while
			// nothing was polling stayed invisible and every `action:"pending"` reported "No pending
			// supervisor requests" while the child blocked in contact_supervisor. An explicit supervisor
			// query must always be authoritative against disk.
			discover();
			refreshPendingRequests(pending, state, onLifecycle, runState);
			const input = params as IntercomParams;
			if (input.action === "status") {
				return { content: [{ type: "text", text: `Native supervisor channel active. Pending replies: ${pending.size}.` }], details: { active: true, pending: pending.size, root: SUPERVISOR_CHANNEL_ROOT } };
			}
			if (input.action === "pending" || input.action === "list") {
				const lines = [...pending.values()].filter((request) => request.expectsReply).map(formatPendingLine);
				return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No pending supervisor requests." }], details: { pending: publicPendingRequests(pending) } };
			}
			if (input.action === "reply") {
				const request = resolvePendingRequest(pending, input);
				const reply = writeReply(request, input.message ?? "");
				appendSupervisorReplyEntry(pi, request, reply);
				onLifecycle(request, "resolved");
				pending.delete(request.id);
				clearForegroundSupervisorAttention(request, pending, state);
				return { content: [{ type: "text", text: `Replied to supervisor request ${request.id}.` }], details: { replyTo: request.id, runId: request.runId, agent: request.agent } };
			}
			if (input.action === "send" || input.action === "ask") {
				throw new Error("The native subagent supervisor handles replies only. Child agents initiate asks with contact_supervisor.");
			}
			throw new Error(`Unsupported supervisor action: ${input.action}`);
		},
	};
}

export function createNativeSupervisorChannel(pi: ExtensionAPI, state: SubagentState, deps: NativeSupervisorChannelDeps = {}): {
	start: () => void;
	activateTransport: () => void;
	findPendingAsks: (target: { runId: string; agent: string; childIndex: number }) => string[];
	dispose: () => void;
	pending: Map<string, PendingSupervisorRequest>;
	getSupervisorRequestState: (event: ControlEvent) => SupervisorRequestState;
} {
	const watch = deps.watch ?? fs.watch;
	const timers = deps.timers ?? globalThis;
	const runState = (request: SupervisorRequest): SubagentState => {
		for (const ownerState of deps.getCurrentOwnerStates?.() ?? []) {
			if (ownerState.asyncJobs.has(request.runId)) return ownerState;
		}
		return state;
	};
	const pending = new Map<string, PendingSupervisorRequest>();
	const requestCorrelations = new Map<string, SupervisorRequestCorrelation>();
	const correlationKey = (request: { runId: string; agent: string; childIndex: number; toolCallId?: string }): string | undefined => {
		if (!request.toolCallId) return undefined;
		return JSON.stringify([request.runId, request.agent, request.childIndex, request.toolCallId]);
	};
	const pruneRequestCorrelations = (now = Date.now()): void => {
		for (const [key, correlation] of requestCorrelations) {
			if (correlation.state === "resolved" && now - correlation.updatedAt > SUPERVISOR_REQUEST_CORRELATION_RETENTION_MS) requestCorrelations.delete(key);
		}
		while (requestCorrelations.size > MAX_SUPERVISOR_REQUEST_CORRELATIONS) {
			const oldest = requestCorrelations.keys().next().value;
			if (oldest === undefined) break;
			requestCorrelations.delete(oldest);
		}
	};
	const rememberPendingRequest = (request: PendingSupervisorRequest): void => {
		const key = correlationKey(request);
		if (!key || !request.expectsReply) return;
		requestCorrelations.set(key, { request, state: "pending", updatedAt: Date.now() });
		pruneRequestCorrelations();
	};
	const rememberResolvedRequest = (request: PendingSupervisorRequest): void => {
		const key = correlationKey(request);
		if (!key || !request.expectsReply) return;
		requestCorrelations.set(key, { request, state: "resolved", updatedAt: Date.now() });
		pruneRequestCorrelations();
	};
	const observeRequestLifecycle: SupervisorRequestLifecycleObserver = (request, lifecycle) => {
		if (lifecycle !== "wrong-session") rememberResolvedRequest(request);
	};
	const getSupervisorRequestState = (event: ControlEvent): SupervisorRequestState => {
		if (event.currentTool === "intercom" || event.index === undefined) return "unknown";
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length > 0 ? event.toolCallId : undefined;
		if (!toolCallId) return "unknown";
		pruneRequestCorrelations();
		const key = correlationKey({ runId: event.runId, agent: event.agent, childIndex: event.index, toolCallId });
		if (!key) return "unknown";
		const correlation = requestCorrelations.get(key);
		if (!correlation) return "unknown";
		if (correlation.state === "resolved") return "resolved";
		const now = Date.now();
		if (!fs.existsSync(correlation.request.requestFile)
			|| fs.existsSync(replyPath(correlation.request.channelDir, correlation.request.id))
			|| now > requestExpiresAt(correlation.request, now)
			|| requestRunInactive(correlation.request, runState(correlation.request))) {
			rememberResolvedRequest(correlation.request);
			return "resolved";
		}
		return "pending";
	};
	const seenFiles = new Set<string>();
	const requestWatchers = new Map<string, fs.FSWatcher>();
	let rootWatcher: fs.FSWatcher | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	let safetyPoller: ReturnType<typeof setInterval> | undefined;
	let deferredWatcherRefresh: ReturnType<typeof setImmediate> | undefined;
	let started = false;
	let lastStaleCleanupAt = 0;
	const platform = deps.platform ?? process.platform;
	const useNativeWatcher = () => shouldUseNativeFsWatch("supervisor-channel", platform) && platform !== "win32";
	const hasTransportDemand = () => {
		if (pending.size > 0) return true;
		if (state.foregroundControls.size > 0) return true;
		if ([...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running")) return true;
		for (const ownerState of deps.getCurrentOwnerStates?.() ?? []) {
			for (const job of ownerState.asyncJobs.values()) {
				if (job.status === "queued" || job.status === "running") return true;
			}
		}
		return false;
	};

	const registerParentTools = (): void => {
		if (!hasTool(pi, NATIVE_SUPERVISOR_TOOL_NAME)) pi.registerTool(buildParentSupervisorTool(pi, pending, state, observeRequestLifecycle, () => poll(), runState));
	};

	const cleanupStaleChannelsIfDue = (): void => {
		const nowMs = Date.now();
		if (nowMs - lastStaleCleanupAt < STALE_EMPTY_CHANNEL_CLEANUP_INTERVAL_MS) return;
		lastStaleCleanupAt = nowMs;
		try {
			cleanupStaleEmptySupervisorChannels(nowMs);
		} catch {
			// Supervisor delivery must not fail because best-effort temp cleanup failed.
		}
	};

	const poll = (): void => {
		cleanupStaleChannelsIfDue();
		// Registration must not require a live UI context. Returning early whenever
		// `state.lastUiContext` was null (never set yet, or nulled by a stale-context error) meant an
		// ask written by a child was never read off disk, so `subagent_supervisor({action:"pending"})`
		// reported nothing. The queue is authoritative; only the display notification needs the context.
		refreshPendingRequests(pending, state, observeRequestLifecycle, runState);
		const now = Date.now();
		for (const { channelDir, file } of listRequestFiles()) {
			if (seenFiles.has(file)) continue;
			const request = parseRequestFile(file, channelDir);
			if (!request || !requestMatchesOwner(request, state)) continue;
			const lifecycle = requestLifecycle(request, state, now, runState(request));
			if (lifecycle !== "pending") {
				seenFiles.add(file);
				observeRequestLifecycle(request, lifecycle);
				cleanupRequestLifecycle(request, lifecycle);
				continue;
			}
			seenFiles.add(file);
			if (request.expectsReply) {
				rememberPendingRequest(request);
				pending.set(request.id, request);
				markForegroundSupervisorAttention(request, state);
			}
			// The ask is already queued above. A sendMessage failure (no UI, stale context) must not
			// lose it, and must not abort the loop before the remaining asks register.
			try {
				pi.sendMessage({
					customType: SUPERVISOR_REQUEST_MESSAGE_TYPE,
					content: requestVisibleText(request),
					display: true,
					details: {
						id: request.id,
						requestId: request.id,
						reason: request.reason,
						expectsReply: request.expectsReply,
						runId: request.runId,
						agent: request.agent,
						childIndex: request.childIndex,
						...(request.childTarget ? { childTarget: request.childTarget } : {}),
						...(request.interview !== undefined ? { interview: request.interview } : {}),
						requestBody: request.message,
						...(request.expectsReply ? { replyHint: supervisorReplyHint(request.id) } : {}),
					},
				}, { triggerTurn: true });
				// sendMessage accepts synchronously; one-way updates stay on disk until it returns.
				if (!request.expectsReply) removeRequestFile(request.requestFile);
			} catch (error) {
				// Allow an existing later scan to retry an unaccepted one-way update.
				if (!request.expectsReply) seenFiles.delete(file);
				console.error(`Failed to surface supervisor request ${request.id} as a user turn:`, error);
			}
			if (request.expectsReply) {
				(pi as { events?: IntercomEventBus }).events?.emit(INTERCOM_DETACH_REQUEST_EVENT, {
					requestId: request.id,
					runId: request.runId,
					agent: request.agent,
					childIndex: request.childIndex,
				});
				if (pending.has(request.id)) markForegroundSupervisorAttention(request, state);
			}
		}
	};

	const startPolling = (): void => {
		if (poller) return;
		poller = timers.setInterval(() => {
			poll();
			if (!useNativeWatcher() && platform === "darwin" && !hasTransportDemand()) {
				if (poller) timers.clearInterval(poller);
				poller = undefined;
			}
		}, CHANNEL_POLL_MS);
		poller.unref?.();
	};
	const startSafetyPolling = (): void => {
		if (safetyPoller) return;
		safetyPoller = timers.setInterval(() => {
			watchExistingRequestDirs();
			poll();
		}, CHANNEL_SAFETY_POLL_MS);
		safetyPoller.unref?.();
	};
	const watchRequestDir = (requestsDir: string): void => {
		if (requestWatchers.has(requestsDir)) return;
		try {
			const watcher = watch(requestsDir, () => poll());
			watcher.on("error", () => {
				try { watcher.close(); } catch {}
				requestWatchers.delete(requestsDir);
				startPolling();
			});
			watcher.unref?.();
			requestWatchers.set(requestsDir, watcher);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") startPolling();
		}
	};
	const watchExistingRequestDirs = (): void => {
		let channelEntries: fs.Dirent[];
		try {
			channelEntries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			startPolling();
			return;
		}
		for (const entry of channelEntries) {
			if (entry.isDirectory()) watchRequestDir(path.join(SUPERVISOR_CHANNEL_ROOT, entry.name, REQUESTS_DIR));
		}
	};
	const scheduleWatcherRefresh = (): void => {
		if (deferredWatcherRefresh) return;
		deferredWatcherRefresh = timers.setImmediate(() => {
			deferredWatcherRefresh = undefined;
			if (!started) return;
			watchExistingRequestDirs();
			poll();
		});
		deferredWatcherRefresh.unref?.();
	};

	return {
		activateTransport: () => {
			if (!started) return;
			poll();
			if (!useNativeWatcher() && hasTransportDemand()) startPolling();
		},
		findPendingAsks: (target) => {
			// Receipt-only discovery: no registration, notification, cleanup or reply writes.
			const channelDir = resolveSupervisorChannelDir(target.runId, target.agent, target.childIndex);
			let files: string[];
			try { files = fs.readdirSync(path.join(channelDir, REQUESTS_DIR)); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			const now = Date.now();
			return files.filter(file => file.endsWith(".json")).flatMap(file => {
				const request = parseRequestFile(path.join(channelDir, REQUESTS_DIR, file), channelDir);
				return request?.expectsReply && request.runId === target.runId
					&& request.agent === target.agent && request.childIndex === target.childIndex
					&& requestLifecycle(request, state, now, runState(request)) === "pending" ? [request.id] : [];
			}).sort();
		},
		start: () => {
			if (started) return;
			started = true;
			registerParentTools();
			poll();
			try {
				fs.mkdirSync(SUPERVISOR_CHANNEL_ROOT, { recursive: true });
				if (!useNativeWatcher()) {
					if (platform === "win32") startPolling();
					return;
				}
				watchExistingRequestDirs();
				rootWatcher = watch(SUPERVISOR_CHANNEL_ROOT, () => {
					watchExistingRequestDirs();
					poll();
					scheduleWatcherRefresh();
				});
				rootWatcher.on("error", startPolling);
				startSafetyPolling();
				scheduleWatcherRefresh();
			} catch {
				startPolling();
			}
		},
		dispose: () => {
			started = false;
			try {
				rootWatcher?.close();
			} catch {
				// Best effort during shutdown.
			}
			rootWatcher = undefined;
			for (const watcher of requestWatchers.values()) {
				try { watcher.close(); } catch {}
			}
			requestWatchers.clear();
			if (poller) timers.clearInterval(poller);
			poller = undefined;
			if (safetyPoller) timers.clearInterval(safetyPoller);
			safetyPoller = undefined;
			if (deferredWatcherRefresh) timers.clearImmediate(deferredWatcherRefresh);
			deferredWatcherRefresh = undefined;
			pending.clear();
			requestCorrelations.clear();
			seenFiles.clear();
		},
		pending,
		getSupervisorRequestState,
	};
}
