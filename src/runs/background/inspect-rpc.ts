import * as fs from "node:fs";
import { sanitizeDisplayText, truncateDisplayText } from "../../shared/display-text.ts";
import { decodeUtf8Tail } from "../../shared/utf8.ts";
import { DIRS, type AsyncStatus, type NestedRunSummary, type SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { readSessionMessagesTail, type SessionTranscriptMessage } from "./fleet-view.ts";
import { completionReplayPath, readCompletionArchive, readCompletionReplay } from "./completion-replay.ts";
import { resultPayloadPathForSessionRun } from "./result-files.ts";
import { resolveSubagentRunId } from "./run-id-resolver.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";

/** On-demand inspection of current-session async children. Re-reads canonical artifacts after the same reconciliation as status; nothing is persisted or broadcast. */

export const INSPECT_REPLY_KIND = "pi-subagents.inspect-reply";
export const INSPECT_REPLY_VERSION = 1;
export const INSPECT_WIDGET_KEY = "subagent-inspect";
export const INSPECT_WIDGET_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";

export type InspectErrorCode =
	| "invalid_request"
	| "not_found"
	| "foreign_session"
	| "stale"
	| "no_active_session"
	| "internal";

export interface InspectRequest {
	requestId: string;
	asyncId: string;
	childId?: string;
	lines?: number;
}

export interface InspectReplyMessage {
	role: string;
	kind: "text" | "toolCall" | "toolResult";
	text: string;
	name?: string;
	isError?: boolean;
}

export interface InspectReply {
	kind: typeof INSPECT_REPLY_KIND;
	version: typeof INSPECT_REPLY_VERSION;
	requestId: string;
	/** Canonical run id of the inspected node. Absent on error replies that
	 *  could not resolve a run. */
	asyncId?: string;
	childId?: string;
	status?: AsyncStatus["state"];
	label?: string;
	task?: string;
	messages?: InspectReplyMessage[];
	finalOutput?: string;
	truncated?: { task: boolean; messages: number; finalOutput: boolean };
	error?: { code: InspectErrorCode; message: string };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 160;
const MAX_TASK_LENGTH = 2_000;
const MAX_FINAL_OUTPUT_LENGTH = 8_000;
const MAX_MESSAGE_TEXT_LENGTH = 1_000;
const DEFAULT_MESSAGE_LINES = 100;
const MAX_MESSAGE_LINES = 200;
const FAILED_OUTPUT_ARTIFACT_PREFIX = "Subagent run failed before producing output.\n\nError:\n";
export const MAX_SERIALIZED_BYTES = 64 * 1024;

export interface InspectDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = sanitizeDisplayText(value.slice(0, maxLength * 4));
	return normalized ? truncateDisplayText(normalized, maxLength) : undefined;
}

/** Bound long-form content without flattening it: task/finalOutput/message text
 *  must keep newlines readable. Only the two unicode line separators are
 *  normalized, since JSON.stringify does not escape them and hosts split the
 *  widget payload on line boundaries. */
function boundContent(value: string, maxLength: number): string {
	const normalized = value.replace(/[\u2028\u2029]/g, "\n");
	return truncateDisplayText(normalized, maxLength);
}

function errorReply(request: Partial<InspectRequest>, code: InspectErrorCode, message: string): InspectReply {
	return {
		kind: INSPECT_REPLY_KIND,
		version: INSPECT_REPLY_VERSION,
		requestId: typeof request.requestId === "string" && REQUEST_ID_PATTERN.test(request.requestId) ? request.requestId : "invalid",
		...(typeof request.asyncId === "string" ? { asyncId: truncateDisplayText(request.asyncId, MAX_ID_LENGTH) } : {}),
		...(typeof request.childId === "string" ? { childId: truncateDisplayText(request.childId, MAX_ID_LENGTH) } : {}),
		error: { code, message },
	};
}

export function parseInspectRequest(args: string): { request?: InspectRequest; error?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	let lines: number | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--lines") {
			const value = tokens[++index];
			const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
			if (!Number.isFinite(parsed)) return { error: "--lines requires an integer value." };
			lines = parsed;
			continue;
		}
		if (token.startsWith("--")) return { error: `Unknown flag: ${token}. Supported: --lines N.` };
		positional.push(token);
	}
	const [requestId, asyncId, childId, ...extra] = positional;
	if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
		return { error: "requestId must match [A-Za-z0-9_-]{1,64}." };
	}
	if (!asyncId) return { error: "Usage: /subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]." };
	if (asyncId.length > MAX_ID_LENGTH || (childId !== undefined && childId.length > MAX_ID_LENGTH)) {
		return { error: "asyncId/childId exceed the maximum length." };
	}
	if (extra.length > 0) return { error: "Too many positional arguments. Usage: /subagents-inspect-rpc <requestId> <asyncId> [childId] [--lines N]." };
	if (lines !== undefined && (lines < 1 || !Number.isSafeInteger(lines))) return { error: "--lines must be a positive integer." };
	return { request: { requestId, asyncId, childId, lines } };
}

interface ResolvedNode {
	asyncDir: string;
	status: AsyncStatus;
	stepIndex?: number;
	label?: string;
}

function findChildNode(status: AsyncStatus, asyncDir: string, childId: string): ResolvedNode | { error: string } {
	const steps = status.steps ?? [];
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index]!;
		const ids = [step.workflowKey, step.runId, `step:${index}`];
		if (ids.includes(childId)) {
			return { asyncDir, status, stepIndex: index, label: step.label ?? step.agent };
		}
	}
	const findNested = (children: readonly NestedRunSummary[] | undefined): NestedRunSummary | undefined => {
		for (const child of children ?? []) {
			if (child.id === childId) return child;
			const deeper = findNested(child.children);
			if (deeper) return deeper;
		}
		return undefined;
	};
	for (const step of steps) {
		const nested = findNested(step.children);
		if (nested) {
			if (!nested.asyncDir) return { error: `Child '${childId}' has no async directory to inspect.` };
			const childStatus = readStatus(nested.asyncDir);
			if (!childStatus) return { error: `Child '${childId}' status is unavailable.` };
			return { asyncDir: nested.asyncDir, status: childStatus, label: nested.agent ?? nested.agents?.join(", ") };
		}
	}
	return { error: `Child '${childId}' was not found under async run '${status.runId}'.` };
}

function resultOutput(data: unknown, stepIndex: number | undefined): { output?: string; errorText?: string } {
	if (!isRecord(data)) throw new Error("Async result payload must be an object.");
	if (data.results !== undefined && !Array.isArray(data.results)) throw new Error("Async result payload results must be an array.");
	if (data.summary !== undefined && typeof data.summary !== "string") throw new Error("Async result payload summary must be a string.");
	const results = data.results;
	if (stepIndex !== undefined && results) {
		const stepResult = results[stepIndex];
		if (stepResult === undefined) return {};
		if (!isRecord(stepResult)) throw new Error("Async result payload step result must be an object.");
		if (stepResult.output !== undefined && typeof stepResult.output !== "string") throw new Error("Async result payload step output must be a string.");
		if (stepResult.error !== undefined && typeof stepResult.error !== "string") throw new Error("Async result payload step error must be a string.");
		return {
			...(typeof stepResult.output === "string" ? { output: stepResult.output } : {}),
			...(typeof stepResult.error === "string" ? { errorText: stepResult.error } : {}),
		};
	}
	if (typeof data.summary === "string") return { output: data.summary };
	if (results?.length === 1) {
		const result = results[0];
		if (!isRecord(result)) throw new Error("Async result payload result must be an object.");
		if (result.output !== undefined && typeof result.output !== "string") throw new Error("Async result payload output must be a string.");
		if (typeof result.output === "string") return { output: result.output };
	}
	return {};
}

function readOutputArtifact(outputPath: string): { output?: string; errorText?: string } {
	const file = fs.openSync(outputPath, "r");
	try {
		const prefix = Buffer.allocUnsafe(Buffer.byteLength(FAILED_OUTPUT_ARTIFACT_PREFIX, "utf-8"));
		const prefixBytes = fs.readSync(file, prefix, 0, prefix.length, 0);
		const failedOutput = prefix.subarray(0, prefixBytes).toString("utf-8") === FAILED_OUTPUT_ARTIFACT_PREFIX;
		const size = fs.fstatSync(file).size;
		const length = Math.min(size, MAX_FINAL_OUTPUT_LENGTH * 4);
		const buffer = Buffer.allocUnsafe(length);
		const bytesRead = fs.readSync(file, buffer, 0, length, size - length);
		let text = decodeUtf8Tail(buffer.subarray(0, bytesRead));
		if (!failedOutput) return { output: text };
		const metadata = text.lastIndexOf("\nMetadata: ");
		if (metadata >= 0 && !text.slice(metadata + 1).includes("\n")) text = text.slice(0, metadata);
		const transcript = text.lastIndexOf("\n\nTranscript: ");
		if (transcript >= 0 && !text.slice(transcript + 2).includes("\n")) text = text.slice(0, transcript);
		return { errorText: text.startsWith(FAILED_OUTPUT_ARTIFACT_PREFIX) ? text.slice(FAILED_OUTPUT_ARTIFACT_PREFIX.length) : text };
	} finally {
		fs.closeSync(file);
	}
}

function readSessionBackedOutput(sessionPath: string, trustedRoots: string[], trustedSessionFileRoot?: string): { output?: string } {
	if (trustedRoots.length === 0 && !trustedSessionFileRoot) return {};
	// The archive retains the child's session file as its output record. The
	// final answer is the terminal assistant message's text — all text parts
	// of that one session record, not just the last part.
	const tail = readSessionMessagesTail(sessionPath, MAX_MESSAGE_LINES, trustedRoots, [sessionPath], trustedSessionFileRoot);
	const last = tail.messages.findLast((message) => message.role === "assistant" && message.kind === "text");
	if (!last) return {};
	const parts = tail.messages.filter((message) => message.recordIndex === last.recordIndex && message.kind === "text");
	return { output: parts.map((part) => part.text).join("\n") };
}

function readResultOutput(resultsDir: string, sessionId: string, runId: string, stepIndex: number | undefined, trustedRoots: string[], stepAgent: string | undefined, now: () => number, trustedSessionFileRoot?: string): { output?: string; errorText?: string } {
	const resultPath = resultPayloadPathForSessionRun(resultsDir, sessionId, runId);
	if (resultPath) return resultOutput(JSON.parse(fs.readFileSync(resultPath, "utf-8")) as unknown, stepIndex);
	// Read the raw record first: readCompletionReplay best-effort deletes
	// invalid or expired records, so reading after it cannot distinguish
	// "never existed" from "failed validation".
	const replayPath = completionReplayPath(resultsDir, runId);
	let rawReplay: unknown;
	try {
		rawReplay = JSON.parse(fs.readFileSync(replayPath, "utf-8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const nowMs = now();
	const replay = readCompletionReplay(resultsDir, runId, { sessionId, now: nowMs });
	if (!replay) {
		// readCompletionReplay also returns undefined for absent, expired, foreign,
		// and unknown-version records. A current-version, unexpired record for this
		// run and session that still failed validation is an inspection failure,
		// not a child without output — surface it instead of replying success with
		// no finalOutput.
		if (isRecord(rawReplay) && rawReplay.version === 1 && rawReplay.runId === runId
			&& rawReplay.sessionId === sessionId
			&& typeof rawReplay.expiresAt === "number" && rawReplay.expiresAt > nowMs) {
			throw new Error("Completion replay record failed validation.");
		}
		return {};
	}
	const archive = readCompletionArchive(replay.archivePath);
	// Run-level inspection must not attribute a child's output to the run in a
	// multi-child archive. Current child entries carry resultIndex and agent;
	// run-level entries carry neither. Legacy archives (written before
	// resultIndex existed) have child entries with agent but no resultIndex,
	// so child reads fall back to a unique agent name. Duplicate legacy agent
	// names fail closed. A single-child archive is the one exception: the run's
	// output IS that child's output, including a legacy agent-tagged entry.
	const childEntries = archive?.entries.filter((entry) => entry.resultIndex !== undefined || entry.agent !== undefined) ?? [];
	const singleChild = childEntries.length === 1;
	const uniqueLegacyAgent = (agent: string | undefined): boolean =>
		agent !== undefined
		&& archive?.entries.filter((entry) => entry.resultIndex === undefined && entry.agent === agent).length === 1;
	const matches = (entry: { resultIndex?: number; agent?: string }): boolean => {
		if (stepIndex !== undefined) {
			if (entry.resultIndex !== undefined) return entry.resultIndex === stepIndex;
			return uniqueLegacyAgent(stepAgent) && entry.agent === stepAgent;
		}
		if (singleChild) return entry.resultIndex !== undefined || entry.agent !== undefined;
		return entry.resultIndex === undefined && entry.agent === undefined;
	};
	const artifact = archive?.entries.find((entry) => entry.source === "output-artifact" && matches(entry));
	const artifactPath = artifact?.source === "output-artifact" ? artifact.path : undefined;
	if (artifactPath) return readOutputArtifact(artifactPath);
	const sessionEntry = archive?.entries.find((entry) => entry.source === "session" && matches(entry));
	const sessionPath = sessionEntry?.source === "session" ? sessionEntry.path : undefined;
	if (sessionPath) return readSessionBackedOutput(sessionPath, trustedRoots, trustedSessionFileRoot);
	const output = archive?.entries.find((entry) => entry.source === "result-tail" && matches(entry))?.text;
	return output ? { output } : {};
}

function toReplyMessage(message: SessionTranscriptMessage): InspectReplyMessage {
	return {
		role: truncateDisplayText(sanitizeDisplayText(message.role), 32),
		kind: message.kind,
		text: boundContent(message.text, MAX_MESSAGE_TEXT_LENGTH),
		...(message.name ? { name: truncateDisplayText(sanitizeDisplayText(message.name), 96) } : {}),
		...(message.isError === true ? { isError: true } : {}),
	};
}

/** Fit the reply under MAX_SERIALIZED_BYTES: drop oldest messages first, then
 *  shrink finalOutput, then task. The envelope always survives. */
function enforceByteBudget(reply: InspectReply): InspectReply {
	const truncated = reply.truncated ?? { task: false, messages: 0, finalOutput: false };
	const sized = (): number => Buffer.byteLength(JSON.stringify(reply), "utf-8");
	while (reply.messages && reply.messages.length > 0 && sized() > MAX_SERIALIZED_BYTES) {
		reply.messages.shift();
		truncated.messages += 1;
	}
	if (sized() > MAX_SERIALIZED_BYTES && reply.finalOutput) {
		reply.finalOutput = truncateDisplayText(reply.finalOutput, Math.max(0, reply.finalOutput.length - (sized() - MAX_SERIALIZED_BYTES) - 256));
		truncated.finalOutput = true;
	}
	if (sized() > MAX_SERIALIZED_BYTES && reply.task) {
		reply.task = truncateDisplayText(reply.task, Math.max(0, reply.task.length - (sized() - MAX_SERIALIZED_BYTES) - 256));
		truncated.task = true;
	}
	if (truncated.task || truncated.messages > 0 || truncated.finalOutput) reply.truncated = truncated;
	return reply;
}

export function buildInspectReply(request: InspectRequest, deps: InspectDeps = {}): InspectReply {
	const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
	const resultsDir = deps.resultsDir ?? DIRS.results;
	const currentSessionId = deps.state?.currentSessionId ?? undefined;
	if (!currentSessionId) {
		return errorReply(request, "no_active_session", "Inspection requires an active session; the request could not be attributed to a session.");
	}

	let resolved: ReturnType<typeof resolveSubagentRunId>;
	try {
		resolved = resolveSubagentRunId(request.asyncId, { asyncDirRoot, resultsDir, state: deps.state });
	} catch {
		return errorReply(request, "invalid_request", "The requested async run could not be resolved.");
	}
	if (!resolved || resolved.kind === "foreground") {
		return errorReply(request, "not_found", `Async run '${request.asyncId}' was not found.`);
	}

	try {
		let asyncDir: string;
		let status: AsyncStatus | null;
		if (resolved.kind === "nested") {
			reconcileNestedAsyncDescendants(resolved.match.route, { resultsDir, kill: deps.kill, now: deps.now });
			asyncDir = resolved.match.run.asyncDir ?? "";
			status = asyncDir ? readStatus(asyncDir) : null;
		} else {
			if (!resolved.location.asyncDir) return errorReply(request, "stale", `Async run '${request.asyncId}' has no remaining artifacts.`);
			asyncDir = resolved.location.asyncDir;
			status = reconcileAsyncRun(asyncDir, { resultsDir, kill: deps.kill, now: deps.now }).status ?? readStatus(asyncDir);
		}
		if (!status) return errorReply(request, "stale", `Async run '${request.asyncId}' artifacts are no longer available.`);
		if (status.sessionId !== currentSessionId) {
			return errorReply(request, "foreign_session", "Inspection is only available for async runs owned by the current session.");
		}

		const node: ResolvedNode | { error: string } = request.childId === undefined
			? { asyncDir, status }
			: findChildNode(status, asyncDir, request.childId);
		if ("error" in node) return errorReply(request, "not_found", node.error);
		if (node.asyncDir !== asyncDir) {
			if (node.status.sessionId !== currentSessionId) {
				return errorReply(request, "foreign_session", "Inspection is only available for async runs owned by the current session.");
			}
			reconcileAsyncRun(node.asyncDir, { resultsDir, kill: deps.kill, now: deps.now });
			node.status = readStatus(node.asyncDir) ?? node.status;
		}

		const step = node.stepIndex !== undefined ? node.status.steps?.[node.stepIndex] : undefined;
		const lineLimit = Math.max(1, Math.min(MAX_MESSAGE_LINES, Math.trunc(request.lines ?? DEFAULT_MESSAGE_LINES)));
		const sessionFile = step?.sessionFile ?? node.status.sessionFile;
		const trustedRoots = [...new Set([
			...(deps.state?.trustedSessionRoots ?? []),
			...(node.status.sessionRoot ? [node.status.sessionRoot] : []),
		])];

		let messages: InspectReplyMessage[] | undefined;
		let task: string | undefined;
		if (sessionFile && (trustedRoots.length > 0 || deps.state?.trustedSessionFileRoot)) {
			const tail = readSessionMessagesTail(sessionFile, lineLimit, trustedRoots, [sessionFile], deps.state?.trustedSessionFileRoot);
			if (tail.messages.length > 0) {
				messages = tail.messages.map(toReplyMessage);
				// The delegated task is the child session's first user message, but
				// only when it is genuinely attributable: fresh-context children
				// (forked sessions begin with inherited parent history) whose
				// session file is fully inside the read window (a truncated tail
				// means the first visible user message may be a steering message).
				if (!tail.truncated && node.status.context !== "fork" && step?.context !== "fork") {
					const firstUser = tail.messages.find((message) => message.role === "user" && message.kind === "text");
					if (firstUser) task = firstUser.text;
				}
			}
		}

		const result = readResultOutput(resultsDir, currentSessionId, node.status.runId, node.stepIndex, trustedRoots, step?.agent, deps.now ?? Date.now, deps.state?.trustedSessionFileRoot);
		const failedText = step?.error ?? node.status.error;
		if (result.output === undefined && result.errorText === undefined && failedText !== undefined) {
			return errorReply(request, "internal", "Inspection could not read the async run artifacts.");
		}
		const finalOutputRaw = result.output ?? result.errorText;

		const truncated = { task: false, messages: 0, finalOutput: false };
		const boundedTask = task !== undefined ? boundContent(task, MAX_TASK_LENGTH) : undefined;
		if (task !== undefined && boundedTask !== task) truncated.task = true;
		const boundedFinal = finalOutputRaw !== undefined ? boundContent(finalOutputRaw, MAX_FINAL_OUTPUT_LENGTH) : undefined;
		if (finalOutputRaw !== undefined && boundedFinal !== finalOutputRaw) truncated.finalOutput = true;
		const label = publicText(node.label ?? step?.label ?? step?.agent ?? node.status.runId, MAX_LABEL_LENGTH);

		const reply: InspectReply = {
			kind: INSPECT_REPLY_KIND,
			version: INSPECT_REPLY_VERSION,
			requestId: request.requestId,
			asyncId: node.status.runId,
			...(request.childId !== undefined ? { childId: request.childId } : {}),
			status: node.status.state,
			...(label ? { label } : {}),
			...(boundedTask !== undefined ? { task: boundedTask } : {}),
			...(messages && messages.length > 0 ? { messages } : {}),
			...(boundedFinal !== undefined ? { finalOutput: boundedFinal } : {}),
			...(truncated.task || truncated.finalOutput || truncated.messages > 0 ? { truncated } : {}),
		};
		return enforceByteBudget(reply);
	} catch {
		return errorReply(request, "internal", "Inspection could not read the async run artifacts.");
	}
}

export function encodeInspectReply(reply: InspectReply): string[] {
	return [`${INSPECT_WIDGET_PREFIX}${JSON.stringify(reply)}`];
}

/** Parse the slash-command args and always return a correlated inspect reply. */
export function handleInspectRpcArgs(args: string, deps: InspectDeps = {}): InspectReply {
	const parsed = parseInspectRequest(args);
	if (parsed.error || !parsed.request) {
		// Echo a well-formed requestId so the host can correlate the failure.
		const firstToken = args.trim().split(/\s+/)[0];
		const echo = firstToken !== undefined && REQUEST_ID_PATTERN.test(firstToken) ? { requestId: firstToken } : {};
		return errorReply(echo, "invalid_request", parsed.error ?? "Invalid inspect request.");
	}
	return buildInspectReply(parsed.request, deps);
}
