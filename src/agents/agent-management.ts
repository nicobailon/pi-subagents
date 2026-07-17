import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	type ChainConfig,
	type ChainStepConfig,
	BUILTIN_AGENT_NAMES,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	buildRuntimeName,
	frontmatterNameForConfig,
	parsePackageName,
	mergeBuiltinAgentOverride,
	removeBuiltinAgentOverride,
	removeBuiltinAgentOverrideFields,
} from "./agents.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { serializeChain, serializeJsonChain } from "./chain-serializer.ts";
import { discoverAvailableSkills, resolveSkills } from "./skills.ts";
import {
	buildProactiveSkillSubagentRecommendationLines,
} from "./proactive-skills.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { resolveSubagentModelOverride, type ParentModel } from "../runs/shared/model-fallback.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { resolveTurnBudgetConfig } from "../runs/shared/turn-budget.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import type { AcceptanceInput, Details, ExtensionConfig, ToolBudgetConfig } from "../shared/types.ts";
import { getProjectConfigDir } from "../shared/utils.ts";

type ManagementAction = "list" | "get" | "models" | "create" | "update" | "delete" | "eject" | "disable" | "enable" | "reset";
type ManagementScope = "user" | "project";
type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry"> & { model?: ExtensionContext["model"]; config?: ExtensionConfig };

interface ManagementParams {
	action?: string;
	agent?: string;
	chainName?: string;
	agentScope?: string;
	config?: unknown;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `config must be valid JSON: ${message}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
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

function availableNames(cwd: string, kind: "agent" | "chain"): string[] {
	const d = discoverAgentsAll(cwd);
	const items = kind === "agent" ? allAgents(d) : d.chains;
	return [...new Set(items.map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return allAgents(d)
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

function findChains(name: string, cwd: string, scope: AgentScope = "both"): ChainConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return discoverAgentsAll(cwd).chains
		.filter((c) => (scope === "both" || c.source === "package" || c.source === scope) && (c.name === raw || c.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

const AGENT_SOURCE_PRECEDENCE: Record<AgentSource, number> = { builtin: 0, package: 1, user: 2, project: 3 };

// Returns the highest-precedence agent for a name (project > user > package > builtin,
// matching mergeAgentsForScope for "both"), including disabled agents so disable/enable/reset
// can locate agents that runtime discovery filters out.
function pickEffectiveAgent(d: ReturnType<typeof discoverAgentsAll>, name: string): AgentConfig | undefined {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	const matches = allAgents(d).filter((a) => a.name === raw || a.name === sanitized);
	if (matches.length === 0) return undefined;
	return matches.reduce((best, agent) => (AGENT_SOURCE_PRECEDENCE[agent.source] > AGENT_SOURCE_PRECEDENCE[best.source] ? agent : best));
}

function nameExistsInScope(cwd: string, scope: ManagementScope, name: string, excludePath?: string): boolean {
	const d = discoverAgentsAll(cwd);
	for (const a of scope === "user" ? d.user : d.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	for (const c of d.chains) {
		if (c.source === scope && c.name === name && c.filePath !== excludePath) return true;
	}
	return false;
}

function isMutableSource(source: AgentSource): source is ManagementScope {
	return source === "user" || source === "project";
}

function unknownChainAgents(cwd: string, steps: ChainStepConfig[]): string[] {
	const d = discoverAgentsAll(cwd);
	const known = new Set(allAgents(d).map((a) => a.name));
	return [...new Set(steps.map((s) => s.agent).filter((a) => !known.has(a)))].sort((a, b) => a.localeCompare(b));
}

function chainStepWarnings(ctx: ManagementContext, steps: ChainStepConfig[]): string[] {
	const warnings: string[] = [];
	const available = new Set(discoverAvailableSkills(ctx.cwd).map((s) => s.name));
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i]!;
		if (s.model) {
			const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === s.model || m.id === s.model);
			if (!found) warnings.push(`Warning: step ${i + 1} (${s.agent}): model '${s.model}' is not in the current model registry.`);
		}
		if (Array.isArray(s.skills) && s.skills.length > 0) {
			const missing = s.skills.filter((sk) => !available.has(sk));
			if (missing.length) warnings.push(`Warning: step ${i + 1} (${s.agent}): skills not found: ${missing.join(", ")}.`);
		}
	}
	return warnings;
}

function modelWarning(ctx: ManagementContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.modelRegistry.getAvailable().some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
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

export function editableAgentConfig(agent: AgentConfig): AgentConfig {
	const base = agent.override?.base;
	if (!base) return { ...agent };

	return {
		...agent,
		model: base.model,
		fallbackModels: base.fallbackModels ? [...base.fallbackModels] : undefined,
		thinking: base.thinking,
		systemPromptMode: base.systemPromptMode,
		inheritProjectContext: base.inheritProjectContext,
		inheritSkills: base.inheritSkills,
		defaultContext: base.defaultContext,
		acceptanceRole: base.acceptanceRole,
		disabled: base.disabled,
		systemPrompt: base.systemPrompt,
		skills: base.skills ? [...base.skills] : undefined,
		skillPath: base.skillPath ? [...base.skillPath] : undefined,
		tools: base.tools ? [...base.tools] : undefined,
		mcpDirectTools: base.mcpDirectTools ? [...base.mcpDirectTools] : undefined,
		subagentOnlyExtensions: base.subagentOnlyExtensions ? [...base.subagentOnlyExtensions] : undefined,
		completionGuard: base.completionGuard,
		override: undefined,
	};
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
	if (hasKey(cfg, "systemPrompt")) changed("systemPrompt");
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

function parseStepList(raw: unknown): { steps?: ChainStepConfig[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array." };
	if (raw.length === 0) return { error: "config.steps must include at least one step." };
	const steps: ChainStepConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.steps[${i}] must be an object.` };
		const s = item as Record<string, unknown>;
		if (typeof s.agent !== "string" || !s.agent.trim()) return { error: `config.steps[${i}].agent must be a non-empty string.` };
		const step: ChainStepConfig = { agent: s.agent.trim(), task: typeof s.task === "string" ? s.task : "" };
		if (hasKey(s, "phase")) {
			if (typeof s.phase === "string") step.phase = s.phase;
			else return { error: `config.steps[${i}].phase must be a string.` };
		}
		if (hasKey(s, "label")) {
			if (typeof s.label === "string") step.label = s.label;
			else return { error: `config.steps[${i}].label must be a string.` };
		}
		if (hasKey(s, "as")) {
			if (typeof s.as === "string") step.as = s.as;
			else return { error: `config.steps[${i}].as must be a string.` };
		}
		if (hasKey(s, "outputSchema")) {
			if (typeof s.outputSchema === "string") step.outputSchema = s.outputSchema;
			else return { error: `config.steps[${i}].outputSchema must be a schema file path string for saved chains.` };
		}
		if (hasKey(s, "output")) {
			if (s.output === false) step.output = false;
			else if (typeof s.output === "string") step.output = s.output;
			else return { error: `config.steps[${i}].output must be a string or false.` };
		}
		if (hasKey(s, "outputMode")) {
			if (s.outputMode === "inline" || s.outputMode === "file-only") step.outputMode = s.outputMode;
			else return { error: `config.steps[${i}].outputMode must be 'inline' or 'file-only'.` };
		}
		if (hasKey(s, "reads")) {
			if (s.reads === false) step.reads = false;
			else if (Array.isArray(s.reads)) step.reads = s.reads.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].reads must be an array or false.` };
		}
		if (hasKey(s, "model")) {
			if (typeof s.model === "string") step.model = s.model;
			else return { error: `config.steps[${i}].model must be a string.` };
		}
		if (hasKey(s, "skills")) {
			if (s.skills === false) step.skills = false;
			else if (Array.isArray(s.skills)) step.skills = s.skills.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].skills must be an array or false.` };
		}
		if (hasKey(s, "progress")) {
			if (typeof s.progress === "boolean") step.progress = s.progress;
			else return { error: `config.steps[${i}].progress must be a boolean.` };
		}
		if (hasKey(s, "toolBudget")) {
			const validation = validateToolBudgetConfig(s.toolBudget, `config.steps[${i}].toolBudget`);
			if (validation.error) return { error: validation.error };
			step.toolBudget = s.toolBudget as ChainStepConfig["toolBudget"];
		}
		steps.push(step);
	}
	return { steps };
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
	return { tools: tools.length ? tools : undefined, mcpDirectTools: mcpDirectTools.length ? mcpDirectTools : undefined };
}

function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") target.fallbackModels = undefined;
		else if (typeof cfg.fallbackModels === "string") {
			const models = parseCsv(cfg.fallbackModels);
			target.fallbackModels = models.length ? models : undefined;
		} else if (Array.isArray(cfg.fallbackModels)) {
			const models = cfg.fallbackModels
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
			target.fallbackModels = models.length ? [...new Set(models)] : undefined;
		} else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { target.tools = undefined; target.mcpDirectTools = undefined; }
		else if (typeof cfg.tools === "string") { const parsed = parseTools(cfg.tools); target.tools = parsed.tools; target.mcpDirectTools = parsed.mcpDirectTools; }
		else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") target.skills = undefined;
		else if (typeof cfg.skills === "string") { const skills = parseCsv(cfg.skills); target.skills = skills.length ? skills : undefined; }
		else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skillPath")) {
		if (cfg.skillPath === false || cfg.skillPath === "") target.skillPath = undefined;
		else if (typeof cfg.skillPath === "string") { const skillPath = parseCsv(cfg.skillPath); target.skillPath = skillPath.length ? skillPath : undefined; }
		else if (Array.isArray(cfg.skillPath) && cfg.skillPath.every((entry) => typeof entry === "string")) {
			const skillPath = [...new Set(cfg.skillPath.map((entry) => entry.trim()).filter(Boolean))];
			target.skillPath = skillPath.length ? skillPath : undefined;
		} else return "config.skillPath must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "subagentOnlyExtensions")) {
		if (cfg.subagentOnlyExtensions === false) target.subagentOnlyExtensions = undefined;
		else if (cfg.subagentOnlyExtensions === "") target.subagentOnlyExtensions = [];
		else if (typeof cfg.subagentOnlyExtensions === "string") target.subagentOnlyExtensions = parseCsv(cfg.subagentOnlyExtensions);
		else return "config.subagentOnlyExtensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
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
		if (cfg.defaultContext === false || cfg.defaultContext === "") target.defaultContext = undefined;
		else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork") target.defaultContext = cfg.defaultContext;
		else return "config.defaultContext must be 'fresh', 'fork', or false when provided.";
	}
	if (hasKey(cfg, "async")) {
		if (cfg.async === "") target.defaultAsync = undefined;
		else if (typeof cfg.async === "boolean") target.defaultAsync = cfg.async;
		else return "config.async must be a boolean or empty string when provided.";
	}
	if (hasKey(cfg, "timeoutMs")) {
		if (cfg.timeoutMs === false || cfg.timeoutMs === "") target.defaultTimeoutMs = undefined;
		else if (typeof cfg.timeoutMs === "number" && Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0) target.defaultTimeoutMs = cfg.timeoutMs;
		else return "config.timeoutMs must be a positive integer or false when provided.";
	}
	if (hasKey(cfg, "turnBudget")) {
		if (cfg.turnBudget === false || cfg.turnBudget === "") target.defaultTurnBudget = undefined;
		else {
			const resolved = resolveTurnBudgetConfig(cfg.turnBudget, "config.turnBudget");
			if (resolved.error) return resolved.error;
			target.defaultTurnBudget = resolved.turnBudget;
		}
	}
	if (hasKey(cfg, "acceptance")) {
		if (cfg.acceptance === "") target.defaultAcceptance = undefined;
		else {
			const errors = validateAcceptanceInput(cfg.acceptance, "config.acceptance");
			if (errors.length > 0) return errors.join(" ");
			target.defaultAcceptance = cfg.acceptance as AcceptanceInput;
		}
	}
	if (hasKey(cfg, "acceptanceRole")) {
		if (cfg.acceptanceRole === false || cfg.acceptanceRole === "") target.acceptanceRole = undefined;
		else if (cfg.acceptanceRole === "read-only" || cfg.acceptanceRole === "writer") target.acceptanceRole = cfg.acceptanceRole;
		else return "config.acceptanceRole must be 'read-only', 'writer', or false when provided.";
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") target.output = undefined;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") target.defaultReads = undefined;
		else if (typeof cfg.reads === "string") {
			const reads = parseCsv(cfg.reads);
			target.defaultReads = reads.length ? reads : undefined;
		} else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") target.maxSubagentDepth = undefined;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) {
			target.maxSubagentDepth = cfg.maxSubagentDepth;
		} else return "config.maxSubagentDepth must be an integer >= 0 or false when provided.";
	}
	if (hasKey(cfg, "completionGuard")) {
		if (typeof cfg.completionGuard !== "boolean") return "config.completionGuard must be a boolean when provided.";
		target.completionGuard = cfg.completionGuard;
	}
	if (hasKey(cfg, "toolBudget")) {
		if (cfg.toolBudget === false || cfg.toolBudget === "") target.toolBudget = undefined;
		else {
			const validation = validateToolBudgetConfig(cfg.toolBudget, "config.toolBudget");
			if (validation.error) return validation.error;
			target.toolBudget = cfg.toolBudget as ToolBudgetConfig;
		}
	}
	return undefined;
}

function resolveTarget<T extends { source: AgentSource; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): T | AgentToolResult<Details> {
	const mutable = matches.filter((m): m is T & { source: ManagementScope } => isMutableSource(m.source));
	if (mutable.length === 0) {
		if (matches.length > 0) {
			return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' is read-only and cannot be modified. Create a same-named ${kind} in user or project scope to override it.`, true);
		}
		const available = availableNames(cwd, kind);
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${available.join(", ") || "none"}.`, true);
	}
	if (mutable.length === 1) return mutable[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found in scope '${scope}'.`, true);
	if (scoped.length > 1) return result(`Multiple ${kind}s named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}`, true);
	return scoped[0]!;
}

function renamePath(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	cwd: string,
): { filePath?: string; error?: string } {
	if (nameExistsInScope(cwd, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const ext = kind === "agent" ? ".md" : currentPath.endsWith(".chain.json") ? ".chain.json" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	if (agent.skillPath?.length) lines.push(`Skill paths: ${agent.skillPath.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
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
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.completionGuard === false) lines.push("Completion guard: false");
	if (agent.toolBudget) lines.push(`Tool budget: ${JSON.stringify(agent.toolBudget)}`);
	if (agent.memory) lines.push(`Memory: ${agent.memory.scope} scope, path: ${agent.memory.path}`);
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

function formatChainStepDetail(step: ChainStepConfig, index: number): string[] {
	const lines: string[] = [];
	if (step.expand || step.collect) {
		const parallel = step.parallel && !Array.isArray(step.parallel) && typeof step.parallel === "object" ? step.parallel as { agent?: unknown; task?: unknown; label?: unknown; outputSchema?: unknown } : undefined;
		const expand = step.expand && typeof step.expand === "object" ? step.expand as { from?: { output?: unknown; path?: unknown }; item?: unknown; key?: unknown; maxItems?: unknown; onEmpty?: unknown } : undefined;
		const collect = step.collect && typeof step.collect === "object" ? step.collect as { as?: unknown; outputSchema?: unknown } : undefined;
		lines.push(`${index + 1}. Dynamic fanout${typeof collect?.as === "string" ? ` -> ${collect.as}` : ""}`);
		if (expand?.from) lines.push(`   Expand: ${String(expand.from.output ?? "?")}${String(expand.from.path ?? "")}`);
		if (typeof expand?.item === "string") lines.push(`   Item variable: ${expand.item}`);
		if (typeof expand?.key === "string") lines.push(`   Key: ${expand.key}`);
		if (typeof expand?.maxItems === "number") lines.push(`   Max items: ${expand.maxItems}`);
		if (typeof expand?.onEmpty === "string") lines.push(`   On empty: ${expand.onEmpty}`);
		if (parallel?.agent) lines.push(`   Agent: ${String(parallel.agent)}`);
		if (typeof parallel?.label === "string") lines.push(`   Label: ${parallel.label}`);
		if (typeof parallel?.task === "string" && parallel.task.trim()) lines.push(`   Task: ${parallel.task}`);
		if (parallel?.outputSchema) lines.push("   Structured output: true");
		if (parallel && "toolBudget" in parallel) lines.push(`   Tool budget: ${JSON.stringify((parallel as { toolBudget?: unknown }).toolBudget)}`);
		if (collect?.outputSchema) lines.push("   Collect schema: true");
		if (step.concurrency !== undefined) lines.push(`   Concurrency: ${step.concurrency}`);
		if (step.failFast !== undefined) lines.push(`   Fail fast: ${step.failFast ? "true" : "false"}`);
		return lines;
	}
	lines.push(`${index + 1}. ${step.agent}`);
	if (step.task?.trim()) lines.push(`   Task: ${step.task}`);
	if (step.output === false) lines.push("   Output: false");
	else if (step.output) lines.push(`   Output: ${step.output}`);
	if (step.outputMode) lines.push(`   Output mode: ${step.outputMode}`);
	if (step.toolBudget) lines.push(`   Tool budget: ${JSON.stringify(step.toolBudget)}`);
	if (step.reads === false) lines.push("   Reads: false");
	else if (Array.isArray(step.reads) && step.reads.length > 0) lines.push(`   Reads: ${step.reads.join(", ")}`);
	if (step.model) lines.push(`   Model: ${step.model}`);
	if (step.skills === false) lines.push("   Skills: false");
	else if (Array.isArray(step.skills) && step.skills.length > 0) lines.push(`   Skills: ${step.skills.join(", ")}`);
	if (step.progress !== undefined) lines.push(`   Progress: ${step.progress ? "true" : "false"}`);
	return lines;
}

function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [`Chain: ${chain.name} (${chain.source})`, `Path: ${chain.filePath}`, `Description: ${chain.description}`];
	if (chain.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(chain)}`);
		lines.push(`Package: ${chain.packageName}`);
	}
	lines.push("", "Steps:");
	for (let i = 0; i < chain.steps.length; i++) {
		lines.push(...formatChainStepDetail(chain.steps[i]!, i));
	}
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const scopedAgents = mergeAgentsForScope(scope, d.user, d.project, d.builtin, d.package)
		.sort((a, b) => a.name.localeCompare(b.name));
	const agents = scopedAgents.filter((a) => !a.disabled);
	const chains = d.chains.filter((c) => scope === "both" || c.source === "package" || c.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const diagnostics = d.chainDiagnostics.filter((entry) => scope === "both" || entry.source === scope);
	const proactiveSuggestions = buildProactiveSkillSubagentRecommendationLines({
		agents,
		chains,
		config: ctx.config?.proactiveSkillSubagents,
		discoverAvailableSkills: () => discoverAvailableSkills(ctx.cwd),
	});
	const lines = [
		"Executable agents:",
		...(agents.length
			? agents.map((a) => `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`)
			: ["- (none)"]),
		"",
		"Chains:",
		...(chains.length ? chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"]),
		...(proactiveSuggestions.length ? ["", ...proactiveSuggestions] : []),
		...(diagnostics.length ? ["", "Chain diagnostics:", ...diagnostics.map((entry) => `- ${entry.filePath}: ${entry.error}`)] : []),
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

	return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for get.", true);
	const scope = normalizeListScope(params.agentScope);
	if (!scope) return result("agentScope must be 'user', 'project', or 'both' for get.", true);
	const hasBoth = Boolean(params.agent && params.chainName);
	const blocks: string[] = [];
	let anyFound = false;
	if (params.agent) {
		const raw = params.agent.trim();
		const sanitized = sanitizeName(raw);
		const d = discoverAgentsAll(ctx.cwd);
		const matches = mergeAgentsForScope(scope, d.user, d.project, d.builtin, d.package)
			.filter((agent) => agent.name === raw || agent.name === sanitized);
		if (!matches.length) {
			const msg = `Agent '${params.agent}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatAgentDetail));
		}
	}
	if (params.chainName) {
		const matches = findChains(params.chainName, ctx.cwd, scope);
		if (!matches.length) {
			const msg = `Chain '${params.chainName}' not found. Available: ${availableNames(ctx.cwd, "chain").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatChainDetail));
		}
	}
	return result(blocks.join("\n\n"), !anyFound);
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
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
	const isChain = hasKey(cfg, "steps");
	const d = discoverAgentsAll(ctx.cwd);
	const projectConfigDir = getProjectConfigDir(ctx.cwd);
	const targetDir = isChain
		? scope === "user" ? d.userChainDir : d.projectChainDir ?? path.join(projectConfigDir, "chains")
		: scope === "user" ? d.userDir : d.projectDir ?? path.join(projectConfigDir, "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, isChain ? `${runtimeName}.chain.md` : `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (!isChain && d.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		const chain: ChainConfig = { name: runtimeName, localName: name, packageName: parsedPackage.packageName, description: cfg.description.trim(), source: scope, filePath: targetPath, steps: parsed.steps! };
		fs.writeFileSync(targetPath, serializeChain(chain), "utf-8");
		const missing = unknownChainAgents(ctx.cwd, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, chain.steps));
		return result([`Created chain '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
	}
	const agent: AgentConfig = {
		name: runtimeName,
		localName: name,
		packageName: parsedPackage.packageName,
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
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for update.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		const updated = editableAgentConfig(target);
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
		updated.packageName = newPackageName;
		updated.name = buildRuntimeName(newLocalName, newPackageName);
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
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, ctx.cwd);
			if (renamed.error) return result(renamed.error, true);
			updated.filePath = renamed.filePath!;
		}
		fs.writeFileSync(updated.filePath, serializeAgent(updated, { preserveFrontmatterFields }), "utf-8");
		if (updated.name !== oldName) {
			const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === oldName)).map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		const headline = updated.name === oldName
			? `Updated agent '${updated.name}' at ${updated.filePath}.`
			: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
		return result([headline, ...warnings].join("\n"));
	}
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	const updated: ChainConfig = { ...target, steps: [...target.steps] };
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
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		parsedSteps = parsed.steps!;
	}
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(ctx.cwd, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, updated.steps));
	}
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, updated.filePath.endsWith(".chain.json") ? serializeJsonChain(updated) : serializeChain(updated), "utf-8");
	const headline = updated.name === oldName
		? `Updated chain '${updated.name}' at ${updated.filePath}.`
		: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for delete.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const scopeHint = asDisambiguationScope(params.agentScope);
	if (params.agent) {
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		fs.unlinkSync(target.filePath);
		const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === target.name)).map((c) => `${c.name} (${c.source})`);
		const lines = [`Deleted agent '${target.name}' at ${target.filePath}.`];
		if (refs.length) lines.push(`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`);
		return result(lines.join("\n"));
	}
	const targetOrError = resolveTarget("chain", params.chainName!, findChains(params.chainName!, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
	if ("content" in targetOrError) return targetOrError;
	const target = targetOrError;
	fs.unlinkSync(target.filePath);
	return result(`Deleted chain '${target.name}' at ${target.filePath}.`);
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
		return result(`Agent '${raw}' not found or is not a bundled/package agent. eject copies a builtin or package agent to ${scope} scope so it can be customized. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = source.name;
	const existingCustom = (scope === "user" ? d.user : d.project).find((a) => a.name === runtimeName);
	if (existingCustom) {
		return result(`Agent '${runtimeName}' is already a custom ${scope} agent at ${existingCustom.filePath}. Edit it with { action: "update", agent: "${runtimeName}" } or delete it first.`, true);
	}
	if (nameExistsInScope(ctx.cwd, scope, runtimeName)) {
		return result(`An agent or chain named '${runtimeName}' already exists in ${scope} scope. Remove or rename it first.`, true);
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
	const effective = pickEffectiveAgent(d, raw);
	if (!effective) {
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.name;
	const settingsPath = mergeBuiltinAgentOverride(ctx.cwd, runtimeName, scope, { disabled: true });
	const after = pickEffectiveAgent(discoverAgentsAll(ctx.cwd), raw);
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
	const effective = pickEffectiveAgent(d, raw);
	if (!effective) {
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
	}
	const runtimeName = effective.name;
	const { path: settingsPath, removed } = removeBuiltinAgentOverrideFields(ctx.cwd, runtimeName, scope, ["disabled"]);
	const after = pickEffectiveAgent(discoverAgentsAll(ctx.cwd), raw);
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
		return result(`Agent '${raw}' not found. Available: ${availableNames(ctx.cwd, "agent").join(", ") || "none"}.`, true);
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
