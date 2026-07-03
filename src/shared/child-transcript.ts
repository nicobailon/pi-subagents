import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { extractTextFromContent, extractToolArgsPreview } from "./utils.ts";

export const CHILD_TRANSCRIPT_ARTIFACT_VERSION = 1;
const DEFAULT_MAX_CHILD_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

type ChildTranscriptSource = "foreground" | "async";
type ChildTranscriptRecordType = "message" | "tool_start" | "tool_end" | "stdout" | "stderr" | "truncated";

type ChildTranscriptMessage = Message & {
	model?: string;
	errorMessage?: string;
	stopReason?: string;
	usage?: unknown;
};

interface ChildTranscriptEvent {
	type?: string;
	message?: ChildTranscriptMessage;
	toolName?: string;
	args?: unknown;
}

interface ChildTranscriptWriterInput {
	transcriptPath: string;
	source: ChildTranscriptSource;
	runId: string;
	agent: string;
	childIndex?: number;
	cwd: string;
	maxBytes?: number;
}

export interface ChildTranscriptWriter {
	path: string;
	writeInitialUserMessage(prompt: string): void;
	writeChildEvent(event: ChildTranscriptEvent): void;
	writeStdoutLine(line: string): void;
	writeStderrLine(line: string): void;
	writeStderrText(text: string): void;
	getError(): string | undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsage(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const rawCost = raw.cost;
	const cost = rawCost && typeof rawCost === "object"
		? finiteNumber((rawCost as { total?: unknown }).total) ?? 0
		: finiteNumber(rawCost) ?? 0;
	return {
		input: finiteNumber(raw.input) ?? finiteNumber(raw.inputTokens) ?? 0,
		output: finiteNumber(raw.output) ?? finiteNumber(raw.outputTokens) ?? 0,
		cacheRead: finiteNumber(raw.cacheRead) ?? 0,
		cacheWrite: finiteNumber(raw.cacheWrite) ?? 0,
		cost,
	};
}

function eventArgs(event: ChildTranscriptEvent): Record<string, unknown> {
	return event.args && typeof event.args === "object" && !Array.isArray(event.args)
		? event.args as Record<string, unknown>
		: {};
}

export function createChildTranscriptWriter(input: ChildTranscriptWriterInput): ChildTranscriptWriter {
	let bytesWritten = 0;
	let writeError: string | undefined;
	let truncated = false;
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_CHILD_TRANSCRIPT_BYTES;

	const baseRecord = (recordType: ChildTranscriptRecordType) => {
		const ts = Date.now();
		return {
			version: CHILD_TRANSCRIPT_ARTIFACT_VERSION,
			recordType,
			source: input.source,
			runId: input.runId,
			agent: input.agent,
			...(input.childIndex !== undefined ? { childIndex: input.childIndex } : {}),
			cwd: input.cwd,
			ts,
			timestamp: new Date(ts).toISOString(),
		};
	};

	const writeTruncatedMarker = () => {
		truncated = true;
		const marker = `${JSON.stringify({
			...baseRecord("truncated"),
			maxBytes,
			message: `Child transcript exceeded ${maxBytes} bytes; further records were omitted.`,
		})}\n`;
		const markerBytes = Buffer.byteLength(marker, "utf-8");
		if (bytesWritten + markerBytes > maxBytes) return false;
		try {
			fs.appendFileSync(input.transcriptPath, marker, "utf-8");
			bytesWritten += markerBytes;
			return true;
		} catch (error) {
			writeError = `Failed to write child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
			return false;
		}
	};

	const writeRecord = (record: Record<string, unknown>) => {
		if (writeError || truncated) return;
		const line = `${JSON.stringify(record)}\n`;
		const bytes = Buffer.byteLength(line, "utf-8");
		if (bytesWritten + bytes > maxBytes) {
			writeTruncatedMarker();
			return;
		}
		const markerProbe = `${JSON.stringify({
			...baseRecord("truncated"),
			maxBytes,
			message: `Child transcript exceeded ${maxBytes} bytes; further records were omitted.`,
		})}\n`;
		if (bytesWritten + bytes + Buffer.byteLength(markerProbe, "utf-8") > maxBytes) {
			writeTruncatedMarker();
			return;
		}
		try {
			fs.appendFileSync(input.transcriptPath, line, "utf-8");
			bytesWritten += bytes;
		} catch (error) {
			writeError = `Failed to write child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
		}
	};

	try {
		fs.mkdirSync(path.dirname(input.transcriptPath), { recursive: true });
		fs.writeFileSync(input.transcriptPath, "", "utf-8");
	} catch (error) {
		writeError = `Failed to initialize child transcript '${input.transcriptPath}': ${errorMessage(error)}`;
	}

	const writeMessage = (sourceEventType: string, message: ChildTranscriptMessage) => {
		const text = extractTextFromContent(message.content);
		writeRecord({
			...baseRecord("message"),
			sourceEventType,
			role: message.role,
			...(text ? { text } : {}),
			...(message.model ? { model: message.model } : {}),
			...(message.stopReason ? { stopReason: message.stopReason } : {}),
			...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
			...(message.usage ? { usage: normalizeUsage(message.usage) } : {}),
			message,
		});
	};

	return {
		path: input.transcriptPath,
		writeInitialUserMessage(prompt: string) {
			writeRecord({
				...baseRecord("message"),
				sourceEventType: "initial_prompt",
				role: "user",
				text: prompt,
				message: { role: "user", content: [{ type: "text", text: prompt }] },
			});
		},
		writeChildEvent(event: ChildTranscriptEvent) {
			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				writeMessage(event.type, event.message);
				return;
			}
			if (event.type === "tool_execution_start" && event.toolName) {
				const args = eventArgs(event);
				writeRecord({
					...baseRecord("tool_start"),
					sourceEventType: event.type,
					toolName: event.toolName,
					...(Object.keys(args).length > 0 ? { argsPreview: extractToolArgsPreview(args) } : {}),
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				writeRecord({
					...baseRecord("tool_end"),
					sourceEventType: event.type,
					...(event.toolName ? { toolName: event.toolName } : {}),
				});
			}
		},
		writeStdoutLine(line: string) {
			if (!line.trim()) return;
			writeRecord({ ...baseRecord("stdout"), text: line });
		},
		writeStderrLine(line: string) {
			if (!line.trim()) return;
			writeRecord({ ...baseRecord("stderr"), text: line });
		},
		writeStderrText(text: string) {
			for (const line of text.split(/\r?\n/)) this.writeStderrLine(line);
		},
		getError() {
			return writeError;
		},
	};
}
