/**
 * Skill resolution and caching for subagent extension
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, type Skill } from "@mariozechner/pi-coding-agent";

export type SkillSource =
	| "project"
	| "user"
	| "project-package"
	| "user-package"
	| "project-settings"
	| "user-settings"
	| "extension"
	| "builtin"
	| "unknown";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: SkillSource;
}

interface SkillCacheEntry {
	mtime: number;
	skill: ResolvedSkill;
}

interface CachedSkillEntry {
	name: string;
	filePath: string;
	source: SkillSource;
	description?: string;
	order: number;
}

interface SkillPathHint {
	path: string;
	source: SkillSource;
}

interface SkillDiscoveryConfig {
	includePaths: SkillPathHint[];
	excludePaths: string[];
}

interface SettingsFileInfo {
	file: string;
	base: string;
	skillSource: Extract<SkillSource, "project-settings" | "user-settings">;
	packageSource: Extract<SkillSource, "project-package" | "user-package">;
}

const skillCache = new Map<string, SkillCacheEntry>();
const MAX_CACHE_SIZE = 50;

let loadSkillsCache: { cwd: string; skills: CachedSkillEntry[]; timestamp: number } | null = null;
const LOAD_SKILLS_CACHE_TTL_MS = 5000;

const CONFIG_DIR = ".pi";
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

const SOURCE_PRIORITY: Record<SkillSource, number> = {
	project: 700,
	"project-settings": 650,
	"project-package": 600,
	user: 300,
	"user-settings": 250,
	"user-package": 200,
	extension: 150,
	builtin: 100,
	unknown: 0,
};

function stripSkillFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return normalized;

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;

	return normalized.slice(endIndex + 4).trim();
}

function isWithinPath(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLikelyFilePath(targetPath: string): boolean {
	return path.extname(targetPath).toLowerCase() === ".md";
}

function matchesPathTarget(filePath: string, targetPath: string): boolean {
	const normalizedFilePath = path.resolve(filePath);
	const normalizedTargetPath = path.resolve(targetPath);
	try {
		const stat = fs.statSync(normalizedTargetPath);
		if (stat.isFile()) return normalizedFilePath === normalizedTargetPath;
	} catch {
		if (isLikelyFilePath(normalizedTargetPath)) return normalizedFilePath === normalizedTargetPath;
	}
	return isWithinPath(normalizedFilePath, normalizedTargetPath);
}

function resolveConfiguredPath(entry: string, base: string): string {
	if (entry.startsWith("~/")) {
		return path.join(os.homedir(), entry.slice(2));
	}
	if (path.isAbsolute(entry)) {
		return path.normalize(entry);
	}
	return path.resolve(base, entry);
}

function hasGlobPattern(value: string): boolean {
	return /[*?[\]{}]/.test(value);
}

function isLocalPackageSource(source: string): boolean {
	return source.startsWith("~/") || source.startsWith("./") || source.startsWith("../") || path.isAbsolute(source);
}

function getPackageSkillPaths(packageRoot: string): string[] {
	const pkgJsonPath = path.join(packageRoot, "package.json");
	try {
		const content = fs.readFileSync(pkgJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		const piSkills = pkg?.pi?.skills;
		if (Array.isArray(piSkills) && piSkills.length > 0) {
			return piSkills
				.filter((s: unknown) => typeof s === "string")
				.map((s: string) => path.resolve(packageRoot, s));
		}
	} catch {
		// Fall back to convention directories below.
	}

	const conventionalSkillsDir = path.join(packageRoot, "skills");
	return fs.existsSync(conventionalSkillsDir) ? [conventionalSkillsDir] : [];
}

function dedupePathHints(paths: SkillPathHint[]): SkillPathHint[] {
	const deduped = new Map<string, SkillPathHint>();
	for (const entry of paths) {
		const key = path.resolve(entry.path);
		const existing = deduped.get(key);
		if (!existing || (SOURCE_PRIORITY[entry.source] ?? 0) > (SOURCE_PRIORITY[existing.source] ?? 0)) {
			deduped.set(key, { path: key, source: entry.source });
		}
	}
	return [...deduped.values()];
}

let cachedGlobalNpmRoot: string | null = null;

function getGlobalNpmRoot(): string | null {
	if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot;
	try {
		cachedGlobalNpmRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
		return cachedGlobalNpmRoot;
	} catch {
		cachedGlobalNpmRoot = ""; // Empty string means "tried but failed"
		return null;
	}
}

function scanPackageRoots(dir: string, source: Extract<SkillSource, "project-package" | "user-package">): SkillPathHint[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const results: SkillPathHint[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		if (entry.name.startsWith("@")) {
			const scopeDir = path.join(dir, entry.name);
			let scopeEntries: fs.Dirent[];
			try {
				scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const scopeEntry of scopeEntries) {
				if (scopeEntry.name.startsWith(".")) continue;
				if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
				const pkgRoot = path.join(scopeDir, scopeEntry.name);
				results.push(...getPackageSkillPaths(pkgRoot).map((skillPath) => ({ path: skillPath, source })));
			}
			continue;
		}

		const pkgRoot = path.join(dir, entry.name);
		results.push(...getPackageSkillPaths(pkgRoot).map((skillPath) => ({ path: skillPath, source })));
	}

	return results;
}

function collectInstalledPackageSkillPaths(cwd: string): SkillPathHint[] {
	const dirs: Array<{ dir: string; source: Extract<SkillSource, "project-package" | "user-package"> }> = [
		{ dir: path.join(cwd, CONFIG_DIR, "npm", "node_modules"), source: "project-package" },
		{ dir: path.join(AGENT_DIR, "npm", "node_modules"), source: "user-package" },
	];

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot) {
		dirs.push({ dir: globalRoot, source: "user-package" });
	}

	return dirs.flatMap(({ dir, source }) => scanPackageRoots(dir, source));
}

function getSettingsFiles(cwd: string): SettingsFileInfo[] {
	return [
		{
			file: path.join(cwd, CONFIG_DIR, "settings.json"),
			base: path.join(cwd, CONFIG_DIR),
			skillSource: "project-settings",
			packageSource: "project-package",
		},
		{
			file: path.join(AGENT_DIR, "settings.json"),
			base: AGENT_DIR,
			skillSource: "user-settings",
			packageSource: "user-package",
		},
	];
}

function collectSettingsSkillPaths(cwd: string): Pick<SkillDiscoveryConfig, "includePaths" | "excludePaths"> {
	const includePaths: SkillPathHint[] = [];
	const excludePaths: string[] = [];

	for (const { file, base, skillSource } of getSettingsFiles(cwd)) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			const settings = JSON.parse(content);
			const skills = settings?.skills;
			if (!Array.isArray(skills)) continue;

			for (const entry of skills) {
				if (typeof entry !== "string") continue;
				const isExcluded = entry.startsWith("-");
				const rawPath = entry.startsWith("-") || entry.startsWith("+") ? entry.slice(1) : entry;
				const resolvedPath = resolveConfiguredPath(rawPath, base);
				if (isExcluded) {
					excludePaths.push(resolvedPath);
				} else {
					includePaths.push({ path: resolvedPath, source: skillSource });
				}
			}
		} catch {}
	}

	return { includePaths, excludePaths };
}

function collectSettingsPackageSkillPaths(cwd: string): Pick<SkillDiscoveryConfig, "includePaths" | "excludePaths"> {
	const includePaths: SkillPathHint[] = [];
	const excludePaths: string[] = [];

	for (const { file, base, packageSource } of getSettingsFiles(cwd)) {
		try {
			const content = fs.readFileSync(file, "utf-8");
			const settings = JSON.parse(content);
			const packages = settings?.packages;
			if (!Array.isArray(packages)) continue;

			for (const entry of packages) {
				let packageSourceValue: string | undefined;
				let skillFilters: unknown;
				if (typeof entry === "string") {
					packageSourceValue = entry;
				} else if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
					packageSourceValue = (entry as { source: string }).source;
					skillFilters = (entry as { skills?: unknown }).skills;
				}

				if (!packageSourceValue || !isLocalPackageSource(packageSourceValue)) continue;
				const packageRoot = resolveConfiguredPath(packageSourceValue, base);
				const defaultSkillPaths = getPackageSkillPaths(packageRoot);
				if (defaultSkillPaths.length === 0) continue;

				if (Array.isArray(skillFilters)) {
					if (skillFilters.length === 0) continue;

					const explicitIncludes = skillFilters
						.filter((filter): filter is string => typeof filter === "string" && filter.length > 0 && !filter.startsWith("!") && !filter.startsWith("-"))
						.map((filter) => resolveConfiguredPath(filter.startsWith("+") ? filter.slice(1) : filter, packageRoot))
						.filter((filterPath) => !hasGlobPattern(filterPath));
					const explicitExcludes = skillFilters
						.filter((filter): filter is string => typeof filter === "string" && filter.length > 0 && (filter.startsWith("!") || filter.startsWith("-")))
						.map((filter) => resolveConfiguredPath(filter.slice(1), packageRoot))
						.filter((filterPath) => !hasGlobPattern(filterPath));

					excludePaths.push(...explicitExcludes);
					const includeCandidates = explicitIncludes.length > 0 ? explicitIncludes : defaultSkillPaths;
					includePaths.push(...includeCandidates.map((skillPath) => ({ path: skillPath, source: packageSource })));
					continue;
				}

				includePaths.push(...defaultSkillPaths.map((skillPath) => ({ path: skillPath, source: packageSource })));
			}
		} catch {}
	}

	return { includePaths, excludePaths };
}

function buildSkillDiscoveryConfig(cwd: string): SkillDiscoveryConfig {
	const defaultSkillPaths: SkillPathHint[] = [
		{ path: path.join(cwd, CONFIG_DIR, "skills"), source: "project" },
		{ path: path.join(AGENT_DIR, "skills"), source: "user" },
	];
	const installedPackagePaths = collectInstalledPackageSkillPaths(cwd);
	const settingsSkillPaths = collectSettingsSkillPaths(cwd);
	const settingsPackagePaths = collectSettingsPackageSkillPaths(cwd);

	return {
		includePaths: dedupePathHints([
			...defaultSkillPaths,
			...installedPackagePaths,
			...settingsSkillPaths.includePaths,
			...settingsPackagePaths.includePaths,
		]),
		excludePaths: [...new Set([...settingsSkillPaths.excludePaths, ...settingsPackagePaths.excludePaths].map((p) => path.resolve(p)))],
	};
}

function inferSkillSource(
	rawSource: unknown,
	filePath: string,
	cwd: string,
	sourceHints: SkillPathHint[],
): SkillSource {
	const hintedSource = sourceHints
		.slice()
		.sort((a, b) => b.path.length - a.path.length)
		.find((hint) => matchesPathTarget(filePath, hint.path))?.source;
	if (hintedSource) return hintedSource;

	const source = typeof rawSource === "string" ? rawSource : "";
	const projectRoot = path.resolve(cwd, CONFIG_DIR);
	const isProjectScoped = isWithinPath(filePath, projectRoot);
	const isUserScoped = isWithinPath(filePath, AGENT_DIR);
	const globalRoot = getGlobalNpmRoot();
	const isGlobalPackage = globalRoot ? isWithinPath(filePath, globalRoot) : false;

	if (source === "project") return "project";
	if (source === "user") return "user";
	if (source === "settings") {
		if (isProjectScoped) return "project-settings";
		if (isUserScoped) return "user-settings";
		return "unknown";
	}
	if (source === "package") {
		if (isProjectScoped) return "project-package";
		if (isUserScoped || isGlobalPackage) return "user-package";
		return "unknown";
	}
	if (source === "extension") return "extension";
	if (source === "builtin") return "builtin";

	if (isProjectScoped) return "project";
	if (isUserScoped) return "user";
	if (isGlobalPackage) return "user-package";
	return "unknown";
}

function chooseHigherPrioritySkill(existing: CachedSkillEntry | undefined, candidate: CachedSkillEntry): CachedSkillEntry {
	if (!existing) return candidate;
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
	const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 0;
	if (candidatePriority > existingPriority) return candidate;
	if (candidatePriority < existingPriority) return existing;
	return candidate.order < existing.order ? candidate : existing;
}

function getCachedSkills(cwd: string): CachedSkillEntry[] {
	const now = Date.now();
	if (loadSkillsCache && loadSkillsCache.cwd === cwd && now - loadSkillsCache.timestamp < LOAD_SKILLS_CACHE_TTL_MS) {
		return loadSkillsCache.skills;
	}

	const discovery = buildSkillDiscoveryConfig(cwd);
	const loaded = loadSkills({
		cwd,
		skillPaths: discovery.includePaths.map((entry) => entry.path),
		includeDefaults: false,
	});
	const dedupedByName = new Map<string, CachedSkillEntry>();

	for (let i = 0; i < loaded.skills.length; i++) {
		const skill = loaded.skills[i] as Skill;
		if (discovery.excludePaths.some((excludePath) => matchesPathTarget(skill.filePath, excludePath))) {
			continue;
		}

		const entry: CachedSkillEntry = {
			name: skill.name,
			filePath: skill.filePath,
			source: inferSkillSource((skill as { source?: unknown }).source, skill.filePath, cwd, discovery.includePaths),
			description: skill.description,
			order: i,
		};
		const current = dedupedByName.get(entry.name);
		dedupedByName.set(entry.name, chooseHigherPrioritySkill(current, entry));
	}

	const skills = [...dedupedByName.values()].sort((a, b) => a.order - b.order);
	loadSkillsCache = { cwd, skills, timestamp: now };
	return skills;
}

export function resolveSkillPath(
	skillName: string,
	cwd: string,
): { path: string; source: SkillSource } | undefined {
	const skills = getCachedSkills(cwd);
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return undefined;
	return { path: skill.filePath, source: skill.source };
}

export function readSkill(
	skillName: string,
	skillPath: string,
	source: SkillSource,
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
		return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
	}
	// Guard against JSON-encoded arrays arriving as strings (e.g. '["a","b"]').
	// Models sometimes serialise the skill parameter as a JSON string instead of
	// a native array, and naively splitting on "," would embed brackets/quotes
	// into the skill names, causing resolution to silently fail.
	const trimmed = input.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return normalizeSkillInput(parsed);
			}
		} catch {
			// Not valid JSON – fall through to comma-split
		}
	}
	return [...new Set(input.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

export function discoverAvailableSkills(cwd: string): Array<{
	name: string;
	source: SkillSource;
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
