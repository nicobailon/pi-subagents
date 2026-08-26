import { parseExternalCliJsonlEvent, type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;

export const CLAUDE_CODE_ADAPTER_ID = "claude-code" as const;
export const CLAUDE_CODE_WRITER_ADAPTER_ID = "claude-code-writer" as const;
export const CLAUDE_CODE_WRITER_TOOLS = "Read,Write,Edit,Glob,Grep" as const;
export const CLAUDE_CODE_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"CLAUDE_CONFIG_DIR",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"CLOUD_ML_REGION",
	"ANTHROPIC_VERTEX_PROJECT_ID",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function terminalError(event: Record<string, unknown>): string {
	for (const value of [event.error, event.result]) {
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_ERROR_LENGTH);
	}
	if (Array.isArray(event.errors)) {
		const messages = event.errors.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
		if (messages.length > 0) return messages.join("; ").slice(0, MAX_ERROR_LENGTH);
	}
	const subtype = typeof event.subtype === "string" && event.subtype ? event.subtype : "unknown";
	return `Claude Code reported terminal result ${subtype}.`;
}

export function createClaudeCodeJsonlParser(): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	return {
		parseLine(line): ExternalCliParserProgress {
			const event = parseExternalCliJsonlEvent(line, "Claude Code", MAX_EVENT_TYPE_LENGTH);
			if (terminal && event.type === "result") throw new Error("Claude Code emitted a duplicate terminal result.");
			eventCount += 1;
			if (!terminal && event.type === "result") {
				if (event.subtype === "success" && event.is_error === false && typeof event.result === "string" && event.result.trim()) {
					terminal = { state: "completed", output: event.result.trim() };
				} else {
					terminal = { state: "failed", error: terminalError(event) };
				}
			}
			return { phase: terminal ? terminal.state : "streaming", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			return terminal;
		},
	};
}

export function resolveClaudeCodeLaunch(input: {
	adapter: typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID;
	command: string;
	/** Test-only executable prefix for a fake Claude Code process. */
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
	const writer = input.adapter === CLAUDE_CODE_WRITER_ADAPTER_ID;
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [
		...prefix,
		"-p",
		"--input-format", "text",
		"--output-format", "stream-json",
		"--verbose",
		"--permission-mode", writer ? "acceptEdits" : "plan",
		"--tools", writer ? CLAUDE_CODE_WRITER_TOOLS : "",
		"--strict-mcp-config",
		"--mcp-config", '{"mcpServers":{}}',
		"--setting-sources", "user",
		"--no-session-persistence",
		"--disable-slash-commands",
		"--no-chrome",
	];
	return {
		command: input.command,
		args,
		environment: { allowlist: CLAUDE_CODE_ENV_ALLOWLIST },
		preflight: {
			id: input.adapter,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "--help"],
			validate(result) {
				if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \(Claude Code\)$/.test(result.version)) throw new Error(`Unsupported Claude Code version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["Claude Code - starts an interactive session", "--print", "--input-format", "stream-json", "--verbose", "--permission-mode", writer ? "acceptEdits" : "plan", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--no-session-persistence", "--disable-slash-commands", "--no-chrome"]) {
					if (!result.help.includes(required)) throw new Error(`Claude Code help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createClaudeCodeJsonlParser(),
	};
}
