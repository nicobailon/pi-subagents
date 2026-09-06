import { type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;

export const AGY_ADAPTER_WRITER_ID = "agy-writer" as const;
export const AGY_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function parseAgyJsonlEvent(line: string): { event: string; result?: Record<string, unknown> } {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (error) {
		throw new Error(`agy emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agy emitted a JSONL event that is not an object.");
	const event = value as Record<string, unknown>;
	if (typeof event.event !== "string" || !event.event || event.event.length > MAX_EVENT_TYPE_LENGTH) throw new Error("agy emitted a JSONL event with an invalid event field.");
	const result = event.result;
	if (result !== undefined && (!result || typeof result !== "object" || Array.isArray(result))) throw new Error("agy emitted a JSONL event with a non-object result field.");
	return { event: event.event, ...(result !== undefined ? { result: result as Record<string, unknown> } : {}) };
}

function resultError(result: Record<string, unknown> | undefined): string | undefined {
	for (const key of ["error", "message"] as const) {
		const value = result?.[key];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_ERROR_LENGTH);
	}
	return undefined;
}

export function createAgyJsonlParser(): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	return {
		parseLine(line): ExternalCliParserProgress {
			const event = parseAgyJsonlEvent(line);
			if (terminal) throw new Error("agy emitted an event after its terminal state.");
			eventCount += 1;
			if (!terminal && event.event === "result") {
				const status = event.result?.status;
				const response = event.result?.response;
				if (status === "SUCCESS" && typeof response === "string" && response.trim()) {
					terminal = { state: "completed", output: response.trim() };
				} else {
					terminal = { state: "failed", error: resultError(event.result) ?? `agy reported terminal result with status ${typeof status === "string" && status ? status : "unknown"}.` };
				}
			}
			return { phase: terminal ? terminal.state : "working", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			return terminal;
		},
	};
}

export function resolveAgyLaunch(input: {
	adapter: typeof AGY_ADAPTER_WRITER_ID;
	command: string;
	/** Test-only executable prefix for a fake agy process. */
	commandPrefixArgs?: readonly string[];
}): {
	command: string;
	args: string[];
	finalOutputPath?: undefined;
	promptFilePath?: undefined;
	temporaryDirectories?: undefined;
	environment: { allowlist: readonly string[] };
	preflight: ExternalCliPreflightSpec;
	parser: ExternalCliParser;
} {
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [
		...prefix,
		"--input-format", "text",
		"--output-format", "stream-json",
		"--mode", "accept-edits",
	];
	return {
		command: input.command,
		args,
		environment: { allowlist: AGY_ENV_ALLOWLIST },
		preflight: {
			id: input.adapter,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "--help"],
			validate(result) {
				if (!/^\d+\.\d+\.\d+$/.test(result.version)) throw new Error(`Unsupported agy version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["--print", "--input-format", "stream-json", "--output-format", "--mode", "accept-edits"]) {
					if (!result.help.includes(required)) throw new Error(`agy help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createAgyJsonlParser(),
	};
}
