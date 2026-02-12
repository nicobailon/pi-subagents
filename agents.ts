/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KNOWN_FIELDS } from "./agent-serializer.js";
import { parseChain } from "./chain-serializer.js";
import { mergeAgentsForScope } from "./agent-selection.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
	skills?: string[];
	extensions?: string[];
	// Chain behavior fields
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	extraFields?: Record<string, string>;
}

export interface ChainStepConfig {
	agent: string;
	task: string;
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
}

export interface ChainConfig {
	name: string;
	description: string;
	source: "user" | "project";
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		// Parse defaultReads as comma-separated list (like tools)
		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			// Chain behavior fields
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: "user" | "project"): ChainConfig[] {
	const chains: ChainConfig[] = [];

	if (!fs.existsSync(dir)) {
		return chains;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return chains;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source, filePath));
		} catch {
			continue;
		}
	}

	return chains;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
} {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);

	const user = loadAgentsFromDir(userDir, "user");
	const project = projectDir ? loadAgentsFromDir(projectDir, "project") : [];
	const chains = [
		...loadChainsFromDir(userDir, "user"),
		...(projectDir ? loadChainsFromDir(projectDir, "project") : []),
	];

	return { user, project, chains, userDir, projectDir };
}
