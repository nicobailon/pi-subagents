import * as fs from "node:fs";
import type { AgentConfig } from "./agents.js";

export const KNOWN_FIELDS = new Set([
	"name",
	"description",
	"tools",
	"model",
	"thinking",
	"skill",
	"skills",
	"extensions",
	"output",
	"defaultReads",
	"defaultProgress",
	"interactive",
]);

function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

export function serializeAgent(config: AgentConfig): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);

	const tools = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	const toolsValue = joinComma(tools);
	if (toolsValue) lines.push(`tools: ${toolsValue}`);

	if (config.model) lines.push(`model: ${config.model}`);
	if (config.thinking && config.thinking !== "off") lines.push(`thinking: ${config.thinking}`);

	const skillsValue = joinComma(config.skills);
	if (skillsValue) lines.push(`skills: ${skillsValue}`);

	if (config.extensions !== undefined) {
		const extensionsValue = joinComma(config.extensions);
		lines.push(`extensions: ${extensionsValue ?? ""}`);
	}

	if (config.output) lines.push(`output: ${config.output}`);

	const readsValue = joinComma(config.defaultReads);
	if (readsValue) lines.push(`defaultReads: ${readsValue}`);

	if (config.defaultProgress) lines.push("defaultProgress: true");
	if (config.interactive) lines.push("interactive: true");

	if (config.extraFields) {
		for (const [key, value] of Object.entries(config.extraFields)) {
			if (KNOWN_FIELDS.has(key)) continue;
			lines.push(`${key}: ${value}`);
		}
	}

	lines.push("---");

	const body = config.systemPrompt ?? "";
	return `${lines.join("\n")}\n\n${body}\n`;
}

export function updateFrontmatterField(filePath: string, field: string, value: string | undefined): void {
	const raw = fs.readFileSync(filePath, "utf-8");
	const normalized = raw.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) {
		throw new Error("Frontmatter not found");
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		throw new Error("Frontmatter not found");
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const rest = normalized.slice(endIndex + 4);
	const lines = frontmatterBlock.split("\n");

	const normalizedField = field === "skill" || field === "skills" ? "skills" : field;
	const targetKeys = field === "skills" ? new Set(["skill", "skills"]) : new Set([field]);
	let found = false;
	const updated: string[] = [];

	for (const line of lines) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match && targetKeys.has(match[1])) {
			if (value !== undefined) {
				if (!found) updated.push(`${normalizedField}: ${value}`);
				found = true;
			}
			continue;
		}
		updated.push(line);
	}

	if (value !== undefined && !found) {
		updated.push(`${normalizedField}: ${value}`);
	}

	const frontmatter = `---\n${updated.join("\n")}\n---`;
	fs.writeFileSync(filePath, frontmatter + rest, "utf-8");
}
