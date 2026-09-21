import * as fs from "node:fs";
import * as piAi from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
const MINIMUM_DYNAMIC_TOOLS_VERSION = [0, 86, 1] as const;
let warnedUnsupportedHost = false;

function supportsNativeDynamicTools(pi: ExtensionAPI): boolean {
	if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function" || typeof piAi.getCurrentTools !== "function") return false;
	try {
		const packageJsonUrl = new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const version = JSON.parse(fs.readFileSync(packageJsonUrl, "utf-8")).version as unknown;
		if (typeof version !== "string") return false;
		const parsed = version.split(".").slice(0, 3).map(Number);
		if (parsed.length !== 3 || parsed.some((part) => !Number.isInteger(part) || part < 0)) return false;
		for (let index = 0; index < 3; index++) {
			const part = parsed[index]!;
			const minimum = MINIMUM_DYNAMIC_TOOLS_VERSION[index]!;
			if (part !== minimum) return part > minimum;
		}
		return true;
	} catch {
		return false;
	}
}

function hasNativeToolSelection(messages: unknown[]): boolean {
	return messages.some((message) => !!message && typeof message === "object"
		&& (Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved")));
}

function setSelection(pi: ExtensionAPI, includeSubagent: boolean): void {
	const active = pi.getActiveTools();
	const next = includeSubagent ? [...active] : active.filter((name) => name !== SUBAGENT_NAME);
	if (!next.includes(LOADER_NAME)) next.push(LOADER_NAME);
	pi.setActiveTools([...new Set(next)]);
}

function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return;
	const registered = new Set(available.map((tool) => tool.name));
	if (!registered.has(LOADER_NAME)) return;
	const sessionContext = (ctx.sessionManager as unknown as { buildSessionContext(): { messages?: unknown[] } }).buildSessionContext();
	const messages = Array.isArray(sessionContext?.messages) ? sessionContext.messages : [];
	if (hasNativeToolSelection(messages)) {
		const getCurrentTools = (piAi as { getCurrentTools?: (messages: any[]) => Array<{ name: string }> }).getCurrentTools;
		if (!getCurrentTools) return;
		setSelection(pi, getCurrentTools(messages as any[]).some((tool) => tool.name === SUBAGENT_NAME));
		return;
	}
	setSelection(pi, messages.length > 0 && pi.getActiveTools().includes(SUBAGENT_NAME));
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined },
): void {
	if (!supportsNativeDynamicTools(pi)) {
		if (!warnedUnsupportedHost) {
			warnedUnsupportedHost = true;
			console.warn("[pi-subagents] Dynamic tool activation requires Pi 0.86.1 or newer; keeping subagent eagerly available.");
		}
		return;
	}

	const parameters = Type.Object({}, { additionalProperties: false });
	const loader: ToolDefinition<typeof parameters, ActivationDetails> = {
		name: LOADER_NAME,
		label: "Enable Subagents",
		description: "Enable pi-subagents delegation and management tools without launching work. Call when delegation is authorized by the current request or applicable user/project instructions, or when managing existing runs. Direct execution is the default; complexity alone never authorizes delegation. Full tools are available on the next model request.",
		promptSnippet: "pi-subagents is installed. For authorized specialist, independent-review, or parallel work, call subagents_enable, then subagent. Authorization must come from the current request or applicable instructions; complexity alone is not authorization.",
		parameters,
		async execute() {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			if (!registered.has(SUBAGENT_NAME)) return {
				isError: true,
				content: [{ type: "text", text: "Cannot enable unavailable tools: subagent." }],
				details: { unavailable: [SUBAGENT_NAME] },
			};
			try {
				pi.setActiveTools([...new Set([...pi.getActiveTools(), SUBAGENT_NAME])]);
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
			const advertised = options.advertisedPrompt();
			return {
				content: [{ type: "text", text: `Enabled: subagent. On the next model request, call subagent({action:\"list\",capabilities:true}) for current capabilities.${advertised ? `\n\n${advertised}` : ""}` }],
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
		if (!event.systemPromptOptions.selectedTools.includes(LOADER_NAME)) event.systemPromptOptions.selectedTools.push(LOADER_NAME);
		if (!pi.getActiveTools().includes(LOADER_NAME)) pi.setActiveTools([...pi.getActiveTools(), LOADER_NAME]);
	});
}
