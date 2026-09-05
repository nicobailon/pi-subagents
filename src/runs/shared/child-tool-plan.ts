/**
 * Child tool plan: which builtin tools, MCP tools, runtime hooks, and extension
 * files a child launch gets, and how that resolution is reported. Both the
 * foreground path and the async runner build their session launch from this.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	formatUnresolvedMcpDirectToolSelectors,
	resolveMcpDirectToolResolution,
	type McpRuntimeSnapshotHost,
	type ResolvedMcpDirectToolSelection,
} from "./mcp-direct-tool-allowlist.ts";
import {
	TEMP_ROOT_DIR,
	type JsonSchemaObject,
	type LaunchResolvedChildExtensions,
} from "../../shared/types.ts";
import { THINKING_LEVELS } from "../../shared/model-info.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { PermissionRules } from "./permissions.ts";
import {
	capabilityCeilingAgentRestrictionSources,
	intersectSubagentCapabilityCeilings,
	isAgentAllowedByCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
	type SubagentCapabilityAudit,
} from "./capability-ceiling.ts";

const MAX_LAUNCH_RESOLVED_EXTENSION_IDS = 32;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"subagent-prompt-runtime.ts",
);
const FANOUT_CHILD_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"extension",
	"fanout-child.ts",
);
const FAST_MODE_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fast-mode-extension.ts",
);
const SUBAGENT_RUNTIME_EXTENSION_PATHS = new Set([
	PROMPT_RUNTIME_EXTENSION_PATH,
	FANOUT_CHILD_EXTENSION_PATH,
	FAST_MODE_EXTENSION_PATH,
].map((extensionPath) => path.normalize(extensionPath)));

/** True for the extension files pi-subagents itself installs in child sessions. */
export function isSubagentRuntimeExtensionPath(extensionPath: string): boolean {
	return SUBAGENT_RUNTIME_EXTENSION_PATHS.has(path.normalize(extensionPath));
}
const FAST_MODE_ALLOWED_MODELS = new Set([
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.6-sol",
]);
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function deriveForkPromptCacheKey(parentSessionId: string | undefined): string | undefined {
	const parent = parentSessionId?.trim();
	if (!parent) return undefined;
	const digest = createHash("sha256").update(parent).digest("hex").slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - "pi-fork:".length);
	return `pi-fork:${digest}`;
}

function sanitizeSupervisorChannelSegment(value: string): string {
	return (
		value
			.trim()
			.replace(/[^A-Za-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown"
	);
}

export function supervisorChannelDir(
	runId: string,
	agent: string,
	childIndex: number,
): string {
	return path.join(
		TEMP_ROOT_DIR,
		"supervisor-channels",
		`${sanitizeSupervisorChannelSegment(runId)}-${sanitizeSupervisorChannelSegment(agent)}-${childIndex}`,
	);
}

export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting = false,
): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (
		colonIdx !== -1 &&
		THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))
	) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

function stripThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return model;
	return THINKING_LEVELS.some((level) => level === model.substring(colonIdx + 1))
		? model.slice(0, colonIdx)
		: model;
}

function resolveFastModeExtension(input: Pick<ResolvePiLaunchToolPlanInput, "fast" | "model" | "modelCandidates" | "agentName">): string[] {
	if (!input.fast) return [];
	const candidates = (input.modelCandidates?.length ? input.modelCandidates : input.model ? [input.model] : [])
		.map(stripThinkingSuffix);
	if (candidates.length === 0) {
		throw new Error(`fast mode requires an explicit supported native OpenAI-Codex model${input.agentName ? ` for agent '${input.agentName}'` : ""}.`);
	}
	const unsupported = candidates.filter((model) => !FAST_MODE_ALLOWED_MODELS.has(model));
	if (unsupported.length > 0) {
		throw new Error(`fast mode supports only ${[...FAST_MODE_ALLOWED_MODELS].join(", ")}; unsupported model${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`);
	}
	return [FAST_MODE_EXTENSION_PATH];
}

export interface ResolvePiLaunchToolPlanInput {
	tools?: string[];
	excludeTools?: string[];
	allowNestedSubagents?: boolean;
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	cwd?: string;
	requireReadTool?: boolean;
	structuredOutput?:
		| boolean
		| {
				schema: JsonSchemaObject;
				schemaPath: string;
				outputPath: string;
		  };
	fast?: boolean;
	model?: string;
	modelCandidates?: readonly string[];
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	agentName?: string;
	permissionRules?: PermissionRules;
	runtimeSnapshotHost?: McpRuntimeSnapshotHost;
}

export interface PiLaunchToolPlan {
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	requestedBuiltinTools: string[];
	declaredBuiltinTools: string[];
	excludeTools: string[];
	toolExtensionPaths: string[];
	resolvedMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpSelections: ResolvedMcpDirectToolSelection[];
	effectiveMcpTools: string[];
	explicitToolAllowlist: boolean;
	internalTools: string[];
	effectiveToolAllowlist: string[];
	requiredChildTools: string[];
	fanoutAuthorized: boolean;
	runtimeExtensions: string[];
	configuredExtensions: string[];
	extensionArgs: string[];
	disableAmbientExtensions: boolean;
	capabilityAudit?: SubagentCapabilityAudit;
	/** Non-fatal launch warnings; they do not change behavior. */
	warnings: string[];
}

function extensionIdentifier(value: string): string {
	return `sha256:${createHash("sha256").update(path.normalize(value.trim())).digest("hex").slice(0, 16)}`;
}

function boundedExtensionIdentifiers(values: string[]): {
	ids: string[];
	omitted: number;
} {
	const ids = [...new Set(values.map(extensionIdentifier))];
	return {
		ids: ids.slice(0, MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
		omitted: Math.max(0, ids.length - MAX_LAUNCH_RESOLVED_EXTENSION_IDS),
	};
}

function hasPermissionRules(rules: PermissionRules | undefined): boolean {
	return rules !== undefined && Object.keys(rules).length > 0;
}

/**
 * Children are pi sessions inside the parent or the runner process; a spawned
 * `pi` received extra MCP server definitions as a CLI argument, but a session
 * has no such input. Selecting a server that exists only in pi-mcp-adapter's
 * runtime snapshot therefore cannot work and fails the launch.
 */
export function formatRuntimeSnapshotMcpServersError(agentName: string | undefined, serverNames: readonly string[]): string {
	const subject = agentName ? `Agent '${agentName}'` : "Subagent";
	return `${subject} selects MCP tools from servers that exist only in pi-mcp-adapter's runtime snapshot (${serverNames.join(", ")}). MCP servers from the runtime snapshot cannot be provided to in-process children; MCP tools must come from an ambient adapter extension in a background child (\`async: true\`), so add the server to the adapter's configuration file instead.`;
}

export function projectLaunchResolvedChildExtensions(
	toolPlan: Pick<
		PiLaunchToolPlan,
		| "runtimeExtensions"
		| "configuredExtensions"
		| "extensionArgs"
		| "disableAmbientExtensions"
	>,
): LaunchResolvedChildExtensions {
	const runtime = boundedExtensionIdentifiers(toolPlan.runtimeExtensions);
	const configured = boundedExtensionIdentifiers(toolPlan.configuredExtensions);
	const effective = boundedExtensionIdentifiers(toolPlan.extensionArgs);
	return {
		version: 1,
		source: "launch-resolved",
		disableAmbientExtensions: toolPlan.disableAmbientExtensions,
		runtime: runtime.ids,
		configured: configured.ids,
		effective: effective.ids,
		omitted: {
			runtime: runtime.omitted,
			configured: configured.omitted,
			effective: effective.omitted,
		},
	};
}

/**
 * Resolve the permission-system extension entry point when installed.
 * Returns the absolute path to the extension's main module, or undefined
 * when the package is not installed. Callers can check `autoInject` config
 * to decide whether to include it in child sessions.
 */
export function resolvePermissionSystemExtension(): string | undefined {
	const agentDir = getAgentDir();
	const candidates = [
		// npm-scoped package (most common)
		path.join(
			agentDir,
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
		),
		// direct extension directory (some layouts)
		path.join(agentDir, "extensions", "pi-permission-system"),
	];
	const errors: Error[] = [];
	for (const extDir of candidates) {
		if (!fs.existsSync(extDir)) continue;
		const pkgPath = path.join(extDir, "package.json");
		if (!fs.existsSync(pkgPath)) {
			errors.push(new Error(`Permission-system package manifest is missing at ${pkgPath}.`));
			continue;
		}
		try {
			let pkg: { pi?: { extensions?: string[] } };
			const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("manifest root must be an object");
			}
			pkg = parsed as typeof pkg;
			const extensions = pkg.pi?.extensions;
			const entry = Array.isArray(extensions) ? extensions[0] : undefined;
			if (typeof entry !== "string" || !entry.trim()) {
				throw new Error(
					`Permission-system package manifest at ${pkgPath} must declare pi.extensions[0] as a non-empty string.`,
				);
			}
			const resolved = path.resolve(extDir, entry);
			if (fs.existsSync(resolved)) return resolved;
			throw new Error(
				`Permission-system extension entry ${JSON.stringify(entry)} in ${pkgPath} does not exist at ${resolved}.`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(message.startsWith("Permission-system") ? new Error(message) : new Error(`Cannot read permission-system package manifest at ${pkgPath}: ${message}`));
		}
	}
	if (errors.length > 0) throw errors[0]!;
	return undefined;
}

export function resolvePiLaunchToolPlan(
	input: ResolvePiLaunchToolPlanInput,
): PiLaunchToolPlan {
	const capabilityCeiling = intersectSubagentCapabilityCeilings(
		input.capabilityCeiling,
		input.inheritedCapabilityCeiling,
	);
	const allowedToolSet =
		capabilityCeiling?.allowedTools === undefined
			? undefined
			: new Set(capabilityCeiling.allowedTools);
	const requestedBuiltinTools =
		input.tools?.filter(
			(tool) =>
				!(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")),
		) ?? [];
	if (input.requireReadTool && allowedToolSet && !allowedToolSet.has("read")) {
		throw new Error(
			`Capability ceiling from ${capabilityCeiling?.sources.join(", ") || "unknown source"} excludes required tool 'read' for lazy skill loading.`,
		);
	}
	const declaredBuiltinTools =
		input.tools === undefined
			? allowedToolSet
				? [...allowedToolSet]
				: []
			: (input.requireReadTool &&
				requestedBuiltinTools.length > 0 &&
				!requestedBuiltinTools.includes("read") &&
				!allowedToolSet
					? ["read", ...requestedBuiltinTools]
					: requestedBuiltinTools
				).filter((tool) => !allowedToolSet || allowedToolSet.has(tool));
	const excludeTools = [...new Set((input.excludeTools ?? []).map((tool) => tool.trim()).filter(Boolean))];
	const excludedToolSet = new Set(excludeTools);
	const effectiveDeclaredBuiltinTools = declaredBuiltinTools.filter((tool) => !excludedToolSet.has(tool));
	const fanoutAuthorized = effectiveDeclaredBuiltinTools.includes("subagent") || (
		input.allowNestedSubagents === true &&
		!excludedToolSet.has("subagent") &&
		(!allowedToolSet || allowedToolSet.has("subagent"))
	);
	const toolExtensionPaths: string[] = capabilityCeiling?.denyExtensions
		? []
		: (input.tools ?? []).filter(
				(tool) =>
					!requestedBuiltinTools.includes(tool) &&
					(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")),
			);
	const mcpResolution = capabilityCeiling?.denyExtensions
		? { selections: [], unresolvedSelectors: [] }
		: resolveMcpDirectToolResolution(input.mcpDirectTools, input.cwd, input.runtimeSnapshotHost);
	if (mcpResolution.runtimeServerNames?.length) {
		throw new Error(formatRuntimeSnapshotMcpServersError(input.agentName, mcpResolution.runtimeServerNames));
	}
	if (mcpResolution.unresolvedSelectors.length > 0) {
		throw new Error(formatUnresolvedMcpDirectToolSelectors(mcpResolution.unresolvedSelectors));
	}
	const resolvedMcpSelections = mcpResolution.selections;
	const resolvedMcpNames = new Set(resolvedMcpSelections.map((selection) => selection.name));
	const legacyMcpNameCounts = countLegacyUnderscoreMcpToolNames(resolvedMcpSelections);
	const effectiveMcpSelections = resolvedMcpSelections.filter(
		(selection) =>
			!allowedToolSet ||
			allowedToolSet.has(selection.name) ||
			isLegacyUnderscoreMcpToolAllowed(selection, allowedToolSet, resolvedMcpNames, legacyMcpNameCounts),
	).filter((selection) => !excludedToolSet.has(selection.name));
	const effectiveMcpTools = effectiveMcpSelections.map(
		(selection) => selection.name,
	);
	const explicitToolAllowlist =
		input.tools !== undefined ||
		(input.mcpDirectTools?.length ?? 0) > 0 ||
		allowedToolSet !== undefined;
	const internalTools = (input.structuredOutput ? ["structured_output"] : []).filter((tool) => !excludedToolSet.has(tool));
	const effectiveToolAllowlist = [
		...new Set([
			...effectiveDeclaredBuiltinTools,
			...effectiveMcpTools,
			...internalTools,
		]),
	];
	// Supervisor-coordination names stay in the --tools allowlist but are never
	// strict requirements: children register contact_supervisor at runtime through
	// the native supervisor channel (or pi-intercom). The pre-0.50 bridge always
	// appended intercom alongside contact_supervisor, so that exact pairing is
	// legacy plumbing, not a user demand for an external intercom provider;
	// a lone intercom entry stays strictly required (#1207).
	const legacySupervisorPairing = effectiveDeclaredBuiltinTools.includes("contact_supervisor");
	const requiredChildTools = explicitToolAllowlist
		? [
				...new Set([
					...(input.tools !== undefined ? effectiveDeclaredBuiltinTools : []),
					...(input.mcpDirectTools?.length ? effectiveMcpTools : []),
					...internalTools,
				].filter((tool) => tool !== "contact_supervisor" && (!legacySupervisorPairing || tool !== "intercom"))),
			]
		: [];
	const permSystemExt = capabilityCeiling?.denyExtensions
		? undefined
		: hasPermissionRules(input.permissionRules)
			? resolvePermissionSystemExtension()
			: undefined;
	if (input.fast && capabilityCeiling?.denyExtensions) throw new Error("fast mode requires a child runtime extension, but this launch denies extensions.");
	const fastModeExtensions = resolveFastModeExtension({ fast: input.fast, model: input.model, modelCandidates: input.modelCandidates, agentName: input.agentName });
	const runtimeExtensions = [
		PROMPT_RUNTIME_EXTENSION_PATH,
		...fastModeExtensions,
		...(fanoutAuthorized ? [FANOUT_CHILD_EXTENSION_PATH] : []),
		...(permSystemExt ? [permSystemExt] : []),
	];
	const disableAmbientExtensions =
		capabilityCeiling?.denyExtensions === true ||
		input.extensions !== undefined;
	const warnings: string[] = [];
	// An explicit empty list disables ambient extensions, including model providers.
	if (capabilityCeiling?.denyExtensions !== true && Array.isArray(input.extensions) && input.extensions.length === 0) {
		const agentLabel = input.agentName ? ` for agent '${input.agentName}'` : "";
		warnings.push(
			`extensions: [] override${agentLabel} disables ALL ambient extensions for this child (not just "adds nothing"), `
				+ "including any model-provider extension needed to resolve a provider-qualified model. "
				+ "List the extensions this child actually needs instead of an empty array.",
		);
	}
	const configuredExtensions = capabilityCeiling?.denyExtensions
		? []
		: [
				...toolExtensionPaths,
				...(input.extensions ?? []),
				...(input.subagentOnlyExtensions ?? []),
			];
	const extensionArgs = disableAmbientExtensions
		? [...new Set([...runtimeExtensions, ...configuredExtensions])]
		: [
				...new Set([
					...runtimeExtensions,
					...toolExtensionPaths,
					...(input.subagentOnlyExtensions ?? []),
				]),
			];
	const requestedToolNames =
		input.tools !== undefined
			? [
					...new Set([
						...requestedBuiltinTools,
						...resolvedMcpSelections.map((selection) => selection.name),
					]),
				]
			: undefined;
	const capabilityAudit = capabilityCeiling
		? ({
				ceiling: capabilityCeiling,
				...(requestedToolNames ? { requestedTools: requestedToolNames } : {}),
				effectiveTools: effectiveToolAllowlist,
				...(excludeTools.length > 0 ? { excludeTools } : {}),
				removedTools:
					requestedToolNames?.filter(
						(tool) => !effectiveToolAllowlist.includes(tool),
					) ?? [],
				internalTools,
				extensionsDenied: capabilityCeiling.denyExtensions,
				removedExtensionCount: capabilityCeiling.denyExtensions
					? (input.extensions?.length ?? 0) +
						(input.subagentOnlyExtensions?.length ?? 0) +
						(input.tools ?? []).filter(
							(tool) =>
								tool.includes("/") ||
								tool.endsWith(".ts") ||
								tool.endsWith(".js"),
						).length
					: 0,
				requestedMcpToolCount: input.mcpDirectTools?.length ?? 0,
				effectiveMcpTools,
				agentAllowed:
					input.agentName === undefined
						? true
						: isAgentAllowedByCapabilityCeiling(
								input.agentName,
								capabilityCeiling,
							),
				...(capabilityCeilingAgentRestrictionSources(capabilityCeiling)
					? {
							agentRestrictionSources:
								capabilityCeilingAgentRestrictionSources(capabilityCeiling),
						}
					: {}),
			} satisfies SubagentCapabilityAudit)
		: undefined;
	return {
		...(capabilityCeiling ? { capabilityCeiling } : {}),
		requestedBuiltinTools,
		declaredBuiltinTools,
		excludeTools,
		toolExtensionPaths,
		resolvedMcpSelections,
		effectiveMcpSelections,
		effectiveMcpTools,
		explicitToolAllowlist,
		internalTools,
		effectiveToolAllowlist,
		requiredChildTools,
		fanoutAuthorized,
		runtimeExtensions,
		configuredExtensions,
		extensionArgs,
		disableAmbientExtensions,
		warnings,
		...(capabilityAudit ? { capabilityAudit } : {}),
	};
}

// Capability ceilings persisted before #1685 may still name hyphenated MCP server prefixes with underscores.
function countLegacyUnderscoreMcpToolNames(selections: readonly ResolvedMcpDirectToolSelection[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const selection of selections) {
		const legacyName = legacyUnderscoreMcpToolName(selection);
		if (legacyName !== selection.name) counts.set(legacyName, (counts.get(legacyName) ?? 0) + 1);
	}
	return counts;
}

function isLegacyUnderscoreMcpToolAllowed(
	selection: ResolvedMcpDirectToolSelection,
	allowedToolSet: ReadonlySet<string>,
	resolvedMcpNames: ReadonlySet<string>,
	legacyMcpNameCounts: ReadonlyMap<string, number>,
): boolean {
	const legacyName = legacyUnderscoreMcpToolName(selection);
	return legacyMcpNameCounts.get(legacyName) === 1 && !resolvedMcpNames.has(legacyName) && allowedToolSet.has(legacyName);
}

function legacyUnderscoreMcpToolName(selection: ResolvedMcpDirectToolSelection): string {
	const slash = selection.selector.indexOf("/");
	if (slash < 1) return selection.name;
	const toolName = selection.selector.slice(slash + 1);
	const suffix = `_${toolName}`;
	if (!selection.name.endsWith(suffix)) return selection.name;
	const prefix = selection.name.slice(0, -suffix.length);
	return `${prefix.replace(/-/g, "_")}${suffix}`;
}
