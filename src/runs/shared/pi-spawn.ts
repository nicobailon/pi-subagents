import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(
	entryPoint: string,
): string | undefined {
	let dir = path.dirname(entryPoint);
	while (dir !== path.dirname(dir)) {
		const packageJsonPath = path.join(dir, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
				name?: unknown;
			};
			if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
		}
		dir = path.dirname(dir);
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
	existsSync?: (filePath: string) => boolean;
	realpathSync?: (filePath: string) => string;
	readFileSync?: (filePath: string, encoding: "utf-8") => string;
	resolvePackageJson?: () => string;
	resolvePackageEntry?: () => string;
	piPackageRoot?: string;
	env?: NodeJS.ProcessEnv;
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
