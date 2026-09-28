import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
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

function setSelection(pi: ExtensionAPI, includeSubagent: boolean): void {
	const active = pi.getActiveTools();
	const next = includeSubagent ? [...active, SUBAGENT_NAME] : active.filter((name) => name !== SUBAGENT_NAME);
	if (!next.includes(LOADER_NAME)) next.push(LOADER_NAME);
	pi.setActiveTools([...new Set(next)]);
}

function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return;
	if (!available.some((tool) => tool.name === LOADER_NAME)) return;
	// SAFETY: The running Pi session manager exposes buildSessionContext, but its read-only extension type omits it.
	const messages = (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: ToolSelectionMessage[] } }).buildSessionContext().messages;
	if (hasNativeToolSelection(messages)) {
		// Only this tool's membership matters; a package-local pi-ai may be older than the running Pi.
		let selected = false;
		for (const message of messages) {
			if (message.role !== "system") continue;
			if (message.toolsRemoved?.some((tool) => tool.name === SUBAGENT_NAME)) selected = false;
			if (message.toolsAdded?.some((tool) => tool.name === SUBAGENT_NAME)) selected = true;
		}
		setSelection(pi, selected);
		return;
	}
	setSelection(pi, messages.length > 0 && pi.getActiveTools().includes(SUBAGENT_NAME));
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined | Promise<string | undefined> },
): void {
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
				setSelection(pi, true);
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
				content: [{ type: "text", text: `Enabled: subagent. Check your tool list. If it has a subagent tool now (the name may carry a prefix), call it, starting with subagent({action:\"list\",capabilities:true}) for current capabilities. If it does not, your provider fixes the tool list for the whole prompt: subagent will appear after the next user prompt, so do not retry it in this one. The operator can start Pi with --exclude-tools subagents_enable to keep subagent always available.${advertised ? `\n\n${advertised}` : ""}` }],
				details: { enabled: [SUBAGENT_NAME] },
			};
		},
	};
	pi.registerTool(loader);

	pi.on("session_start", (_event, ctx) => applyRecordedSelection(pi, ctx));
	pi.on("session_tree", (_event, ctx) => applyRecordedSelection(pi, ctx));
	pi.on("before_agent_start", (event) => {
		const available = pi.getAllTools();
		if (!Array.isArray(available) || !available.some((tool) => tool.name === LOADER_NAME)) return;
		const selectedTools = event.systemPromptOptions.selectedTools ??= [...pi.getActiveTools()];
		if (!selectedTools.includes(LOADER_NAME)) selectedTools.push(LOADER_NAME);
		if (!pi.getActiveTools().includes(LOADER_NAME)) pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
	});
}
