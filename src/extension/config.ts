import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Key } from "@earendil-works/pi-tui";
import { FLEET_KEYBINDING_ACTIONS, type ArtifactDirPreference, type ExtensionConfig } from "../shared/types.ts";
import { validateMissionStoreConfig } from "../missions/store.ts";
import { validateAuthorityPolicy } from "../policy/authority.ts";
import { getAgentDir } from "../shared/utils.ts";
import { validatePermissionConfig } from "../runs/shared/permissions.ts";
import { MAX_ABANDONED_SLOT_RELEASE_AFTER_MS, MIN_ABANDONED_SLOT_RELEASE_AFTER_MS } from "../runs/background/active-async-capacity.ts";
import { normalizeWorktreeBranchPrefix } from "../runs/shared/worktree.ts";
import { validateModelResponseAliases } from "../shared/model-response-aliases.ts";
import { validateDisabledFeatures } from "../shared/disabled-features.ts";

// Explicit route identity, worktree, checkpoint, and tool-surface policies must not be silently
// discarded and replaced by the built-in defaults after validation fails.
const FAIL_CLOSED_CONFIG_KEYS = ["worktreeProvider", "worktreeBranchPrefix", "modelResponseAliases", "modelExclusions", "checkpointBeforeDeadlineMs", "disabledFeatures", "scheduledRuns", "toolActivation", "authorityPolicy", "permissions", "toolBudget"];

const ARTIFACT_DIR_PREFERENCES = new Set<ArtifactDirPreference>(["project", "session", "temp"]);
const FLEET_KEYBINDING_ACTION_SET = new Set<string>(FLEET_KEYBINDING_ACTIONS);
const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const BASE_KEY_IDS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	...Object.values(Key).flatMap((value) => typeof value === "string" ? [value.toLowerCase()] : []),
]);

class PrunedForkConfigError extends Error {}

function validateForkContextConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.forkContext must be a JSON object");
	const config = value as Record<string, unknown>;
	if (config.mode !== undefined && config.mode !== "full" && config.mode !== "pruned") {
		throw new Error('config.forkContext.mode must be "full" or "pruned"');
	}
	if (config.model !== undefined && (typeof config.model !== "string" || !config.model.trim())) {
		throw new PrunedForkConfigError("config.forkContext.model must be a non-empty string");
	}
	if (config.mode === "pruned" && config.model === undefined) {
		throw new PrunedForkConfigError('config.forkContext.model is required when config.forkContext.mode is "pruned"');
	}
}

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
	const enabled = (value as Record<string, unknown>).enabled;
	if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("config.scheduledRuns.enabled must be a boolean");
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

function validateCapacityConfig(value: unknown): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.capacity must be a JSON object");
	const abandonedSlotReleaseAfterMs = (value as Record<string, unknown>).abandonedSlotReleaseAfterMs;
	if (abandonedSlotReleaseAfterMs !== undefined
		&& abandonedSlotReleaseAfterMs !== false
		&& (typeof abandonedSlotReleaseAfterMs !== "number"
			|| !Number.isInteger(abandonedSlotReleaseAfterMs)
			|| abandonedSlotReleaseAfterMs < MIN_ABANDONED_SLOT_RELEASE_AFTER_MS
			|| abandonedSlotReleaseAfterMs > MAX_ABANDONED_SLOT_RELEASE_AFTER_MS)) {
		throw new Error(`config.capacity.abandonedSlotReleaseAfterMs must be false or an integer from ${MIN_ABANDONED_SLOT_RELEASE_AFTER_MS} to ${MAX_ABANDONED_SLOT_RELEASE_AFTER_MS}`);
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
	if (config.worktree !== undefined && typeof config.worktree !== "boolean") {
		throw new Error("config.worktree must be a boolean");
	}
	if (config.worktreeProvider !== undefined && config.worktreeProvider !== "auto" && config.worktreeProvider !== "native" && config.worktreeProvider !== "worktrunk") {
		throw new Error('config.worktreeProvider must be "auto", "native", or "worktrunk"');
	}
	if (config.worktreeBranchPrefix !== undefined) {
		if (typeof config.worktreeBranchPrefix !== "string") throw new Error("config.worktreeBranchPrefix must be a string");
		normalizeWorktreeBranchPrefix(config.worktreeBranchPrefix);
	}
	if (config.defaultSubagentContext !== undefined && config.defaultSubagentContext !== "fresh" && config.defaultSubagentContext !== "fork") {
		throw new Error('config.defaultSubagentContext must be "fresh" or "fork"');
	}
	validateForkContextConfig(config.forkContext);
	if (config.checkpointBeforeDeadlineMs !== undefined
		&& (typeof config.checkpointBeforeDeadlineMs !== "number"
			|| !Number.isInteger(config.checkpointBeforeDeadlineMs)
			|| config.checkpointBeforeDeadlineMs <= 0
			|| config.checkpointBeforeDeadlineMs > 2_147_483_647)) {
		throw new Error("config.checkpointBeforeDeadlineMs must be a positive integer no larger than 2147483647");
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
	if (config.resultScanLogging !== undefined && config.resultScanLogging !== "all" && config.resultScanLogging !== "activity" && config.resultScanLogging !== "off") {
		throw new Error('config.resultScanLogging must be "all", "activity", or "off"');
	}
	if (config.asyncWidgetCollapsed !== undefined && typeof config.asyncWidgetCollapsed !== "boolean") {
		throw new Error("config.asyncWidgetCollapsed must be a boolean");
	}
	if (config.toolActivation !== undefined && config.toolActivation !== "auto" && config.toolActivation !== "dynamic" && config.toolActivation !== "eager") {
		throw new Error('config.toolActivation must be "auto", "dynamic", or "eager"');
	}
	validateMissionStoreConfig(config.missions);
	validateAuthorityPolicy(config.authorityPolicy);
	validatePermissionConfig(config.permissions);
	validateScheduledRunsConfig(config.scheduledRuns);
	validateDisabledFeatures(config.disabledFeatures);
	validateFleetKeybindingsConfig(config.fleetKeybindings);
	validateArtifactConfig(config.artifactConfig);
	validateCapacityConfig(config.capacity);
	if (config.modelExclusions !== undefined) throw new Error("config.modelExclusions was removed; model failures are no longer persisted or used for automatic switching");
	validateModelResponseAliases(config.modelResponseAliases);
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
		if (error instanceof PrunedForkConfigError) throw error;
		try {
			const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
			if (raw && typeof raw === "object" && !Array.isArray(raw) && FAIL_CLOSED_CONFIG_KEYS.some((key) => Object.hasOwn(raw, key))) throw error;
		} catch (readError) {
			if (readError === error) throw error;
		}
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
