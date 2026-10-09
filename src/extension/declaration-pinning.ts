import { declarationsEqual, getCurrentSystemMessage, toToolDeclaration, type Message, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

// Pi records each declared tool definition and prompt section in the session transcript and
// re-declares any difference before the next request. A changed tool or prompt section makes
// the provider re-read the whole conversation without its prompt cache, so a session keeps the
// pi-subagents definitions and prompt text it already declared. Only a session that never
// declared a tool gets its current definition.

type PinnableTool = ToolDefinition<TSchema, unknown>;

/** What a session declared for one tool; an absent snippet or guidelines keeps the current value. */
interface DeclaredPin {
	declaration: Tool;
	snippet?: { text?: string };
	guidelines?: string[];
}

interface Pins {
	current: Map<string, PinnableTool>;
	declared: Map<string, DeclaredPin>;
	registered: Map<string, string>;
}

const pinsByApi = new WeakMap<ExtensionAPI, Pins>();
const GUIDELINES_PLACEHOLDER = "\u0000pi-subagents guidelines";

function pinnedDefinition(tool: PinnableTool, pin: DeclaredPin | undefined): PinnableTool {
	const { constrainedSampling, promptSnippet, promptGuidelines, ...rest } = tool;
	// An unchanged declaration keeps the registered schema object rather than its JSON copy.
	const declaration = pin && !declarationsEqual(pin.declaration, tool) ? pin.declaration : undefined;
	const definition: PinnableTool = { ...rest, description: declaration?.description ?? rest.description, parameters: declaration?.parameters ?? rest.parameters };
	const sampling = declaration ? declaration.constrainedSampling : constrainedSampling;
	if (sampling !== undefined) definition.constrainedSampling = sampling;
	const snippet = pin?.snippet ? pin.snippet.text : promptSnippet;
	if (snippet !== undefined) definition.promptSnippet = snippet;
	const guidelines = pin?.guidelines ?? promptGuidelines;
	if (guidelines !== undefined) definition.promptGuidelines = guidelines;
	return definition;
}

function register(pi: ExtensionAPI, pins: Pins, name: string): void {
	const definition = pinnedDefinition(pins.current.get(name)!, pins.declared.get(name));
	const key = JSON.stringify([toToolDeclaration(definition), definition.promptSnippet, definition.promptGuidelines]);
	if (pins.registered.get(name) === key) return;
	pins.registered.set(name, key);
	pi.registerTool(definition);
}

function sectionLines(text: string | undefined, name: string): string[] | undefined {
	const lines = text?.split("\n") ?? [];
	const start = lines.indexOf(`<${name}>`);
	const end = lines.indexOf(`</${name}>`, start + 1);
	return start >= 0 && end > start ? lines.slice(start + 1, end) : undefined;
}

/** Mirrors the unexported buildRules of Pi's default system prompt, without prompt-level guidelines. */
function ruleLines(activeTools: string[], guidelines: Map<string, string[]>): string[] {
	const lines: string[] = [];
	const add = (rule: string): void => {
		const line = `- ${rule.trim()}`;
		if (line !== "- " && !lines.includes(line)) lines.push(line);
	};
	const active = (name: string) => activeTools.includes(name);
	if ((active("bash") || active("powershell")) && !active("grep") && !active("find") && !active("ls")) {
		if (active("bash") && active("powershell")) add("Use bash or PowerShell for file operations like listing, searching, and finding files");
		else if (active("powershell")) add("Use PowerShell for file operations like listing, searching, and finding files");
		else add("Use bash for file operations like ls, rg, find");
	}
	for (const name of activeTools) for (const rule of guidelines.get(name) ?? []) add(rule);
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	return lines;
}

const sameLines = (left: string[], right: string[]) => left.length === right.length && left.every((line, index) => line === right[index]);

/**
 * The rules section does not say which tool contributed a bullet, so a declared tool's guidelines
 * are recovered by rebuilding the recorded rules with candidate bullets at that tool's position.
 * Nothing is recovered unless the rebuild first reproduces Pi's current rules.
 */
function recordedGuidelines(pi: ExtensionAPI, ctx: ExtensionContext, recorded: string[], names: string[]): Map<string, string[]> {
	const recovered = new Map<string, string[]>();
	const activeTools = pi.getActiveTools();
	const guidelines = new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []]));
	const current = sectionLines(ctx.getSystemPrompt(), "rules");
	if (!current || !sameLines(ruleLines(activeTools, guidelines), current)) return recovered;
	const rebuild = (name: string, candidate: string[]) => ruleLines(activeTools, new Map(guidelines).set(name, candidate));
	for (const name of names) {
		const start = rebuild(name, [GUIDELINES_PLACEHOLDER]).indexOf(`- ${GUIDELINES_PLACEHOLDER}`);
		if (start < 0) continue;
		const candidate = recorded.slice(start, start + recorded.length - rebuild(name, []).length).map((line) => line.slice(2));
		if (!sameLines(rebuild(name, candidate), recorded)) continue;
		guidelines.set(name, candidate);
		recovered.set(name, candidate);
	}
	return recovered;
}

function declaredPins(pi: ExtensionAPI, pins: Pins, ctx: ExtensionContext | undefined): Map<string, DeclaredPin> {
	// SAFETY: Pi's session manager exposes buildSessionContext, but its read-only extension type omits it.
	const sessionManager = ctx?.sessionManager as (ExtensionContext["sessionManager"] & { buildSessionContext?(): { messages: Message[] } }) | undefined;
	// A host without a readable transcript, such as a test double, declares nothing to keep.
	if (!ctx || typeof sessionManager?.buildSessionContext !== "function") return new Map();
	const system = getCurrentSystemMessage(sessionManager.buildSessionContext().messages);
	const declarations = system?.toolsAdded ?? [];
	const snippets = sectionLines(system?.sections?.tools ?? undefined, "tools");
	const rules = sectionLines(system?.sections?.rules ?? undefined, "rules");
	const guidelines = rules ? recordedGuidelines(pi, ctx, rules, declarations.map((tool) => tool.name).filter((name) => pins.current.has(name))) : new Map<string, string[]>();
	return new Map(declarations.map((declaration) => {
		const pin: DeclaredPin = { declaration };
		// Pi renders each snippet on one line as "- <tool>: <snippet>".
		if (snippets) pin.snippet = { text: snippets.find((line) => line.startsWith(`- ${declaration.name}: `))?.slice(declaration.name.length + 4) };
		const recovered = guidelines.get(declaration.name);
		if (recovered) pin.guidelines = recovered;
		return [declaration.name, pin];
	}));
}

function pinsFor(pi: ExtensionAPI): Pins {
	const existing = pinsByApi.get(pi);
	if (existing) return existing;
	const pins: Pins = { current: new Map(), declared: new Map(), registered: new Map() };
	pinsByApi.set(pi, pins);
	// Pi restores the transcript's active tools before both events, so handler order does not matter.
	const refresh = (ctx: ExtensionContext | undefined) => {
		pins.declared = declaredPins(pi, pins, ctx);
		for (const name of pins.current.keys()) register(pi, pins, name);
	};
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => refresh(ctx));
	return pins;
}

/**
 * Register a pi-subagents tool so a session keeps the definition, prompt snippet and guidelines
 * its transcript already declared. Only a session that never declared the tool gets this definition.
 */
export function registerPinnedTool<TParams extends TSchema, TDetails>(pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails>): void {
	const pins = pinsFor(pi);
	// SAFETY: Pinning reads only model-facing fields and re-registers every runtime field unchanged.
	pins.current.set(tool.name, tool as unknown as PinnableTool);
	pins.registered.delete(tool.name);
	register(pi, pins, tool.name);
}
