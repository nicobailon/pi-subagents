import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FLEET_KEYBINDING_ACTIONS, type ArtifactDirPreference, type ExtensionConfig } from "../shared/types.ts";
import { validateMissionStoreConfig } from "../missions/store.ts";
import { validateAuthorityPolicy } from "../policy/authority.ts";
import { getAgentDir } from "../shared/utils.ts";
import { validatePermissionConfig } from "../runs/shared/permissions.ts";

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>(["project", "session", "temp"]);
const FLEET_KEYBINDING_ACTION_SET = new Set<string>(FLEET_KEYBINDING_ACTIONS);

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

function validateConfig(config: Record<string, unknown>): void {
	if (config.artifactDir !== undefined && !ARTIFACT_DIR_PREFERENCES.has(config.artifactDir as ArtifactDirPreference)) {
		throw new Error(`config.artifactDir must be "project", "session", or "temp"`);
	}
	if (config.legacyChainControls !== undefined && typeof config.legacyChainControls !== "boolean") {
		throw new Error("config.legacyChainControls must be a boolean");
	}
	validateMissionStoreConfig(config.missions);
	validateAuthorityPolicy(config.authorityPolicy);
	validatePermissionConfig(config.permissions);
	validateScheduledRunsConfig(config.scheduledRuns);
	validateFleetKeybindingsConfig(config.fleetKeybindings);
	validateArtifactConfig(config.artifactConfig);
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
