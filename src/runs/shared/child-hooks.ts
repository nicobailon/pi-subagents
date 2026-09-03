import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFanoutChildSubagentExtension from "../../extension/fanout-child.ts";
import registerSubagentFastModeExtension from "./fast-mode-extension.ts";
import registerSubagentPromptRuntime from "./subagent-prompt-runtime.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";

/** Inline extension shape accepted by pi's resource loader (`extensionFactories`). */
export interface ChildHookExtension {
	name: string;
	factory: (pi: ExtensionAPI) => void;
}

/**
 * The child-side hooks pi-subagents installs in every child, keyed off the
 * launch config instead of the process environment. Spawned children load the
 * same registrations from `subagent-prompt-runtime.ts`, `fast-mode-extension.ts`,
 * and `fanout-child.ts` as extension files.
 */
export function createChildHooks(config: ChildRuntimeConfig): ChildHookExtension[] {
	const hooks: ChildHookExtension[] = [
		{ name: "pi-subagents:prompt-runtime", factory: (pi) => registerSubagentPromptRuntime(pi, config) },
	];
	if (config.fast) hooks.push({ name: "pi-subagents:fast-mode", factory: (pi) => registerSubagentFastModeExtension(pi) });
	if (config.fanoutChild) hooks.push({ name: "pi-subagents:fanout-child", factory: (pi) => registerFanoutChildSubagentExtension(pi, config) });
	return hooks;
}
