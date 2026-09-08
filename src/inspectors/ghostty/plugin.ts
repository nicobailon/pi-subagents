import { openGhosttyInspector, type GhosttyRunner } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";

export interface GhosttyPluginDeps {
	platform?: NodeJS.Platform;
	runner?: GhosttyRunner;
}

export function createGhosttyInspectorPlugin(deps: GhosttyPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	return {
		name: "ghostty",
		available: (context) => platform === "darwin" && context.env.TERM_PROGRAM?.toLowerCase() === "ghostty",
		owns: () => false,
		open: (context, launch, params) => openGhosttyInspector(context, launch, params, deps.runner),
	};
}
