import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncWidgetPlacement, ExtensionConfig } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "subagent", "config.json");
}

function readConfigForUpdate(configPath = getConfigPath()): ExtensionConfig {
	if (!fs.existsSync(configPath)) return {};
	const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Subagent config at '${configPath}' must be a JSON object`);
	}
	return parsed as ExtensionConfig;
}

export function saveConfig(config: ExtensionConfig, configPath = getConfigPath()): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
}

export function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig {
	const configPath = getConfigPath();
	const next = updater(readConfigForUpdate(configPath));
	saveConfig(next, configPath);
	return next;
}

export function resolveAsyncWidgetPlacement(
	config: Pick<ExtensionConfig, "asyncWidgetPlacement">,
	warn: (message: string) => void = console.warn,
): AsyncWidgetPlacement {
	const placement = config.asyncWidgetPlacement;
	if (placement === undefined || placement === "aboveEditor") return "aboveEditor";
	if (placement === "belowEditor") return "belowEditor";
	warn(`[pi-subagents] Ignoring invalid asyncWidgetPlacement ${JSON.stringify(placement)}; expected "aboveEditor" or "belowEditor".`);
	return "aboveEditor";
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
