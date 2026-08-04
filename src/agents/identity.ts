import type { AgentConfig, ChainConfig } from "./agents.ts";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

function normalizePackageName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "");
}

export function parsePackageName(value: unknown, label = "package"): { packageName?: string; error?: string } {
	if (value === undefined || value === false || value === "") return {};
	if (typeof value !== "string") return { error: `${label} must be a string or false when provided.` };
	const packageName = normalizePackageName(value);
	if (!packageName || !IDENTIFIER_PATTERN.test(packageName)) return { error: `${label} is invalid after sanitization.` };
	return { packageName };
}

export function buildRuntimeName(localName: string, packageName?: string): string {
	const trimmedPackage = packageName?.trim();
	return trimmedPackage ? `${trimmedPackage}.${localName}` : localName;
}

export function frontmatterNameForConfig(config: Pick<AgentConfig | ChainConfig, "name" | "localName" | "packageName">): string {
	if (config.localName) return config.localName;
	if (config.packageName && config.name.startsWith(`${config.packageName}.`)) {
		return config.name.slice(config.packageName.length + 1);
	}
	return config.name;
}
