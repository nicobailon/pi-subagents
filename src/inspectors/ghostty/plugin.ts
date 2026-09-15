import { openGhosttyInspector, type GhosttyRunner } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";

/** 独立 Ghostty.app 的 bundle id (作者 Mitchell Hashimoto)。 */
const GHOSTTY_BUNDLE_ID = "com.mitchellh.ghostty";

export interface GhosttyPluginDeps {
	platform?: NodeJS.Platform;
	runner?: GhosttyRunner;
}

export function createGhosttyInspectorPlugin(deps: GhosttyPluginDeps = {}): InspectorPlugin {
	const platform = deps.platform ?? process.platform;
	return {
		name: "ghostty",
		available: (context) => {
			// cmux 内嵌 Ghostty 内核, 也会把 TERM_PROGRAM 设成 "ghostty"。仅凭环境变量会让 plugin
			// 在 cmux 下误接管, 随后 osascript 连不上真正的 Ghostty 应用而抛 -1728/-2741。
			if (platform !== "darwin") return false;
			if (context.env.TERM_PROGRAM?.toLowerCase() !== "ghostty") return false;
			// macOS GUI 应用启动子进程时注入 __CFBundleIdentifier, 标识当前终端宿主 app。
			// cmux 的 bundle id 是 com.cmuxterm.app, 而非 Ghostty; 即便系统同时装了独立 Ghostty,
			// 也能据此判定当前终端不是 Ghostty, 避免误连独立 Ghostty 的窗口。
			return context.env.__CFBundleIdentifier?.trim() === GHOSTTY_BUNDLE_ID;
		},
		owns: () => false,
		open: (context, launch, params) => openGhosttyInspector(context, launch, params, deps.runner),
	};
}
