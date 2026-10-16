import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODEL_ONLY_TOOL } from "../shared/extension-context.ts";
import type { ToolActivationMode } from "../shared/types.ts";
import { registerPinnedTool } from "./declaration-pinning.ts";
import { CONTACT_SUPERVISOR_TOOL_NAME as SUPERVISOR_NAME } from "../intercom/native-supervisor-channel.ts";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
// Registered and active whenever this extension loads, and never deactivated here.
const WAIT_NAME = "bg_wait";
// SUPERVISOR_NAME is declared with subagent: a fork launched through it then declares exactly this session's tools.
let warnedUnsupportedHost = false;

type ToolSelectionMessage = {
	role: string;
	toolsAdded?: readonly { name: string }[];
	toolsRemoved?: readonly { name: string }[];
};

function hasNativeToolSelection(messages: readonly ToolSelectionMessage[]): boolean {
	return messages.some((message) => message.role === "system"
		&& (Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved")));
}

function setSelection(pi: ExtensionAPI, includeSubagent: boolean, includeLoader: boolean, restore: readonly string[] = []): void {
	const next = [...pi.getActiveTools(), ...restore].filter((name) => (includeSubagent || (name !== SUBAGENT_NAME && name !== SUPERVISOR_NAME)) && (includeLoader || name !== LOADER_NAME));
	if (includeSubagent) next.push(SUBAGENT_NAME, SUPERVISOR_NAME);
	if (includeLoader) next.push(LOADER_NAME);
	pi.setActiveTools([...new Set(next)]);
}

// Mirrors pi-ai's per-API transcript handling: without these flags, a mid-conversation tool change
// makes Pi resend the conversation under a new leading system message, missing the prompt cache.
function addsToolsWithoutCheckpoint(model: ExtensionContext["model"]): boolean {
	const compat = model?.compat as {
		supportsMidConvoSystemMessages?: boolean;
		supportsMidConvoToolChanges?: boolean;
		supportsMidConvoToolAdditions?: boolean;
		supportsAdditionalTools?: boolean;
		supportsToolSearch?: boolean;
	} | undefined;
	if (!model || compat?.supportsMidConvoSystemMessages !== true) return false;
	switch (model.api) {
		case "anthropic-messages": return compat.supportsMidConvoToolChanges === true;
		case "openai-completions": return compat.supportsMidConvoToolAdditions === true;
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses": return compat.supportsAdditionalTools === true || compat.supportsToolSearch === true;
		default: return false;
	}
}

// Returns whether the loader is selected for this session.
function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext, mode: "auto" | "dynamic"): boolean {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return true;
	if (!available.some((tool) => tool.name === LOADER_NAME)) return true;
	// SAFETY: The running Pi session manager exposes buildSessionContext, but its read-only extension type omits it.
	const messages = (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: ToolSelectionMessage[] } }).buildSessionContext().messages;
	if (hasNativeToolSelection(messages)) {
		// Replayed here because a package-local pi-ai may be older than the running Pi.
		const recorded = new Set<string>();
		const unloadedNames = new Set<string>();
		for (const message of messages) {
			if (message.role !== "system") continue;
			// Pi records an extension unload (update, reload) as a removal of each of its active tools, with no cause.
			// One that drops bg_wait is that unload, not a choice, so the selection from before it stands.
			const unloaded = message.toolsRemoved?.some((tool) => tool.name === WAIT_NAME) && !message.toolsAdded?.some((tool) => tool.name === WAIT_NAME);
			for (const tool of message.toolsRemoved ?? []) {
				if (unloaded) unloadedNames.add(tool.name);
				else recorded.delete(tool.name);
			}
			for (const tool of message.toolsAdded ?? []) recorded.add(tool.name);
		}
		// "auto" never adds the loader to a transcript that did not declare it: that is itself a tool change.
		const loaderSelected = mode === "dynamic" || recorded.has(LOADER_NAME);
		// A new process restores the transcript's tools, where the unload left this extension's tools inactive; only
		// /reload re-adds them. Restoring them keeps bg_wait declared, so a later unload is recognised too. Tools of
		// other extensions, and tools excluded for this process (not registered, so not in getAllTools), stay as they are.
		const source = unloadedNames.size > 0 ? available.find((tool) => tool.name === LOADER_NAME)?.sourceInfo.path : undefined;
		const restore = source === undefined ? [] : available
			.filter((tool) => unloadedNames.has(tool.name) && recorded.has(tool.name) && tool.sourceInfo.path === source)
			.map((tool) => tool.name);
		setSelection(pi, recorded.has(SUBAGENT_NAME), loaderSelected, restore);
		return loaderSelected;
	}
	// "auto" goes eager only for an empty session; any history keeps the tools it already sent.
	const eager = mode === "auto" && messages.length === 0 && !addsToolsWithoutCheckpoint(ctx.model);
	setSelection(pi, eager || (messages.length > 0 && pi.getActiveTools().includes(SUBAGENT_NAME)), !eager);
	return !eager;
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined | Promise<string | undefined>; mode?: ToolActivationMode },
): void {
	const mode = options.mode ?? "auto";
	// Same as --exclude-tools subagents_enable: without the loader, subagent stays active.
	if (mode === "eager") return;
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") {
		if (!warnedUnsupportedHost) {
			warnedUnsupportedHost = true;
			console.warn("[pi-subagents] Dynamic tool activation requires Pi 0.86.1 or newer; keeping subagent eagerly available.");
		}
		return;
	}

	// Takes no arguments, but a stray one (DeepSeek sends `{ action: "enable" }`) must not fail validation.
	const parameters = Type.Object({});
	const loader: ToolDefinition<typeof parameters, ActivationDetails> = {
		name: LOADER_NAME,
		...MODEL_ONLY_TOOL,
		label: "Enable Subagents",
		description: "Enable pi-subagents delegation and management tools without launching work. Call when delegation is authorized by the current request or applicable user/project instructions, or when managing existing runs. Direct execution is the default; complexity alone never authorizes delegation. Full tools are available on the next model request.",
		promptSnippet: "pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. Authorization must come from the current request or applicable instructions; complexity alone is not authorization.",
		parameters,
		async execute() {
			if (!pi.getAllTools().some((tool) => tool.name === SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Cannot enable unavailable tools: subagent." }],
				details: { unavailable: [SUBAGENT_NAME] },
			};
			try {
				setSelection(pi, true, true);
			} catch (error) {
				return {
					isError: true,
					content: [{ type: "text", text: `Activation failed: ${error instanceof Error ? error.message : String(error)}` }],
					details: { missing: [SUBAGENT_NAME] },
				};
			}
			if (!pi.getActiveTools().includes(SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Activation failed: subagent." }],
				details: { missing: [SUBAGENT_NAME] },
			};
			const advertised = await options.advertisedPrompt();
			return {
				content: [{ type: "text", text: `Enabled: subagent. If your tool list includes subagent (possibly prefixed), call it now. Otherwise, wait for the next user prompt; do not retry now. Start Pi with --exclude-tools subagents_enable to keep subagent always available.${advertised ? `\n\n${advertised}` : ""}` }],
				details: { enabled: [SUBAGENT_NAME] },
			};
		},
	};
	registerPinnedTool(pi, loader);

	// Decided at session start and tree navigation only; switching models keeps the session's tools.
	let loaderSelected = true;
	pi.on("session_start", (_event, ctx) => { loaderSelected = applyRecordedSelection(pi, ctx, mode); });
	pi.on("session_tree", (_event, ctx) => { loaderSelected = applyRecordedSelection(pi, ctx, mode); });
	pi.on("before_agent_start", (event) => {
		if (!loaderSelected) return;
		const available = pi.getAllTools();
		if (!Array.isArray(available) || !available.some((tool) => tool.name === LOADER_NAME)) return;
		const selectedTools = event.systemPromptOptions.selectedTools ??= [...pi.getActiveTools()];
		if (!selectedTools.includes(LOADER_NAME)) selectedTools.push(LOADER_NAME);
		if (!pi.getActiveTools().includes(LOADER_NAME)) pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
	});
}
