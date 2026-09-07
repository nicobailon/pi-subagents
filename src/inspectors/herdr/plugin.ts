import { createHerdrClient, type HerdrClient } from "./client.ts";
import { closeHerdrInspector, openHerdrInspector, readHerdrInspectorBindingForTarget, statusHerdrInspector } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";

export interface HerdrPluginDeps {
	client?: HerdrClient;
}

export function createHerdrInspectorPlugin(deps: HerdrPluginDeps = {}): InspectorPlugin {
	const client = deps.client ?? createHerdrClient();
	return {
		name: "herdr",
		available: async (context) => context.env.HERDR_ENV === "1"
			&& Boolean(context.env.HERDR_PANE_ID?.trim()),
		owns: (context) => readHerdrInspectorBindingForTarget(context.target) !== undefined,
		open: (context, launch, params) => openHerdrInspector(context, launch, params, client),
		status: (context) => statusHerdrInspector(context, client),
		close: (context) => closeHerdrInspector(context, client),
	};
}
