/**
 * Skill resolution and caching for subagent extension
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: "project" | "user";
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

export function resolveSkillPath(
	skillName: string,
	cwd: string,
): { path: string; source: "project" | "user" } | undefined {
	const projectPath = path.resolve(cwd, ".pi", "skills", skillName, "SKILL.md");
	if (fs.existsSync(projectPath)) {
		return { path: projectPath, source: "project" };
	}

	const userPath = path.join(os.homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
	if (fs.existsSync(userPath)) {
		return { path: userPath, source: "user" };
	}

	return undefined;
}

export function readSkill(
	skillName: string,
	skillPath: string,
	source: "project" | "user",
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

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function discoverAvailableSkills(cwd: string): Array<{
	name: string;
	source: "project" | "user";
	description?: string;
}> {
	const skills: Array<{ name: string; source: "project" | "user"; description?: string }> = [];
	const seen = new Set<string>();

	const scanDir = (dir: string, source: "project" | "user") => {
		if (!fs.existsSync(dir)) return;

		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(fullPath));
				if (!isDir) continue;

				const skillPath = path.join(fullPath, "SKILL.md");
				if (!fs.existsSync(skillPath)) continue;

				if (source === "project" || !seen.has(entry.name)) {
					let description: string | undefined;
					try {
						const content = fs.readFileSync(skillPath, "utf-8");
						if (content.startsWith("---")) {
							const endIndex = content.indexOf("\n---", 3);
							if (endIndex !== -1) {
								const fmBlock = content.slice(0, endIndex);
								const match = fmBlock.match(/description:\s*(.+)/);
								if (match) {
									let desc = match[1].trim();
									if (
										(desc.startsWith("\"") && desc.endsWith("\"")) ||
										(desc.startsWith("'") && desc.endsWith("'"))
									) {
										desc = desc.slice(1, -1);
									}
									description = desc;
								}
							}
						}
					} catch {}

					if (source === "project" && seen.has(entry.name)) {
						const idx = skills.findIndex((s) => s.name === entry.name);
						if (idx !== -1) skills.splice(idx, 1);
					}

					skills.push({ name: entry.name, source, description });
					seen.add(entry.name);
				}
			}
		} catch {}
	};

	scanDir(path.join(os.homedir(), ".pi", "agent", "skills"), "user");
	scanDir(path.resolve(cwd, ".pi", "skills"), "project");

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function clearSkillCache(): void {
	skillCache.clear();
}
