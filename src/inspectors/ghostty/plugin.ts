import { detectGhosttyApp, openGhosttyInspector, type GhosttyRunner } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";

export interface GhosttyPluginDeps {
	platform?: NodeJS.Platform;
	runner?: GhosttyRunner;
}

export function createGhosttyInspectorPlugin(deps: GhosttyPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	return {
		name: "ghostty",
		available: async (context) => {
			// cmux 内嵌 Ghostty 内核, 也会把 TERM_PROGRAM 设成 "ghostty"。仅凭环境变量会让 plugin
			// 在 cmux 下误接管, 随后 osascript 连不上真正的 Ghostty 应用而抛 -1728/-2741。
			// 探测名为 "Ghostty" 的应用是否真的可达; 不可达则放弃接管, 落到 inspector.command 提示。
			if (platform !== "darwin") return false;
			if (context.env.TERM_PROGRAM?.toLowerCase() !== "ghostty") return false;
			return detectGhosttyApp(deps.runner);
		},
		owns: () => false,
		open: (context, launch, params) => openGhosttyInspector(context, launch, params, deps.runner),
	};
}
