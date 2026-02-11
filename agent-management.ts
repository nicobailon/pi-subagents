import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type ChainConfig,
	type ChainStepConfig,
	discoverAgentsAll,
} from "./agents.js";
import { serializeAgent } from "./agent-serializer.js";
import { serializeChain } from "./chain-serializer.js";
import { discoverAvailableSkills } from "./skills.js";
import type { Details } from "./types.js";

type ManagementAction = "list" | "get" | "create" | "update" | "delete";
type ManagementScope = "user" | "project";
type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry">;

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

function configObject(config: unknown): Record<string, unknown> | undefined {
	let val = config;
	if (typeof val === "string") {
		try { val = JSON.parse(val); } catch { return undefined; }
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
	return val as Record<string, unknown>;
}

function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function availableNames(cwd: string, kind: "agent" | "chain"): string[] {
	const d = discoverAgentsAll(cwd);
	const items = kind === "agent" ? [...d.user, ...d.project] : d.chains;
	return [...new Set(items.map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

export function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	const d = discoverAgentsAll(cwd);
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return [...d.user, ...d.project]
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function findChains(name: string, cwd: string, scope: AgentScope = "both"): ChainConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return discoverAgentsAll(cwd).chains
		.filter((c) => (scope === "both" || c.source === scope) && (c.name === raw || c.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
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

function unknownChainAgents(cwd: string, steps: ChainStepConfig[]): string[] {
	const d = discoverAgentsAll(cwd);
	const known = new Set([...d.user, ...d.project].map((a) => a.name));
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

function skillsWarning(cwd: string, skills: string[] | undefined): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const available = new Set(discoverAvailableSkills(cwd).map((s) => s.name));
	const missing = skills.filter((s) => !available.has(s));
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
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
		if (hasKey(s, "output")) {
			if (s.output === false) step.output = false;
			else if (typeof s.output === "string") step.output = s.output;
			else return { error: `config.steps[${i}].output must be a string or false.` };
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
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") { target.extensions = parseCsv(cfg.extensions); }
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
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
	return undefined;
}

function resolveTarget<T extends { source: "user" | "project"; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	cwd: string,
	scopeHint?: string,
): T | AgentToolResult<Details> {
	if (matches.length === 0) {
		const available = availableNames(cwd, kind);
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${available.join(", ") || "none"}.`, true);
	}
	if (matches.length === 1) return matches[0]!;
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = matches.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return result(`${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}`, true);
	}
	const scoped = matches.filter((m) => m.source === scope);
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
	const ext = kind === "agent" ? ".md" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

export function formatAgentDetail(agent: AgentConfig): string {
	const tools = [...(agent.tools ?? []), ...(agent.mcpDirectTools ?? []).map((t) => `mcp:${t}`)];
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (tools.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

export function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [`Chain: ${chain.name} (${chain.source})`, `Path: ${chain.filePath}`, `Description: ${chain.description}`, "", "Steps:"];
	for (let i = 0; i < chain.steps.length; i++) {
		const s = chain.steps[i]!;
		lines.push(`${i + 1}. ${s.agent}`);
		if (s.task.trim()) lines.push(`   Task: ${s.task}`);
		if (s.output === false) lines.push("   Output: false");
		else if (s.output) lines.push(`   Output: ${s.output}`);
		if (s.reads === false) lines.push("   Reads: false");
		else if (Array.isArray(s.reads) && s.reads.length > 0) lines.push(`   Reads: ${s.reads.join(", ")}`);
		if (s.model) lines.push(`   Model: ${s.model}`);
		if (s.skills === false) lines.push("   Skills: false");
		else if (Array.isArray(s.skills) && s.skills.length > 0) lines.push(`   Skills: ${s.skills.join(", ")}`);
		if (s.progress !== undefined) lines.push(`   Progress: ${s.progress ? "true" : "false"}`);
	}
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const agents = [...d.user, ...d.project].filter((a) => scope === "both" || a.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const chains = d.chains.filter((c) => scope === "both" || c.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const lines = ["Agents:", ...(agents.length ? agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`) : ["- (none)"]), "", "Chains:", ...(chains.length ? chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"])];
	return result(lines.join("\n"));
}

export function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for get.", true);
	const hasBoth = Boolean(params.agent && params.chainName);
	const blocks: string[] = [];
	let anyFound = false;
	if (params.agent) {
		const matches = findAgents(params.agent, ctx.cwd, "both");
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
		const matches = findChains(params.chainName, ctx.cwd, "both");
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
	const cfg = configObject(params.config);
	if (!cfg) return result("config required for create.", true);
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return result("config.name is required and must be a non-empty string.", true);
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return result("config.description is required and must be a non-empty string.", true);
	const name = sanitizeName(cfg.name);
	if (!name) return result("config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens.", true);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return result("config.scope must be 'user' or 'project'.", true);
	const scope = scopeRaw as ManagementScope;
	const isChain = hasKey(cfg, "steps");
	const d = discoverAgentsAll(ctx.cwd);
	const targetDir = scope === "user" ? d.userDir : d.projectDir ?? path.join(ctx.cwd, ".pi", "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInScope(ctx.cwd, scope, name)) return result(`Name '${name}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, isChain ? `${name}.chain.md` : `${name}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		const chain: ChainConfig = { name, description: cfg.description.trim(), source: scope, filePath: targetPath, steps: parsed.steps! };
		fs.writeFileSync(targetPath, serializeChain(chain), "utf-8");
		const missing = unknownChainAgents(ctx.cwd, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, chain.steps));
		return result([`Created chain '${name}' at ${targetPath}.`, ...warnings].join("\n"));
	}
	const agent: AgentConfig = { name, description: cfg.description.trim(), source: scope, filePath: targetPath, systemPrompt: "" };
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return result(applyError, true);
	const mw = modelWarning(ctx, agent.model);
	if (mw) warnings.push(mw);
	const sw = skillsWarning(ctx.cwd, agent.skills);
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${name}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for update.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const cfg = configObject(params.config);
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetOrError = resolveTarget("agent", params.agent, findAgents(params.agent, ctx.cwd, scopeHint ?? "both"), ctx.cwd, params.agentScope);
		if ("content" in targetOrError) return targetOrError;
		const target = targetOrError;
		const updated: AgentConfig = { ...target };
		const oldName = target.name;
		// Validate all fields before any filesystem mutation
		if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
		if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
		let newName: string | undefined;
		if (hasKey(cfg, "name")) {
			newName = sanitizeName(cfg.name as string);
			if (!newName) return result("config.name is invalid after sanitization.", true);
		}
		const applyError = applyAgentConfig(updated, cfg);
		if (applyError) return result(applyError, true);
		// Apply name/description (validated above)
		if (newName !== undefined) updated.name = newName;
		if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
		if (hasKey(cfg, "model")) {
			const mw = modelWarning(ctx, updated.model);
			if (mw) warnings.push(mw);
		}
		if (hasKey(cfg, "skills")) {
			const sw = skillsWarning(ctx.cwd, updated.skills);
			if (sw) warnings.push(sw);
		}
		// Filesystem mutations last
		if (updated.name !== oldName) {
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, ctx.cwd);
			if (renamed.error) return result(renamed.error, true);
			updated.filePath = renamed.filePath!;
		}
		fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
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
	// Validate all fields before any filesystem mutation
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) return result("config.name must be a non-empty string when provided.", true);
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) return result("config.description must be a non-empty string when provided.", true);
	let newName: string | undefined;
	if (hasKey(cfg, "name")) {
		newName = sanitizeName(cfg.name as string);
		if (!newName) return result("config.name is invalid after sanitization.", true);
	}
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		parsedSteps = parsed.steps!;
	}
	// Apply validated changes to in-memory object
	if (newName !== undefined) updated.name = newName;
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(ctx.cwd, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(ctx, updated.steps));
	}
	// Filesystem mutations last
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, target.source, ctx.cwd);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, serializeChain(updated), "utf-8");
	const headline = updated.name === oldName
		? `Updated chain '${updated.name}' at ${updated.filePath}.`
		: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

export function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
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

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
