import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AcceptanceInput, AcceptanceRole, AgentRunnerConfig, OutputMode, ToolBudgetConfig } from "../shared/types.ts";
import { CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL, isCodeOwnedExternalCliAdapterId, parseExternalCliCapabilityNarrowing, validateCodeOwnedProfileRunner } from "../runs/shared/external-cli-contract.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import { validatePermissionRules, type PermissionRules } from "../runs/shared/permissions.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { BUILTIN_AGENT_NAMES } from "./builtin-names.ts";
import type { AgentConfig, AgentDefaultContext, AgentDiscoveryDiagnostic } from "./agents.ts";

export const RUNTIME_AGENT_REGISTRY_KEY = "pi-subagents.runtime-agents.v1";

const MAX_RUNTIME_AGENTS_PER_PI = 200;
const MAX_AGENT_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_SYSTEM_PROMPT_LENGTH = 1024 * 1024;
const MAX_FIELD_STRING_LENGTH = 8_192;

export interface RuntimeAgentDefinition {
	description: string;
	systemPrompt: string;
	aliases?: readonly string[];
	tools?: readonly string[];
	excludeTools?: readonly string[];
	allowNestedSubagents?: boolean;
	mcpDirectTools?: readonly string[];
	model?: string;
	fallbackModels?: readonly string[];
	thinking?: string | false;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext?: boolean;
	inheritGlobalContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext;
	defaultAsync?: boolean;
	defaultTimeoutMs?: number;
	defaultToolTimeoutMs?: number;
	defaultAcceptance?: AcceptanceInput;
	acceptanceRole?: AcceptanceRole;
	runner?: AgentRunnerConfig;
	skills?: readonly string[];
	skillPath?: readonly string[];
	extensions?: readonly string[];
	subagentOnlyExtensions?: readonly string[];
	mutationTools?: readonly string[];
	output?: string;
	outputMode?: OutputMode;
	defaultReads?: readonly string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	toolBudget?: ToolBudgetConfig;
	permissions?: PermissionRules;
}

export interface RegisterRuntimeAgentInput {
	pi: ExtensionAPI;
	name: string;
	definition: RuntimeAgentDefinition;
}

export interface RuntimeAgentRegistration {
	dispose(): void;
}

interface RuntimeAgentRecord {
	pi: ExtensionAPI;
	agent: AgentConfig;
}

interface RuntimeAgentRegistry {
	version: 1;
	byPi: WeakMap<ExtensionAPI, RuntimeAgentRecord[]>;
}

export type RuntimeAgentOwner = ExtensionAPI;

function defaultSystemPromptMode(name: string): "append" | "replace" {
	return name === "delegate" ? "append" : "replace";
}

function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

function defaultInheritSkills(): boolean {
	return false;
}

function registry(): RuntimeAgentRegistry {
	const key = Symbol.for(RUNTIME_AGENT_REGISTRY_KEY);
	const globalObject = globalThis as Record<PropertyKey, unknown>;
	const existing = globalObject[key];
	if (existing === undefined) {
		const created: RuntimeAgentRegistry = { version: 1, byPi: new WeakMap() };
		globalObject[key] = created;
		return created;
	}
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		throw new Error(`Malformed runtime agent registry at Symbol.for("${RUNTIME_AGENT_REGISTRY_KEY}").`);
	}
	const candidate = existing as Partial<RuntimeAgentRegistry>;
	if (candidate.version !== 1 || !(candidate.byPi instanceof WeakMap)) {
		throw new Error(`Unsupported runtime agent registry at Symbol.for("${RUNTIME_AGENT_REGISTRY_KEY}").`);
	}
	return candidate as RuntimeAgentRegistry;
}

function validatePi(value: unknown): ExtensionAPI {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime agent pi must be an ExtensionAPI object.");
	const pi = value as Partial<ExtensionAPI>;
	if (typeof pi.on !== "function" || typeof pi.registerTool !== "function") throw new Error("Runtime agent pi must be an ExtensionAPI object.");
	return value as ExtensionAPI;
}

function validateString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
		throw new Error(`${field} must be a non-empty string without leading or trailing whitespace.`);
	}
	if (value.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters.`);
	if (value.includes("\0")) throw new Error(`${field} must not contain NUL characters.`);
	return value;
}

function validateOptionalString(value: unknown, field: string, maxLength = MAX_FIELD_STRING_LENGTH): string | undefined {
	if (value === undefined) return undefined;
	return validateString(value, field, maxLength);
}

function validateStringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings when provided.`);
	return [...new Set(value.map((entry, index) => validateString(entry, `${field}[${index}]`, MAX_FIELD_STRING_LENGTH)))];
}

function validatePositiveInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer when provided.`);
	return value;
}

function validateBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${field} must be a boolean when provided.`);
	return value;
}

function isJsonSerializable(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonSerializable);
	if (value && typeof value === "object") return Object.values(value).every(isJsonSerializable);
	return false;
}

function validateRunner(value: unknown): AgentRunnerConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime agent definition runner must be an object when provided.");
	const runner = value as Record<string, unknown>;
	if (runner.type === "pi") {
		if (Object.keys(runner).some((key) => key !== "type")) throw new Error("Runtime agent definition Pi runner supports only 'type'.");
		return { type: "pi" };
	}
	if (runner.type === "external-job") {
		if (typeof runner.provider !== "string" || !runner.provider.trim() || runner.provider.trim() !== runner.provider) throw new Error("Runtime agent definition external-job runner requires a non-empty trimmed provider string.");
		if (runner.options !== undefined && (!runner.options || typeof runner.options !== "object" || Array.isArray(runner.options) || !isJsonSerializable(runner.options))) throw new Error("Runtime agent definition external-job runner options must be a JSON-serializable object.");
		const supported = new Set(["type", "provider", "options"]);
		const unknown = Object.keys(runner).filter((key) => !supported.has(key));
		if (unknown.length > 0) throw new Error(`Runtime agent definition external-job runner has unsupported fields: ${unknown.join(", ")}.`);
		return { type: "external-job", provider: runner.provider, ...(runner.options ? { options: runner.options as Record<string, unknown> } : {}) };
	}
	if (runner.type !== "external-cli") throw new Error("Runtime agent definition runner.type must be 'pi', 'external-cli', or 'external-job'.");
	if (typeof runner.command !== "string" || !runner.command.trim()) throw new Error("Runtime agent definition external-cli runner requires a non-empty command string.");
	if (runner.args !== undefined && (!Array.isArray(runner.args) || runner.args.some((arg) => typeof arg !== "string"))) throw new Error("Runtime agent definition external-cli runner args must be an array of strings.");
	if (runner.adapter !== undefined && !isCodeOwnedExternalCliAdapterId(runner.adapter)) throw new Error(`Runtime agent definition external-cli runner adapter must be ${CODE_OWNED_EXTERNAL_CLI_ADAPTER_LABEL}.`);
	if (runner.adapter !== undefined && Array.isArray(runner.args) && runner.args.length > 0) throw new Error(`Runtime agent definition ${runner.adapter} adapter owns its argv; runner args are not supported.`);
	if (runner.promptDelivery !== undefined && runner.promptDelivery !== "stdin") throw new Error("Runtime agent definition external-cli runner promptDelivery must be 'stdin'.");
	const capabilities = parseExternalCliCapabilityNarrowing(runner.capabilities, "Runtime agent definition external-cli runner capabilities");
	const supported = new Set(["type", "adapter", "command", "args", "promptDelivery", "capabilities"]);
	const unknown = Object.keys(runner).filter((key) => !supported.has(key));
	if (unknown.length > 0) throw new Error(`Runtime agent definition external-cli runner has unsupported fields: ${unknown.join(", ")}.`);
	const args = runner.args as string[] | undefined;
	return { type: "external-cli", ...(isCodeOwnedExternalCliAdapterId(runner.adapter) ? { adapter: runner.adapter } : {}), command: runner.command.trim(), ...(args?.length ? { args } : {}), ...(runner.promptDelivery ? { promptDelivery: "stdin" as const } : {}), ...(capabilities ? { capabilities } : {}) };
}

function validateAcceptance(value: unknown): AcceptanceInput | undefined {
	const errors = validateAcceptanceInput(value, "Runtime agent definition defaultAcceptance");
	if (errors.length > 0) throw new Error(errors.join(" "));
	return value as AcceptanceInput | undefined;
}

function validateToolBudget(value: unknown): ToolBudgetConfig | undefined {
	const result = validateToolBudgetConfig(value, "Runtime agent definition toolBudget");
	if (result.error) throw new Error(result.error);
	return result.budget;
}

function validateDefinition(value: unknown): RuntimeAgentDefinition {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime agent definition must be an object.");
	const definition = value as Record<string, unknown>;
	const supported = new Set([
		"description", "systemPrompt", "aliases", "tools", "excludeTools", "allowNestedSubagents", "mcpDirectTools", "model", "fallbackModels", "thinking",
		"systemPromptMode", "inheritProjectContext", "inheritGlobalContext", "inheritSkills", "defaultContext", "defaultAsync", "defaultTimeoutMs",
		"defaultToolTimeoutMs", "defaultAcceptance", "acceptanceRole", "runner", "skills", "skillPath",
		"extensions", "subagentOnlyExtensions", "mutationTools", "output", "outputMode", "defaultReads", "defaultProgress", "interactive",
		"maxSubagentDepth", "completionGuard", "toolBudget", "permissions",
	]);
	const unknown = Object.keys(definition).filter((key) => !supported.has(key));
	if (unknown.length > 0) throw new Error(`Runtime agent definition has unknown fields: ${unknown.join(", ")}.`);
	const systemPromptMode = definition.systemPromptMode;
	if (systemPromptMode !== undefined && systemPromptMode !== "append" && systemPromptMode !== "replace") throw new Error("Runtime agent definition systemPromptMode must be 'append' or 'replace'.");
	const defaultContext = definition.defaultContext;
	if (defaultContext !== undefined && defaultContext !== "fresh" && defaultContext !== "fork") throw new Error("Runtime agent definition defaultContext must be 'fresh' or 'fork'.");
	const thinking = definition.thinking;
	if (thinking !== undefined && thinking !== false && typeof thinking !== "string") throw new Error("Runtime agent definition thinking must be a string or false when provided.");
	const acceptanceRole = definition.acceptanceRole;
	if (acceptanceRole !== undefined && acceptanceRole !== "read-only" && acceptanceRole !== "writer") throw new Error("Runtime agent definition acceptanceRole must be 'read-only' or 'writer'.");
	const outputMode = definition.outputMode;
	if (outputMode !== undefined && outputMode !== "inline" && outputMode !== "file-only") throw new Error("Runtime agent definition outputMode must be 'inline' or 'file-only'.");
	const aliases = validateStringList(definition.aliases, "Runtime agent definition aliases");
	const tools = validateStringList(definition.tools, "Runtime agent definition tools");
	const excludeTools = validateStringList(definition.excludeTools, "Runtime agent definition excludeTools");
	const allowNestedSubagents = validateBoolean(definition.allowNestedSubagents, "Runtime agent definition allowNestedSubagents");
	const mcpDirectTools = validateStringList(definition.mcpDirectTools, "Runtime agent definition mcpDirectTools");
	const model = validateOptionalString(definition.model, "Runtime agent definition model");
	const fallbackModels = validateStringList(definition.fallbackModels, "Runtime agent definition fallbackModels");
	const inheritProjectContext = validateBoolean(definition.inheritProjectContext, "Runtime agent definition inheritProjectContext");
	const inheritGlobalContext = validateBoolean(definition.inheritGlobalContext, "Runtime agent definition inheritGlobalContext");
	const inheritSkills = validateBoolean(definition.inheritSkills, "Runtime agent definition inheritSkills");
	const defaultAsync = validateBoolean(definition.defaultAsync, "Runtime agent definition defaultAsync");
	const defaultTimeoutMs = validatePositiveInteger(definition.defaultTimeoutMs, "Runtime agent definition defaultTimeoutMs");
	const defaultToolTimeoutMs = validatePositiveInteger(definition.defaultToolTimeoutMs, "Runtime agent definition defaultToolTimeoutMs");
	const defaultAcceptance = validateAcceptance(definition.defaultAcceptance);
	const runner = validateRunner(definition.runner);
	const skills = validateStringList(definition.skills, "Runtime agent definition skills");
	const skillPath = validateStringList(definition.skillPath, "Runtime agent definition skillPath");
	const extensions = validateStringList(definition.extensions, "Runtime agent definition extensions");
	const subagentOnlyExtensions = validateStringList(definition.subagentOnlyExtensions, "Runtime agent definition subagentOnlyExtensions");
	const mutationTools = validateStringList(definition.mutationTools, "Runtime agent definition mutationTools");
	const output = validateOptionalString(definition.output, "Runtime agent definition output");
	const defaultReads = validateStringList(definition.defaultReads, "Runtime agent definition defaultReads");
	const defaultProgress = validateBoolean(definition.defaultProgress, "Runtime agent definition defaultProgress");
	const interactive = validateBoolean(definition.interactive, "Runtime agent definition interactive");
	const maxSubagentDepth = validatePositiveInteger(definition.maxSubagentDepth, "Runtime agent definition maxSubagentDepth");
	const completionGuard = validateBoolean(definition.completionGuard, "Runtime agent definition completionGuard");
	const toolBudget = validateToolBudget(definition.toolBudget);
	const permissions = validatePermissionRules(definition.permissions, "Runtime agent definition permissions");
	return {
		description: validateString(definition.description, "Runtime agent definition description", MAX_DESCRIPTION_LENGTH),
		systemPrompt: validateString(definition.systemPrompt, "Runtime agent definition systemPrompt", MAX_SYSTEM_PROMPT_LENGTH),
		...(aliases ? { aliases } : {}),
		...(tools ? { tools } : {}),
		...(excludeTools ? { excludeTools } : {}),
		...(allowNestedSubagents !== undefined ? { allowNestedSubagents } : {}),
		...(mcpDirectTools ? { mcpDirectTools } : {}),
		...(model ? { model } : {}),
		...(fallbackModels ? { fallbackModels } : {}),
		...(thinking !== undefined ? { thinking: thinking as string | false } : {}),
		...(systemPromptMode !== undefined ? { systemPromptMode: systemPromptMode as "append" | "replace" } : {}),
		...(inheritProjectContext !== undefined ? { inheritProjectContext } : {}),
		...(inheritGlobalContext !== undefined ? { inheritGlobalContext } : {}),
		...(inheritSkills !== undefined ? { inheritSkills } : {}),
		...(defaultContext !== undefined ? { defaultContext: defaultContext as AgentDefaultContext } : {}),
		...(defaultAsync !== undefined ? { defaultAsync } : {}),
		...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
		...(defaultToolTimeoutMs !== undefined ? { defaultToolTimeoutMs } : {}),
		...(defaultAcceptance !== undefined ? { defaultAcceptance } : {}),
		...(acceptanceRole !== undefined ? { acceptanceRole: acceptanceRole as AcceptanceRole } : {}),
		...(runner !== undefined ? { runner } : {}),
		...(skills ? { skills } : {}),
		...(skillPath ? { skillPath } : {}),
		...(extensions ? { extensions } : {}),
		...(subagentOnlyExtensions ? { subagentOnlyExtensions } : {}),
		...(mutationTools ? { mutationTools } : {}),
		...(output ? { output } : {}),
		...(outputMode !== undefined ? { outputMode: outputMode as OutputMode } : {}),
		...(defaultReads ? { defaultReads } : {}),
		...(defaultProgress !== undefined ? { defaultProgress } : {}),
		...(interactive !== undefined ? { interactive } : {}),
		...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
		...(completionGuard !== undefined ? { completionGuard } : {}),
		...(toolBudget !== undefined ? { toolBudget } : {}),
		...(permissions !== undefined ? { permissions } : {}),
	};
}

function normalizeAliases(rawAliases: readonly string[] | undefined, agentName: string): string[] | undefined {
	const aliases = [...new Set((rawAliases ?? []).map((alias) => alias.trim()).filter(Boolean))]
		.filter((alias) => alias !== agentName);
	return aliases.length > 0 ? aliases : undefined;
}

function identityKeys(agent: Pick<AgentConfig, "name" | "localName" | "aliases">): string[] {
	return [agent.name, ...(agent.localName ? [agent.localName] : []), ...(agent.aliases ?? [])];
}

function assertNoIdentityCollisions(agents: readonly AgentConfig[], context: string): void {
	const seen = new Map<string, string>();
	for (const agent of agents) {
		for (const key of identityKeys(agent)) {
			const previous = seen.get(key);
			if (previous !== undefined) throw new Error(`${context} collision for '${key}' between '${previous}' and '${agent.name}'.`);
			seen.set(key, agent.name);
		}
	}
}

function assertNoRuntimeCollision(agent: AgentConfig, existing: readonly AgentConfig[]): void {
	const existingKeys = new Map<string, string>();
	for (const registered of existing) {
		for (const key of identityKeys(registered)) existingKeys.set(key, registered.name);
	}
	for (const key of identityKeys(agent)) {
		const previous = existingKeys.get(key);
		if (previous !== undefined) throw new Error(`Runtime agent '${agent.name}' collides with runtime agent '${previous}' on name or alias '${key}'.`);
	}
}

function assertNoBuiltinCollision(agent: AgentConfig): void {
	for (const key of identityKeys(agent)) {
		if ((BUILTIN_AGENT_NAMES as readonly string[]).includes(key)) throw new Error(`Runtime agent '${agent.name}' collides with builtin agent '${key}'.`);
	}
}

function toAgentConfig(name: string, definition: RuntimeAgentDefinition): AgentConfig {
	const aliases = normalizeAliases(definition.aliases, name);
	const agent: AgentConfig = {
		name,
		description: definition.description,
		...(aliases ? { aliases } : {}),
		...(definition.runner !== undefined ? { runner: definition.runner } : {}),
		...(definition.tools !== undefined ? { tools: [...definition.tools] } : {}),
		...(definition.excludeTools !== undefined ? { excludeTools: [...definition.excludeTools] } : {}),
		...(definition.allowNestedSubagents !== undefined ? { allowNestedSubagents: definition.allowNestedSubagents } : {}),
		...(definition.mcpDirectTools !== undefined ? { mcpDirectTools: [...definition.mcpDirectTools] } : {}),
		...(definition.model !== undefined ? { model: definition.model } : {}),
		...(definition.fallbackModels !== undefined ? { fallbackModels: [...definition.fallbackModels] } : {}),
		...(definition.thinking !== undefined ? { thinking: definition.thinking } : {}),
		systemPromptMode: definition.systemPromptMode ?? defaultSystemPromptMode(name),
		inheritProjectContext: definition.inheritProjectContext ?? defaultInheritProjectContext(name),
		inheritGlobalContext: definition.inheritGlobalContext ?? false,
		inheritSkills: definition.inheritSkills ?? defaultInheritSkills(),
		...(definition.defaultContext !== undefined ? { defaultContext: definition.defaultContext } : {}),
		...(definition.defaultAsync !== undefined ? { defaultAsync: definition.defaultAsync } : {}),
		...(definition.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: definition.defaultTimeoutMs } : {}),
		...(definition.defaultToolTimeoutMs !== undefined ? { defaultToolTimeoutMs: definition.defaultToolTimeoutMs } : {}),
		...(definition.defaultAcceptance !== undefined ? { defaultAcceptance: definition.defaultAcceptance } : {}),
		...(definition.acceptanceRole !== undefined ? { acceptanceRole: definition.acceptanceRole } : {}),
		systemPrompt: definition.systemPrompt,
		source: "runtime",
		filePath: `runtime:${name}`,
		...(definition.skills !== undefined ? { skills: [...definition.skills] } : {}),
		...(definition.skillPath !== undefined ? { skillPath: [...definition.skillPath] } : {}),
		...(definition.extensions !== undefined ? { extensions: [...definition.extensions] } : {}),
		...(definition.subagentOnlyExtensions !== undefined ? { subagentOnlyExtensions: [...definition.subagentOnlyExtensions] } : {}),
		...(definition.mutationTools !== undefined ? { mutationTools: [...definition.mutationTools] } : {}),
		...(definition.output !== undefined ? { output: definition.output } : {}),
		...(definition.outputMode !== undefined ? { outputMode: definition.outputMode } : {}),
		...(definition.defaultReads !== undefined ? { defaultReads: [...definition.defaultReads] } : {}),
		...(definition.defaultProgress !== undefined ? { defaultProgress: definition.defaultProgress } : {}),
		...(definition.interactive !== undefined ? { interactive: definition.interactive } : {}),
		...(definition.maxSubagentDepth !== undefined ? { maxSubagentDepth: definition.maxSubagentDepth } : {}),
		...(definition.completionGuard !== undefined ? { completionGuard: definition.completionGuard } : {}),
		...(definition.toolBudget !== undefined ? { toolBudget: definition.toolBudget } : {}),
		...(definition.permissions !== undefined ? { permissions: definition.permissions } : {}),
	};
	assertNoIdentityCollisions([agent], `Runtime agent '${name}'`);
	return agent;
}

export function registerRuntimeAgent(input: RegisterRuntimeAgentInput): RuntimeAgentRegistration {
	const pi = validatePi(input.pi);
	const name = validateString(input.name, "Runtime agent name", MAX_AGENT_NAME_LENGTH);
	const definition = validateDefinition(input.definition);
	const agent = toAgentConfig(name, definition);
	const profileError = validateCodeOwnedProfileRunner(agent);
	if (profileError) throw new Error(profileError);
	assertNoBuiltinCollision(agent);
	const current = registry();
	const records = current.byPi.get(pi) ?? [];
	if (records.length >= MAX_RUNTIME_AGENTS_PER_PI) throw new Error(`Runtime agent registry supports at most ${MAX_RUNTIME_AGENTS_PER_PI} agents per Pi runtime.`);
	assertNoRuntimeCollision(agent, records.map((record) => record.agent));
	const record: RuntimeAgentRecord = { pi, agent };
	records.push(record);
	current.byPi.set(pi, records);
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			const latest = current.byPi.get(pi);
			if (!latest) return;
			const next = latest.filter((entry) => entry !== record);
			if (next.length > 0) current.byPi.set(pi, next);
			else current.byPi.delete(pi);
		},
	};
}

export function clearRuntimeAgentsForPi(pi: RuntimeAgentOwner): void {
	registry().byPi.delete(pi);
}

export function listRuntimeAgentConfigs(pi: RuntimeAgentOwner): AgentConfig[] {
	return (registry().byPi.get(pi) ?? []).map((record) => ({ ...record.agent, aliases: record.agent.aliases ? [...record.agent.aliases] : undefined }));
}

function assertNoConfiguredCollision(configuredAgents: readonly AgentConfig[], runtimeAgents: readonly AgentConfig[]): void {
	const configured = new Map<string, string>();
	for (const agent of configuredAgents) {
		for (const key of identityKeys(agent)) configured.set(key, agent.name);
	}
	for (const agent of runtimeAgents) {
		for (const key of identityKeys(agent)) {
			const previous = configured.get(key);
			if (previous !== undefined) {
				throw new Error(`Runtime agent '${agent.name}' collides with configured agent '${previous}' on name or alias '${key}'.`);
			}
		}
	}
}

export function mergeRuntimeAgents<T extends { agents: AgentConfig[]; agentDiagnostics?: AgentDiscoveryDiagnostic[] }>(pi: RuntimeAgentOwner, discovered: T, configuredAgents: readonly AgentConfig[] = discovered.agents): T {
	const runtimeAgents = listRuntimeAgentConfigs(pi).filter((agent) => agent.disabled !== true);
	if (runtimeAgents.length === 0) return discovered;
	assertNoIdentityCollisions(runtimeAgents, "Runtime agent registration");
	assertNoConfiguredCollision(configuredAgents, runtimeAgents);
	return { ...discovered, agents: [...discovered.agents, ...runtimeAgents] };
}
