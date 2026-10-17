import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
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

export function resolvePiPackageRoot(entry = process.argv[1]): string | undefined {
	try {
		return entry
			? findPiPackageRootFromEntry(fs.realpathSync(entry))
			: undefined;
	} catch {
		// process.argv[1] probing is best-effort; callers can fall back to PATH/package resolution.
		return undefined;
	}
}

/** Resolve only the canonical host entry's local dependency graph, not NODE_PATH/global stores. */
export function resolveHostDependencyPiPackageRoot(entry = process.argv[1]): string | undefined {
	let canonicalEntry: string;
	try {
		if (!entry) return undefined;
		canonicalEntry = fs.realpathSync(entry);
	} catch {
		return undefined;
	}
	const localPaths = new Set<string>();
	let dir = path.dirname(canonicalEntry);
	for (;;) {
		localPaths.add(path.join(dir, "node_modules"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// require.resolve(package) cannot resolve Pi's import-only root export.
	for (const modules of createRequire(canonicalEntry).resolve.paths(PI_CODING_AGENT_PACKAGE) ?? []) {
		if (!localPaths.has(modules)) continue;
		const root = path.join(modules, PI_CODING_AGENT_PACKAGE);
		try {
			fs.lstatSync(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		// The first installed candidate is authoritative, including broken links/manifests.
		const canonicalRoot = fs.realpathSync(root);
		readPiPackageJson(path.join(canonicalRoot, "package.json"));
		return canonicalRoot;
	}
	return undefined;
}

/** One SDK root for foreground imports and detached peer aliases; never retry a selected root. */
export function resolveHostPiPackageRoot(): string | undefined {
	const root = resolvePiPackageRoot()
		?? (process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim() || undefined)
		?? resolveHostDependencyPiPackageRoot()
		?? resolveInstalledPiPackageRoot();
	if (root) readPiPackageJson(path.join(root, "package.json"));
	return root;
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

function readPiPackageJson(
	packageJsonPath: string,
	readFileSync: (filePath: string, encoding: "utf-8") => string = (filePath, encoding) => fs.readFileSync(filePath, encoding),
): PiPackageJson {
	const source = readFileSync(packageJsonPath, "utf-8");
	let pkg: unknown;
	try {
		pkg = JSON.parse(source);
	} catch (error) {
		throw new Error(`invalid host SDK manifest at ${packageJsonPath}: malformed JSON`, { cause: error });
	}
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
		throw new Error(`invalid host SDK manifest at ${packageJsonPath}: expected a JSON object`);
	}
	if ((pkg as PiPackageJson).name !== PI_CODING_AGENT_PACKAGE) {
		throw new Error(`invalid host SDK manifest at ${packageJsonPath}: expected "${PI_CODING_AGENT_PACKAGE}"`);
	}
	return pkg as PiPackageJson;
}

function resolvePiCliScriptFromPackageJson(
	packageJsonPath: string,
	readFileSync: (filePath: string, encoding: "utf-8") => string,
	existsSync: (filePath: string) => boolean,
): string | undefined {
	const packageJson = readPiPackageJson(packageJsonPath, readFileSync);
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

	const selectedRoot = resolvePiPackageRoot(argv1)
		?? (deps.piPackageRoot?.trim() || undefined)
		?? (env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]?.trim() || undefined)
		?? resolveHostDependencyPiPackageRoot(argv1);
	if (selectedRoot) {
		const cli = resolvePiCliScriptFromPackageJson(path.join(selectedRoot, "package.json"), readFileSync, existsSync);
		if (!cli) throw new Error(`Selected Pi package at ${selectedRoot} has no runnable CLI script`);
		return cli;
	}

	// Installed CLI discovery remains best-effort; authoritative host/override roots above fail closed.
	const packageJsonCandidates: Array<() => string | undefined> = [];
	if (deps.resolvePackageJson) packageJsonCandidates.push(deps.resolvePackageJson);
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
