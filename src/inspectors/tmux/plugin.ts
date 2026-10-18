import { loadConfig } from "../../extension/config.ts";
import { closeTmuxInspector, openTmuxInspector, readTmuxInspectorBindingForTarget, statusTmuxInspector, type TmuxInspectorLayout } from "./actions.ts";
import { createTmuxClient, type TmuxClient } from "./client.ts";
import type { InspectorPlugin } from "../types.ts";

export interface TmuxPluginDeps {
	platform?: NodeJS.Platform;
	client?: TmuxClient;
	/** Where a new inspector opens. Defaults to config `tmuxInspectorLayout`, then "tab". */
	layout?: () => TmuxInspectorLayout;
}

export function createTmuxInspectorPlugin(deps: TmuxPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	const client = deps.client ?? createTmuxClient();
	const layout = deps.layout ?? (() => loadConfig().tmuxInspectorLayout ?? "tab");
	return {
		name: "tmux",
		available: (context) => platform !== "win32" && Boolean(context.env.TMUX),
		owns: (context) => readTmuxInspectorBindingForTarget(context.target) !== undefined,
		open: (context, launch, params) => openTmuxInspector(context, launch, params.focus === true, client, layout()),
		status: (context) => statusTmuxInspector(context, client),
		close: (context) => closeTmuxInspector(context, client),
	};
}
