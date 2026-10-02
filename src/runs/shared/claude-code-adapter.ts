import { parseExternalCliJsonlEvent, type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "../../shared/model-info.ts";
import { assertThinkingWithinCeiling } from "../../shared/thinking-ceiling.ts";
import { checkModelScope, type ResolvedModelScope } from "./model-scope.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;

export const CLAUDE_CODE_ADAPTER_ID = "claude-code" as const;
export const CLAUDE_CODE_WRITER_ADAPTER_ID = "claude-code-writer" as const;

/** True for the two code-owned adapters that launch the Claude Code CLI. */
export function isClaudeCodeAdapterId(value: unknown): value is typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID {
	return value === CLAUDE_CODE_ADAPTER_ID || value === CLAUDE_CODE_WRITER_ADAPTER_ID;
}
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

/**
 * Claude Code exposes a five-value `--effort` scale. Pi's thinking vocabulary is
 * wider, so the extra levels collapse onto the nearest supported value and `off`
 * means "pass no flag at all".
 */
const CLAUDE_CODE_EFFORT_BY_THINKING: Record<ThinkingLevel, string | undefined> = {
	off: undefined,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/**
 * Claude Code model ids: aliases, `claude-*` ids, and Bedrock/Vertex prefixes.
 * `:` stays legal because Bedrock inference profiles and ARNs contain it, so the
 * thinking suffix is split off before this pattern is applied rather than
 * excluded by it.
 */
const CLAUDE_CODE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const INVALID_CLAUDE_CODE_MODEL = "expected an alias such as \"opus\" or a model id such as \"claude-opus-5.5\"";

export interface ClaudeCodeOverride {
	/** Tokens appended after the adapter's fixed argv. */
	args: string[];
	/** Model id the launch pins, when it pins one. */
	model?: string;
}

/** The agent-config fields that can pin a model, structurally typed to avoid importing them. */
export interface ClaudeCodeAgentModel {
	model?: string | false;
	modelSource?: { type?: string; model?: string };
}

/**
 * The model an agent pins for itself. `subagents.defaultModel` is a Pi child
 * model, so it is a default for Pi children only and never becomes `--model`.
 */
function agentPinnedModel(agent: ClaudeCodeAgentModel | undefined): string | undefined {
	const model = typeof agent?.model === "string" ? agent.model : undefined;
	if (!model) return undefined;
	if (agent?.modelSource?.type === "subagents.defaultModel" && agent.modelSource.model === model) return undefined;
	return model;
}

/**
 * A launch that asks only for a level keeps the agent's pinned model, so
 * `model: ":high"` means the same thing as frontmatter `thinking: high`.
 */
function combineClaudeCodeModel(launch: string | undefined, pinned: string | undefined): string | undefined {
	if (launch === undefined) return pinned;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(launch);
	if (baseModel) return launch;
	if (!launch) return launch;
	// An empty base means the request was a bare level: run it on the agent's model.
	const pinnedBase = pinned ? splitKnownThinkingSuffix(pinned).baseModel : "";
	return pinnedBase && thinkingSuffix ? `${pinnedBase}${thinkingSuffix}` : launch;
}

/**
 * Resolve an explicit model and thinking level for a code-owned Claude Code
 * adapter. Returns undefined when neither was requested, so the CLI falls back
 * to its own configured default.
 *
 * The level travels as the same `:level` suffix Pi children use:
 * `model: "claude-opus-5.5:high"` pins the model and the effort, and a bare
 * `model: ":high"` takes the effort alone on the agent's own model. A suffix
 * wins over the frontmatter `thinking` value, which is the precedence Pi
 * children already use.
 *
 * Values are validated here because this module owns the adapter's argv: every
 * returned token is passed as its own argv element, and an unusable value is a
 * rejected launch rather than a silently different model. The ceiling is checked
 * against the requested level, not against the effort it maps to.
 */
export function resolveClaudeCodeOverride(input: {
	model?: string;
	agent?: ClaudeCodeAgentModel;
	thinking?: string;
	thinkingCeiling?: ThinkingLevel;
	agentName?: string;
	runId?: string;
}): ClaudeCodeOverride | undefined {
	const args: string[] = [];
	let model: string | undefined;
	let level: string | undefined;
	const launchModel = input.model === undefined ? undefined : input.model.trim();
	const requested = combineClaudeCodeModel(launchModel, agentPinnedModel(input.agent));
	if (requested !== undefined) {
		const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(requested);
		level = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
		if (baseModel) {
			if (!CLAUDE_CODE_MODEL_PATTERN.test(baseModel)) throw new Error(`Invalid Claude Code model ${JSON.stringify(requested)}; ${INVALID_CLAUDE_CODE_MODEL}.`);
			model = baseModel;
			args.push("--model", baseModel);
		} else if (!level) {
			// The request reduced to nothing: neither a model nor a level survived.
			throw new Error(`Invalid Claude Code model ${JSON.stringify(requested)}; ${INVALID_CLAUDE_CODE_MODEL}.`);
		}
	}
	if (!level && input.thinking !== undefined) {
		const thinking = input.thinking.trim();
		if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
			throw new Error(`Invalid thinking level ${JSON.stringify(input.thinking)}; expected one of ${THINKING_LEVELS.join(", ")}.`);
		}
		level = thinking;
	}
	if (level) {
		// A level can arrive without a model, so it goes to the shared check as the
		// suffix form that check already understands.
		assertThinkingWithinCeiling({ model: `:${level}`, ceiling: input.thinkingCeiling, agent: input.agentName, runId: input.runId });
		const effort = CLAUDE_CODE_EFFORT_BY_THINKING[level as ThinkingLevel];
		if (effort) args.push("--effort", effort);
	}
	if (args.length === 0) return undefined;
	return { args, ...(model ? { model } : {}) };
}

/**
 * A Claude Code launch pins a model the Pi registry does not know, so an enforced
 * model scope can only be honored by checking the id the CLI will actually run.
 * A launch that pins nothing cannot be checked at all, and an enforced scope must
 * not be bypassed by staying silent.
 */
export function assertClaudeCodeModelScope(input: { scopes: readonly ResolvedModelScope[]; model?: string; agent: string; runId?: string }): void {
	const enforced = input.scopes.filter((scope) => scope.enforce === true);
	if (enforced.length === 0) return;
	if (!input.model) {
		const subject = input.runId ? `agent '${input.agent}' run '${input.runId}'` : `agent '${input.agent}'`;
		throw new Error(`${subject} does not name a Claude Code model, so it cannot be checked against an enforced subagent model scope (modelScope). Name the model on the launch, or in the agent's frontmatter, or turn enforcement off.`);
	}
	for (const scope of enforced) {
		const violation = checkModelScope(input.model, scope, "explicit");
		if (violation) throw new Error(violation.message);
	}
}

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
	/** Trailing argv for an explicit model/thinking request, built by resolveClaudeCodeOverride. */
	overrideArgs?: readonly string[];
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
		// Session options go last: preflight builds versionArgs/helpArgs from `prefix`
		// only, so these tokens never reach the --version/--help probes.
		...(input.overrideArgs ?? []),
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
				// Claude Code now publishes both semver (`2.1.259 (Claude Code)`) and
				// calendar/platform (`2026.4.24 macos-arm64 (2026-04-27)`) versions.
				// The fixed launch flags are validated from --help below, so only require a
				// recognizable release identifier here rather than one display format. The
				// per-launch --model/--effort tokens are not part of this probe; a CLI that
				// does not know them reports that itself on the launch.
				if (!/^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \(Claude Code\)|\d{4}\.\d{1,2}\.\d{1,2} [A-Za-z0-9._-]+ \(\d{4}-\d{2}-\d{2}\))$/.test(result.version)) throw new Error(`Unsupported Claude Code version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["Claude Code - starts an interactive session", "--print", "--input-format", "stream-json", "--verbose", "--permission-mode", writer ? "acceptEdits" : "plan", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--no-session-persistence", "--disable-slash-commands", "--no-chrome"]) {
					if (!result.help.includes(required)) throw new Error(`Claude Code help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createClaudeCodeJsonlParser(),
	};
}
