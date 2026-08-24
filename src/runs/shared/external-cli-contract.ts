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
const GROK_UNSUPPORTED = {
	...UNSUPPORTED,
	steer: "The one-shot prompt-file adapter closes input after launch and cannot accept live steer messages.",
	resume: "The one-shot prompt-file adapter does not retain a durable external session identity.",
} as const;

export function validateCodeOwnedProfileRunner(
	agent: {
		name: string;
		localName?: string;
		aliases?: readonly string[];
		runner?: { type: string; adapter?: string };
	},
): string | undefined {
	const selectionNames = [agent.name, ...(agent.localName ? [agent.localName] : []), ...(agent.aliases ?? [])];
	if (selectionNames.includes("claude-code") && !(agent.runner?.type === "external-cli" && agent.runner.adapter === "claude-code")) {
		return "Selection name 'claude-code' is reserved for the read-only 'claude-code' adapter. Use 'claude-code-writer' for explicit file-write access.";
	}
	if (selectionNames.includes("grok-build") && !(agent.runner?.type === "external-cli" && agent.runner.adapter === "grok-build")) {
		return "Selection name 'grok-build' is reserved for the read-only 'grok-build' adapter.";
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
	adapter?: "codex-exec" | "claude-code" | "claude-code-writer" | "grok-build";
	command: string;
	args?: string[];
	promptDelivery?: "stdin";
	capabilities?: ExternalCliCapabilityNarrowing;
}): ExternalCliRunnerStatus {
	const codexExec = input.adapter === "codex-exec";
	const claudeCode = input.adapter === "claude-code";
	const claudeCodeWriter = input.adapter === "claude-code-writer";
	const grokBuild = input.adapter === "grok-build";
	const unsupported = grokBuild ? GROK_UNSUPPORTED : UNSUPPORTED;
	return {
		type: "external-cli",
		command: input.command,
		args: input.args ?? [],
		promptDelivery: grokBuild ? "prompt-file" : input.promptDelivery ?? "stdin",
		adapter: { id: input.adapter ?? "external-cli", version: 1, executionMode: grokBuild ? "one-shot-prompt-file" : "one-shot-stdin" },
		...(codexExec ? { safety: { sandbox: "read-only" as const, approvalPolicy: "never" as const, ephemeral: true as const } } : {}),
		...(claudeCode ? { safety: { access: "read-only" as const, authentication: "existing-cli-required" as const, permissionMode: "plan" as const, tools: "none" as const, mcp: "empty-strict" as const, settingSources: "user" as const, userSettingsTrust: "required" as const, sessionPersistence: false as const } } : {}),
		...(claudeCodeWriter ? { safety: { access: "workspace-write" as const, authentication: "existing-cli-required" as const, permissionMode: "acceptEdits" as const, tools: "Read,Write,Edit,Glob,Grep" as const, mcp: "empty-strict" as const, settingSources: "user" as const, userSettingsTrust: "required" as const, sessionPersistence: false as const } } : {}),
		...(grokBuild ? { safety: { access: "read-only" as const, authentication: "xai-api-key-required" as const, permissionMode: "plan" as const, tools: "read_file,grep,list_dir" as const, deniedTools: "run_terminal_cmd,search_replace,Agent,Bash,Edit,Write,MCPTool" as const, sandbox: "read-only" as const, webSearch: false as const, subagents: false as const, config: "temporary-home" as const, updates: "disabled" as const, sessionPersistence: false as const } } : {}),
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
	const adapter = adapterId === "codex-exec" || adapterId === "claude-code" || adapterId === "claude-code-writer" || adapterId === "grok-build" ? adapterId : undefined;
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
