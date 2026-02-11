/**
 * Skill resolution and caching for subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadSkills, type Skill } from "@mariozechner/pi-coding-agent";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: string;
}

interface SkillCacheEntry {
	mtime: number;
	skill: ResolvedSkill;
}

const skillCache = new Map<string, SkillCacheEntry>();
const MAX_CACHE_SIZE = 50;

function stripSkillFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return normalized;

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;

	return normalized.slice(endIndex + 4).trim();
}

/** Cache for pi's loadSkills result, keyed by cwd */
let loadSkillsCache: { cwd: string; skills: Skill[]; timestamp: number } | null = null;
const LOAD_SKILLS_CACHE_TTL_MS = 5000;

const CONFIG_DIR = ".pi";
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

/**
 * Read the `pi.skills` array from a package's package.json and resolve
 * each entry to an absolute path relative to the package root.
 */
function getPackageSkillPaths(packageRoot: string): string[] {
	const pkgJsonPath = path.join(packageRoot, "package.json");
	try {
		const content = fs.readFileSync(pkgJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		const piSkills = pkg?.pi?.skills;
		if (!Array.isArray(piSkills)) return [];
		return piSkills
			.filter((s: unknown) => typeof s === "string")
			.map((s: string) => path.resolve(packageRoot, s));
	} catch {
		return [];
	}
}

/**
 * Scan installed packages (npm) for pi.skills entries.
 * Checks both project-local (.pi/npm/node_modules) and user-global (~/.pi/npm/node_modules).
 */
function collectPackageSkillPaths(cwd: string): string[] {
	const dirs = [
		path.join(cwd, CONFIG_DIR, "npm", "node_modules"),
		path.join(AGENT_DIR, "npm", "node_modules"),
	];
	const results: string[] = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;

				// Handle scoped packages (@scope/name)
				if (entry.name.startsWith("@")) {
					const scopeDir = path.join(dir, entry.name);
					try {
						const scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
						for (const scopeEntry of scopeEntries) {
							if (scopeEntry.name.startsWith(".")) continue;
							const pkgRoot = path.join(scopeDir, scopeEntry.name);
							results.push(...getPackageSkillPaths(pkgRoot));
						}
					} catch {}
					continue;
				}

				const pkgRoot = path.join(dir, entry.name);
				results.push(...getPackageSkillPaths(pkgRoot));
			}
		} catch {}
	}
	return results;
}

/**
 * Read the `skills` array from settings.json (both user and project level).
 * Resolves relative paths against the settings file's base directory.
 */
function collectSettingsSkillPaths(cwd: string): string[] {
	const results: string[] = [];
	const settingsFiles = [
		{ file: path.join(AGENT_DIR, "settings.json"), base: AGENT_DIR },
		{ file: path.join(cwd, CONFIG_DIR, "settings.json"), base: path.join(cwd, CONFIG_DIR) },
	];
	for (const { file, base } of settingsFiles) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			const settings = JSON.parse(content);
			const skills = settings?.skills;
			if (!Array.isArray(skills)) continue;
			for (const entry of skills) {
				if (typeof entry !== "string") continue;
				let resolved = entry;
				// Expand ~ to homedir
				if (resolved.startsWith("~/")) {
					resolved = path.join(os.homedir(), resolved.slice(2));
				} else if (!path.isAbsolute(resolved)) {
					resolved = path.resolve(base, resolved);
				}
				results.push(resolved);
			}
		} catch {}
	}
	return results;
}

function getCachedSkills(cwd: string): Skill[] {
	const now = Date.now();
	if (loadSkillsCache && loadSkillsCache.cwd === cwd && (now - loadSkillsCache.timestamp) < LOAD_SKILLS_CACHE_TTL_MS) {
		return loadSkillsCache.skills;
	}

	// Collect additional skill paths from packages and settings
	const packagePaths = collectPackageSkillPaths(cwd);
	const settingsPaths = collectSettingsSkillPaths(cwd);

	// Important: keep project skills before user skills so project wins on name collisions.
	// We disable loadSkills defaults and pass explicit paths in precedence order.
	const defaultSkillPaths = [
		path.join(cwd, CONFIG_DIR, "skills"),
		path.join(AGENT_DIR, "skills"),
	];
	const skillPaths = [...new Set([...defaultSkillPaths, ...packagePaths, ...settingsPaths])];

	const { skills } = loadSkills({ cwd, skillPaths, includeDefaults: false });
	loadSkillsCache = { cwd, skills, timestamp: now };
	return skills;
}

/**
 * Resolve a skill path by name using pi's built-in loader.
 * This finds skills from all pi skill sources (global, project, packages, settings).
 */
export function resolveSkillPath(
	skillName: string,
	cwd: string,
): { path: string; source: string } | undefined {
	const skills = getCachedSkills(cwd);
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return undefined;
	return { path: skill.filePath, source: skill.source };
}

export function readSkill(
	skillName: string,
	skillPath: string,
	source: string,
): ResolvedSkill | undefined {
	try {
		const stat = fs.statSync(skillPath);
		const cached = skillCache.get(skillPath);
		if (cached && cached.mtime === stat.mtimeMs) {
			return cached.skill;
		}

		const raw = fs.readFileSync(skillPath, "utf-8");
		const content = stripSkillFrontmatter(raw);
		const skill: ResolvedSkill = {
			name: skillName,
			path: skillPath,
			content,
			source,
		};

		skillCache.set(skillPath, { mtime: stat.mtimeMs, skill });
		if (skillCache.size > MAX_CACHE_SIZE) {
			const firstKey = skillCache.keys().next().value;
			if (firstKey) skillCache.delete(firstKey);
		}

		return skill;
	} catch {
		return undefined;
	}
}

export function resolveSkills(
	skillNames: string[],
	cwd: string,
): { resolved: ResolvedSkill[]; missing: string[] } {
	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];

	for (const name of skillNames) {
		const trimmed = name.trim();
		if (!trimmed) continue;

		const location = resolveSkillPath(trimmed, cwd);
		if (!location) {
			missing.push(trimmed);
			continue;
		}

		const skill = readSkill(trimmed, location.path, location.source);
		if (skill) {
			resolved.push(skill);
		} else {
			missing.push(trimmed);
		}
	}

	return { resolved, missing };
}

export function buildSkillInjection(skills: ResolvedSkill[]): string {
	if (skills.length === 0) return "";

	return skills
		.map((s) => `<skill name="${s.name}">\n${s.content}\n</skill>`)
		.join("\n\n");
}

export function normalizeSkillInput(
	input: string | string[] | boolean | undefined,
): string[] | false | undefined {
	if (input === false) return false;
	if (input === true || input === undefined) return undefined;
	if (Array.isArray(input)) {
		// Deduplicate while preserving order
		return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
	}
	// Deduplicate while preserving order
	return [...new Set(input.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * Discover available skills using pi's built-in loader.
 * This delegates to pi's `loadSkills()` which scans all skill sources:
 * - Global: ~/.pi/agent/skills/
 * - Project: .pi/skills/
 * - Packages: skills/ dirs or pi.skills in package.json
 * - Settings: skills array with files/dirs
 *
 * It also handles .gitignore, symlinks, name validation, and collision detection.
 */
export function discoverAvailableSkills(cwd: string): Array<{
	name: string;
	source: string;
	description?: string;
}> {
	const skills = getCachedSkills(cwd);
	return skills
		.map((s) => ({
			name: s.name,
			source: s.source,
			description: s.description,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function clearSkillCache(): void {
	skillCache.clear();
	loadSkillsCache = null;
}
