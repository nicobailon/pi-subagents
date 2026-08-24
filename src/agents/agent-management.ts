import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentDiscoveryDiagnostic,
	type AgentScope,
	type AgentSource,
	BUILTIN_AGENT_NAMES,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	buildRuntimeName,
	findBlockingAgentDiagnostic,
	frontmatterNameForConfig,
	parsePackageName,
	mergeBuiltinAgentOverride,
	removeBuiltinAgentOverride,
	removeBuiltinAgentOverrideFields,
	resolveAgentName,
} from "./agents.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { discoverAvailableSkills, resolveSkills } from "./skills.ts";
import {
	buildProactiveSkillSubagentRecommendationLines,
} from "./proactive-skills.ts";
import { parseFrontmatter, parseFrontmatterList } from "./frontmatter.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { resolveSubagentModelOverride, type ParentModel } from "../runs/shared/model-fallback.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { validateCodeOwnedProfileRunner } from "../runs/shared/external-cli-contract.ts";
import type { AcceptanceInput, Details, ExtensionConfig, ToolBudgetConfig } from "../shared/types.ts";
import { getProjectConfigDir } from "../shared/utils.ts";
import { capabilityCeilingAgentRestrictionSources, isAgentAllowedByCapabilityCeiling, resolveCurrentSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { listRuntimeAgentConfigs, mergeRuntimeAgents, type RuntimeAgentOwner } from "./runtime-agent-registry.ts";
import { listExternalJobProviders } from "../api/external-job-provider.ts";

type ManagementAction = "list" | "get" | "models" | "create" | "update" | "delete" | "eject" | "disable" | "enable" | "reset";
type ManagementScope = "user" | "project";
type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry"> & { model?: ExtensionContext["model"]; config?: ExtensionConfig; currentSessionId?: string; runtimeAgentOwner?: RuntimeAgentOwner };

interface ManagementParams {
	action?: string;
	agent?: string;
	agentScope?: unknown;
	config?: unknown;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

type ConfigObjectResult =
	| { status: "ok"; value: Record<string, unknown> }
	| { status: "missing" }
	| { status: "error"; message: string };

function configObject(config: unknown): ConfigObjectResult {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: "error", message: `config must be valid JSON: ${message}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return { status: "missing" };
	return { status: "ok", value: val as Record<string, unknown> };
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function isJsonSerializable(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonSerializable);
	if (value && typeof value === "object") return Object.values(value).every(isJsonSerializable);
	return false;
}

function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

function actionScope(scope: unknown, action: ManagementAction): { scope?: ManagementScope; error?: AgentToolResult<Details> } {
	if (scope === undefined) return { scope: "user" };
	const parsed = asDisambiguationScope(scope);
	return parsed ? { scope: parsed } : { error: result(`agentScope must be 'user' or 'project' for ${action}.`, true) };
}

function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function parsePackageConfig(value: unknown): { packageName?: string; error?: string } {
	return parsePackageName(value, "config.package");
}

function allAgents(d: { builtin: AgentConfig[]; package: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }): AgentConfig[] {
	return [...d.builtin, ...d.package, ...d.user, ...d.project];
}

function availableAgentNamesFromDiscovery(d: { builtin: AgentConfig[]; package: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }): string[] {
	return [...new Set(allAgents(d).map((agent) => agent.name))].sort((a, b) => a.localeCompare(b));
}

function availableAgentNames(cwd: string): string[] {
	return availableAgentNamesFromDiscovery(discoverAgentsAll(cwd));
}

function findAgentsInDiscovery(name: string, d: { builtin: AgentConfig[]; package: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] }, scope: AgentScope = "both"): AgentConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	const scoped = mergeAgentsForScope(scope, d.user, d.project, d.builtin, d.package);
	let resolved = resolveAgentName(raw, scoped);
	if (!resolved.agent && !resolved.error && sanitized !== raw) resolved = resolveAgentName(sanitized, scoped);
	if (resolved.agent) return scoped.filter((agent) => agent.name === resolved.agent!.name).sort((a, b) => a.source.localeCompare(b.source));
	return scoped
		.filter((agent) => Boolean(resolveAgentName(raw, [agent]).agent)
			|| (sanitized !== raw && Boolean(resolveAgentName(sanitized, [agent]).agent)))
		.sort((a, b) => a.source.localeCompare(b.source));
}

function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	return findAgentsInDiscovery(name, discoverAgentsAll(cwd), scope);
}

function diagnosticsForScope(diagnostics: AgentDiscoveryDiagnostic[] | undefined, scope: AgentScope): AgentDiscoveryDiagnostic[] | undefined {
	if (scope === "both") return diagnostics;
	const excludedSource = scope === "user" ? "project" : "user";
	return diagnostics?.filter((diagnostic) => diagnostic.source !== excludedSource);
}

const AGENT_SOURCE_PRECEDENCE: Record<AgentSource, number> = { builtin: 0, package: 1, user: 2, project: 3, runtime: 4 };

// Returns the highest-precedence definition for a resolved canonical name (project > user > package > builtin),
// matching mergeAgentsForScope for "both", including disabled agents so disable/enable can locate hidden targets.
function resolveEffectiveAgent(d: ReturnType<typeof discoverAgentsAll>, name: string): { agent?: AgentConfig; error?: string } {
	const raw = name.trim();
	const candidates = allAgents(d);
	let resolved = resolveAgentName(raw, candidates);
	if (!resolved.agent && !resolved.error) {
		const sanitized = sanitizeName(raw);
		if (sanitized !== raw) resolved = resolveAgentName(sanitized, candidates);
	}
	if (resolved.error) return { error: resolved.error };
	if (!resolved.agent) return {};
	const matches = candidates.filter((agent) => agent.name === resolved.agent!.name);
	return { agent: matches.reduce((best, agent) => (AGENT_SOURCE_PRECEDENCE[agent.source] > AGENT_SOURCE_PRECEDENCE[best.source] ? agent : best)) };
}

function nameExistsInScope(cwd: string, scope: ManagementScope, name: string, excludePath?: string): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	return false;
}

function isMutableSource(source: AgentSource): source is ManagementScope {
	return source === "user" || source === "project";
}

function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	if (found) return undefined;
	return `Warning: model '${model}' is not in the current model registry. Run subagent({ action: "models" }) to list valid provider/id selectors, then use the exact provider/id form (bare ids resolve only when unique).`;
}

function fallbackModelsWarning(ctx: ManagementContext, fallbackModels: string[] | undefined): string | undefined {
	if (!fallbackModels || fallbackModels.length === 0) return undefined;
	const available = new Set(ctx.modelRegistry.getAvailable().flatMap((m) => [`${m.provider}/${m.id}`, m.id]));
	const missing = fallbackModels.filter((model) => !available.has(model));
	return missing.length ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.` : undefined;
}

function skillsWarning(cwd: string, agent: Pick<AgentConfig, "skills" | "skillPath" | "filePath">): string | undefined {
	if (!agent.skills?.length) return undefined;
	const { missing } = resolveSkills(
		agent.skills,
		cwd,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : cwd,
	);
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}

function withDeclaredExtensionPaths(config: AgentConfig, filePath: string): AgentConfig {
	const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
	const { extensions: _extensions, subagentOnlyExtensions: _subagentOnlyExtensions, ...withoutResolvedExtensions } = config;
	return {
		...withoutResolvedExtensions,
		...(frontmatter.extensions !== undefined ? { extensions: parseFrontmatterList(frontmatter.extensions) } : {}),
		...(frontmatter.subagentOnlyExtensions !== undefined
			? { subagentOnlyExtensions: parseFrontmatterList(frontmatter.subagentOnlyExtensions) }
			: {}),
	};
}

export function editableAgentConfig(agent: AgentConfig): AgentConfig {
	const { extensions: _extensions, ...withoutExtensions } = agent;
	const base = agent.override?.base;
	const {
		override: _override,
		output: _output,
		outputMode: _outputMode,
		defaultReads: _defaultReads,
		model: _model,
		fallbackModels: _fallbackModels,
		thinking: _thinking,
		systemPromptMode: _systemPromptMode,
		inheritProjectContext: _inheritProjectContext,
		inheritSkills: _inheritSkills,
		defaultContext: _defaultContext,
		acceptanceRole: _acceptanceRole,
		disabled: _disabled,
		systemPrompt: _systemPrompt,
		skills: _skills,
		skillPath: _skillPath,
		tools: _tools,
		mcpDirectTools: _mcpDirectTools,
		subagentOnlyExtensions: _subagentOnlyExtensions,
		completionGuard: _completionGuard,
		...editable
	} = withoutExtensions;
	if (!base) {
		return withDeclaredExtensionPaths({
			...withoutExtensions,
			...(agent.extensionsFromDefault ? {} : agent.extensions !== undefined ? { extensions: [...agent.extensions] } : {}),
		}, agent.filePath);
	}

	return withDeclaredExtensionPaths({
		...editable,
		...(base.output !== undefined ? { output: base.output } : {}),
		...(base.outputMode !== undefined ? { outputMode: base.outputMode } : {}),
		...(base.defaultReads !== undefined ? { defaultReads: [...base.defaultReads] } : {}),
		...(base.model !== undefined ? { model: base.model } : {}),
		...(base.fallbackModels !== undefined ? { fallbackModels: [...base.fallbackModels] } : {}),
		...(base.thinking !== undefined ? { thinking: base.thinking } : {}),
		systemPromptMode: base.systemPromptMode,
		inheritProjectContext: base.inheritProjectContext,
		inheritSkills: base.inheritSkills,
		...(base.defaultContext !== undefined ? { defaultContext: base.defaultContext } : {}),
		...(base.acceptanceRole !== undefined ? { acceptanceRole: base.acceptanceRole } : {}),
		...(base.disabled !== undefined ? { disabled: base.disabled } : {}),
		systemPrompt: base.systemPrompt,
		...(base.skills !== undefined ? { skills: [...base.skills] } : {}),
		...(base.skillPath !== undefined ? { skillPath: [...base.skillPath] } : {}),
		...(base.tools !== undefined ? { tools: [...base.tools] } : {}),
		...(base.mcpDirectTools !== undefined ? { mcpDirectTools: [...base.mcpDirectTools] } : {}),
		...(base.extensions !== undefined ? { extensions: [...base.extensions] } : {}),
		...(base.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: [...base.subagentOnlyExtensions] } : {}),
		...(base.completionGuard !== undefined ? { completionGuard: base.completionGuard } : {}),
	}, agent.filePath);
}

function readAgentFrontmatterFields(filePath: string): Set<string> {
	try {
		const { frontmatter } = parseFrontmatter(fs.readFileSync(filePath, "utf-8"));
		return new Set(Object.keys(frontmatter));
	} catch {
		return new Set();
	}
}

export function preservedAgentFrontmatterFields(agent: AgentConfig, cfg: Record<string, unknown>): Set<string> {
	const fields = readAgentFrontmatterFields(agent.filePath);
	const changed = (...names: string[]) => {
		for (const name of names) fields.delete(name);
	};

	if (hasKey(cfg, "name")) changed("name");
	if (hasKey(cfg, "package")) changed("package");
	if (hasKey(cfg, "description")) changed("description");
	if (hasKey(cfg, "aliases")) changed("alias", "aliases");
	if (hasKey(cfg, "systemPrompt")) changed("systemPrompt");
	if (hasKey(cfg, "runner")) changed("runner");
	if (hasKey(cfg, "model")) changed("model");
	if (hasKey(cfg, "fallbackModels")) changed("fallbackModels");
	if (hasKey(cfg, "tools")) changed("tools");
	if (hasKey(cfg, "skills")) changed("skill", "skills");
	if (hasKey(cfg, "skillPath")) changed("skillPath");
	if (hasKey(cfg, "extensions")) changed("extensions");
	if (hasKey(cfg, "subagentOnlyExtensions")) changed("subagentOnlyExtensions");
	if (hasKey(cfg, "thinking")) {
		changed("thinking");
		if (cfg.thinking === "off") fields.add("thinking");
	}
	if (hasKey(cfg, "systemPromptMode")) {
		changed("systemPromptMode");
		fields.add("systemPromptMode");
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		changed("inheritProjectContext");
		fields.add("inheritProjectContext");
	}
	if (hasKey(cfg, "inheritSkills")) {
		changed("inheritSkills");
		fields.add("inheritSkills");
	}
	if (hasKey(cfg, "defaultContext")) changed("defaultContext");
	if (hasKey(cfg, "async")) changed("async");
	if (hasKey(cfg, "timeoutMs")) changed("timeoutMs");
	if (hasKey(cfg, "turnBudget")) changed("turnBudget");
	if (hasKey(cfg, "acceptance")) changed("acceptance");
	if (hasKey(cfg, "acceptanceRole")) changed("acceptanceRole");
	if (hasKey(cfg, "output")) changed("output");
	if (hasKey(cfg, "outputMode")) changed("outputMode");
	if (hasKey(cfg, "reads")) changed("defaultReads");
	if (hasKey(cfg, "progress")) changed("defaultProgress");
	if (hasKey(cfg, "maxSubagentDepth")) changed("maxSubagentDepth");
	if (hasKey(cfg, "completionGuard")) {
		changed("completionGuard");
		if (cfg.completionGuard === true) fields.add("completionGuard");
	}
	if (hasKey(cfg, "toolBudget")) changed("toolBudget");

	return fields;
}

function parseTools(raw: string): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const item of parseCsv(raw)) {
		if (item.startsWith("mcp:")) {
			const direct = item.slice(4).trim();
			if (direct) mcpDirectTools.push(direct);
		} else tools.push(item);
	}
	return {
		...(tools.length ? { tools } : {}),
		...(mcpDirectTools.length ? { mcpDirectTools } : {}),
	};
}

function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "aliases")) {
		if (cfg.aliases === false || cfg.aliases === "") delete target.aliases;
		else if (typeof cfg.aliases === "string") {
			const aliases = parseCsv(cfg.aliases).filter((alias) => alias !== target.name);
			if (aliases.length) target.aliases = aliases;
			else delete target.aliases;
		} else if (Array.isArray(cfg.aliases) && cfg.aliases.every((entry) => typeof entry === "string")) {
			const aliases = [...new Set(cfg.aliases.map((entry) => entry.trim()).filter(Boolean).filter((alias) => alias !== target.name))];
			if (aliases.length) target.aliases = aliases;
			else delete target.aliases;
		} else return "config.aliases must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "runner")) {
		if (cfg.runner === false || cfg.runner === "") delete target.runner;
		else if (cfg.runner && typeof cfg.runner === "object" && !Array.isArray(cfg.runner)) {
			const runner = cfg.runner as Record<string, unknown>;
			if (runner.type === "pi" && Object.keys(runner).every((key) => key === "type")) target.runner = { type: "pi" };
			else if (runner.type === "external-cli" && typeof runner.command === "string" && runner.command.trim()
				&& (runner.args === undefined || (Array.isArray(runner.args) && runner.args.every((arg) => typeof arg === "string")))
				&& (runner.adapter === undefined || runner.adapter === "codex-exec" || runner.adapter === "codex-exec-writer" || runner.adapter === "claude-code" || runner.adapter === "claude-code-writer" || runner.adapter === "cursor-agent" || runner.adapter === "cursor-agent-writer")
				&& (runner.adapter === undefined || runner.args === undefined || runner.args.length === 0)
				&& (runner.promptDelivery === undefined || runner.promptDelivery === "stdin")
				&& Object.keys(runner).every((key) => ["type", "adapter", "command", "args", "promptDelivery"].includes(key))) {
				const runnerArgs = Array.isArray(runner.args) ? runner.args.filter((arg): arg is string => typeof arg === "string") : undefined;
				target.runner = { type: "external-cli", ...(runner.adapter === "codex-exec" || runner.adapter === "codex-exec-writer" || runner.adapter === "claude-code" || runner.adapter === "claude-code-writer" || runner.adapter === "cursor-agent" || runner.adapter === "cursor-agent-writer" ? { adapter: runner.adapter } : {}), command: runner.command.trim(), ...(runnerArgs?.length ? { args: runnerArgs } : {}), ...(runner.promptDelivery ? { promptDelivery: "stdin" } : {}) };
			} else if (runner.type === "external-job" && typeof runner.provider === "string" && runner.provider.trim() === runner.provider && runner.provider
				&& (runner.options === undefined || (runner.options && typeof runner.options === "object" && !Array.isArray(runner.options) && isJsonSerializable(runner.options)))
				&& Object.keys(runner).every((key) => ["type", "provider", "options"].includes(key))) {
				target.runner = { type: "external-job", provider: runner.provider, ...(runner.options ? { options: runner.options as Record<string, unknown> } : {}) };
			} else return "config.runner must be { type: 'pi' }, { type: 'external-cli', adapter?: 'codex-exec' | 'codex-exec-writer' | 'claude-code' | 'claude-code-writer' | 'cursor-agent' | 'cursor-agent-writer', command: string, args?: string[], promptDelivery?: 'stdin' }, or { type: 'external-job', provider: string, options?: object }.";
		} else return "config.runner must be an object, false, or empty string when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") delete target.model;
		else if (typeof cfg.model === "string") {
			const model = cfg.model.trim();
			if (model) target.model = model;
			else delete target.model;
		} else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") delete target.fallbackModels;
		else if (typeof cfg.fallbackModels === "string") {
			const models = parseCsv(cfg.fallbackModels);
			if (models.length) target.fallbackModels = models;
			else delete target.fallbackModels;
		} else if (Array.isArray(cfg.fallbackModels)) {
			const models = cfg.fallbackModels
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
			if (models.length) target.fallbackModels = [...new Set(models)];
			else delete target.fallbackModels;
		} else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { delete target.tools; delete target.mcpDirectTools; }
		else if (typeof cfg.tools === "string") {
			const parsed = parseTools(cfg.tools);
			if (parsed.tools) target.tools = parsed.tools;
			else delete target.tools;
			if (parsed.mcpDirectTools) target.mcpDirectTools = parsed.mcpDirectTools;
			else delete target.mcpDirectTools;
		} else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") delete target.skills;
		else if (typeof cfg.skills === "string") {
			const skills = parseCsv(cfg.skills);
			if (skills.length) target.skills = skills;
			else delete target.skills;
		} else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skillPath")) {
		if (cfg.skillPath === false || cfg.skillPath === "") delete target.skillPath;
		else if (typeof cfg.skillPath === "string") {
			const skillPath = parseCsv(cfg.skillPath);
			if (skillPath.length) target.skillPath = skillPath;
			else delete target.skillPath;
		} else if (Array.isArray(cfg.skillPath) && cfg.skillPath.every((entry) => typeof entry === "string")) {
			const skillPath = [...new Set(cfg.skillPath.map((entry) => entry.trim()).filter(Boolean))];
			if (skillPath.length) target.skillPath = skillPath;
			else delete target.skillPath;
		} else return "config.skillPath must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) delete target.extensions;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "subagentOnlyExtensions")) {
		if (cfg.subagentOnlyExtensions === false) delete target.subagentOnlyExtensions;
		else if (cfg.subagentOnlyExtensions === "") target.subagentOnlyExtensions = [];
		else if (typeof cfg.subagentOnlyExtensions === "string") target.subagentOnlyExtensions = parseCsv(cfg.subagentOnlyExtensions);
		else return "config.subagentOnlyExtensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") delete target.thinking;
		else if (typeof cfg.thinking === "string") {
			const thinking = cfg.thinking.trim();
			if (thinking) target.thinking = thinking;
			else delete target.thinking;
		} else return "config.thinking must be a string or false when provided.";
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") target.systemPromptMode = cfg.systemPromptMode;
		else return "config.systemPromptMode must be 'append' or 'replace' when provided.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") return "config.inheritProjectContext must be a boolean when provided.";
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean when provided.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "defaultContext")) {
		if (cfg.defaultContext === false || cfg.defaultContext === "") delete target.defaultContext;
		else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork") target.defaultContext = cfg.defaultContext;
		else return "config.defaultContext must be 'fresh', 'fork', or false when provided.";
	}
	if (hasKey(cfg, "async")) {
		if (cfg.async === "") delete target.defaultAsync;
		else if (typeof cfg.async === "boolean") target.defaultAsync = cfg.async;
		else return "config.async must be a boolean or empty string when provided.";
	}
	if (hasKey(cfg, "timeoutMs")) {
		if (cfg.timeoutMs === false || cfg.timeoutMs === "") delete target.defaultTimeoutMs;
		else if (typeof cfg.timeoutMs === "number" && Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0) target.defaultTimeoutMs = cfg.timeoutMs;
		else return "config.timeoutMs must be a positive integer or false when provided.";
	}
	if (hasKey(cfg, "turnBudget")) {
		if (cfg.turnBudget === false || cfg.turnBudget === "") delete target.defaultTurnBudget;
		else {
			const resolved = resolveTurnBudgetConfig(cfg.turnBudget, "config.turnBudget");
			if (resolved.error) return resolved.error;
			if (resolved.turnBudget !== undefined) target.defaultTurnBudget = resolved.turnBudget;
			else delete target.defaultTurnBudget;
		}
	}
	if (hasKey(cfg, "acceptance")) {
		if (cfg.acceptance === "") delete target.defaultAcceptance;
		else {
			const errors = validateAcceptanceInput(cfg.acceptance, "config.acceptance");
			if (errors.length > 0) return errors.join(" ");
			target.defaultAcceptance = cfg.acceptance as AcceptanceInput;
		}
	}
	if (hasKey(cfg, "acceptanceRole")) {
		if (cfg.acceptanceRole === false || cfg.acceptanceRole === "") delete target.acceptanceRole;
		else if (cfg.acceptanceRole === "read-only" || cfg.acceptanceRole === "writer") target.acceptanceRole = cfg.acceptanceRole;
		else return "config.acceptanceRole must be 'read-only', 'writer', or false when provided.";
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") delete target.output;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "outputMode")) {
		if (cfg.outputMode === "inline" || cfg.outputMode === "file-only") target.outputMode = cfg.outputMode;
		else return "config.outputMode must be 'inline' or 'file-only' when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") delete target.defaultReads;
		else if (typeof cfg.reads === "string") {
			const reads = parseCsv(cfg.reads);
			if (reads.length) target.defaultReads = reads;
			else delete target.defaultReads;
		} else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") delete target.maxSubagentDepth;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) {
			target.maxSubagentDepth = cfg.maxSubagentDepth;
		} else return "config.maxSubagentDepth must be an integer >= 0 or false when provided.";
	}
	if (hasKey(cfg, "completionGuard")) {
		if (typeof cfg.completionGuard !== "boolean") return "config.completionGuard must be a boolean when provided.";
		target.completionGuard = cfg.completionGuard;
	}
	if (hasKey(cfg, "toolBudget")) {
		if (cfg.toolBudget === false || cfg.toolBudget === "") delete target.toolBudget;
		else {
			const validation = validateToolBudgetConfig(cfg.toolBudget, "config.toolBudget");
			if (validation.error) return validation.error;
			target.toolBudget = cfg.toolBudget as ToolBudgetConfig;
		}
	}
	if (target.runner?.type === "external-cli" || target.runner?.type === "external-job") {
		const unsupported = [
			target.tools?.length || target.mcpDirectTools?.length ? "tools" : undefined,
			target.model ? "model" : undefined,
			target.fallbackModels?.length ? "fallbackModels" : undefined,
			target.thinking ? "thinking" : undefined,
			target.extensions?.length ? "extensions" : undefined,
			target.subagentOnlyExtensions?.length ? "subagentOnlyExtensions" : undefined,
			target.skills?.length || target.skillPath?.length ? "skills" : undefined,
			target.maxSubagentDepth !== undefined ? "maxSubagentDepth" : undefined,
			target.completionGuard !== undefined ? "completionGuard" : undefined,
			target.toolBudget ? "toolBudget" : undefined,
		].filter((field): field is string => Boolean(field));
		if (unsupported.length > 0) return `config.runner type '${target.runner.type}' does not support Pi-only fields: ${unsupported.join(", ")}.`;
	}
	return undefined;
}

function resolveTarget<T extends { name: string; source: AgentSource; filePath: string }>(
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): T | AgentToolResult<Details> {
	const distinctNames = [...new Set(matches.map((match) => match.name))];
	if (distinctNames.length > 1) return result(`Ambiguous agent alias or name '${name}': ${distinctNames.sort((a, b) => a.localeCompare(b)).join(", ")}`, true);
	const mutable = matches.filter((match): match is T & { source: ManagementScope } => isMutableSource(match.source));
	if (mutable.length === 0) {
		if (matches.length > 0) return result(`Agent '${name}' is read-only and cannot be modified. Create a same-named agent in user or project scope to override it.`, true);
		return result(`Agent '${name}' not found. Available: ${availableAgentNames(cwd).join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((match) => `${match.source}: ${match.filePath}`).join("\n");
		return result(`Agent '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = mutable.filter((match) => match.source === scope);
	if (scoped.length === 0) return result(`Agent '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1) return result(`Multiple agents named '${name}' found in scope '${scope}': ${scoped.map((match) => match.filePath).join(", ")}`, true);
	return scoped[0]!;
}

function renamePath(currentPath: string, newName: string, scope: ManagementScope, cwd: string): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const filePath = path.join(path.dirname(currentPath), `${newName}.md`);
	if (fs.existsSync(filePath) && filePath !== currentPath) return { error: `File already exists at ${filePath} but is not a valid agent definition. Remove or rename it first.` };
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

function packageSourceLabel(agent: AgentConfig): string {
	if (!agent.packageSourceName) return agent.source;
	return agent.packageSourceVersion ? `${agent.packageSourceName}@${agent.packageSourceVersion}` : agent.packageSourceName;
}

type ExternalJobProviderStatus =
	| { ok: true; names: Set<string> }
	| { ok: false; error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function registeredExternalJobProviderStatus(): ExternalJobProviderStatus {
	try {
		return { ok: true, names: new Set(listExternalJobProviders().map((provider) => provider.name)) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

function externalJobProviderSuffix(provider: string, names: Set<string> | undefined): string {
	if (!names) return "?";
	return names.has(provider) ? "✓" : "missing";
}

function runnerListBadge(agent: AgentConfig, providerNames: Set<string> | undefined): string | undefined {
	if (agent.runner?.type === "external-job") return `external-job:${agent.runner.provider} ${externalJobProviderSuffix(agent.runner.provider, providerNames)}`;
	if (agent.runner?.type === "external-cli") return "external-cli";
	return undefined;
}

function formatAgentListLine(agent: AgentConfig, providerNames: Set<string> | undefined): string {
	const source = agent.source === "package" ? packageSourceLabel(agent) : agent.source;
	const parts = [
		source,
		runnerListBadge(agent, providerNames),
		agent.defaultContext ? `context: ${agent.defaultContext}` : undefined,
		agent.aliases?.length ? `aliases: ${agent.aliases.join(", ")}` : undefined,
	].filter((part): part is string => Boolean(part));
	return `- ${agent.name} (${parts.join(", ")}): ${agent.description}`;
}

function formatAgentListSections(agents: AgentConfig[], providerNames: Set<string> | undefined): string[] {
	if (agents.length === 0) return ["- (none)"];
	const sections: Array<[AgentSource, string]> = [
		["package", "Package agents"],
		["user", "User agents"],
		["project", "Project agents"],
		["runtime", "Runtime agents"],
		["builtin", "Builtin agents"],
	];
	const lines: string[] = [];
	for (const [source, label] of sections) {
		const matches = agents.filter((agent) => agent.source === source);
		if (matches.length === 0) continue;
		if (lines.length > 0) lines.push("");
		lines.push(label, ...matches.map((agent) => formatAgentListLine(agent, providerNames)));
	}
	return lines;
}

function formatRunnerDetail(agent: AgentConfig, providerNames: Set<string> | undefined): string | undefined {
	if (!agent.runner) return undefined;
	if (agent.runner.type === "external-job") return `Runner: external-job via ${agent.runner.provider} ${externalJobProviderSuffix(agent.runner.provider, providerNames)}`;
	if (agent.runner.type === "external-cli") return `Runner: external-cli ${agent.runner.command}`;
	return `Runner: ${JSON.stringify(agent.runner)}`;
}

function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const providerStatus = registeredExternalJobProviderStatus();
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.source === "package" && agent.packageSourceName) {
		lines.push(`Source package: ${packageSourceLabel(agent)}`);
		if (agent.packageSourceRoot) lines.push(`Package root: ${agent.packageSourceRoot}`);
	}
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	if (agent.aliases?.length) lines.push(`Aliases: ${agent.aliases.join(", ")}`);
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	if (agent.skillPath?.length) lines.push(`Skill paths: ${agent.skillPath.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	const runnerDetail = formatRunnerDetail(agent, providerStatus.ok ? providerStatus.names : undefined);
	if (runnerDetail) {
		lines.push(runnerDetail);
		if (agent.runner?.type === "external-job" && !providerStatus.ok) lines.push(`External-job provider registry unavailable: ${providerStatus.error}`);
		if (agent.runner?.type === "external-job" && agent.runner.options) lines.push(`Runner options: ${JSON.stringify(agent.runner.options)}`);
	}
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.defaultAsync !== undefined) lines.push(`Async: ${agent.defaultAsync ? "true" : "false"}`);
	if (agent.defaultTimeoutMs !== undefined) lines.push(`Timeout: ${agent.defaultTimeoutMs}ms`);
	if (agent.defaultTurnBudget) lines.push(`Turn budget: ${JSON.stringify(agent.defaultTurnBudget)}`);
	if (agent.defaultAcceptance !== undefined) lines.push(`Acceptance: ${typeof agent.defaultAcceptance === "object" ? JSON.stringify(agent.defaultAcceptance) : String(agent.defaultAcceptance)}`);
	if (agent.acceptanceRole) lines.push(`Acceptance role: ${agent.acceptanceRole}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.subagentOnlyExtensions !== undefined) lines.push(`Subagent-only extensions: ${agent.subagentOnlyExtensions.length ? agent.subagentOnlyExtensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.outputMode) lines.push(`Output mode: ${agent.outputMode}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.completionGuard === false) lines.push("Completion guard: false");
	if (agent.toolBudget) lines.push(`Tool budget: ${JSON.stringify(agent.toolBudget)}`);
	if (agent.memory) lines.push(`Memory: ${agent.memory.scope} scope, path: ${agent.memory.path}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	let scopedAgents = mergeAgentsForScope(scope, d.user, d.project, d.builtin, d.package);
	if (ctx.runtimeAgentOwner && listRuntimeAgentConfigs(ctx.runtimeAgentOwner).length > 0) {
		const configuredAgents: AgentConfig[] = [
			...d.builtin,
			...d.package,
			...d.user,
			...d.project,
		];
		scopedAgents = mergeRuntimeAgents(ctx.runtimeAgentOwner, { agents: scopedAgents }, configuredAgents).agents;
	}
	scopedAgents = scopedAgents
		.sort((a, b) => a.name.localeCompare(b.name));
	const capabilityCeiling = resolveCurrentSubagentCapabilityCeiling(ctx.currentSessionId);
	const visibleAgents = scopedAgents.filter((a) => !a.disabled);
	const agents = visibleAgents.filter((a) => isAgentAllowedByCapabilityCeiling(a.name, capabilityCeiling));
	const restrictedAgents = visibleAgents.filter((a) => !isAgentAllowedByCapabilityCeiling(a.name, capabilityCeiling));
	const restrictedSources = capabilityCeilingAgentRestrictionSources(capabilityCeiling);
	const proactiveSuggestions = buildProactiveSkillSubagentRecommendationLines({
		agents,
		...(ctx.config?.proactiveSkillSubagents !== undefined ? { config: ctx.config.proactiveSkillSubagents } : {}),
		discoverAvailableSkills: () => discoverAvailableSkills(ctx.cwd),
	});
	const providerStatus = registeredExternalJobProviderStatus();
	const lines = [
		"Executable agents:",
		...formatAgentListSections(agents, providerStatus.ok ? providerStatus.names : undefined),
		...(restrictedAgents.length ? [
			"",
			`Restricted agents (not executable in this session${restrictedSources?.length ? `; capability ceiling: ${restrictedSources.join(", ")}` : ""}):`,
			...restrictedAgents.map((a) => formatAgentListLine(a, providerStatus.ok ? providerStatus.names : undefined)),
		] : []),
		...(!providerStatus.ok && [...agents, ...restrictedAgents].some((agent) => agent.runner?.type === "external-job") ? ["", `External-job provider registry unavailable: ${providerStatus.error}`] : []),
		...(d.agentDiagnostics?.length ? [
			"",
			"Invalid agent definitions:",
			...d.agentDiagnostics.map((diagnostic) => `- ${diagnostic.name ?? diagnostic.filePath} (${diagnostic.source}): ${diagnostic.error}`),
		] : []),
		...(proactiveSuggestions.length ? ["", ...proactiveSuggestions] : []),
	];
	return result(lines.join("\n"));
}

function formatModelSource(agent: AgentConfig, currentModel: ParentModel | undefined): string {
	if (agent.override && agent.model !== agent.override.base.model) {
		return `${agent.override.scope} override`;
	}
	if (agent.modelSource?.type === "subagents.defaultModel" && agent.model === agent.modelSource.model) {
		return `${agent.modelSource.scope} defaultModel`;
	}
	if (agent.model) return "builtin agent config";
	if (currentModel) return "inherits current session model";
	return "inherit requested, but no current session model is available";
}

function handleModels(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const requestedAgent = params.agent?.trim();
	if (requestedAgent && !(BUILTIN_AGENT_NAMES as readonly string[]).includes(requestedAgent)) {
		return result(`Builtin agent '${requestedAgent}' not found. Available: ${BUILTIN_AGENT_NAMES.join(", ")}.`, true);
	}

	const discovered = discoverAgentsAll(ctx.cwd);
	const builtinByName = new Map(discovered.builtin.map((agent) => [agent.name, agent]));
	const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	const preferredProvider = ctx.model?.provider;
	const names = requestedAgent ? [requestedAgent] : [...BUILTIN_AGENT_NAMES];

	if (requestedAgent) {
		const agent = builtinByName.get(requestedAgent);
		if (!agent) return result(`Builtin agent '${requestedAgent}' not found.`, true);
		const resolvedModel = resolveSubagentModelOverride(agent.model, currentModel, availableModels, preferredProvider);
		const lines = [
			"Builtin subagent model",
			"",
			`Agent: ${requestedAgent}`,
			"Effective model:",
			`  ${resolvedModel ?? "(unresolved)"}`,
			`Source: ${formatModelSource(agent, currentModel)}`,
		];
		if (agent.override) {
			lines.push("Override file:");
			lines.push(`  ${agent.override.path}`);
		}
		if (agent.model && resolvedModel && agent.model !== resolvedModel) {
			lines.push("Requested model setting:");
			lines.push(`  ${agent.model}`);
		}
		if (agent.disabled) lines.push("Disabled: true");
		lines.push("Current session model:");
		lines.push(`  ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "(unavailable)"}`);
		return result(lines.join("\n"));
	}

	const lines = [
		"Builtin subagent models",
		"",
		"Current session model:",
		`  ${currentModel ? `${currentModel.provider}/${currentModel.id}` : "(unavailable)"}`,
		"",
	];

	for (const name of names) {
		const agent = builtinByName.get(name);
		if (!agent) {
			lines.push(name);
			lines.push("  model:");
			lines.push("    (builtin definition not found)");
			lines.push("  source: missing");
			lines.push("");
			continue;
		}
		const resolvedModel = resolveSubagentModelOverride(agent.model, currentModel, availableModels, preferredProvider);
		const source = `${formatModelSource(agent, currentModel)}${agent.disabled ? "; disabled" : ""}`;
		lines.push(name);
		lines.push("  model:");
		lines.push(`    ${resolvedModel ?? "(unresolved)"}`);
		lines.push(`  source: ${source}`);
		lines.push("");
	}

	const availableFullIds = availableModels.map((m) => m.fullId).sort();
	if (availableFullIds.length > 0) {
		lines.push("Available models in this session's registry (copy an exact provider/id when passing model):");
		lines.push("");
		const shown = availableFullIds.slice(0, 80);
		for (const fullId of shown) lines.push(`  ${fullId}`);
		if (availableFullIds.length > shown.length) lines.push(`  ... and ${availableFullIds.length - shown.length} more`);
		lines.push("");
		lines.push("Use an exact provider/id from this list when you pass model; bare ids resolve only when unique in the registry.");
	}

	return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for get.", true);
	const scope = normalizeListScope(params.agentScope);
	if (!scope) return result("agentScope must be 'user', 'project', or 'both' for get.", true);
	const discovered = discoverAgentsAll(ctx.cwd);
	const matches = findAgentsInDiscovery(params.agent, discovered, scope);
	const diagnostics = diagnosticsForScope(discovered.agentDiagnostics, scope);
	const rawName = params.agent.trim();
	const normalizedName = sanitizeName(rawName);
	const diagnostic = findBlockingAgentDiagnostic(rawName, matches, diagnostics)
		?? (normalizedName !== rawName ? findBlockingAgentDiagnostic(normalizedName, matches, diagnostics) : undefined);
	if (diagnostic) return result(`Agent '${params.agent}' has invalid configuration: ${diagnostic.error}`, true);
	const distinctNames = [...new Set(matches.map((agent) => agent.name))];
	if (distinctNames.length > 1) return result(`Ambiguous agent alias or name '${params.agent}': ${distinctNames.sort((a, b) => a.localeCompare(b)).join(", ")}`, true);
	if (!matches.length) {
		return result(`Agent '${params.agent}' not found. Available: ${availableAgentNamesFromDiscovery(discovered).join(", ") || "none"}.`, true);
	}
	return result(matches.map(formatAgentDetail).join("\n\n"));
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.status === "error") return result(parsedConfig.message, true);
	if (parsedConfig.status === "missing") return result("config required for create.", true);
	const cfg = parsedConfig.value;
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name) return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const parsedPackage = parsePackageConfig(cfg.package);
	if (parsedPackage.error) return result(parsedPackage.error, true);
	const runtimeName = buildRuntimeName(name, parsedPackage.packageName);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	if (hasKey(cfg, "steps")) return result("Durable chain definitions were removed; use workflowScript or /prompt-workflow for repeatable workflows.", true);
	const d = discoverAgentsAll(ctx.cwd);
	const projectConfigDir = getProjectConfigDir(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : d.projectDir ?? path.join(projectConfigDir, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (d.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	const agent: AgentConfig = {
		name: runtimeName,
		localName: name,
		...(parsedPackage.packageName !== undefined ? { packageName: parsedPackage.packageName } : {}),
		description: cfg.description.trim(),
		source: scope,
		filePath: targetPath,
		systemPrompt: "",
		systemPromptMode: defaultSystemPromptMode(name),
		inheritProjectContext: defaultInheritProjectContext(name),
		inheritSkills: defaultInheritSkills(),
	};
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return result(applyError, true);
	const profileError = validateCodeOwnedProfileRunner(agent);
	if (profileError) return result(profileError, true);
	const mw = modelWarning(ctx, agent.model);
	if (mw) warnings.push(mw);
	const fmw = fallbackModelsWarning(ctx, agent.fallbackModels);
	if (fmw) warnings.push(fmw);
	const sw = skillsWarning(ctx.cwd, agent);
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for update.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.status === "error") return result(parsedConfig.message, true);
	if (parsedConfig.status === "missing") return result("config required for update.", true);
	const cfg = parsedConfig.value;
	if (hasKey(cfg, "steps")) return result("Durable chain definitions were removed; use workflowScript or /prompt-workflow for repeatable workflows.", true);
	const warnings: string[] = [];
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, scopeHint);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	if (target.source !== "user" && target.source !== "project") return result(`Cannot update ${target.source} agent '${target.name}'. Eject it to user or project scope first.`, true);
	let updated: AgentConfig;
	try {
		updated = editableAgentConfig(target);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Could not reread agent definition ${target.filePath} before updating '${target.name}': ${message}`, true);
	}
	const oldName = target.name;
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
	let newLocalName = target.localName ?? frontmatterNameForConfig(target);
	if (hasKey(cfg, "name")) {
		newLocalName = sanitizeName(cfg.name as string);
		if (!newLocalName) return result("config.name is invalid after sanitization.", true);
	}
	let newPackageName = target.packageName;
	if (hasKey(cfg, "package")) {
		const parsedPackage = parsePackageConfig(cfg.package);
		if (parsedPackage.error) return result(parsedPackage.error, true);
		newPackageName = parsedPackage.packageName;
	}
	const applyError = applyAgentConfig(updated, cfg);
	if (applyError) return result(applyError, true);
	const preserveFrontmatterFields = preservedAgentFrontmatterFields(target, cfg);
	updated.localName = newLocalName;
	if (newPackageName !== undefined) updated.packageName = newPackageName;
	else delete updated.packageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	const profileError = validateCodeOwnedProfileRunner(updated);
	if (profileError) return result(profileError, true);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (hasKey(cfg, "model")) {
		const mw = modelWarning(ctx, updated.model);
		if (mw) warnings.push(mw);
	}
	if (hasKey(cfg, "fallbackModels")) {
		const fmw = fallbackModelsWarning(ctx, updated.fallbackModels);
		if (fmw) warnings.push(fmw);
	}
	if (hasKey(cfg, "skills") || hasKey(cfg, "skillPath")) {
		const sw = skillsWarning(ctx.cwd, updated);
		if (sw) warnings.push(sw);
	}
	if (updated.name !== oldName) {
		const renamed = renamePath(target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, serializeAgent(updated, { preserveFrontmatterFields }), "utf-8");
	const headline = updated.name === oldName
		? `Updated agent '${updated.name}' at ${updated.filePath}.`
		: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for delete.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget(params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, scopeHint);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	fs.unlinkSync(target.filePath);
	return result(`Deleted agent '${target.name}' at ${target.filePath}.`);
}

function handleEject(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for eject.", true);
	const raw = params.agent.trim();
	const sanitized = sanitizeName(raw);
	const parsedScope = actionScope(params.agentScope, "eject");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	const source = [...d.package, ...d.builtin].find((a) => a.name === raw || a.name === sanitized);
	if (!source) {
		return result(`Agent '${raw}' not found or is not a bundled/package agent. eject copies a builtin or package agent to ${scope} scope so it can be customized. Available: ${availableAgentNames(ctx.cwd).join(", ") || "none"}.`, true);
	}
	const runtimeName = source.name;
	const existingCustom = (scope === "user" ? d.user : d.project).find((a) => a.name === runtimeName);
	if (existingCustom) {
		return result(`Agent '${runtimeName}' is already a custom ${scope} agent at ${existingCustom.filePath}. Edit it with { action: "update", agent: "${runtimeName}" } or delete it first.`, true);
	}
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) {
		return result(`An agent named '${runtimeName}' already exists in ${scope} scope. Remove or rename it first.`, true);
	}
	const projectConfigDir = getProjectConfigDir(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : d.projectDir ?? path.join(projectConfigDir, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	const targetPath = path.join(targetDir, `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) {
		return result(`File already exists at ${targetPath} but is not a valid agent definition. Remove or rename it first.`, true);
	}
	let content: string;
	try {
		content = fs.readFileSync(source.filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Failed to read source agent at ${source.filePath}: ${message}`, true);
	}
	fs.writeFileSync(targetPath, content, "utf-8");
	return result(`Ejected agent '${runtimeName}' from ${source.source} to ${scope} scope at ${targetPath}. Edit it there to customize; it shadows the bundled ${source.source} agent of the same name.`);
}

function handleDisable(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for disable.", true);
	const raw = params.agent.trim();
	const parsedScope = actionScope(params.agentScope, "disable");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const effective = resolveEffectiveAgent(d, raw);
	if (effective.error) return result(effective.error, true);
	if (!effective.agent) {
		return result(`Agent '${raw}' not found. Available: ${availableAgentNames(ctx.cwd).join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.agent.name;
	const settingsPath = mergeBuiltinAgentOverride(ctx.cwd, runtimeName, scope, { disabled: true });
	const after = resolveEffectiveAgent(discoverAgentsAll(ctx.cwd), raw).agent;
	if (after?.disabled === true) {
		return result(`Disabled agent '${runtimeName}' via ${scope} settings override at ${settingsPath}. It is now hidden from runtime discovery and { action: "list" }.`);
	}
	return result(`Wrote a disabled override for '${runtimeName}' at ${settingsPath}, but the agent is still enabled. A higher-precedence ${after?.override?.scope ?? "project"} override is likely winning. Try agentScope: '${after?.override?.scope ?? "project"}'.`, true);
}

function handleEnable(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for enable.", true);
	const raw = params.agent.trim();
	const parsedScope = actionScope(params.agentScope, "enable");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const effective = resolveEffectiveAgent(d, raw);
	if (effective.error) return result(effective.error, true);
	if (!effective.agent) {
		return result(`Agent '${raw}' not found. Available: ${availableAgentNames(ctx.cwd).join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.agent.name;
	const { path: settingsPath, removed } = removeBuiltinAgentOverrideFields(ctx.cwd, runtimeName, scope, ["disabled"]);
	const after = resolveEffectiveAgent(discoverAgentsAll(ctx.cwd), raw).agent;
	if (after && after.disabled !== true) {
		if (removed) return result(`Enabled agent '${runtimeName}' (removed disabled override at ${settingsPath}).`);
		return result(`Agent '${runtimeName}' is already enabled.`);
	}
	if (after?.override?.scope && after.override.scope !== scope) {
		return result(`Agent '${runtimeName}' is still disabled via a ${after.override.scope} scope override at ${after.override.path}. Specify agentScope: '${after.override.scope}' to enable it.`, true);
	}
	return result(`Agent '${runtimeName}' is still disabled after removing the ${scope} disabled override. It may be hidden via subagents.disableBuiltins in ${after?.override?.scope ?? scope} settings at ${after?.override?.path ?? settingsPath}.`, true);
}

function handleReset(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent) return result("Specify 'agent' for reset.", true);
	const raw = params.agent.trim();
	const sanitized = sanitizeName(raw);
	const parsedScope = actionScope(params.agentScope, "reset");
	if (parsedScope.error) return parsedScope.error;
	const scope = parsedScope.scope!;
	const d = discoverAgentsAll(ctx.cwd);
	if (scope === "project" && d.projectSettingsPath === null) {
		return result("Project override is not available here: no project config root (.pi or .agents) was found above the cwd. Use agentScope: 'user' or run from inside a project.", true);
	}
	const bundled = [...d.package, ...d.builtin].find((a) => a.name === raw || a.name === sanitized);
	if (!bundled) {
		const custom = [...d.user, ...d.project].find((a) => a.name === raw || a.name === sanitized);
		if (custom) {
			return result(`Agent '${raw}' has no bundled default to reset to. Use { action: "delete", agent: "${custom.name}" } to remove the custom ${custom.source} agent.`, true);
		}
		return result(`Agent '${raw}' not found. Available: ${availableAgentNames(ctx.cwd).join(", ") || "none"}.`, true);
	}
	const runtimeName = bundled.name;
	const custom = (scope === "user" ? d.user : d.project).find((a) => a.name === raw || a.name === sanitized);
	const lines: string[] = [];
	if (custom) {
		fs.unlinkSync(custom.filePath);
		lines.push(`Deleted custom ${scope} agent file at ${custom.filePath}.`);
	}
	const overrideRemoval = removeBuiltinAgentOverride(ctx.cwd, runtimeName, scope);
	if (overrideRemoval.removed) lines.push(`Removed ${scope} settings override at ${overrideRemoval.path}.`);
	if (lines.length === 0) {
		const otherScope = scope === "user" ? "project" : "user";
		const otherCustom = (otherScope === "user" ? d.user : d.project).find((a) => a.name === raw || a.name === sanitized);
		const hasOtherOverride = bundled.override?.scope === otherScope;
		const note = (otherCustom || hasOtherOverride)
			? ` Customization exists in ${otherScope} scope; specify agentScope: '${otherScope}' to reset it.`
			: "";
		return result(`Agent '${runtimeName}' has no ${scope} customization to reset.${note} It is at its bundled ${bundled.source} default.`);
	}
	lines.push(`Reset agent '${runtimeName}' to its bundled ${bundled.source} default.`);
	return result(lines.join("\n"));
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "models": return handleModels(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		case "eject": return handleEject(params, ctx);
		case "disable": return handleDisable(params, ctx);
		case "enable": return handleEnable(params, ctx);
		case "reset": return handleReset(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
