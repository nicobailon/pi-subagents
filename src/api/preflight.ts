import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgentSnapshot, findBlockingAgentDiagnostic, formatUnknownAgentError, resolveAgentName, unknownAgentDiagnosticContext, type AgentConfig, type AgentDiscoveryAllResult, type AgentScope, type AgentSource } from "../agents/agents.ts";
import { resolveExecutionAgentScope } from "../agents/agent-scope.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../agents/skills.ts";
import { buildAgentMemoryInjection } from "../agents/agent-memory.ts";
import { buildModelCandidates, inheritsParentModel, resolveEffectiveSubagentModel, resolveModelOrigin, type AvailableModelInfo, type ParentModel } from "../runs/shared/model-fallback.ts";
import { resolveModelScopesForAgent } from "../runs/shared/model-scope.ts";
import { applyThinkingSuffix, resolvePiLaunchToolPlan, type PiLaunchToolPlan } from "../runs/shared/pi-args.ts";
import { injectOutputPathSystemPrompt, normalizeSingleOutputOverride, resolveSingleOutputPath } from "../runs/shared/single-output.ts";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { resolveEffectiveThinking } from "../shared/model-info.ts";
import { assertThinkingWithinCeiling, decodeThinkingCeiling, intersectThinkingCeilings, SUBAGENT_THINKING_CEILING_ENV, type ThinkingLevel } from "../shared/thinking-ceiling.ts";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, type ArtifactDirPreference, type ArtifactPaths, type JsonSchemaObject, type OutputMode } from "../shared/types.ts";
import { capabilityCeilingAgentRestrictionMessage, intersectSubagentCapabilityCeilings, type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "../runs/shared/capability-ceiling.ts";
import { resolvePermissionRules } from "../runs/shared/permissions.ts";
import type { ResolvedMcpDirectToolSelection } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { resolveStepBehavior } from "../shared/settings.ts";
import { canPreferForkFromSnapshot, resolveSubagentLaunchContext } from "../shared/fork-context.ts";
import { loadConfig } from "../extension/config.ts";
import { agentDefinitionDigest, AGENT_DEFINITION_PROJECTION_VERSION, launchBindingDigest, stableJsonDigest } from "../shared/launch-contract.ts";
import { DIRS, TEMP_ROOT_DIR } from "../shared/types.ts";
import { processTerminalCandidatePath, processTerminalPath } from "../runs/background/process-terminal.ts";
import { resultFilePath } from "../runs/background/result-files.ts";
import { nestedResultsPath } from "../runs/shared/nested-events.ts";
import { normalizeExtensionBindings, type ExtensionBindings } from "../runs/shared/extension-bindings.ts";

export const SUBAGENT_LAUNCH_CONTRACT_VERSION = 2 as const;

export type SubagentLaunchContractReasonCode =
	| "missing_agent"
	| "ambiguous_agent"
	| "missing_skill"
	| "denied_required_tool"
	| "invalid_artifact_dir"
	| "invalid_cwd"
	| "unsupported_mode"
	| "restricted_agent"
	| "thinking_ceiling"
	| "invalid_extension_bindings";

export type SubagentLaunchContractDiagnosticCode = SubagentLaunchContractReasonCode | "host_required" | "snapshot_warning" | "workspace_scope_authority";

export interface SubagentLaunchContractDiagnostic {
	code: SubagentLaunchContractDiagnosticCode;
	severity: "error" | "warning" | "host-required";
	message: string;
}

export interface SubagentLaunchContractInput {
	agent: string;
	cwd: string;
	task?: string;
	agentScope?: AgentScope;
	context?: "fresh" | "fork";
	model?: string;
	fast?: boolean;
	thinking?: string | false;
	thinkingCeiling?: ThinkingLevel;
	inheritedThinkingCeiling?: ThinkingLevel;
	parentModel?: ParentModel;
	availableModels?: ReadonlyArray<AvailableModelInfo | { provider: string; id: string; fullId?: string; reasoning?: boolean }>;
	preferredProvider?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: OutputMode;
	outputSchema?: JsonSchemaObject;
	extensionBindings?: ExtensionBindings;
	artifacts?: boolean;
	artifactDir?: ArtifactDirPreference;
	parentSessionFile?: string | null;
	/** Current parent leaf required before an implicit `defaultContext: fork` stays `fork`. */
	parentLeafId?: string | null;
	sessionRoot?: string;
	sessionDir?: string;
	runId?: string;
	/** Root run id supplied by a host when projecting nested async lifecycle paths. */
	nestedRootRunId?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface SubagentLaunchContractAgentCandidate {
	name: string;
	localName?: string;
	packageName?: string;
	source: AgentSource;
	filePath: string;
	disabled?: boolean;
	selected: boolean;
}

export interface SubagentLaunchContractAgent {
	name: string;
	localName?: string;
	packageName?: string;
	source: AgentSource;
	filePath: string;
	definitionProjectionVersion: typeof AGENT_DEFINITION_PROJECTION_VERSION;
	definitionDigest: string;
	shadowedCandidates: SubagentLaunchContractAgentCandidate[];
}

export interface SubagentLaunchContractSkills {
	requested: string[];
	resolved: Array<{ name: string; path: string; source: string }>;
	missing: string[];
}

export interface SubagentLaunchContractTools {
	requestedBuiltin: string[];
	declaredBuiltin: string[];
	excludeTools?: string[];
	effectiveAllowlist: string[];
	explicitAllowlist: boolean;
	requiredChildTools: string[];
	internalTools: string[];
	mcp: ResolvedMcpDirectToolSelection[];
	effectiveMcpTools: string[];
	toolExtensionPaths: string[];
	runtimeExtensions: string[];
	configuredExtensions: string[];
	extensionArgs: string[];
	disableAmbientExtensions: boolean;
	fanoutAuthorized: boolean;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
}

export interface SubagentLaunchContractRoots {
	cwd: string;
	sessionRoot?: string;
	sessionDir?: string;
	sessionFile?: string;
	artifactsDir?: string;
	artifactPaths?: ArtifactPaths;
	outputPath?: string;
	lifecycle?: {
		asyncDir: string;
		resultPath: string;
		statusPath: string;
		eventsPath: string;
		processTerminalPath: string;
		processTerminalCandidatePath: string;
	};
}

export interface SubagentLaunchContract {
	version: typeof SUBAGENT_LAUNCH_CONTRACT_VERSION;
	runId: string;
	agent: SubagentLaunchContractAgent;
	context: "fresh" | "fork";
	model?: string;
	modelCandidates: string[];
	thinking?: string;
	thinkingCeiling?: ThinkingLevel;
	systemPromptMode: AgentConfig["systemPromptMode"];
	inheritProjectContext: boolean;
	inheritGlobalContext: boolean;
	inheritSkills: boolean;
	skills: SubagentLaunchContractSkills;
	tools: SubagentLaunchContractTools;
	roots: SubagentLaunchContractRoots;
	protocol: {
		lifecycleArtifactVersion: number;
		packageVersion: string;
	};
	diagnostics: SubagentLaunchContractDiagnostic[];
	/** Digest of the resolved child inputs, recomputed by execution paths. */
	launchContractDigest: string;
	digest: string;
}

export type SubagentLaunchContractResult =
	| { ok: true; contract: SubagentLaunchContract }
	| { ok: false; code: SubagentLaunchContractReasonCode; message: string; diagnostics: SubagentLaunchContractDiagnostic[] };

function packageVersion(): string {
	const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
	const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as { version?: unknown };
	if (typeof parsed.version !== "string" || !parsed.version.trim()) {
		throw new Error(`Invalid package version in '${packagePath}'.`);
	}
	return parsed.version;
}

function digestContract(contract: Omit<SubagentLaunchContract, "digest">): string {
	return stableJsonDigest(contract);
}

function normalizeAvailableModels(models: SubagentLaunchContractInput["availableModels"]): AvailableModelInfo[] {
	return (models ?? []).map((model) => ({ ...model, fullId: model.fullId ?? `${model.provider}/${model.id}` }));
}

function resolveLaunchContractContext(input: SubagentLaunchContractInput, agent: AgentConfig): "fresh" | "fork" {
	return resolveSubagentLaunchContext({
		explicitContext: input.context,
		agentDefaultContext: agent.defaultContext,
		defaultSubagentContext: loadConfig().defaultSubagentContext,
		canUseImplicitFork: canPreferForkFromSnapshot({
			parentSessionFile: input.parentSessionFile,
			leafId: input.parentLeafId,
		}),
	});
}

function taskWorkspaceScopeAuthorityDiagnostic(task: string | undefined): SubagentLaunchContractDiagnostic | undefined {
	if (!task) return undefined;
	const text = task.replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	const createsWorkspacePackage = /\b(?:add|create|introduce|make|set up)\b.{0,80}\b(?:new\s+)?(?:workspace\s+)?package\b/i.test(text)
		|| /\b(?:new\s+)?package\b.{0,80}\b(?:workspace|monorepo)\b/i.test(text);
	if (!createsWorkspacePackage) return undefined;
	const packageOnlyAuthority = /\b(?:only|solely)\b.{0,40}\b(?:edit|change|modify|touch|write(?:\s+to)?)\b.{0,80}\b(?:package(?:\s+directory)?|packages\/[\w.-]+)\b/i.test(text)
		|| /\b(?:do not|don't|must not)\b.{0,40}\b(?:edit|change|modify|touch|write(?:\s+to)?)\b.{0,80}\b(?:root|workspace|lockfile|metadata)\b/i.test(text)
		|| /\bwithout\b.{0,40}\b(?:root|workspace|lockfile|metadata)\b.{0,40}\b(?:edit|change|modification|write)s?\b/i.test(text);
	if (!packageOnlyAuthority) return undefined;
	return {
		code: "workspace_scope_authority",
		severity: "warning",
		message: "Task asks for a workspace package change while limiting authority to package-scope edits. New workspace packages often need root workspace metadata or lockfile changes, so confirm that authority before launch.",
	};
}

function candidateList(inputAgent: string, selected: AgentConfig | undefined, all: AgentDiscoveryAllResult): SubagentLaunchContractAgentCandidate[] {
	return [...all.builtin, ...all.package, ...all.user, ...all.project]
		.filter((agent) => Boolean(resolveAgentName(inputAgent, [agent]).agent))
		.map((agent) => ({
			name: agent.name,
			...(agent.localName ? { localName: agent.localName } : {}),
			...(agent.packageName ? { packageName: agent.packageName } : {}),
			source: agent.source,
			filePath: agent.filePath,
			...(agent.disabled === true ? { disabled: true } : {}),
			selected: Boolean(selected && agent.filePath === selected.filePath && agent.name === selected.name),
		}));
}

export async function resolveSubagentLaunchContract(input: SubagentLaunchContractInput): Promise<SubagentLaunchContractResult> {
	const diagnostics: SubagentLaunchContractDiagnostic[] = [];
	const authorityDiagnostic = taskWorkspaceScopeAuthorityDiagnostic(input.task);
	if (authorityDiagnostic) diagnostics.push(authorityDiagnostic);
	const effectiveCwd = path.resolve(input.cwd);
	try {
		if (!fs.statSync(effectiveCwd).isDirectory()) {
			return { ok: false, code: "invalid_cwd", message: `cwd '${effectiveCwd}' is not a directory.`, diagnostics };
		}
	} catch (error) {
		const detail = error instanceof Error ? ` ${error.message}` : "";
		return { ok: false, code: "invalid_cwd", message: `cwd '${effectiveCwd}' is not a directory.${detail}`, diagnostics };
	}
	if (input.context !== undefined && input.context !== "fresh" && input.context !== "fork") {
		return { ok: false, code: "unsupported_mode", message: `Unsupported context '${String(input.context)}'; expected 'fresh' or 'fork'.`, diagnostics };
	}
	if (input.artifactDir !== undefined && input.artifactDir !== "project" && input.artifactDir !== "session" && input.artifactDir !== "temp") {
		return { ok: false, code: "invalid_artifact_dir", message: `Unsupported artifactDir '${String(input.artifactDir)}'; expected 'project', 'session', or 'temp'.`, diagnostics };
	}
	const scope = resolveExecutionAgentScope(input.agentScope);
	const parentProvider = input.preferredProvider ?? input.parentModel?.provider;
	const discovery = discoverAgentSnapshot(effectiveCwd, scope, parentProvider, { includeChains: false });
	const discovered = discovery.effective;
	const resolvedAgent = resolveAgentName(input.agent, discovered.agents);
	const ambiguousCandidates = resolvedAgent.error
		? discovered.agents.filter((agent) => resolveAgentName(input.agent, [agent]).agent)
		: resolvedAgent.agent;
	const invalidAgent = findBlockingAgentDiagnostic(input.agent, ambiguousCandidates, discovered.agentDiagnostics);
	if (invalidAgent) {
		const message = `Agent '${input.agent}' has invalid configuration: ${invalidAgent.error}`;
		return { ok: false, code: "missing_agent", message, diagnostics: [{ code: "missing_agent", severity: "error", message }] };
	}
	if (resolvedAgent.error) {
		return { ok: false, code: "ambiguous_agent", message: resolvedAgent.error, diagnostics };
	}
	if (!resolvedAgent.agent) {
		return { ok: false, code: "missing_agent", message: formatUnknownAgentError(input.agent, unknownAgentDiagnosticContext(discovered)), diagnostics };
	}
	const agent = resolvedAgent.agent;
	let extensionBindings: ExtensionBindings | undefined;
	try {
		extensionBindings = normalizeExtensionBindings(input.extensionBindings)?.value;
	} catch (error) {
		return { ok: false, code: "invalid_extension_bindings", message: error instanceof Error ? error.message : String(error), diagnostics };
	}
	if (extensionBindings !== undefined && (agent.runner?.type === "external-cli" || agent.runner?.type === "external-job")) {
		return { ok: false, code: "unsupported_mode", message: `extensionBindings is not supported for runner.type='${agent.runner.type}'.`, diagnostics };
	}
	const context = resolveLaunchContractContext(input, agent);
	if (context === "fork") {
		diagnostics.push({ code: "host_required", severity: "host-required", message: "Exact fork session branching and fork-thinking downgrade checks require Pi host session and model-registry snapshots." });
	}
	const effectiveCapabilityCeiling = intersectSubagentCapabilityCeilings(input.capabilityCeiling, input.inheritedCapabilityCeiling);
	const restrictionMessage = capabilityCeilingAgentRestrictionMessage(agent.name, effectiveCapabilityCeiling);
	if (restrictionMessage) return { ok: false, code: "restricted_agent", message: restrictionMessage, diagnostics };
	const runId = input.runId ?? "preflight";
	const skillInput = normalizeSkillInput(input.skill);
	const outputOverride = normalizeSingleOutputOverride(input.output, agent.output);
	const behavior = resolveStepBehavior(agent, {
		...(outputOverride !== undefined ? { output: outputOverride } : {}),
		...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
		...(skillInput !== undefined ? { skills: skillInput } : {}),
		...(input.model !== undefined ? { model: input.model } : {}),
	});
	const requestedSkills = behavior.skills === false ? [] : behavior.skills;
	const resolvedSkills = resolveSkillsWithFallback(
		requestedSkills,
		effectiveCwd,
		effectiveCwd,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : effectiveCwd,
	);
	if (resolvedSkills.missing.includes("pi-subagents")) {
		return { ok: false, code: "missing_skill", message: "The pi-subagents orchestration skill is not child-injectable.", diagnostics };
	}
	if (resolvedSkills.missing.length > 0) diagnostics.push({ code: "missing_skill", severity: "error", message: `Missing skills: ${resolvedSkills.missing.join(", ")}` });

	const externalRunner = agent.runner?.type === "external-cli" || agent.runner?.type === "external-job";
	const availableModels = normalizeAvailableModels(input.availableModels);
	const preferredProvider = agent.modelProvider ?? input.preferredProvider ?? input.parentModel?.provider;
	const modelScopes = resolveModelScopesForAgent(discovered.modelScope, agent.name, input.parentModel);
	const modelOrigin = resolveModelOrigin({ explicitModel: input.model, agentModel: agent.model, parentModel: input.parentModel });
	const primaryModel = externalRunner
		? undefined
		: resolveEffectiveSubagentModel(input.model, agent.model, input.parentModel, availableModels, preferredProvider, {
			scope: modelScopes,
			source: modelOrigin === "explicit" ? "explicit" : "inherited",
		});
	const effectiveThinkingConfig = input.thinking !== undefined ? input.thinking : agent.thinking;
	const thinkingCeiling = externalRunner ? undefined : intersectThinkingCeilings(
		discovered.maxThinking,
		input.thinkingCeiling,
		input.inheritedThinkingCeiling,
		decodeThinkingCeiling(process.env[SUBAGENT_THINKING_CEILING_ENV]),
	);
	const model = externalRunner ? undefined : applyThinkingSuffix(primaryModel, effectiveThinkingConfig, input.thinking !== undefined);
	const modelCandidates = externalRunner
		? []
		: buildModelCandidates(primaryModel, agent.fallbackModels, availableModels, preferredProvider, {
			scope: modelScopes,
			primaryModelFromParent: modelOrigin === "inherited" || inheritsParentModel(input.model, agent.model, input.parentModel),
			origin: modelOrigin,
		})
			.map((candidate) => applyThinkingSuffix(candidate, effectiveThinkingConfig, input.thinking !== undefined) ?? candidate);
	if (!externalRunner) {
		try {
			assertThinkingWithinCeiling({ model, configThinking: effectiveThinkingConfig, ceiling: thinkingCeiling, agent: agent.name, runId });
			for (const candidate of modelCandidates) assertThinkingWithinCeiling({ model: candidate, configThinking: effectiveThinkingConfig, ceiling: thinkingCeiling, agent: agent.name, runId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({ code: "thinking_ceiling", severity: "error", message });
			return { ok: false, code: "thinking_ceiling", message, diagnostics };
		}
	}
	let toolPlan: PiLaunchToolPlan;
	const permissionRules = resolvePermissionRules(loadConfig().permissions, agent.permissions);
	const fast = input.fast ?? agent.fast;
	try {
		toolPlan = resolvePiLaunchToolPlan({
			tools: agent.tools,
			excludeTools: agent.excludeTools,
			allowNestedSubagents: agent.allowNestedSubagents,
			extensions: agent.extensions,
			subagentOnlyExtensions: agent.subagentOnlyExtensions,
			mcpDirectTools: agent.mcpDirectTools,
			cwd: effectiveCwd,
			requireReadTool: resolvedSkills.resolved.length > 0,
			structuredOutput: Boolean(input.outputSchema),
			fast,
			model,
			modelCandidates,
			capabilityCeiling: effectiveCapabilityCeiling,
			agentName: agent.name,
			permissionRules,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		diagnostics.push({ code: "denied_required_tool", severity: "error", message });
		return { ok: false, code: "denied_required_tool", message, diagnostics };
	}
	const artifactsEnabled = input.artifacts !== false;
	const artifactsDir = artifactsEnabled ? getArtifactsDir(input.parentSessionFile ?? null, effectiveCwd, input.artifactDir) : undefined;
	const artifactPaths = artifactsDir ? getArtifactPaths(artifactsDir, runId, agent.name, 0) : undefined;
	const outputPath = resolveSingleOutputPath(behavior.output, effectiveCwd, effectiveCwd, artifactsDir ? path.join(artifactsDir, "outputs", runId) : undefined);
	const sessionRoot = input.sessionDir ? path.resolve(input.sessionDir) : input.sessionRoot ? path.join(path.resolve(input.sessionRoot), runId) : undefined;
	const sessionDir = sessionRoot ? path.join(sessionRoot, "run-0") : undefined;
	const lifecycleAsyncDir = input.nestedRootRunId
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", input.nestedRootRunId, runId)
		: path.join(DIRS.async, runId);
	const lifecycleResultPath = input.nestedRootRunId
		? nestedResultsPath(input.nestedRootRunId, runId)
		: resultFilePath(DIRS.results, runId);
	if (!sessionDir) diagnostics.push({ code: "host_required", severity: "host-required", message: "No sessionRoot/sessionDir was supplied; exact child session paths require the Pi host session-root policy." });
	if (!externalRunner && input.availableModels === undefined && (input.model || agent.model || input.parentModel)) {
		diagnostics.push({ code: "host_required", severity: "host-required", message: "No availableModels snapshot was supplied; model resolution may differ from the active Pi host registry." });
	}
	if (resolvedSkills.missing.length > 0) {
		return { ok: false, code: "missing_skill", message: `Missing skills: ${resolvedSkills.missing.join(", ")}`, diagnostics };
	}
	let effectiveSystemPrompt = agent.systemPrompt?.trim() ?? "";
	if (resolvedSkills.resolved.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills.resolved);
		effectiveSystemPrompt = effectiveSystemPrompt ? `${effectiveSystemPrompt}\n\n${skillInjection}` : skillInjection;
	}
	const memoryInjection = buildAgentMemoryInjection(agent, effectiveCwd);
	if (memoryInjection) effectiveSystemPrompt = effectiveSystemPrompt ? `${effectiveSystemPrompt}\n\n${memoryInjection}` : memoryInjection;
	effectiveSystemPrompt = injectOutputPathSystemPrompt(effectiveSystemPrompt, outputPath, agent);
	const candidates = candidateList(input.agent, agent, discovery.all);
	const shadowedCandidates = candidates.filter((candidate) => !candidate.selected);
	const definitionDigest = agentDefinitionDigest(agent);
	const contractBase: Omit<SubagentLaunchContract, "digest"> = {
		version: SUBAGENT_LAUNCH_CONTRACT_VERSION,
		runId,
		agent: {
			name: agent.name,
			...(agent.localName ? { localName: agent.localName } : {}),
			...(agent.packageName ? { packageName: agent.packageName } : {}),
			source: agent.source,
			filePath: agent.filePath,
			definitionProjectionVersion: AGENT_DEFINITION_PROJECTION_VERSION,
			definitionDigest,
			shadowedCandidates,
		},
		context,
		...(model ? { model } : {}),
		modelCandidates,
		...(resolveEffectiveThinking(model, effectiveThinkingConfig) ? { thinking: resolveEffectiveThinking(model, effectiveThinkingConfig) } : {}),
		...(thinkingCeiling ? { thinkingCeiling } : {}),
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritGlobalContext: agent.inheritGlobalContext,
		inheritSkills: agent.inheritSkills,
		skills: {
			requested: requestedSkills,
			resolved: resolvedSkills.resolved.map((skill) => ({ name: skill.name, path: skill.path, source: skill.source })),
			missing: resolvedSkills.missing,
		},
		tools: {
			requestedBuiltin: toolPlan.requestedBuiltinTools,
			declaredBuiltin: toolPlan.declaredBuiltinTools,
			...(toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
			effectiveAllowlist: toolPlan.effectiveToolAllowlist,
			explicitAllowlist: toolPlan.explicitToolAllowlist,
			requiredChildTools: toolPlan.requiredChildTools,
			internalTools: toolPlan.internalTools,
			mcp: toolPlan.effectiveMcpSelections,
			effectiveMcpTools: toolPlan.effectiveMcpTools,
			toolExtensionPaths: toolPlan.toolExtensionPaths,
			runtimeExtensions: toolPlan.runtimeExtensions,
			configuredExtensions: toolPlan.configuredExtensions,
			extensionArgs: toolPlan.extensionArgs,
			disableAmbientExtensions: toolPlan.disableAmbientExtensions,
			fanoutAuthorized: toolPlan.fanoutAuthorized,
			...(toolPlan.capabilityCeiling ? { capabilityCeiling: toolPlan.capabilityCeiling } : {}),
			...(toolPlan.capabilityAudit ? { capabilityAudit: toolPlan.capabilityAudit } : {}),
		},
		roots: {
			cwd: effectiveCwd,
			...(sessionRoot ? { sessionRoot } : {}),
			...(sessionDir ? { sessionDir, sessionFile: path.join(sessionDir, "session.jsonl") } : {}),
			...(artifactsDir ? { artifactsDir } : {}),
			...(artifactPaths ? { artifactPaths } : {}),
			...(outputPath ? { outputPath } : {}),
			lifecycle: {
				asyncDir: lifecycleAsyncDir,
				resultPath: lifecycleResultPath,
				statusPath: path.join(lifecycleAsyncDir, "status.json"),
				eventsPath: path.join(lifecycleAsyncDir, "events.jsonl"),
				processTerminalPath: processTerminalPath(lifecycleAsyncDir),
				processTerminalCandidatePath: processTerminalCandidatePath(lifecycleAsyncDir),
			},
		},
		protocol: {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			packageVersion: packageVersion(),
		},
		diagnostics,
		launchContractDigest: launchBindingDigest({
			task: input.task ?? "",
			definitionDigest,
			...(model ? { model } : {}),
			modelCandidates,
			...(fast !== undefined ? { fast } : {}),
			...(resolveEffectiveThinking(model, effectiveThinkingConfig) ? { thinking: resolveEffectiveThinking(model, effectiveThinkingConfig) } : {}),
			systemPrompt: effectiveSystemPrompt,
			systemPromptMode: agent.systemPromptMode,
			inheritProjectContext: agent.inheritProjectContext,
			inheritGlobalContext: agent.inheritGlobalContext,
			inheritSkills: agent.inheritSkills,
			skills: requestedSkills,
			tools: toolPlan.effectiveToolAllowlist,
			...(toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
			extensions: toolPlan.extensionArgs,
			mcpDirectTools: toolPlan.effectiveMcpTools,
			...(outputPath ? { outputPath } : {}),
			outputMode: behavior.outputMode,
			...(input.outputSchema ? { structuredOutputSchema: input.outputSchema } : {}),
			...(extensionBindings ? { extensionBindings } : {}),
		}),
	};
	return { ok: true, contract: { ...contractBase, digest: digestContract(contractBase) } };
}
