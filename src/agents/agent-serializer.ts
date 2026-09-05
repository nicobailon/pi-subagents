import { stringify as stringifyYaml } from "yaml";
import type { AgentConfig } from "./agents.ts";
import { frontmatterNameForConfig } from "./identity.ts";

export const KNOWN_FIELDS = new Set([
	"name",
	"package",
	"description",
	"advertise",
	"alias",
	"aliases",
	"tools",
	"excludeTools",
	"allowNestedSubagents",
	"model",
	"fallbackModels",
	"fast",
	"thinking",
	"systemPromptMode",
	"inheritProjectContext",
	"inheritGlobalContext",
	"inheritSkills",
	"defaultContext",
	"async",
	"timeoutMs",
	"toolTimeoutMs",
	"acceptance",
	"acceptanceRole",
	"skill",
	"skills",
	"skillPath",
	"extensions",
	"subagentOnlyExtensions",
	"mutationTools",
	"output",
	"outputMode",
	"defaultReads",
	"defaultProgress",
	"interactive",
	"maxSubagentDepth",
	"completionGuard",
	"toolBudget",
	"permission",
	"permissions",
	"memory",
	"runner",
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
	if (config.advertise === true || preserve("advertise")) lines.push(`advertise: ${config.advertise === true ? "true" : "false"}`);
	const aliasesValue = joinComma(config.aliases);
	if (aliasesValue || preserve("alias", "aliases")) lines.push(`aliases: ${aliasesValue ?? ""}`);

	const tools = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	const toolsValue = joinComma(tools);
	if (toolsValue || preserve("tools")) lines.push(`tools: ${toolsValue ?? ""}`);
	const excludeToolsValue = joinComma(config.excludeTools);
	if (excludeToolsValue || preserve("excludeTools")) lines.push(`excludeTools: ${excludeToolsValue ?? ""}`);
	if (config.allowNestedSubagents === true || preserve("allowNestedSubagents")) {
		lines.push(`allowNestedSubagents: ${config.allowNestedSubagents === undefined ? "" : config.allowNestedSubagents ? "true" : "false"}`);
	}

	if (config.model || preserve("model")) lines.push(`model: ${config.model ?? ""}`);
	const fallbackModelsValue = joinComma(config.fallbackModels);
	if (fallbackModelsValue || preserve("fallbackModels")) lines.push(`fallbackModels: ${fallbackModelsValue ?? ""}`);
	if (config.fast === true || preserve("fast")) lines.push(`fast: ${config.fast === undefined ? "" : config.fast ? "true" : "false"}`);
	if ((config.thinking && (config.thinking !== "off" || preserve("thinking"))) || (!config.thinking && preserve("thinking"))) {
		lines.push(`thinking: ${config.thinking ?? ""}`);
	}
	if (!preservingExistingFrontmatter || preserve("systemPromptMode")) lines.push(`systemPromptMode: ${config.systemPromptMode}`);
	if (!preservingExistingFrontmatter || preserve("inheritProjectContext")) lines.push(`inheritProjectContext: ${config.inheritProjectContext ? "true" : "false"}`);
	if (config.inheritGlobalContext || preserve("inheritGlobalContext")) lines.push(`inheritGlobalContext: ${config.inheritGlobalContext ? "true" : "false"}`);
	if (!preservingExistingFrontmatter || preserve("inheritSkills")) lines.push(`inheritSkills: ${config.inheritSkills ? "true" : "false"}`);
	if (config.defaultContext || preserve("defaultContext")) lines.push(`defaultContext: ${config.defaultContext ?? ""}`);
	if (config.runner || preserve("runner")) {
		if (config.runner) {
			lines.push("runner:");
			for (const line of stringifyYaml(config.runner).trimEnd().split("\n")) lines.push(`  ${line}`);
		} else {
			lines.push("runner:");
		}
	}
	if (config.defaultAsync !== undefined || preserve("async")) lines.push(`async: ${config.defaultAsync === undefined ? "" : config.defaultAsync ? "true" : "false"}`);
	if (config.defaultTimeoutMs !== undefined || preserve("timeoutMs")) lines.push(`timeoutMs: ${config.defaultTimeoutMs ?? ""}`);
	if (config.defaultToolTimeoutMs !== undefined || preserve("toolTimeoutMs")) lines.push(`toolTimeoutMs: ${config.defaultToolTimeoutMs ?? ""}`);
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
	const mutationToolsValue = joinComma(config.mutationTools);
	if (mutationToolsValue || preserve("mutationTools")) lines.push(`mutationTools: ${mutationToolsValue ?? ""}`);

	if (config.output || preserve("output")) lines.push(`output: ${config.output ?? ""}`);
	if (config.outputMode || preserve("outputMode")) lines.push(`outputMode: ${config.outputMode ?? ""}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue || preserve("defaultReads")) lines.push(`defaultReads: ${readsValue ?? ""}`);

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
	if (config.permissions || preserve("permission", "permissions")) {
		const key = preserve("permission") && !preserve("permissions") ? "permission" : "permissions";
		lines.push(`${key}:`);
		if (config.permissions) {
			for (const line of stringifyYaml(config.permissions).trimEnd().split("\n")) lines.push(`  ${line}`);
		}
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
