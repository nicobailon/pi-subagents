/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseChain } from "./chain-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import {
	loadSubagentsOverlay,
	type AgentOverride,
	type SubagentsOverlay,
} from "./subagents-config.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	// Chain behavior fields
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
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
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function applyOverride(agent: AgentConfig, o: AgentOverride): AgentConfig {
	const next = { ...agent };
	if (o.description !== undefined) next.description = o.description;
	if (o.model !== undefined) next.model = o.model;
	if (o.thinking !== undefined) next.thinking = o.thinking;
	if (o.tools !== undefined) next.tools = [...o.tools];
	if (o.skills !== undefined) next.skills = [...o.skills];
	if (o.extensions !== undefined) next.extensions = [...o.extensions];
	if (o.output !== undefined) next.output = o.output;
	if (o.defaultReads !== undefined) next.defaultReads = [...o.defaultReads];
	if (o.defaultProgress !== undefined) next.defaultProgress = o.defaultProgress;
	if (o.interactive !== undefined) next.interactive = o.interactive;
	if (o.maxSubagentDepth !== undefined) next.maxSubagentDepth = o.maxSubagentDepth;
	return next;
}

function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
	overlay?: SubagentsOverlay,
): AgentConfig[] {
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

		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);

		const base: AgentConfig = {
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
			maxSubagentDepth:
				Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
					? parsedMaxSubagentDepth
					: undefined,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		};

		const override = overlay?.agents.get(base.name);
		agents.push(override ? applyOverride(base, override) : base);
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
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
		const candidateAlt = path.join(currentDir, ".agents");
		if (isDirectory(candidateAlt)) return candidateAlt;

		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

const BUILTIN_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const overlay = loadSubagentsOverlay(cwd);

	const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", overlay);

	const userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user", overlay);
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user", overlay);
	const userAgents = [...userAgentsOld, ...userAgentsNew];

	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadAgentsFromDir(projectAgentsDir, "project", overlay);
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
} {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const overlay = loadSubagentsOverlay(cwd);

	const builtin = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", overlay);
	const user = [
		...loadAgentsFromDir(userDirOld, "user", overlay),
		...loadAgentsFromDir(userDirNew, "user", overlay),
	];
	const project = projectDir ? loadAgentsFromDir(projectDir, "project", overlay) : [];
	const chains = [
		...loadChainsFromDir(userDirOld, "user"),
		...loadChainsFromDir(userDirNew, "user"),
		...(projectDir ? loadChainsFromDir(projectDir, "project") : []),
	];

	const userDir = fs.existsSync(userDirNew) ? userDirNew : userDirOld;

	return { builtin, user, project, chains, userDir, projectDir };
}
