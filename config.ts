import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionConfig } from "./types.js";

const DEFAULT_AGENT_MANAGER_NEW_KEYS = ["ctrl+n", "alt+n"];
const PROJECT_CONFIG_DIR = ".pi";

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
	try {
		if (!fs.existsSync(filePath)) return undefined;
		return asObject(JSON.parse(fs.readFileSync(filePath, "utf-8")));
	} catch {
		return undefined;
	}
}

function readSettingsConfig(filePath: string): Record<string, unknown> | undefined {
	const settings = readJsonFile(filePath);
	return asObject(settings?.["pi-subagents"]);
}

function normalizeKeybindingList(value: unknown, fallback: string[]): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) {
		const keys = value.filter((item): item is string => typeof item === "string" && item.length > 0);
		if (keys.length > 0) return keys;
	}
	return [...fallback];
}

export function loadExtensionConfig(cwd?: string, homeDir = os.homedir()): ExtensionConfig {
	const agentDir = path.join(homeDir, ".pi", "agent");
	const legacyConfig = readJsonFile(path.join(agentDir, "extensions", "subagent", "config.json"));
	const userSettings = readSettingsConfig(path.join(agentDir, "settings.json"));
	const projectSettings = cwd ? readSettingsConfig(path.join(cwd, PROJECT_CONFIG_DIR, "settings.json")) : undefined;

	const mergedKeybindings = {
		...asObject(legacyConfig?.keybindings),
		...asObject(userSettings?.keybindings),
		...asObject(projectSettings?.keybindings),
	};

	const asyncByDefault =
		typeof projectSettings?.asyncByDefault === "boolean"
			? projectSettings.asyncByDefault
			: typeof userSettings?.asyncByDefault === "boolean"
				? userSettings.asyncByDefault
				: typeof legacyConfig?.asyncByDefault === "boolean"
					? legacyConfig.asyncByDefault
					: undefined;

	const defaultSessionDir =
		typeof projectSettings?.defaultSessionDir === "string"
			? projectSettings.defaultSessionDir
			: typeof userSettings?.defaultSessionDir === "string"
				? userSettings.defaultSessionDir
				: typeof legacyConfig?.defaultSessionDir === "string"
					? legacyConfig.defaultSessionDir
					: undefined;

	return {
		...(asyncByDefault !== undefined ? { asyncByDefault } : {}),
		...(defaultSessionDir !== undefined ? { defaultSessionDir } : {}),
		keybindings: {
			agentManagerNew: normalizeKeybindingList(mergedKeybindings.agentManagerNew, DEFAULT_AGENT_MANAGER_NEW_KEYS),
		},
	};
}
