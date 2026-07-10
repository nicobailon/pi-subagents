import { isAbsolute, join } from "node:path";

export function resolveHomeDir(): string {
	if (process.env.HOME) return process.env.HOME;
	if (process.env.USERPROFILE) return process.env.USERPROFILE;
	if (process.env.LOCALAPPDATA) return process.env.USERPROFILE ?? process.env.HOME ?? process.env.LOCALAPPDATA;
	return require("node:os").homedir();
}

export function toAbsolute(value: string | undefined, fallback: string): string {
	const home = resolveHomeDir();
	const base = join(home, ".pi");
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "." || trimmed === "..") return fallback;
	if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
	if (isAbsolute(trimmed)) return trimmed;
	if (trimmed.startsWith("/")) return trimmed;
	// Treat bare filename or relative path as anchored under ~/.pi/agent
	return join(base, "agent", trimmed);
}
