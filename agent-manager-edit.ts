import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { defaultSystemPromptMode, type AgentConfig, type BuiltinAgentOverrideBase } from "./agents.ts";
import { createEditorState, ensureCursorVisible, getCursorDisplayPos, handleEditorInput, renderEditor, wrapText } from "./text-editor.ts";
import type { TextEditorState } from "./text-editor.ts";
import { pad, row, renderHeader, renderFooter, formatScrollInfo } from "./render-helpers.ts";

export interface ModelInfo { provider: string; id: string; fullId: string; }
export interface SkillInfo { name: string; source: string; description?: string; }
export type EditScreen = "edit" | "edit-field" | "edit-prompt";
export type EditField = typeof FIELD_ORDER[number];

export interface EditState {
	draft: AgentConfig; isNew: boolean; fieldIndex: number; fieldMode: "text" | "model" | "thinking" | "skills" | null;
	fieldEditor: TextEditorState; promptEditor: TextEditorState; modelSearchQuery: string; modelCursor: number; filteredModels: ModelInfo[];
	thinkingCursor: number; skillSearchQuery: string; skillCursor: number; filteredSkills: SkillInfo[]; skillSelected: Set<string>; error?: string;
	fields: EditField[];
	title?: string;
	overrideBase?: BuiltinAgentOverrideBase;
}
export interface EditInputResult { action?: "save" | "discard" | "delete"; nextScreen?: EditScreen; }
export interface CreateEditStateOptions {
	fields?: EditField[];
	title?: string;
	overrideBase?: BuiltinAgentOverrideBase;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const FIELD_ORDER = ["name", "description", "model", "fallbackModels", "thinking", "systemPromptMode", "inheritProjectContext", "inheritSkills", "tools", "extensions", "skills", "output", "reads", "progress", "interactive", "prompt"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
const PROMPT_VIEWPORT_HEIGHT = 16;
const MODEL_SELECTOR_HEIGHT = 10;
const SKILL_SELECTOR_HEIGHT = 10;

function formatTools(draft: Pick<AgentConfig, "tools" | "mcpDirectTools">): string { const tools = [...(draft.tools ?? []), ...(draft.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)]; return tools.length > 0 ? tools.join(", ") : ""; }
function toolList(draft: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined { const tools = [...(draft.tools ?? []), ...(draft.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`)]; return tools.length > 0 ? tools : undefined; }
function parseTools(value: string): { tools?: string[]; mcp?: string[] } { const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0); const tools: string[] = []; const mcp: string[] = []; for (const item of items) { if (item.startsWith("mcp:")) { const name = item.slice(4).trim(); if (name) mcp.push(name); } else { tools.push(item); } } return { tools: tools.length > 0 ? tools : undefined, mcp: mcp.length > 0 ? mcp : undefined }; }
function parseCommaList(value: string): string[] | undefined { const items = value.split(",").map((item) => item.trim()).filter((item) => item.length > 0); return items.length > 0 ? items : undefined; }
function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean { if (!a && !b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

function fieldValueMatchesBase(field: EditField, state: EditState): boolean {
	const base = state.overrideBase;
	if (!base) return false;
	switch (field) {
		case "model": return state.draft.model === base.model;
		case "fallbackModels": return arraysEqual(state.draft.fallbackModels, base.fallbackModels);
		case "thinking": return state.draft.thinking === base.thinking;
		case "systemPromptMode": return state.draft.systemPromptMode === base.systemPromptMode;
		case "inheritProjectContext": return state.draft.inheritProjectContext === base.inheritProjectContext;
		case "inheritSkills": return state.draft.inheritSkills === base.inheritSkills;
		case "disabled": return state.draft.disabled === base.disabled;
		case "tools": return arraysEqual(toolList(state.draft), toolList(base));
		case "skills": return arraysEqual(state.draft.skills, base.skills);
		case "prompt": return state.draft.systemPrompt === base.systemPrompt;
		default: return false;
	}
}

function resetFieldToBase(field: EditField, state: EditState): void {
	const base = state.overrideBase;
	if (!base) return;
	switch (field) {
		case "model": state.draft.model = base.model; break;
		case "fallbackModels": state.draft.fallbackModels = base.fallbackModels ? [...base.fallbackModels] : undefined; break;
		case "thinking": state.draft.thinking = base.thinking; break;
		case "systemPromptMode": state.draft.systemPromptMode = base.systemPromptMode; break;
		case "inheritProjectContext": state.draft.inheritProjectContext = base.inheritProjectContext; break;
		case "inheritSkills": state.draft.inheritSkills = base.inheritSkills; break;
		case "disabled": state.draft.disabled = base.disabled; break;
		case "tools": state.draft.tools = base.tools ? [...base.tools] : undefined; state.draft.mcpDirectTools = base.mcpDirectTools ? [...base.mcpDirectTools] : undefined; break;
		case "skills": state.draft.skills = base.skills ? [...base.skills] : undefined; break;
		case "prompt": state.draft.systemPrompt = base.systemPrompt; state.promptEditor = createEditorState(base.systemPrompt); break;
		default: break;
	}
}

export function createEditState(draft: AgentConfig, isNew: boolean, models: ModelInfo[], skills: SkillInfo[], options: CreateEditStateOptions = {}): EditState {
	return {
		draft: { ...draft, tools: draft.tools ? [...draft.tools] : undefined, mcpDirectTools: draft.mcpDirectTools ? [...draft.mcpDirectTools] : undefined, skills: draft.skills ? [...draft.skills] : undefined, fallbackModels: draft.fallbackModels ? [...draft.fallbackModels] : undefined, extensions: draft.extensions ? [...draft.extensions] : draft.extensions, defaultReads: draft.defaultReads ? [...draft.defaultReads] : undefined, extraFields: draft.extraFields ? { ...draft.extraFields } : undefined },
		isNew, fieldIndex: 0, fieldMode: null, fieldEditor: createEditorState(), promptEditor: createEditorState(draft.systemPrompt ?? ""),
		modelSearchQuery: "", modelCursor: 0, filteredModels: [...models], thinkingCursor: 0, skillSearchQuery: "", skillCursor: 0, filteredSkills: [...skills], skillSelected: new Set(draft.skills ?? []),
		fields: options.fields ?? [...FIELD_ORDER], title: options.title, overrideBase: options.overrideBase,
	};
}

function renderFieldValue(field: EditField, state: EditState): string {
	const draft = state.draft;
	switch (field) {
		case "name": return draft.name;
		case "description": return draft.description;
		case "model": return draft.model ?? "default";
		case "fallbackModels": return draft.fallbackModels && draft.fallbackModels.length > 0 ? draft.fallbackModels.join(", ") : "";
		case "thinking": return draft.thinking ?? "off";
		case "systemPromptMode": return draft.systemPromptMode ?? defaultSystemPromptMode(draft.name);
		case "inheritProjectContext": return draft.inheritProjectContext ? "on" : "off";
		case "inheritSkills": return draft.inheritSkills ? "on" : "off";
		case "disabled": return draft.disabled ? "on" : "off";
		case "tools": return formatTools(draft);
		case "extensions": return draft.extensions !== undefined ? (draft.extensions.length > 0 ? draft.extensions.join(", ") : "") : "(all)";
		case "skills": return draft.skills && draft.skills.length > 0 ? draft.skills.join(", ") : "";
		case "output": return draft.output ?? "";
		case "reads": return draft.defaultReads && draft.defaultReads.length > 0 ? draft.defaultReads.join(", ") : "";
		case "progress": return draft.defaultProgress ? "on" : "off";
		case "interactive": return draft.interactive ? "on" : "off";
		default: return "";
	}
}

function applyFieldValue(field: EditField, state: EditState, value: string): void {
	const draft = state.draft;
	switch (field) {
		case "name": draft.name = value.trim(); break;
		case "description": draft.description = value.trim(); break;
		case "model": draft.model = value.trim() || undefined; break;
		case "fallbackModels": draft.fallbackModels = parseCommaList(value); break;
		case "systemPromptMode": {
			const trimmed = value.trim();
			if (trimmed === "") {
				draft.systemPromptMode = defaultSystemPromptMode(draft.name);
				break;
			}
			if (trimmed === "append" || trimmed === "replace") {
				draft.systemPromptMode = trimmed;
			}
			break;
		}
		case "tools": { const parsed = parseTools(value); draft.tools = parsed.tools; draft.mcpDirectTools = parsed.mcp; break; }
		case "extensions": { const trimmed = value.trim(); draft.extensions = trimmed === "(all)" ? undefined : parseCommaList(trimmed) ?? []; break; }
		case "skills": draft.skills = parseCommaList(value); break;
		case "output": { const trimmed = value.trim(); draft.output = trimmed.length > 0 ? trimmed : undefined; break; }
		case "reads": draft.defaultReads = parseCommaList(value); break;
		case "inheritProjectContext":
		case "inheritSkills":
		case "disabled":
		case "progress":
		case "interactive":
		case "prompt":
			break;
	}
}

function openModelPicker(state: EditState, models: ModelInfo[]): void {
	state.fieldIndex = state.fields.indexOf("model"); state.fieldMode = "model"; state.modelSearchQuery = ""; state.filteredModels = [...models];
	const idx = state.filteredModels.findIndex((m) => m.fullId === state.draft.model || m.id === state.draft.model); state.modelCursor = idx >= 0 ? idx : 0;
}
function openThinkingPicker(state: EditState): void {
	state.fieldIndex = state.fields.indexOf("thinking"); state.fieldMode = "thinking";
	const idx = THINKING_LEVELS.indexOf((state.draft.thinking ?? "off") as ThinkingLevel); state.thinkingCursor = idx >= 0 ? idx : 0;
}
function openSkillPicker(state: EditState, skills: SkillInfo[]): void {
	state.fieldIndex = state.fields.indexOf("skills"); state.fieldMode = "skills"; state.skillSearchQuery = ""; state.filteredSkills = [...skills]; state.skillSelected = new Set(state.draft.skills ?? []); state.skillCursor = 0;
}

function renderModelPicker(state: EditState, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(" Select Model ", width, theme));
	lines.push(row("", width, theme));
	const cursor = "\x1b[7m \x1b[27m";
	lines.push(row(` ${theme.fg("dim", "Search: ")}${state.modelSearchQuery}${cursor}`, width, theme));
	lines.push(row("", width, theme));
	const currentModel = state.draft.model ?? "default";
	lines.push(row(` ${theme.fg("dim", "Current: ")}${theme.fg("warning", currentModel)}`, width, theme));
	lines.push(row("", width, theme));
	const list = state.filteredModels;
	if (list.length === 0) {
		lines.push(row(` ${theme.fg("dim", "No matching models")}`, width, theme));
	} else {
		const maxVisible = MODEL_SELECTOR_HEIGHT; let startIdx = 0;
		if (list.length > maxVisible) { startIdx = Math.max(0, state.modelCursor - Math.floor(maxVisible / 2)); startIdx = Math.min(startIdx, list.length - maxVisible); }
		const endIdx = Math.min(startIdx + maxVisible, list.length);
		if (startIdx > 0) lines.push(row(` ${theme.fg("dim", `  ↑ ${startIdx} more`)}`, width, theme));
		for (let i = startIdx; i < endIdx; i++) { const model = list[i]!; const isSelected = i === state.modelCursor; const prefix = isSelected ? theme.fg("accent", "→ ") : "  "; const modelText = isSelected ? theme.fg("accent", model.id) : model.id; const provider = theme.fg("dim", ` [${model.provider}]`); lines.push(row(` ${prefix}${modelText}${provider}`, width, theme)); }
		const remaining = list.length - endIdx; if (remaining > 0) lines.push(row(` ${theme.fg("dim", `  ↓ ${remaining} more`)}`, width, theme));
	}
	while (lines.length < 19) lines.push(row("", width, theme));
	lines.push(renderFooter(" [enter] select  [esc] cancel  type to search ", width, theme));
	return lines;
}

function renderThinkingPicker(state: EditState, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(" Select Thinking Level ", width, theme));
	lines.push(row("", width, theme));
	const currentModel = state.draft.model ?? "default";
	const current = truncateToWidth(currentModel, width - 13);
	lines.push(row(` ${theme.fg("dim", "Model: ")}${theme.fg("warning", current)}`, width, theme));
	lines.push(row("", width, theme));
	const descriptions: Record<ThinkingLevel, string> = {
		off: "No extended thinking",
		minimal: "Brief reasoning",
		low: "Light reasoning",
		medium: "Moderate reasoning",
		high: "Deep reasoning",
		xhigh: "Maximum reasoning (ultrathink)",
	};
	for (let i = 0; i < THINKING_LEVELS.length; i++) {
		const level = THINKING_LEVELS[i]!;
		const isSelected = i === state.thinkingCursor;
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		const levelText = isSelected ? theme.fg("accent", level) : level;
		const desc = theme.fg("dim", ` - ${descriptions[level]}`);
		lines.push(row(` ${prefix}${levelText}${desc}`, width, theme));
	}
	while (lines.length < 19) lines.push(row("", width, theme));
	lines.push(renderFooter(" [enter] select  [esc] cancel  [↑↓] navigate ", width, theme));
	return lines;
}

function renderSkillPicker(state: EditState, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(" Select Skills ", width, theme));
	lines.push(row("", width, theme));
	const cursor = "\x1b[7m \x1b[27m";
	lines.push(row(` ${theme.fg("dim", "Search: ")}${state.skillSearchQuery}${cursor}`, width, theme));
	lines.push(row("", width, theme));
	const selected = [...state.skillSelected].join(", ") || theme.fg("dim", "(none)");
	lines.push(row(` ${theme.fg("dim", "Selected: ")}${truncateToWidth(selected, width - 14)}`, width, theme));
	lines.push(row("", width, theme));
	const list = state.filteredSkills;
	if (list.length === 0) {
		lines.push(row(` ${theme.fg("dim", "No matching skills")}`, width, theme));
	} else {
		let startIdx = 0;
		if (list.length > SKILL_SELECTOR_HEIGHT) { startIdx = Math.max(0, state.skillCursor - Math.floor(SKILL_SELECTOR_HEIGHT / 2)); startIdx = Math.min(startIdx, list.length - SKILL_SELECTOR_HEIGHT); }
		const endIdx = Math.min(startIdx + SKILL_SELECTOR_HEIGHT, list.length);
		if (startIdx > 0) lines.push(row(` ${theme.fg("dim", `  ↑ ${startIdx} more`)}`, width, theme));
		for (let i = startIdx; i < endIdx; i++) { const skill = list[i]!; const isCursor = i === state.skillCursor; const isSelected = state.skillSelected.has(skill.name); const prefix = isCursor ? theme.fg("accent", "→ ") : "  "; const checkbox = isSelected ? theme.fg("success", "[x]") : "[ ]"; const nameText = isCursor ? theme.fg("accent", skill.name) : skill.name; const sourceBadge = theme.fg("dim", ` [${skill.source}]`); const desc = skill.description ? theme.fg("dim", ` - ${truncateToWidth(skill.description, 25)}`) : ""; lines.push(row(` ${prefix}${checkbox} ${nameText}${sourceBadge}${desc}`, width, theme)); }
		const remaining = list.length - endIdx; if (remaining > 0) lines.push(row(` ${theme.fg("dim", `  ↓ ${remaining} more`)}`, width, theme));
	}
	while (lines.length < 19) lines.push(row("", width, theme));
	lines.push(renderFooter(" [enter] confirm  [space] toggle  [esc] cancel ", width, theme));
	return lines;
}

function renderPromptEditor(state: EditState, width: number, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(" Editing System Prompt ", width, theme));
	lines.push(row("", width, theme));
	const textWidth = Math.max(10, width - 4);
	const wrapped = wrapText(state.promptEditor.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(state.promptEditor.cursor, wrapped.starts);
	state.promptEditor.viewportOffset = ensureCursorVisible(cursorPos.line, PROMPT_VIEWPORT_HEIGHT, state.promptEditor.viewportOffset);
	const editorLines = renderEditor(state.promptEditor, textWidth, PROMPT_VIEWPORT_HEIGHT);
	for (const line of editorLines) lines.push(row(` ${line}`, width, theme));
	const scrollInfo = formatScrollInfo(state.promptEditor.viewportOffset, Math.max(0, wrapped.lines.length - state.promptEditor.viewportOffset - PROMPT_VIEWPORT_HEIGHT));
	lines.push(row(scrollInfo ? ` ${theme.fg("dim", scrollInfo)}` : "", width, theme));
	lines.push(renderFooter(" [esc] done ", width, theme));
	return lines;
}

export function handleEditInput(screen: EditScreen, state: EditState, data: string, width: number, models: ModelInfo[], skills: SkillInfo[]): EditInputResult | undefined {
	if (screen === "edit") {
		if (matchesKey(data, "ctrl+s")) return { action: "save" };
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { action: "discard" };
		if (data === "D" && state.overrideBase) return { action: "delete" };
		if (matchesKey(data, "up")) { state.fieldIndex = Math.max(0, state.fieldIndex - 1); return; }
		if (matchesKey(data, "down")) { state.fieldIndex = Math.min(state.fields.length - 1, state.fieldIndex + 1); return; }
		const field = state.fields[state.fieldIndex]!;
		if (data === "r" && state.overrideBase) { resetFieldToBase(field, state); return; }
		if (data === "m") { openModelPicker(state, models); return { nextScreen: "edit-field" }; }
		if (data === "t") { openThinkingPicker(state); return { nextScreen: "edit-field" }; }
		if (data === "s") { openSkillPicker(state, skills); return { nextScreen: "edit-field" }; }
		if (data === " " && (field === "inheritProjectContext" || field === "inheritSkills" || field === "disabled" || field === "progress" || field === "interactive")) {
			if (field === "inheritProjectContext") state.draft.inheritProjectContext = !state.draft.inheritProjectContext;
			if (field === "inheritSkills") state.draft.inheritSkills = !state.draft.inheritSkills;
			if (field === "disabled") state.draft.disabled = !state.draft.disabled;
			if (field === "progress") state.draft.defaultProgress = !state.draft.defaultProgress;
			if (field === "interactive") state.draft.interactive = !state.draft.interactive;
			return;
		}
		if (matchesKey(data, "return")) {
			if (field === "model") { openModelPicker(state, models); return { nextScreen: "edit-field" }; }
			if (field === "thinking") { openThinkingPicker(state); return { nextScreen: "edit-field" }; }
			if (field === "skills") { openSkillPicker(state, skills); return { nextScreen: "edit-field" }; }
			if (field === "prompt") { state.promptEditor = createEditorState(state.draft.systemPrompt ?? ""); return { nextScreen: "edit-prompt" }; }
			if (field === "inheritProjectContext" || field === "inheritSkills" || field === "disabled" || field === "progress" || field === "interactive") return;
			state.fieldMode = "text"; state.fieldEditor = createEditorState(renderFieldValue(field, state)); return { nextScreen: "edit-field" };
		}
		return;
	}
	if (screen === "edit-field") {
		if (state.fieldMode === "model") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.fieldMode = null; return { nextScreen: "edit" }; }
			if (matchesKey(data, "return")) { const selected = state.filteredModels[state.modelCursor]; if (selected) state.draft.model = selected.fullId; state.fieldMode = null; return { nextScreen: "edit" }; }
			if (matchesKey(data, "up")) { if (state.filteredModels.length > 0) state.modelCursor = state.modelCursor === 0 ? state.filteredModels.length - 1 : state.modelCursor - 1; return; }
			if (matchesKey(data, "down")) { if (state.filteredModels.length > 0) state.modelCursor = state.modelCursor === state.filteredModels.length - 1 ? 0 : state.modelCursor + 1; return; }
			if (matchesKey(data, "backspace")) { if (state.modelSearchQuery.length > 0) state.modelSearchQuery = state.modelSearchQuery.slice(0, -1); }
			else if (data.length === 1 && data.charCodeAt(0) >= 32) state.modelSearchQuery += data;
			const query = state.modelSearchQuery.toLowerCase();
			state.filteredModels = query ? models.filter((m) => m.fullId.toLowerCase().includes(query) || m.id.toLowerCase().includes(query) || m.provider.toLowerCase().includes(query)) : [...models];
			state.modelCursor = Math.min(state.modelCursor, Math.max(0, state.filteredModels.length - 1));
			return;
		}
		if (state.fieldMode === "thinking") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.fieldMode = null; return { nextScreen: "edit" }; }
			if (matchesKey(data, "return")) { const selected = THINKING_LEVELS[state.thinkingCursor]; state.draft.thinking = selected === "off" ? undefined : selected; state.fieldMode = null; return { nextScreen: "edit" }; }
			if (matchesKey(data, "up")) { state.thinkingCursor = state.thinkingCursor === 0 ? THINKING_LEVELS.length - 1 : state.thinkingCursor - 1; return; }
			if (matchesKey(data, "down")) { state.thinkingCursor = state.thinkingCursor === THINKING_LEVELS.length - 1 ? 0 : state.thinkingCursor + 1; return; }
			return;
		}
		if (state.fieldMode === "skills") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.fieldMode = null; return { nextScreen: "edit" }; }
			if (matchesKey(data, "return")) { const selected = [...state.skillSelected]; state.draft.skills = selected.length > 0 ? selected : undefined; state.fieldMode = null; return { nextScreen: "edit" }; }
			if (data === " ") { const skill = state.filteredSkills[state.skillCursor]; if (skill) { if (state.skillSelected.has(skill.name)) state.skillSelected.delete(skill.name); else state.skillSelected.add(skill.name); } return; }
			if (matchesKey(data, "up")) { if (state.filteredSkills.length > 0) state.skillCursor = state.skillCursor === 0 ? state.filteredSkills.length - 1 : state.skillCursor - 1; return; }
			if (matchesKey(data, "down")) { if (state.filteredSkills.length > 0) state.skillCursor = state.skillCursor === state.filteredSkills.length - 1 ? 0 : state.skillCursor + 1; return; }
			if (matchesKey(data, "backspace")) { if (state.skillSearchQuery.length > 0) state.skillSearchQuery = state.skillSearchQuery.slice(0, -1); }
			else if (data.length === 1 && data.charCodeAt(0) >= 32) state.skillSearchQuery += data;
			const query = state.skillSearchQuery.toLowerCase();
			state.filteredSkills = query ? skills.filter((s) => s.name.toLowerCase().includes(query) || (s.description?.toLowerCase().includes(query) ?? false)) : [...skills];
			state.skillCursor = Math.min(state.skillCursor, Math.max(0, state.filteredSkills.length - 1));
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.fieldMode = null; return { nextScreen: "edit" }; }
		if (matchesKey(data, "return")) { const field = state.fields[state.fieldIndex]!; applyFieldValue(field, state, state.fieldEditor.buffer); state.fieldMode = null; return { nextScreen: "edit" }; }
		if (matchesKey(data, "tab")) return;
		const innerW = width - 2; const labelWidth = 12; const textWidth = Math.max(10, innerW - labelWidth - 6);
		const nextState = handleEditorInput(state.fieldEditor, data, textWidth); if (nextState) state.fieldEditor = nextState; return;
	}
	if (screen === "edit-prompt") {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.draft.systemPrompt = state.promptEditor.buffer; return { nextScreen: "edit" }; }
		const textWidth = Math.max(10, width - 4);
		if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) { const wrapped = wrapText(state.promptEditor.buffer, textWidth); const cursorPos = getCursorDisplayPos(state.promptEditor.cursor, wrapped.starts); const targetLine = Math.max(0, cursorPos.line - PROMPT_VIEWPORT_HEIGHT); const targetCol = Math.min(cursorPos.col, wrapped.lines[targetLine]?.length ?? 0); state.promptEditor = { ...state.promptEditor, cursor: wrapped.starts[targetLine] + targetCol }; return; }
		if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) { const wrapped = wrapText(state.promptEditor.buffer, textWidth); const cursorPos = getCursorDisplayPos(state.promptEditor.cursor, wrapped.starts); const targetLine = Math.min(wrapped.lines.length - 1, cursorPos.line + PROMPT_VIEWPORT_HEIGHT); const targetCol = Math.min(cursorPos.col, wrapped.lines[targetLine]?.length ?? 0); state.promptEditor = { ...state.promptEditor, cursor: wrapped.starts[targetLine] + targetCol }; return; }
		const nextState = handleEditorInput(state.promptEditor, data, textWidth, { multiLine: true }); if (nextState) state.promptEditor = nextState; return;
	}
	return;
}

export function renderEdit(screen: EditScreen, state: EditState, width: number, theme: Theme): string[] {
	if (screen === "edit-field" && state.fieldMode === "model") return renderModelPicker(state, width, theme);
	if (screen === "edit-field" && state.fieldMode === "thinking") return renderThinkingPicker(state, width, theme);
	if (screen === "edit-field" && state.fieldMode === "skills") return renderSkillPicker(state, width, theme);
	if (screen === "edit-prompt") return renderPromptEditor(state, width, theme);
	const lines: string[] = [];
	const scopeBadge = state.draft.source === "user" ? "[user]" : "[proj]"; const label = state.isNew ? " [new]" : "";
	lines.push(renderHeader(` ${state.title ?? `Editing: ${state.draft.name} ${scopeBadge}${label}`} `, width, theme));
	lines.push(row("", width, theme));
	const innerW = width - 2; const labelWidth = 12; const valueWidth = Math.max(10, innerW - labelWidth - 6);
	for (let i = 0; i < state.fields.length; i++) {
		const field = state.fields[i]!; if (field === "prompt") break;
		const isFocused = i === state.fieldIndex; const prefix = isFocused ? theme.fg("accent", "▸ ") : "  ";
		const fieldLabel = field === "systemPromptMode"
			? "Prompt Mode"
			: field === "inheritProjectContext"
				? "Project Ctx"
				: field === "inheritSkills"
					? "Skills Ctx"
					: field === "disabled"
						? "Disabled"
					: `${field[0]!.toUpperCase()}${field.slice(1)}`;
		const rawLabel = pad(`${fieldLabel}:`, labelWidth);
		const labelText = state.overrideBase && !fieldValueMatchesBase(field, state) ? theme.fg("accent", rawLabel) : rawLabel; let valueText = renderFieldValue(field, state);
		if (field === "inheritProjectContext") { const toggle = state.draft.inheritProjectContext ? theme.fg("success", "[x]") : "[ ]"; valueText = `${toggle} ${state.draft.inheritProjectContext ? "on" : "off"}`; lines.push(row(` ${prefix}${labelText} ${pad(truncateToWidth(valueText, valueWidth), valueWidth)}`, width, theme)); continue; }
		if (field === "inheritSkills") { const toggle = state.draft.inheritSkills ? theme.fg("success", "[x]") : "[ ]"; valueText = `${toggle} ${state.draft.inheritSkills ? "on" : "off"}`; lines.push(row(` ${prefix}${labelText} ${pad(truncateToWidth(valueText, valueWidth), valueWidth)}`, width, theme)); continue; }
		if (field === "disabled") { const toggle = state.draft.disabled ? theme.fg("warning", "[x]") : "[ ]"; valueText = `${toggle} ${state.draft.disabled ? "on" : "off"}`; lines.push(row(` ${prefix}${labelText} ${pad(truncateToWidth(valueText, valueWidth), valueWidth)}`, width, theme)); continue; }
		if (field === "progress") { const toggle = state.draft.defaultProgress ? theme.fg("success", "[x]") : "[ ]"; valueText = `${toggle} ${state.draft.defaultProgress ? "on" : "off"}`; lines.push(row(` ${prefix}${labelText} ${pad(truncateToWidth(valueText, valueWidth), valueWidth)}`, width, theme)); continue; }
		if (field === "interactive") { const toggle = state.draft.interactive ? theme.fg("success", "[x]") : "[ ]"; valueText = `${toggle} ${state.draft.interactive ? "on" : "off"}`; lines.push(row(` ${prefix}${labelText} ${pad(truncateToWidth(valueText, valueWidth), valueWidth)}`, width, theme)); continue; }
		let displayValue = truncateToWidth(valueText, valueWidth);
		if (screen === "edit-field" && state.fieldMode === "text" && isFocused) {
			const { starts } = wrapText(state.fieldEditor.buffer, valueWidth);
			const pos = getCursorDisplayPos(state.fieldEditor.cursor, starts);
			state.fieldEditor.viewportOffset = ensureCursorVisible(pos.line, 1, state.fieldEditor.viewportOffset);
			const editorLine = renderEditor(state.fieldEditor, valueWidth, 1)[0] ?? "";
			displayValue = pad(editorLine, valueWidth);
		}
		lines.push(row(` ${prefix}${labelText} [${displayValue}]`, width, theme));
	}
	if (state.fields.includes("prompt")) {
		lines.push(row("", width, theme));
		const promptIndex = state.fields.indexOf("prompt");
		const promptFocused = state.fieldIndex === promptIndex;
		const promptPrefix = promptFocused ? theme.fg("accent", "▸ ") : "  ";
		const promptTitle = state.overrideBase && !fieldValueMatchesBase("prompt", state)
			? theme.fg("accent", "── System Prompt ──")
			: theme.fg("dim", "── System Prompt ──");
		lines.push(row(` ${promptPrefix}${promptTitle}`, width, theme));
		const previewWidth = innerW - 2; const wrapped = wrapText(state.draft.systemPrompt ?? "", previewWidth); const previewLines = wrapped.lines.slice(0, 4);
		for (const line of previewLines) lines.push(row(` ${line}`, width, theme));
		for (let i = previewLines.length; i < 4; i++) lines.push(row("", width, theme));
	}
	if (state.error) lines.push(row(` ${theme.fg("error", state.error)}`, width, theme)); else lines.push(row("", width, theme));
	const footer = state.overrideBase
		? " [ctrl+s] save  [r] reset field  [D] remove override  [esc] back "
		: " [ctrl+s] save  [esc] back ";
	lines.push(renderFooter(footer, width, theme));
	return lines;
}
