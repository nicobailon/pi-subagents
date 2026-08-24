import * as path from "node:path";
import type { ExternalCliParser, ExternalCliParserProgress, ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;

export const GROK_BUILD_ADAPTER_ID = "grok-build" as const;
export const GROK_BUILD_READ_TOOLS = "read_file,grep,list_dir" as const;
export const GROK_BUILD_DISALLOWED_TOOLS = "run_terminal_cmd,search_replace,Agent" as const;
export const GROK_BUILD_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"GROK_HOME",
	"XAI_API_KEY",
	"GROK_DISABLE_AUTOUPDATER",
	"GROK_MEMORY",
	"GROK_SUBAGENTS",
	"GROK_WRITE_FILE",
	"GROK_CLAUDE_AGENTS_ENABLED",
	"GROK_CLAUDE_HOOKS_ENABLED",
	"GROK_CLAUDE_MCPS_ENABLED",
	"GROK_CLAUDE_RULES_ENABLED",
	"GROK_CLAUDE_SESSIONS_ENABLED",
	"GROK_CLAUDE_SKILLS_ENABLED",
	"GROK_CODEX_SESSIONS_ENABLED",
	"GROK_CURSOR_AGENTS_ENABLED",
	"GROK_CURSOR_HOOKS_ENABLED",
	"GROK_CURSOR_MCPS_ENABLED",
	"GROK_CURSOR_RULES_ENABLED",
	"GROK_CURSOR_SESSIONS_ENABLED",
	"GROK_CURSOR_SKILLS_ENABLED",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function eventError(event: Record<string, unknown>, fallback: string): string {
	for (const value of [event.message, event.error]) {
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_ERROR_LENGTH);
	}
	return fallback;
}

export function createGrokBuildJsonlParser(): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	let reportedError: string | undefined;
	const text: string[] = [];
	return {
		parseLine(line): ExternalCliParserProgress {
			let value: unknown;
			try { value = JSON.parse(line) as unknown; }
			catch (error) { throw new Error(`Grok Build emitted malformed JSONL: ${error instanceof Error ? error.message : String(error)}`); }
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grok Build emitted a JSONL event that is not an object.");
			const event = value as Record<string, unknown>;
			if (typeof event.type !== "string" || !event.type || event.type.length > MAX_EVENT_TYPE_LENGTH) throw new Error("Grok Build emitted a JSONL event with an invalid type.");
			if (terminal) throw new Error("Grok Build emitted an event after its terminal state.");
			eventCount += 1;
			if (event.type === "text" && typeof event.data === "string") text.push(event.data);
			else if (event.type === "error" && !reportedError) reportedError = eventError(event, "Grok Build reported an error event.");
			else if (event.type === "end") {
				if (reportedError) terminal = { state: "failed", error: reportedError };
				else if (event.stopReason !== "end_turn") {
					const reason = typeof event.stopReason === "string" && event.stopReason ? event.stopReason : "missing";
					terminal = { state: "failed", error: `Grok Build stopped without successful end_turn: ${reason}.` };
				} else {
					const output = text.join("").trim();
					terminal = output
						? { state: "completed", output }
						: { state: "failed", error: "Grok Build completed without final text." };
				}
			}
			return { phase: terminal ? terminal.state : "streaming", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			return terminal ?? (reportedError ? { state: "failed", error: reportedError } : undefined);
		},
	};
}

export function resolveGrokBuildLaunch(input: {
	command: string;
	cwd: string;
	asyncDir: string;
	stepIndex: number;
	/** Test-only executable prefix for a fake Grok Build process. */
	commandPrefixArgs?: readonly string[];
}): {
	command: string;
	args: string[];
	finalOutputPath?: undefined;
	promptFilePath: string;
	temporaryDirectories: string[];
	environment: { allowlist: readonly string[]; values: Readonly<Record<string, string>> };
	preflight: ExternalCliPreflightSpec;
	parser: ExternalCliParser;
} {
	const promptFilePath = path.join(input.asyncDir, `external-${input.stepIndex}.grok-prompt.txt`);
	const grokHomePath = path.join(input.asyncDir, `external-${input.stepIndex}.grok-home`);
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [
		...prefix,
		"--cwd", input.cwd,
		"--prompt-file", promptFilePath,
		"--output-format", "streaming-json",
		"--permission-mode", "plan",
		"--tools", GROK_BUILD_READ_TOOLS,
		"--disallowed-tools", GROK_BUILD_DISALLOWED_TOOLS,
		"--deny", "Bash",
		"--deny", "Edit",
		"--deny", "Write",
		"--deny", "MCPTool",
		"--disable-web-search",
		"--no-subagents",
		"--sandbox", "read-only",
		"--max-turns", "16",
	];
	return {
		command: input.command,
		args,
		promptFilePath,
		temporaryDirectories: [grokHomePath],
		environment: {
			allowlist: GROK_BUILD_ENV_ALLOWLIST,
			values: {
				HOME: grokHomePath,
				USERPROFILE: grokHomePath,
				GROK_HOME: grokHomePath,
				GROK_DISABLE_AUTOUPDATER: "1",
				GROK_MEMORY: "0",
				GROK_SUBAGENTS: "0",
				GROK_WRITE_FILE: "0",
				GROK_CLAUDE_AGENTS_ENABLED: "0",
				GROK_CLAUDE_HOOKS_ENABLED: "0",
				GROK_CLAUDE_MCPS_ENABLED: "0",
				GROK_CLAUDE_RULES_ENABLED: "0",
				GROK_CLAUDE_SESSIONS_ENABLED: "0",
				GROK_CLAUDE_SKILLS_ENABLED: "0",
				GROK_CODEX_SESSIONS_ENABLED: "0",
				GROK_CURSOR_AGENTS_ENABLED: "0",
				GROK_CURSOR_HOOKS_ENABLED: "0",
				GROK_CURSOR_MCPS_ENABLED: "0",
				GROK_CURSOR_RULES_ENABLED: "0",
				GROK_CURSOR_SESSIONS_ENABLED: "0",
				GROK_CURSOR_SKILLS_ENABLED: "0",
			},
		},
		preflight: {
			id: GROK_BUILD_ADAPTER_ID,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "--help"],
			evidenceArgs: [...prefix, "inspect", "--json"],
			evidenceLabel: "inspect --json",
			validate(result) {
				if (!/^grok \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \([0-9a-f]+\)(?: \[[^\]]+\])?$/.test(result.version)) throw new Error(`Unsupported Grok Build version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["Grok Build TUI", "--cwd", "--prompt-file", "streaming-json", "--permission-mode", "plan", "--tools", "--disallowed-tools", "--deny", "--disable-web-search", "--no-subagents", "--sandbox", "--max-turns"]) {
					if (!result.help.includes(required)) throw new Error(`Grok Build help does not document required option ${JSON.stringify(required)}.`);
				}
				let inspect: unknown;
				try { inspect = JSON.parse(result.evidence ?? ""); }
				catch (error) { throw new Error(`Grok Build inspect --json returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`); }
				if (!inspect || typeof inspect !== "object" || Array.isArray(inspect)) throw new Error("Grok Build inspect --json did not return an object.");
				const inspectRecord = inspect as Record<string, unknown>;
				for (const field of ["hooks", "lspServers", "mcpServers", "plugins"] as const) {
					const entries = inspectRecord[field];
					if (!Array.isArray(entries)) throw new Error(`Grok Build inspect --json field ${field} is invalid.`);
					if (entries.length > 0) throw new Error(`Grok Build inspect --json discovered executable configuration in ${field}.`);
				}
				const externalCompat = inspectRecord.externalCompat;
				if (!externalCompat || typeof externalCompat !== "object" || Array.isArray(externalCompat)) throw new Error("Grok Build inspect --json field externalCompat is invalid.");
				const cells = (externalCompat as Record<string, unknown>).cells;
				if (!Array.isArray(cells) || cells.some((cell) => !cell || typeof cell !== "object" || Array.isArray(cell) || (cell as Record<string, unknown>).enabled !== false)) {
					throw new Error("Grok Build inspect --json did not confirm disabled external compatibility.");
				}
			},
		},
		parser: createGrokBuildJsonlParser(),
	};
}
