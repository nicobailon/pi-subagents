import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";

export function findPiPackageRootFromEntry(
	entryPoint: string,
	deps: Pick<PiSpawnDeps, "platform" | "existsSync" | "readFileSync"> = {},
): string | undefined {
	const pathApi = (deps.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
	const existsSync = deps.existsSync ?? fs.existsSync;
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	let dir = pathApi.dirname(entryPoint);
	while (dir !== pathApi.dirname(dir)) {
		const packageJsonPath = pathApi.join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
				name?: unknown;
			};
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = pathApi.dirname(dir);
	}
	return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
	try {
		return findPiPackageRootFromEntry(
			fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)),
		);
	} catch {
		return undefined;
	}
}

export function resolvePiPackageRoot(): string | undefined {
	try {
		const entry = process.argv[1];
		return entry
			? findPiPackageRootFromEntry(fs.realpathSync(entry))
			: undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

export interface PiSpawnDeps {
	platform?: NodeJS.Platform;
	execPath?: string;
	argv1?: string;
	bunVersion?: string;
	existsSync?: (filePath: string) => boolean;
	realpathSync?: (filePath: string) => string;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
	env?: NodeJS.ProcessEnv;
}

export type RunningPiPackageRoot =
	| { root: string; source: "argv" | "PI_PACKAGE_DIR" | "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" | "bun-adjacent" | "bun-share" }
	| { reason: string };

function validateRunningPiRoot(
	root: string,
	source: Exclude<RunningPiPackageRoot, { reason: string }>["source"],
	readFileSync: (filePath: string, encoding: "utf-8") => string,
	manifestPath: string,
): RunningPiPackageRoot {
	const sourceLabel = source === "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" ? `${source} override` : source;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { reason: `Could not read a valid Pi package manifest at ${manifestPath} (${sourceLabel}): ${message}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { name?: unknown }).name !== PI_CODING_AGENT_PACKAGE) {
		return { reason: `${manifestPath} is not ${PI_CODING_AGENT_PACKAGE} (${sourceLabel})` };
	}
	return { root, source };
}

/** Resolve only package roots that can be attributed to the process that owns this session. */
export function resolveRunningPiPackageRoot(deps: PiSpawnDeps = {}): RunningPiPackageRoot | undefined {
	const env = deps.env ?? process.env;
	const platform = deps.platform ?? process.platform;
	const pathApi = platform === "win32" ? path.win32 : path.posix;
	const argv1 = deps.argv1 ?? process.argv[1];
	const readFileSync = deps.readFileSync ?? ((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;

	if (argv1) {
		let entry: string | undefined;
		try {
			entry = realpathSync(argv1);
		} catch {
			// Virtual Bun entries and non-filesystem launchers continue to explicit host evidence.
		}
		if (entry) {
			try {
				const root = findPiPackageRootFromEntry(entry, { platform, existsSync, readFileSync });
				if (root) return { root, source: "argv" };
			} catch (error) {
				return { reason: `Could not inspect the running Pi entry at ${entry}: ${error instanceof Error ? error.message : String(error)}` };
			}
		}
	}

	for (const [source, value] of [
		[PI_PACKAGE_DIR_ENV, env[PI_PACKAGE_DIR_ENV]],
		[PI_CODING_AGENT_PACKAGE_ROOT_ENV, env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]],
	] as const) {
		const root = value?.trim();
		if (root) return validateRunningPiRoot(root, source, readFileSync, pathApi.join(root, "package.json"));
	}

	const bunVersion = deps.bunVersion ?? process.versions.bun;
	if (!bunVersion || !argv1 || !/^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(argv1)) return undefined;
	const imagePath = deps.execPath ?? process.execPath;
	let canonicalImage = imagePath;
	try {
		canonicalImage = realpathSync(imagePath);
	} catch {
		// A validated adjacent manifest can still establish ownership when canonicalization is unavailable.
	}
	const imageDir = pathApi.dirname(canonicalImage);
	const candidates = [
		{ root: imageDir, source: "bun-adjacent" as const },
		{ root: pathApi.resolve(imageDir, "..", "share", "pi-coding-agent"), source: "bun-share" as const },
	];
	for (const candidate of candidates) {
		const manifestPath = pathApi.join(candidate.root, "package.json");
		if (!existsSync(manifestPath)) continue;
		return validateRunningPiRoot(candidate.root, candidate.source, readFileSync, manifestPath);
	}
	return undefined;
}

/** Compiled Pi's entrypoint is virtual; execPath is the real (possibly renamed) image. */
export function resolveBunPiExecutable(deps: PiSpawnDeps = {}): string | undefined {
	const bunVersion = deps.bunVersion ?? process.versions.bun;
	const entry = deps.argv1 ?? process.argv[1];
	if (!bunVersion || !entry || !/^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/.test(entry)) return undefined;
	const env = deps.env ?? process.env;
	return env[PI_SUBAGENT_PI_BINARY_ENV]?.trim() || (deps.execPath ?? process.execPath);
}

interface PiSpawnCommand {
	command: string;
	args: string[];
}

interface PiPackageJson {
	name?: unknown;
	bin?: string | Record<string, string>;
}

function isNodeScriptPath(filePath: string): boolean {
	return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function isRunnableNodeScript(
	filePath: string,
	existsSync: (filePath: string) => boolean,
): boolean {
	if (!existsSync(filePath)) return false;
	return isNodeScriptPath(filePath);
}

function normalizePath(filePath: string): string {
	return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

function isStandalonePiExecutable(execPath: string): boolean {
	const executableName = execPath.split(/[\\/]/).pop();
	return /^pi(?:\.exe)?$/i.test(executableName ?? "");
}

function resolvePiCliScriptFromPackageJson(
	packageJsonPath: string,
	readFileSync: (filePath: string, encoding: "utf-8") => string,
	existsSync: (filePath: string) => boolean,
): string | undefined {
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PiPackageJson;
	if (packageJson.name !== PI_CODING_AGENT_PACKAGE) return undefined;
	const binField = packageJson.bin;
	const binPath =
		typeof binField === "string"
			? binField
			: (binField?.pi ?? Object.values(binField ?? {})[0]);
	if (!binPath) return undefined;
	const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
	return isRunnableNodeScript(candidate, existsSync) ? candidate : undefined;
}

export function resolvePiCliScript(
	deps: PiSpawnDeps = {},
): string | undefined {
	const existsSync = deps.existsSync ?? fs.existsSync;
	const realpathSync = deps.realpathSync ?? fs.realpathSync;
	const readFileSync =
		deps.readFileSync ??
		((filePath, encoding) => fs.readFileSync(filePath, encoding));
	const argv1 = deps.argv1 ?? process.argv[1];
	const env = deps.env ?? process.env;

	if (argv1) {
		const argvPath = normalizePath(argv1);
		if (isRunnableNodeScript(argvPath, existsSync)) {
			try {
				const canonicalArgvPath = realpathSync(argvPath);
				if (isRunnableNodeScript(canonicalArgvPath, existsSync) && findPiPackageRootFromEntry(canonicalArgvPath)) {
					return canonicalArgvPath;
				}
			} catch {
				// Host package metadata is untrusted here; keep resolving the installed Pi CLI.
			}
		}
	}

	const packageJsonCandidates: Array<() => string | undefined> = [];
	if (deps.resolvePackageJson) packageJsonCandidates.push(deps.resolvePackageJson);
	for (const root of [deps.piPackageRoot, env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], resolvePiPackageRoot()]) {
		const trimmed = root?.trim();
		if (trimmed) packageJsonCandidates.push(() => path.join(trimmed, "package.json"));
	}
	packageJsonCandidates.push(() => {
		const packageRoot = deps.resolvePackageEntry
			? findPiPackageRootFromEntry(deps.resolvePackageEntry())
			: resolveInstalledPiPackageRoot();
		return packageRoot ? path.join(packageRoot, "package.json") : undefined;
	});

	for (const candidatePackageJson of packageJsonCandidates) {
		try {
			const packageJsonPath = candidatePackageJson();
			if (!packageJsonPath) continue;
			const candidate = resolvePiCliScriptFromPackageJson(packageJsonPath, readFileSync, existsSync);
			if (candidate) return candidate;
		} catch {
			// Keep resolving; callers decide whether a PATH fallback is safe.
		}
	}

	return undefined;
}

export function getPiSpawnCommand(
	args: string[],
	deps: PiSpawnDeps = {},
): PiSpawnCommand {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const piBinary = env[PI_SUBAGENT_PI_BINARY_ENV]?.trim();
	if (piBinary) {
		if (platform === "win32" && isNodeScriptPath(piBinary)) {
			return {
				command: deps.execPath ?? process.execPath,
				args: [piBinary, ...args],
			};
		}
		return { command: piBinary, args };
	}

	const execPath = deps.execPath ?? process.execPath;
	if (isStandalonePiExecutable(execPath)) {
		return { command: execPath, args };
	}

	const piCliPath = resolvePiCliScript(deps);
	if (piCliPath) {
		return {
			command: execPath,
			args: [piCliPath, ...args],
		};
	}
	if (platform === "win32") {
		throw new Error(
			`Could not resolve the Pi CLI on Windows. Set ${PI_SUBAGENT_PI_BINARY_ENV} or ensure ${PI_CODING_AGENT_PACKAGE} is installed.`,
		);
	}

	return { command: "pi", args };
}
