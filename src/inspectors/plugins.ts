import { createHerdrInspectorPlugin } from "./herdr/plugin.ts";
import type { InspectorPlugin } from "./types.ts";

/** Built-in inspector plugins, ordered by host preference. */
export function createBuiltinInspectorPlugins(): readonly InspectorPlugin[] {
	return [createHerdrInspectorPlugin()];
}
