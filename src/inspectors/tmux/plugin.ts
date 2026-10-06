import { closeTmuxInspector, openTmuxInspector, readTmuxInspectorBindingForTarget, statusTmuxInspector } from "./actions.ts";
import { createTmuxClient, type TmuxClient } from "./client.ts";
import type { InspectorPlugin } from "../types.ts";

export interface TmuxPluginDeps {
	platform?: NodeJS.Platform;
	client?: TmuxClient;
}

export function createTmuxInspectorPlugin(deps: TmuxPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	const client = deps.client ?? createTmuxClient();
	return {
		name: "tmux",
		available: (context) => platform !== "win32" && Boolean(context.env.TMUX),
		owns: (context) => readTmuxInspectorBindingForTarget(context.target) !== undefined,
		open: (context, launch, params) => openTmuxInspector(context, launch, params.focus === true, client),
		status: (context) => statusTmuxInspector(context, client),
		close: (context) => closeTmuxInspector(context, client),
	};
}
