import type { AgentConfig } from "./agents.ts";
import { frontmatterNameForConfig } from "./identity.ts";

export const KNOWN_FIELDS = new Set([
	"name",
	"package",
	"description",
	"tools",
	"model",
	"fallbackModels",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritSkills",
	"defaultContext",
	"async",
	"timeoutMs",
	"turnBudget",
	"acceptance",
	"acceptanceRole",
	"skill",
	"skills",
	"skillPath",
	"extensions",
	"subagentOnlyExtensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
	"completionGuard",
	"toolBudget",
	"memory",
]);

function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

interface SerializeAgentOptions {
	preserveFrontmatterFields?: ReadonlySet<string>;
}

export function serializeAgent(config: AgentConfig, options: SerializeAgentOptions = {}): string {
	const lines: string[] = [];
	const preserve = (...fields: string[]) => fields.some((field) => options.preserveFrontmatterFields?.has(field));
	const preservingExistingFrontmatter = options.preserveFrontmatterFields !== undefined;
	lines.push("---");
	lines.push(`name: ${frontmatterNameForConfig(config)}`);
	if (config.packageName) lines.push(`package: ${config.packageName}`);
	lines.push(`description: ${config.description}`);

	const tools = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	const toolsValue = joinComma(tools);
	if (toolsValue || preserve("tools")) lines.push(`tools: ${toolsValue ?? ""}`);

	if (config.model || preserve("model")) lines.push(`model: ${config.model ?? ""}`);
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue || preserve("fallbackModels")) lines.push(`fallbackModels: ${fallbackModelsValue ?? ""}`);
	if ((config.thinking && (config.thinking !== "off" || preserve("thinking"))) || (!config.thinking && preserve("thinking"))) {
		lines.push(`thinking: ${config.thinking ?? ""}`);
	}
	if (!preservingExistingFrontmatter || preserve("systemPromptMode")) lines.push(`systemPromptMode: ${config.systemPromptMode}`);
	if (!preservingExistingFrontmatter || preserve("inheritProjectContext")) lines.push(`inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`);
	if (!preservingExistingFrontmatter || preserve("inheritSkills")) lines.push(`inheritSkills: ${config.inheritSkills ? "true" : "false"}`);
	if (config.defaultContext || preserve("defaultContext")) lines.push(`defaultContext: ${config.defaultContext ?? ""}`);
	if (config.defaultAsync !== undefined || preserve("async")) lines.push(`async: ${config.defaultAsync === undefined ? "" : config.defaultAsync ? "true" : "false"}`);
	if (config.defaultTimeoutMs !== undefined || preserve("timeoutMs")) lines.push(`timeoutMs: ${config.defaultTimeoutMs ?? ""}`);
	if (config.defaultTurnBudget || preserve("turnBudget")) lines.push(`turnBudget: ${config.defaultTurnBudget ? JSON.stringify(config.defaultTurnBudget) : ""}`);
	if (config.defaultAcceptance !== undefined || preserve("acceptance")) {
		lines.push(`acceptance: ${config.defaultAcceptance === undefined
			? ""
			: typeof config.defaultAcceptance === "object"
				? JSON.stringify(config.defaultAcceptance)
				: String(config.defaultAcceptance)}`);
	}
	if (config.acceptanceRole || preserve("acceptanceRole")) lines.push(`acceptanceRole: ${config.acceptanceRole ?? ""}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue || preserve("skill", "skills")) lines.push(`skills: ${skillsValue ?? ""}`);
	const skillPathValue = joinComma(config.skillPath);
	if (skillPathValue || preserve("skillPath")) lines.push(`skillPath: ${skillPathValue ?? ""}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}
	if (config.subagentOnlyExtensions !== undefined || preserve("subagentOnlyExtensions")) {
		const subagentOnlyExtensionsValue = joinComma(config.subagentOnlyExtensions);
		lines.push(`subagentOnlyExtensions: ${subagentOnlyExtensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");
	const maxSubagentDepth = config.maxSubagentDepth;
	if (typeof maxSubagentDepth === "number" && Number.isInteger(maxSubagentDepth) && maxSubagentDepth >= 0) {
		lines.push(`maxSubagentDepth: ${maxSubagentDepth}`);
	}
	if (config.completionGuard === false || preserve("completionGuard")) {
		lines.push(`completionGuard: ${config.completionGuard === undefined ? "" : config.completionGuard ? "true" : "false"}`);
	}
	if (config.toolBudget || preserve("toolBudget")) {
		lines.push(`toolBudget: ${config.toolBudget ? JSON.stringify(config.toolBudget) : ""}`);
	}

	if (config.memory) {
		lines.push("memory:");
		lines.push(`  scope: ${config.memory.scope}`);
		lines.push(`  path: ${config.memory.path}`);
	}

	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (KNOWN_FIELDS.has(key)) continue;
			if (typeof value === "string" && value.includes("\n")) {
				// Multi-line block value (e.g. permission: nested YAML)
				lines.push(`${key}:`);
				for (const blockLine of value.split("\n")) {
					lines.push(`  ${blockLine}`);
				}
			} else {
				lines.push(`${key}: ${value}`);
			}
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}
