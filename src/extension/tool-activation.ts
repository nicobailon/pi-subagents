import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MODEL_ONLY_TOOL } from "../shared/extension-context.ts";
import type { ToolActivationMode } from "../shared/types.ts";
import { registerPinnedTool } from "./declaration-pinning.ts";
import { listBackgroundWorkProviders } from "../api/background-work.ts";
import { DEFAULT_WAIT_TOOL_NAME, waitToolName } from "../shared/wait-tool-name.ts";
import { CONTACT_SUPERVISOR_TOOL_NAME as SUPERVISOR_NAME, NATIVE_SUPERVISOR_TOOL_NAME as PARENT_SUPERVISOR_NAME } from "../intercom/native-supervisor-channel.ts";

interface ActivationDetails {
	enabled?: string[];
	missing?: string[];
	unavailable?: string[];
}

const LOADER_NAME = "subagents_enable";
const SUBAGENT_NAME = "subagent";
// The wait tool (bg_wait unless config.waitTool.name renames it) is declared with subagent, or once
// background-work providers exist (they report work only the wait tool reads).
// SUPERVISOR_NAME is declared with subagent: a fork launched through it then declares exactly this session's tools.
// PARENT_SUPERVISOR_NAME (answering this session's children) is declared with subagent too, unless the session already
// declared it: a changed tool set would miss the prompt cache. The channel declares it when a child request arrives.
const isUnloadSentinel = (name: string) => name === LOADER_NAME || name === SUBAGENT_NAME || name === waitToolName();

type ToolSelectionMessage = {
	role: string;
	// toolsAdded entries are the complete tool definitions that were sent.
	toolsAdded?: readonly { name: string; parameters?: unknown }[];
	toolsRemoved?: readonly { name: string }[];
};

// Every bg_wait pi-subagents has registered (since 0.61.0) takes nonBlocking and stopOnAttention; another extension's
// bg_wait (@99percentpeople/pi-background-tasks takes id and timeout) does not.
function isOwnWaitDefinition(tool: { parameters?: unknown }): boolean {
	const properties = (tool.parameters as { properties?: unknown } | undefined)?.properties;
	return typeof properties === "object" && properties !== null && Object.hasOwn(properties, "nonBlocking") && Object.hasOwn(properties, "stopOnAttention");
}

function hasNativeToolSelection(messages: readonly ToolSelectionMessage[]): boolean {
	return messages.some((message) => message.role === "system"
		&& (Object.hasOwn(message, "toolsAdded") || Object.hasOwn(message, "toolsRemoved")));
}

function setSelection(pi: ExtensionAPI, includeSubagent: boolean, includeLoader: boolean, includeWait: boolean, restore: readonly string[] = [], keepParentSupervisor = false): void {
	const next = [...pi.getActiveTools(), ...restore].filter((name) => (includeSubagent || (name !== SUBAGENT_NAME && name !== SUPERVISOR_NAME && (keepParentSupervisor || name !== PARENT_SUPERVISOR_NAME)))
		&& (includeLoader || name !== LOADER_NAME) && (includeWait || name !== waitToolName()));
	if (includeSubagent) next.push(SUBAGENT_NAME, SUPERVISOR_NAME, PARENT_SUPERVISOR_NAME);
	if (includeLoader) next.push(LOADER_NAME);
	if (includeWait) next.push(waitToolName());
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

// Returns whether the loader is selected for this session. `replyOwed`: a child request already woke this session.
function applyRecordedSelection(pi: ExtensionAPI, ctx: ExtensionContext, mode: "auto" | "dynamic", replyOwed: boolean): boolean {
	const available = pi.getAllTools();
	if (!Array.isArray(available) || !Array.isArray(pi.getActiveTools())) return true;
	if (!available.some((tool) => tool.name === LOADER_NAME)) return true;
	// SAFETY: The running Pi session manager exposes buildSessionContext, but its read-only extension type omits it.
	let messages = (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: ToolSelectionMessage[] } }).buildSessionContext().messages;
	// A compaction checkpoint (the system message before the summary) folds the branch's earlier system messages into
	// one declaration, which hides an extension unload before the compaction. Replay those messages instead, as Pi
	// restores the session's tools from them.
	if (messages[0]?.role === "system" && messages[1]?.role === "compactionSummary") {
		const branch = ctx.sessionManager.getBranch();
		const history = branch.slice(0, branch.findLastIndex((entry) => entry.type === "compaction"))
			.flatMap((entry) => entry.type === "message" && entry.message.role === "system" ? [entry.message as ToolSelectionMessage] : []);
		messages = [...history, ...messages.slice(1)];
	}
	// A compaction without a checkpoint leaves its summary first, with no system message before it: the
	// declarations from before it are lost, even when no tool selection was recorded after it.
	const lost = messages.find((message) => message.role === "system" || message.role === "compactionSummary")?.role === "compactionSummary";
	if (lost || hasNativeToolSelection(messages)) {
		// Replayed here because a package-local pi-ai may be older than the running Pi.
		const recorded = new Set<string>();
		const unloadedNames = new Set<string>();
		const declaredSentinels = new Set<string>();
		// Tools the surviving transcript says something about: an addition, or a removal that is not an unload.
		const evidenced = new Set<string>();
		// Whether the latest bg_wait declaration was this extension's wait tool, from before a waitTool.name rename.
		let legacyWaitIsOwn = false;
		for (const message of messages) {
			if (message.role !== "system") continue;
			// Pi records an extension unload (update, reload) as a removal of each of its active tools, with no cause.
			// While this extension is loaded, the loader, subagent or bg_wait stays declared, so a removal of declared
			// sentinels that leaves none of them is that unload, not a choice, and the selection from before it stands.
			// Pi removes only declared tools, so a removal naming an undeclared sentinel is a choice.
			const removedSentinels = (message.toolsRemoved ?? []).filter((tool) => isUnloadSentinel(tool.name));
			const allDeclared = removedSentinels.every((tool) => declaredSentinels.has(tool.name));
			for (const tool of message.toolsRemoved ?? []) declaredSentinels.delete(tool.name);
			for (const tool of message.toolsAdded ?? []) if (isUnloadSentinel(tool.name)) declaredSentinels.add(tool.name);
			const unloaded = removedSentinels.length > 0 && allDeclared && declaredSentinels.size === 0;
			for (const tool of message.toolsRemoved ?? []) {
				if (unloaded) unloadedNames.add(tool.name);
				else {
					recorded.delete(tool.name);
					evidenced.add(tool.name);
				}
			}
			for (const tool of message.toolsAdded ?? []) {
				recorded.add(tool.name);
				evidenced.add(tool.name);
				if (tool.name === DEFAULT_WAIT_TOOL_NAME) legacyWaitIsOwn = isOwnWaitDefinition(tool);
			}
		}
		// The loader and subagent record one activation state (cold, warm, eager); bg_wait and subagent_supervisor
		// are declared on their own. Only when the activation state itself is lost is it decided as for a new
		// session. The live tools are no evidence: Pi restores them from this transcript, or activates every
		// extension tool on /reload.
		const fresh = lost && !evidenced.has(LOADER_NAME) && !evidenced.has(SUBAGENT_NAME);
		const startsEager = fresh && mode === "auto" && !addsToolsWithoutCheckpoint(ctx.model);
		// Otherwise "auto" never adds the loader to a transcript that did not declare it: that is itself a tool change.
		const loaderSelected = mode === "dynamic" || recorded.has(LOADER_NAME) || (fresh && !startsEager);
		// An eager re-decision re-adds bg_wait only when the transcript is silent about it: a post-compaction
		// removal that is not an unload is an operator choice, and a surviving declaration is recorded.has.
		// A new process restores the transcript's tools, where the unload left this extension's tools inactive; only
		// /reload re-adds them. Restoring them keeps a sentinel declared, so a later unload is recognised too. Tools of
		// other extensions, and tools excluded for this process (not registered, so not in getAllTools), stay as they are.
		// A transcript from before a waitTool.name rename records the wait tool as bg_wait; that record stands for the
		// renamed tool while the transcript says nothing about the new name and its latest bg_wait was this extension's.
		const waitRecord = waitToolName() !== DEFAULT_WAIT_TOOL_NAME && !evidenced.has(waitToolName()) && legacyWaitIsOwn ? DEFAULT_WAIT_TOOL_NAME : waitToolName();
		const source = unloadedNames.size > 0 ? available.find((tool) => tool.name === LOADER_NAME)?.sourceInfo.path : undefined;
		const restore = source === undefined ? [] : available
			.filter((tool) => unloadedNames.has(tool.name) && recorded.has(tool.name) && tool.sourceInfo.path === source)
			.map((tool) => tool.name);
		setSelection(pi, recorded.has(SUBAGENT_NAME) || startsEager, loaderSelected, recorded.has(waitRecord) || (!evidenced.has(waitRecord) && startsEager), replyOwed ? [...restore, PARENT_SUPERVISOR_NAME] : restore, replyOwed || recorded.has(PARENT_SUPERVISOR_NAME));
		return loaderSelected;
	}
	// "auto" goes eager only for an empty session; any history keeps the tools it already sent.
	const eager = mode === "auto" && messages.length === 0 && !addsToolsWithoutCheckpoint(ctx.model);
	const kept = (name: string) => eager || (messages.length > 0 && pi.getActiveTools().includes(name));
	setSelection(pi, kept(SUBAGENT_NAME), !eager, kept(waitToolName()), replyOwed ? [PARENT_SUPERVISOR_NAME] : [], replyOwed || messages.length > 0);
	return !eager;
}

export function registerSubagentToolActivation(
	pi: ExtensionAPI,
	options: { advertisedPrompt: () => string | undefined | Promise<string | undefined>; mode?: ToolActivationMode; hasPendingSupervisorRequest?: () => boolean },
): void {
	const mode = options.mode ?? "auto";
	// Same as --exclude-tools subagents_enable: without the loader, subagent stays active.
	if (mode === "eager") return;

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
				setSelection(pi, true, true, true);
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

	// Decided at session start and tree navigation. Pi declares a session's first tools only with its first request, so a
	// model switch before then decides again; later switches keep the session's tools.
	let loaderSelected = true;
	// The loader and subagent state the last decision left, until the first request (agent_start). A different live
	// state is a choice made since, and stands.
	let undeclared: string | undefined;
	const activationState = () => [LOADER_NAME, SUBAGENT_NAME].map((name) => pi.getActiveTools().includes(name)).join();
	const replyOwed = () => options.hasPendingSupervisorRequest?.() === true;
	const decide = (ctx: ExtensionContext) => {
		loaderSelected = applyRecordedSelection(pi, ctx, mode, replyOwed());
		undeclared = Array.isArray(pi.getActiveTools()) ? activationState() : undefined;
	};
	pi.on("session_start", (_event, ctx) => decide(ctx));
	pi.on("session_tree", (_event, ctx) => decide(ctx));
	pi.on("agent_start", () => { undeclared = undefined; });
	// Only while idle: a run being prepared or started may already have fixed its first tools.
	pi.on("model_select", (_event, ctx) => {
		if (mode === "auto" && ctx.isIdle() && undeclared === activationState() && loaderSelected !== addsToolsWithoutCheckpoint(ctx.model)
			// SAFETY: as in applyRecordedSelection.
			&& (ctx.sessionManager as typeof ctx.sessionManager & { buildSessionContext(): { messages: unknown[] } }).buildSessionContext().messages.length === 0) decide(ctx);
	});
	pi.on("before_agent_start", (event) => {
		const available = pi.getAllTools();
		if (!Array.isArray(available) || !available.some((tool) => tool.name === LOADER_NAME)) return;
		// Another extension's background-work provider reports work only bg_wait can wait for, so a session with one
		// declares bg_wait without enabling subagent, including when the provider registered after session start.
		const providedWait = available.some((tool) => tool.name === waitToolName()) && listBackgroundWorkProviders().length > 0;
		const names = [...(loaderSelected ? [LOADER_NAME] : []), ...(providedWait ? [waitToolName()] : [])];
		if (names.length === 0) return;
		const selectedTools = event.systemPromptOptions.selectedTools ??= [...pi.getActiveTools()];
		for (const name of names) if (!selectedTools.includes(name)) selectedTools.push(name);
		const inactive = names.filter((name) => !pi.getActiveTools().includes(name));
		if (inactive.length > 0) pi.setActiveTools([...pi.getActiveTools(), ...inactive]);
	});
}
