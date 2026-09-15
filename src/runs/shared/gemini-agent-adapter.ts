import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;
const AgyResultSchema = Type.Object({
	status: Type.Optional(Type.String()),
	response: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
}, { additionalProperties: true });
const AgyEventSchema = Type.Object({ event: Type.String(), result: Type.Optional(Type.Unknown()) }, { additionalProperties: true });
type AgyResult = Static<typeof AgyResultSchema>;
type AgyEvent = Static<typeof AgyEventSchema>;

export const GEMINI_AGENT_ADAPTER_ID = "gemini-agent" as const;
export const GEMINI_AGENT_WRITER_ADAPTER_ID = "gemini-agent-writer" as const;
export const GEMINI_AGENT_ENV_ALLOWLIST = [
	"PATH", "HOME", "USERPROFILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
	"http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

function resultError(result: AgyResult): string {
	for (const value of [result.error, result.response, result.status]) {
		if (value?.trim()) return value.trim().slice(0, MAX_ERROR_LENGTH);
	}
	return "agy reported an unsuccessful result.";
}

export function serializeGeminiAgentPrompt(prompt: string): string {
	return `${JSON.stringify({ event: "user", message: { role: "user", content: prompt } })}\n`;
}

export function createGeminiAgentJsonlParser(): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	return {
		parseLine(line): ExternalCliParserProgress {
			let parsed: unknown;
			try { parsed = JSON.parse(line); }
			catch (error) { throw new Error(`agy emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`); }
			if (!Value.Check(AgyEventSchema, parsed)) throw new Error("agy emitted a JSONL event that is not an object.");
			// SAFETY: Value.Check establishes AgyEventSchema before this typed view.
			const event = parsed as AgyEvent;
			if (!event.event || event.event.length > MAX_EVENT_TYPE_LENGTH) throw new Error("agy emitted a JSONL event with an invalid event name.");
			if (terminal) throw new Error("agy emitted an event after its terminal state.");
			eventCount += 1;
			if (event.event === "result") {
				const result = event.result;
				if (!Value.Check(AgyResultSchema, result)) {
					terminal = { state: "failed", error: "agy result event has an invalid result object." };
				} else {
					// SAFETY: Value.Check establishes AgyResultSchema before this typed view.
					const value = result as AgyResult;
					if (value.status === "SUCCESS" && value.response?.trim()) terminal = { state: "completed", output: value.response.trim() };
					else terminal = { state: "failed", error: resultError(value) };
				}
			}
			return { phase: terminal ? terminal.state : "streaming", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			return terminal;
		},
	};
}

export interface GeminiAgentLaunch {
	command: string;
	args: string[];
	finalOutputPath?: undefined;
	promptFilePath?: undefined;
	temporaryDirectories?: undefined;
	promptDelivery: "stdin";
	serializePrompt: (prompt: string) => string;
	environment: { allowlist: readonly string[] };
	preflight: ExternalCliPreflightSpec;
	parser: ExternalCliParser;
}

export function resolveGeminiAgentLaunch(input: {
	adapter: typeof GEMINI_AGENT_ADAPTER_ID | typeof GEMINI_AGENT_WRITER_ADAPTER_ID;
	command: string;
	/** Test-only executable prefix for a fake agy process. */
	commandPrefixArgs?: readonly string[];
}): GeminiAgentLaunch {
	const writer = input.adapter === GEMINI_AGENT_WRITER_ADAPTER_ID;
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [...prefix, "--input-format", "stream-json", "--output-format", "stream-json", "--mode", writer ? "accept-edits" : "plan", "--sandbox"];
	return {
		command: input.command,
		args,
		promptDelivery: "stdin",
		serializePrompt: serializeGeminiAgentPrompt,
		environment: { allowlist: GEMINI_AGENT_ENV_ALLOWLIST },
		preflight: {
			id: input.adapter,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "--help"],
			validate(result) {
				if (!result.version.trim()) throw new Error("agy version response is empty.");
				for (const required of ["--input-format", "stream-json", "--output-format", "--mode", "plan", "accept-edits", "--sandbox"]) {
					if (!result.help.includes(required)) throw new Error(`agy help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createGeminiAgentJsonlParser(),
	};
}
