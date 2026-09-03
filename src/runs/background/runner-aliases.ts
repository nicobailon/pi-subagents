/**
 * Module aliases for the detached async runner.
 *
 * The runner is a plain Node process started through jiti. The child hooks it
 * loads import pi's host packages (`@earendil-works/pi-coding-agent`,
 * `pi-agent-core`, `pi-ai`, `pi-tui`, `typebox`), which are peer packages of
 * this extension and are not installed next to it. pi's own extension loader
 * aliases those specifiers to the copies shipped inside the installed pi
 * package; the parent computes the same map and hands it to the runner
 * through `JITI_ALIAS`, so the runner's child sessions and hooks share one
 * copy of every host package.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const JITI_ALIAS_ENV = "JITI_ALIAS";

/** Specifiers the runner's import graph may use, with the package and export subpath each resolves to. */
export const HOST_PEER_ALIASES: ReadonlyArray<{ specifier: string; pkg: string; subpath: string }> = [
	{ specifier: "@earendil-works/pi-coding-agent", pkg: "@earendil-works/pi-coding-agent", subpath: "." },
	{ specifier: "@earendil-works/pi-agent-core", pkg: "@earendil-works/pi-agent-core", subpath: "." },
	{ specifier: "@earendil-works/pi-tui", pkg: "@earendil-works/pi-tui", subpath: "." },
	{ specifier: "@earendil-works/pi-ai", pkg: "@earendil-works/pi-ai", subpath: "./compat" },
	{ specifier: "@earendil-works/pi-ai/compat", pkg: "@earendil-works/pi-ai", subpath: "./compat" },
	{ specifier: "@earendil-works/pi-ai/oauth", pkg: "@earendil-works/pi-ai", subpath: "./oauth" },
	{ specifier: "@earendil-works/pi-ai/providers/all", pkg: "@earendil-works/pi-ai", subpath: "./providers/all" },
	{ specifier: "typebox", pkg: "typebox", subpath: "." },
	{ specifier: "typebox/compile", pkg: "typebox", subpath: "./compile" },
	{ specifier: "typebox/value", pkg: "typebox", subpath: "./value" },
];

interface PackageManifest {
	name?: unknown;
	main?: unknown;
	exports?: unknown;
}

function readManifest(packageDir: string): PackageManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8")) as PackageManifest;
	} catch {
		return undefined;
	}
}

/** Pick the import target of one exports entry (string, conditions object, or array of those). */
function exportTarget(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (Array.isArray(entry)) {
		for (const candidate of entry) {
			const target = exportTarget(candidate);
			if (target) return target;
		}
		return undefined;
	}
	if (entry && typeof entry === "object") {
		const conditions = entry as Record<string, unknown>;
		for (const condition of ["import", "node", "default"]) {
			if (condition in conditions) {
				const target = exportTarget(conditions[condition]);
				if (target) return target;
			}
		}
	}
	return undefined;
}

/** Resolve `subpath` of the package at `packageDir` through its `exports` map (with `*` patterns) or `main`. */
export function resolvePackageSubpath(packageDir: string, subpath: string): string | undefined {
	const manifest = readManifest(packageDir);
	if (!manifest) return undefined;
	const exportsField = manifest.exports;
	if (exportsField !== undefined) {
		const map: Record<string, unknown> = typeof exportsField === "string" || Array.isArray(exportsField) || (exportsField && typeof exportsField === "object" && !Object.keys(exportsField as object).some((key) => key.startsWith(".")))
			? { ".": exportsField }
			: exportsField as Record<string, unknown>;
		const exact = exportTarget(map[subpath]);
		if (exact) return path.resolve(packageDir, exact);
		for (const [pattern, entry] of Object.entries(map)) {
			const star = pattern.indexOf("*");
			if (star === -1) continue;
			const prefix = pattern.slice(0, star);
			const suffix = pattern.slice(star + 1);
			if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue;
			const target = exportTarget(entry);
			if (!target) continue;
			const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
			return path.resolve(packageDir, target.replace("*", wildcard));
		}
		return undefined;
	}
	if (subpath !== ".") return undefined;
	return path.resolve(packageDir, typeof manifest.main === "string" && manifest.main.trim() ? manifest.main : "index.js");
}

/** Find `pkg` as the pi package itself, one of its dependencies, or a sibling in a hoisted install. */
export function findHostPeerPackageDir(piPackageRoot: string, pkg: string): string | undefined {
	if (readManifest(piPackageRoot)?.name === pkg) return piPackageRoot;
	const candidates = [path.join(piPackageRoot, "node_modules", pkg)];
	let dir = piPackageRoot;
	for (;;) {
		const parent = path.dirname(dir);
		if (parent === dir) break;
		if (path.basename(parent) === "node_modules" || path.basename(path.dirname(parent)) === "node_modules") {
			const modulesRoot = path.basename(parent) === "node_modules" ? parent : path.dirname(parent);
			candidates.push(path.join(modulesRoot, pkg));
		}
		candidates.push(path.join(parent, "node_modules", pkg));
		dir = parent;
	}
	return candidates.find((candidate) => readManifest(candidate)?.name === pkg);
}

/** The alias map the runner needs, or the specifiers that could not be resolved. */
export function resolveHostPeerAliases(piPackageRoot: string): { aliases: Record<string, string>; missing: string[] } {
	const aliases: Record<string, string> = {};
	const missing: string[] = [];
	for (const { specifier, pkg, subpath } of HOST_PEER_ALIASES) {
		const packageDir = findHostPeerPackageDir(piPackageRoot, pkg);
		const target = packageDir ? resolvePackageSubpath(packageDir, subpath) : undefined;
		if (target && fs.existsSync(target)) aliases[specifier] = target;
		else missing.push(specifier);
	}
	return { aliases, missing };
}
