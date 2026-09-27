import * as fs from "node:fs";

let resolved = false;
let cachedScope: string | undefined;

/** Linux PID namespace identity, cached because reconciliation is a polling path. */
export function currentPidNamespaceScope(): string | undefined {
	if (resolved) return cachedScope;
	resolved = true;
	if (process.platform !== "linux") return undefined;
	try {
		const scope = fs.readlinkSync("/proc/self/ns/pid", "utf-8").trim();
		cachedScope = scope || undefined;
	} catch {
		cachedScope = undefined;
	}
	return cachedScope;
}
