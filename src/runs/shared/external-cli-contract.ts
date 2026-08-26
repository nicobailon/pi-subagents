import type {
	ExternalCliReceiptMetadata,
	ExternalCliCapabilityNarrowing,
	ExternalCliRunnerStatus,
	ExternalProcessStatus,
} from "../../shared/types.ts";

const UNSUPPORTED = {
	steer: "The one-shot stdin adapter closes input after launch and cannot accept live steer messages.",
	resume: "The one-shot stdin adapter has no durable external session identity.",
	structuredOutput: "The generic external CLI adapter does not parse a trusted structured result.",
	toolEvents: "The generic external CLI adapter treats stdout as untrusted text, not native Pi tool events.",
	supervisor: "The generic external CLI adapter has no trusted supervisor event transport.",
	forkContext: "Native Pi fork context is not available without an adapter-owned handoff artifact.",
	extensionBindings: "Native Pi extension bindings are never passed to external runners.",
} as const;

const CAPABILITY_KEYS = new Set(Object.keys(UNSUPPORTED));
const PROMPT_FILE_UNSUPPORTED = {
	...UNSUPPORTED,
	steer: "The one-shot prompt-file adapter closes input after launch and cannot accept live steer messages.",
	resume: "The one-shot prompt-file adapter does not retain a durable external session identity.",
} as const;

export const CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS = [
	"codex-exec",
	"codex-exec-writer",
	"claude-code",
	"claude-code-writer",
	"cursor-agent",
	"cursor-agent-writer",
] as const;
export type CodeOwnedExternalCliAdapterId = typeof CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS[number];

const CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET = new Set<string>(CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS);
export const CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL = CODE_OWNED_EXTERNAL_CLI_ADAPTER_IDS.map((id) => `'${id}'`).join(", ");

export function isCodeOwnedExternalCliAdapterId(value: unknown): value is CodeOwnedExternalCliAdapterId {
	return typeof value === "string" && CODE_OWNED_EXTERNAL_CLI_ADAPTER_ID_SET.has(value);
}

const RESERVED_READ_ONLY_ADAPTERS = [
	{ name: "claude-code", writer: "claude-code-writer", access: "file-write" },
	{ name: "codex-exec", writer: "codex-exec-writer", access: "workspace-write" },
	{ name: "cursor-agent", writer: "cursor-agent-writer", access: "workspace-write" },
] as const;

export function validateCodeOwnedProfileRunner(
	agent: {
		name: string;
		localName?: string;
		aliases?: readonly string[];
		runner?: { type: string; adapter?: string };
	},
): string | undefined {
	const selectionNames = [agent.name, ...(agent.localName ? [agent.localName] : []), ...(agent.aliases ?? [])];
	for (const adapter of RESERVED_READ_ONLY_ADAPTERS) {
		if (selectionNames.includes(adapter.name) && !(agent.runner?.type === "external-cli" && agent.runner.adapter === adapter.name)) {
			return `Selection name '${adapter.name}' is reserved for the read-only '${adapter.name}' adapter. Use '${adapter.writer}' for explicit ${adapter.access} access.`;
		}
	}
	return undefined;
}

export function parseExternalCliCapabilityNarrowing(value: unknown, label: string): ExternalCliCapabilityNarrowing | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !CAPABILITY_KEYS.has(key));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
	for (const [key, setting] of Object.entries(input)) {
		if (setting !== false) throw new Error(`${label}.${key} may only be false; user config cannot widen code-owned external adapter capabilities.`);
	}
	return input as ExternalCliCapabilityNarrowing;
}

export function resolveExternalCliRunnerStatus(input: {
	adapter?: CodeOwnedExternalCliAdapterId;
	command: string;
	args?: string[];
	promptDelivery?: "stdin";
	capabilities?: ExternalCliCapabilityNarrowing;
}): ExternalCliRunnerStatus {
	const codexExec = input.adapter === "codex-exec";
	const codexExecWriter = input.adapter === "codex-exec-writer";
	const claudeCode = input.adapter === "claude-code";
	const claudeCodeWriter = input.adapter === "claude-code-writer";
	const cursorAgent = input.adapter === "cursor-agent";
	const cursorAgentWriter = input.adapter === "cursor-agent-writer";
	const cursor = cursorAgent || cursorAgentWriter;
	const unsupported = cursor ? PROMPT_FILE_UNSUPPORTED : UNSUPPORTED;
	return {
		type: "external-cli",
		command: input.command,
		args: input.args ?? [],
		promptDelivery: cursor ? "prompt-file" : input.promptDelivery ?? "stdin",
		adapter: { id: input.adapter ?? "external-cli", version: 1, executionMode: cursor ? "one-shot-prompt-file" : "one-shot-stdin" },
		...(codexExec ? { safety: { sandbox: "read-only" as const, approvalPolicy: "never" as const, ephemeral: true as const } } : {}),
		...(codexExecWriter ? { safety: { access: "workspace-write" as const, sandbox: "workspace-write" as const, approvalPolicy: "never" as const, ephemeral: true as const } } : {}),
		...(claudeCode ? { safety: { access: "read-only" as const, authentication: "existing-cli-required" as const, permissionMode: "plan" as const, tools: "none" as const, mcp: "empty-strict" as const, settingSources: "user" as const, userSettingsTrust: "required" as const, sessionPersistence: false as const } } : {}),
		...(claudeCodeWriter ? { safety: { access: "workspace-write" as const, authentication: "existing-cli-required" as const, permissionMode: "acceptEdits" as const, tools: "Read,Write,Edit,Glob,Grep" as const, mcp: "empty-strict" as const, settingSources: "user" as const, userSettingsTrust: "required" as const, sessionPersistence: false as const } } : {}),
		...(cursorAgent ? { safety: { access: "read-only" as const, authentication: "cursor-api-key-or-existing-login" as const, mode: "ask" as const, sandbox: "enabled" as const, workspaceTrust: "existing-required" as const, sessionReuse: false as const } } : {}),
		...(cursorAgentWriter ? { safety: { access: "workspace-write" as const, authentication: "cursor-api-key-or-existing-login" as const, mode: "print" as const, sandbox: "enabled" as const, workspaceTrust: "existing-required" as const, sessionReuse: false as const } } : {}),
		capabilities: {
			stop: true,
			steer: false,
			resume: false,
			structuredOutput: false,
			toolEvents: false,
			supervisor: "unsupported",
			forkContext: false,
			extensionBindings: false,
		},
		unsupportedReasons: unsupported,
		nonResumableReason: unsupported.resume,
	};
}

export function normalizeExternalCliRunnerStatus(value: unknown): ExternalCliRunnerStatus | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.type !== "external-cli" || typeof input.command !== "string" || !input.command.trim()) return undefined;
	const args = Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")
		? input.args
		: undefined;
	const promptDelivery = input.promptDelivery === "stdin" ? "stdin" : undefined;
	const adapterId = input.adapter && typeof input.adapter === "object" && !Array.isArray(input.adapter)
		? (input.adapter as Record<string, unknown>).id
		: undefined;
	if (adapterId === "grok-build") {
		return {
			type: "external-cli",
			command: input.command,
			args: args ?? [],
			promptDelivery: "prompt-file",
			adapter: { id: "grok-build", version: 1, executionMode: "one-shot-prompt-file" },
			capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false, supervisor: "unsupported", forkContext: false, extensionBindings: false },
			unsupportedReasons: PROMPT_FILE_UNSUPPORTED,
			nonResumableReason: PROMPT_FILE_UNSUPPORTED.resume,
		};
	}
	const adapter = isCodeOwnedExternalCliAdapterId(adapterId) ? adapterId : undefined;
	return resolveExternalCliRunnerStatus({ ...(adapter ? { adapter } : {}), command: input.command, ...(args ? { args } : {}), ...(promptDelivery ? { promptDelivery } : {}) });
}

export function externalCliReceiptMetadata(input: {
	runner: ExternalCliRunnerStatus;
	externalProcess?: ExternalProcessStatus;
	outputReference?: string;
}): ExternalCliReceiptMetadata {
	const { runner } = input;
	return {
		adapter: { ...runner.adapter },
		capabilities: { ...runner.capabilities },
		...(runner.safety ? { safety: { ...runner.safety } } : {}),
		...(input.externalProcess ? {
			outputArtifacts: {
				stdoutPath: input.externalProcess.stdoutPath,
				stderrPath: input.externalProcess.stderrPath,
				...(input.outputReference || input.externalProcess.finalOutputPath ? { finalOutputPath: input.outputReference ?? input.externalProcess.finalOutputPath } : {}),
			},
		} : input.outputReference ? { outputArtifacts: { finalOutputPath: input.outputReference } } : {}),
		handoff: { mode: "fresh" },
		supervisor: { mode: "unsupported", reason: runner.unsupportedReasons.supervisor },
		nonResumableReason: runner.nonResumableReason,
	};
}
