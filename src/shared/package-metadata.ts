import * as fs from "node:fs";

interface PackageMetadata {
	readonly name: string;
	readonly version: string;
}

function loadPackageMetadata(): PackageMetadata {
	const packagePath = new URL("../../package.json", import.meta.url);
	const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as { name?: unknown; version?: unknown };
	if (typeof parsed.name !== "string" || !parsed.name.trim()) {
		throw new Error(`Invalid package name in '${packagePath.pathname}'.`);
	}
	if (typeof parsed.version !== "string" || !parsed.version.trim()) {
		throw new Error(`Invalid package version in '${packagePath.pathname}'.`);
	}
	return Object.freeze({ name: parsed.name, version: parsed.version });
}

/** Canonical runtime identity derived from the package manifest shipped with this module. */
export const PACKAGE_METADATA = loadPackageMetadata();
