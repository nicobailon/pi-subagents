import type {
	ExternalCliReceiptMetadata,
	ExternalCliCapabilityNarrowing,
	ExternalCliDeclaredSafety,
	ExternalCliRunnerStatus,
	ExternalCliMachineStatus,
	ExternalProcessStatus,
	HerdrMachineReference,
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

// What each adapter's own argv asks the CLI for. It is a profile, not a measurement:
// a runner command that wraps the CLI can grant something else, and declares it with
// runner.declaredSafety.
export const EXTERNAL_CLI_ADAPTER_SAFETY = {
	"codex-exec": { sandbox: "read-only", approvalPolicy: "never", ephemeral: true },
	"codex-exec-writer": { access: "workspace-write", sandbox: "workspace-write", approvalPolicy: "never", ephemeral: true },
	"claude-code": { access: "read-only", authentication: "existing-cli-required", permissionMode: "plan", tools: "none", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false },
	"claude-code-writer": { access: "workspace-write", authentication: "existing-cli-required", permissionMode: "acceptEdits", tools: "Read,Write,Edit,Glob,Grep", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false },
	"cursor-agent": { access: "read-only", authentication: "cursor-api-key-or-existing-login", mode: "ask", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false },
	"cursor-agent-writer": { access: "workspace-write", authentication: "cursor-api-key-or-existing-login", mode: "print", sandbox: "enabled", workspaceTrust: "existing-required", sessionReuse: false },
} as const satisfies Record<CodeOwnedExternalCliAdapterId, Record<string, string | boolean>>;

const MAX_DECLARED_SAFETY_VALUE_LENGTH = 512;

export function parseExternalCliDeclaredSafety(value: unknown, adapter: CodeOwnedExternalCliAdapterId | undefined, label: string): ExternalCliDeclaredSafety | undefined {
	if (value === undefined) return undefined;
	if (!adapter) throw new Error(`${label} requires a code-owned adapter; the generic external-cli runner has no safety profile.`);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const input = value as Record<string, unknown>;
	const profile: Record<string, string | boolean> = EXTERNAL_CLI_ADAPTER_SAFETY[adapter];
	const unknown = Object.keys(input).filter((key) => !Object.hasOwn(profile, key));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}. The '${adapter}' adapter records: ${Object.keys(profile).join(", ")}.`);
	if (Object.keys(input).length === 0) throw new Error(`${label} must declare at least one field.`);
	for (const [key, setting] of Object.entries(input)) {
		if (typeof profile[key] === "boolean") {
			if (typeof setting !== "boolean") throw new Error(`${label}.${key} must be a boolean.`);
		} else if (typeof setting !== "string" || !setting.trim() || setting.trim() !== setting || setting.length > MAX_DECLARED_SAFETY_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(setting)) {
			throw new Error(`${label}.${key} must be a non-empty trimmed string of at most ${MAX_DECLARED_SAFETY_VALUE_LENGTH} characters.`);
		}
	}
	return input as ExternalCliDeclaredSafety;
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
	declaredSafety?: ExternalCliDeclaredSafety;
	machine?: HerdrMachineReference;
}): ExternalCliRunnerStatus {
	const cursor = input.adapter === "cursor-agent" || input.adapter === "cursor-agent-writer";
	const profileSafety = input.adapter ? EXTERNAL_CLI_ADAPTER_SAFETY[input.adapter] : undefined;
	const unsupported = cursor ? PROMPT_FILE_UNSUPPORTED : UNSUPPORTED;
	return {
		type: "external-cli",
		command: input.command,
		args: input.args ?? [],
		promptDelivery: cursor ? "prompt-file" : input.promptDelivery ?? "stdin",
		adapter: { id: input.adapter ?? "external-cli", version: 1, executionMode: cursor ? "one-shot-prompt-file" : "one-shot-stdin" },
		...(profileSafety ? {
			safety: { ...profileSafety, ...input.declaredSafety },
			safetySource: { measured: false as const, command: input.command, declaredFields: Object.keys(input.declaredSafety ?? {}) },
		} : {}),
		...(input.machine ? { machine: input.machine } : {}),
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
	const machine = input.machine && typeof input.machine === "object" && !Array.isArray(input.machine)
		? input.machine as HerdrMachineReference
		: undefined;
	const adapterId = input.adapter && typeof input.adapter === "object" && !Array.isArray(input.adapter)
		? (input.adapter as Record<string, unknown>).id
		: undefined;
	if (adapterId === "grok-build") {
		return {
			type: "external-cli",
			command: input.command,
			...(machine ? { machine } : {}),
			args: args ?? [],
			promptDelivery: "prompt-file",
			adapter: { id: "grok-build", version: 1, executionMode: "one-shot-prompt-file" },
			capabilities: { stop: true, steer: false, resume: false, structuredOutput: false, toolEvents: false, supervisor: "unsupported", forkContext: false, extensionBindings: false },
			unsupportedReasons: PROMPT_FILE_UNSUPPORTED,
			nonResumableReason: PROMPT_FILE_UNSUPPORTED.resume,
		};
	}
	const adapter = isCodeOwnedExternalCliAdapterId(adapterId) ? adapterId : undefined;
	let declaredSafety: ExternalCliDeclaredSafety | undefined;
	try {
		declaredSafety = persistedDeclaredSafety(input, adapter);
	} catch {
		return undefined;
	}
	return resolveExternalCliRunnerStatus({ ...(adapter ? { adapter } : {}), command: input.command, ...(args ? { args } : {}), ...(promptDelivery ? { promptDelivery } : {}), ...(declaredSafety ? { declaredSafety } : {}), ...(machine ? { machine } : {}) });
}

// Status written before safetySource existed has no declared fields and gets the profile.
function persistedDeclaredSafety(input: Record<string, unknown>, adapter: CodeOwnedExternalCliAdapterId | undefined): ExternalCliDeclaredSafety | undefined {
	const source = input.safetySource;
	if (source === undefined) return undefined;
	if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("safetySource must be an object.");
	const declaredFields = (source as Record<string, unknown>).declaredFields;
	if (!Array.isArray(declaredFields) || declaredFields.some((field) => typeof field !== "string")) throw new Error("safetySource.declaredFields must be a string array.");
	if (declaredFields.length === 0) return undefined;
	const safety = input.safety;
	if (!safety || typeof safety !== "object" || Array.isArray(safety)) throw new Error("safety is missing.");
	const declared = Object.fromEntries(declaredFields.map((field: string) => [field, (safety as Record<string, unknown>)[field]]));
	return parseExternalCliDeclaredSafety(declared, adapter, "safety");
}

export function externalCliReceiptMetadata(input: {
	runner: ExternalCliRunnerStatus;
	externalProcess?: ExternalProcessStatus;
	outputReference?: string;
}): ExternalCliReceiptMetadata {
	const { runner } = input;
	const machine: ExternalCliMachineStatus | undefined = input.externalProcess?.machine ?? runner.machine;
	return {
		adapter: { ...runner.adapter },
		capabilities: { ...runner.capabilities },
		...(machine ? { machine: { ...machine, ...(machine.remoteGit ? { remoteGit: { ...machine.remoteGit } } : {}) } } : {}),
		...(runner.safety ? { safety: { ...runner.safety } } : {}),
		...(runner.safetySource ? { safetySource: { ...runner.safetySource, declaredFields: [...runner.safetySource.declaredFields] } } : {}),
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
