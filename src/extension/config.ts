import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Key } from "@earendil-works/pi-tui";
import { FLEET_KEYBINDING_ACTIONS, type ArtifactDirPreference, type ExtensionConfig } from "../shared/types.ts";
import { validateMissionStoreConfig } from "../missions/store.ts";
import { validateAuthorityPolicy } from "../policy/authority.ts";
import { getAgentDir } from "../shared/utils.ts";
import { validatePermissionConfig } from "../runs/shared/permissions.ts";

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>(["project", "session", "temp"]);
const FLEET_KEYBINDING_ACTION_SET = new Set<string>(FLEET_KEYBINDING_ACTIONS);
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEY_IDS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	...Object.values(Key).flatMap((value) => typeof value === "string" ? [value.toLowerCase()] : []),
]);

function isValidKeyId(value: string): boolean {
	if (value !== value.trim()) return false;
	const parts = value.toLowerCase().split("+");
	const base = parts.pop();
	if (!base || !BASE_KEY_IDS.has(base)) return false;
	return parts.length <= KEY_MODIFIERS.size
		&& new Set(parts).size === parts.length
		&& parts.every((modifier) => KEY_MODIFIERS.has(modifier));
}

export function resolveScheduledStoreRoot(value: string): string {
	const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	if (!path.isAbsolute(expanded)) throw new Error(`config.scheduledRuns.storeRoot must be an absolute path or "~/...", got ${JSON.stringify(value)}`);
	return path.normalize(expanded);
}

function validateScheduledRunsConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.scheduledRuns must be a JSON object");
	const storeRoot = (value as Record<string, unknown>).storeRoot;
	if (storeRoot === undefined) return;
	if (typeof storeRoot !== "string" || !storeRoot.trim()) throw new Error("config.scheduledRuns.storeRoot must be a non-empty string");
	resolveScheduledStoreRoot(storeRoot);
}

function validateFleetKeybindingsConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.fleetKeybindings must be a JSON object");
	for (const [action, bindings] of Object.entries(value)) {
		if (!FLEET_KEYBINDING_ACTION_SET.has(action)) throw new Error(`config.fleetKeybindings.${action} is not a supported Fleet action`);
		if (!Array.isArray(bindings) || bindings.length === 0) throw new Error(`config.fleetKeybindings.${action} must be a non-empty array of strings`);
		for (const binding of bindings) {
			if (typeof binding !== "string" || !binding.trim()) throw new Error(`config.fleetKeybindings.${action} entries must be non-empty strings`);
		}
	}
}

function validateArtifactConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.artifactConfig must be a JSON object");
	const cleanupDays = (value as Record<string, unknown>).cleanupDays;
	if (cleanupDays !== undefined && (typeof cleanupDays !== "number" || !Number.isInteger(cleanupDays) || cleanupDays < 0)) {
		throw new Error("config.artifactConfig.cleanupDays must be a non-negative integer");
	}
}

function validateOrcaProgressTabsConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.orcaProgressTabs must be a JSON object");
	const config = value as Record<string, unknown>;
	for (const key of Object.keys(config)) {
		if (key !== "enabled") throw new Error(`config.orcaProgressTabs.${key} is not supported`);
	}
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		throw new Error("config.orcaProgressTabs.enabled must be a boolean");
	}
}

function validateMainWindowRendererConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.mainWindowRenderer must be a JSON object");
	const rendererConfig = value as Record<string, unknown>;
	if (rendererConfig.horizontalSpacing !== undefined
		&& (typeof rendererConfig.horizontalSpacing !== "number"
			|| !Number.isInteger(rendererConfig.horizontalSpacing)
			|| rendererConfig.horizontalSpacing < 0
			|| rendererConfig.horizontalSpacing > 4)) {
		throw new Error("config.mainWindowRenderer.horizontalSpacing must be an integer from 0 to 4");
	}
	if (rendererConfig.compactResultMaxLines !== undefined
		&& (typeof rendererConfig.compactResultMaxLines !== "number"
			|| !Number.isInteger(rendererConfig.compactResultMaxLines)
			|| rendererConfig.compactResultMaxLines < 1)) {
		throw new Error("config.mainWindowRenderer.compactResultMaxLines must be a positive integer");
	}
}

function validateConfig(config: Record<string, unknown>): void {
	if (config.defaultSubagentContext !== undefined && config.defaultSubagentContext !== "fresh" && config.defaultSubagentContext !== "fork") {
		throw new Error('config.defaultSubagentContext must be "fresh" or "fork"');
	}
	if (config.foregroundDetachShortcut !== undefined
		&& (typeof config.foregroundDetachShortcut !== "string" || !isValidKeyId(config.foregroundDetachShortcut))) {
		throw new Error("config.foregroundDetachShortcut must be a valid keybinding string such as \"ctrl+b\"");
	}
	if (config.artifactDir !== undefined && !ARTIFACT_DIR_PREFERENCES.has(config.artifactDir as ArtifactDirPreference)) {
		throw new Error(`config.artifactDir must be "project", "session", or "temp"`);
	}
	if (config.maxActiveAsyncRunsPerSession !== undefined
		&& (typeof config.maxActiveAsyncRunsPerSession !== "number"
			|| !Number.isInteger(config.maxActiveAsyncRunsPerSession)
			|| config.maxActiveAsyncRunsPerSession < 0)) {
		throw new Error("config.maxActiveAsyncRunsPerSession must be a non-negative integer");
	}
	validateMissionStoreConfig(config.missions);
	validateAuthorityPolicy(config.authorityPolicy);
	validatePermissionConfig(config.permissions);
	validateScheduledRunsConfig(config.scheduledRuns);
	validateFleetKeybindingsConfig(config.fleetKeybindings);
	validateArtifactConfig(config.artifactConfig);
	validateMainWindowRendererConfig(config.mainWindowRenderer);
	validateOrcaProgressTabsConfig(config.orcaProgressTabs);
}

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
	}
	validateConfig(parsed as Record<string, unknown>);
	return parsed as ExtensionConfig;
}

export function saveConfig(config: ExtensionConfig, configPath = getConfigPath()): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

export function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig {
	const configPath = getConfigPath();
	const next = updater(readConfigForUpdate(configPath));
	validateConfig(next as Record<string, unknown>);
	saveConfig(next, configPath);
	return next;
}

export function resolveAsyncByDefault(config: Pick<ExtensionConfig, "asyncByDefault">): boolean {
	return config.asyncByDefault !== false;
}

export function loadConfig(): ExtensionConfig {
	const configPath = getConfigPath();
	try {
		return readConfigForUpdate(configPath);
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
