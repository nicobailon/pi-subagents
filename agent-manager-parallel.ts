import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { TextEditorState } from "./text-editor.ts";
import { createEditorState, handleEditorInput, renderEditor, wrapText, getCursorDisplayPos, ensureCursorVisible } from "./text-editor.ts";
import { pad, row, renderHeader, renderFooter, fuzzyFilter } from "./render-helpers.ts";

export interface ParallelSlot {
	agentName: string;
	customTask: string;
}

export interface ParallelState {
	slots: ParallelSlot[];
	cursor: number;
	scrollOffset: number;
	mode: "browse" | "add" | "edit-task";
	addQuery: string;
	addCursor: number;
	editIndex: number;
	editEditor: TextEditorState | null;
}

export type ParallelAction =
	| { type: "proceed" }
	| { type: "back" };

export interface AgentOption {
	name: string;
	description: string;
	model?: string;
}

const CONTENT_HEIGHT = 14;
const SLOT_VIEWPORT_BROWSE = 12;
const SLOT_VIEWPORT_COMPACT = 5;
const ADD_RESULTS_MAX = 5;

export function createParallelState(agentNames: string[]): ParallelState {
	return {
		slots: agentNames.map((name) => ({ agentName: name, customTask: "" })),
		cursor: 0,
		scrollOffset: 0,
		mode: "browse",
		addQuery: "",
		addCursor: 0,
		editIndex: -1,
		editEditor: null,
	};
}

function clampSlotScroll(state: ParallelState, viewport: number): void {
	if (state.slots.length === 0) { state.cursor = 0; state.scrollOffset = 0; return; }
	state.cursor = Math.max(0, Math.min(state.cursor, state.slots.length - 1));
	const maxOffset = Math.max(0, state.slots.length - viewport);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
	if (state.cursor < state.scrollOffset) state.scrollOffset = state.cursor;
	else if (state.cursor >= state.scrollOffset + viewport) state.scrollOffset = state.cursor - viewport + 1;
}

export function handleParallelInput(
	state: ParallelState,
	agents: AgentOption[],
	data: string,
	width: number,
): ParallelAction | undefined {
	switch (state.mode) {
		case "browse": return handleBrowse(state, data);
		case "add": return handleAdd(state, agents, data);
		case "edit-task": return handleEditTask(state, data, width);
	}
}

function handleBrowse(state: ParallelState, data: string): ParallelAction | undefined {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { type: "back" };
	if (matchesKey(data, "up")) { state.cursor = Math.max(0, state.cursor - 1); clampSlotScroll(state, SLOT_VIEWPORT_BROWSE); return; }
	if (matchesKey(data, "down")) { state.cursor = Math.min(state.slots.length - 1, state.cursor + 1); clampSlotScroll(state, SLOT_VIEWPORT_BROWSE); return; }

	if (matchesKey(data, "ctrl+a")) {
		state.mode = "add";
		state.addQuery = "";
		state.addCursor = 0;
		return;
	}

	if (matchesKey(data, "delete") || matchesKey(data, "ctrl+d")) {
		if (state.slots.length > 1) {
			state.slots.splice(state.cursor, 1);
			state.cursor = Math.min(state.cursor, state.slots.length - 1);
			clampSlotScroll(state, SLOT_VIEWPORT_BROWSE);
		}
		return;
	}

	if (matchesKey(data, "return")) {
		if (state.slots.length === 0) return;
		state.mode = "edit-task";
		state.editIndex = state.cursor;
		state.editEditor = createEditorState(state.slots[state.cursor]!.customTask);
		return;
	}

	if (matchesKey(data, "ctrl+r")) {
		if (state.slots.length >= 2) return { type: "proceed" };
		return;
	}

	return;
}

function handleAdd(state: ParallelState, agents: AgentOption[], data: string): ParallelAction | undefined {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { state.mode = "browse"; return; }

	const filtered = fuzzyFilter(agents, state.addQuery);

	if (matchesKey(data, "up")) { state.addCursor = Math.max(0, state.addCursor - 1); return; }
	if (matchesKey(data, "down")) { state.addCursor = Math.min(Math.max(0, filtered.length - 1), state.addCursor + 1); return; }

	if (matchesKey(data, "return")) {
		const selected = filtered[state.addCursor];
		if (selected) {
			state.slots.push({ agentName: selected.name, customTask: "" });
			state.cursor = state.slots.length - 1;
			clampSlotScroll(state, SLOT_VIEWPORT_BROWSE);
		}
		state.mode = "browse";
		return;
	}

	if (matchesKey(data, "backspace")) {
		state.addQuery = state.addQuery.slice(0, -1);
		state.addCursor = 0;
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		state.addQuery += data;
		state.addCursor = 0;
		return;
	}

	return;
}

function handleEditTask(state: ParallelState, data: string, width: number): ParallelAction | undefined {
	if (!state.editEditor) { state.mode = "browse"; return; }

	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		state.editEditor = null;
		state.mode = "browse";
		return;
	}

	if (matchesKey(data, "return")) {
		const slot = state.slots[state.editIndex];
		if (slot) slot.customTask = state.editEditor.buffer.trim();
		state.editEditor = null;
		state.mode = "browse";
		return;
	}

	if (matchesKey(data, "tab")) return;

	const innerW = width - 2;
	const boxInnerWidth = Math.max(10, innerW - 4);
	const nextState = handleEditorInput(state.editEditor, data, boxInnerWidth);
	if (nextState) state.editEditor = nextState;
	return;
}

function renderSlotLine(
	slot: ParallelSlot,
	slotNumber: number,
	isCursor: boolean,
	width: number,
	theme: Theme,
): string {
	const cursor = isCursor ? theme.fg("accent", "▸") : " ";
	const num = theme.fg("accent", slotNumber.toString().padStart(2));
	const name = isCursor ? theme.fg("accent", slot.agentName) : slot.agentName;
	const nameWidth = 16;
	const prefix = `${cursor} ${num}  `;
	const prefixVis = visibleWidth(prefix);
	const nameStr = pad(truncateToWidth(name, nameWidth), nameWidth);

	if (slot.customTask) {
		const taskWidth = Math.max(0, width - 2 - prefixVis - nameWidth - 3);
		const taskPreview = theme.fg("dim", `"${truncateToWidth(slot.customTask, Math.max(0, taskWidth - 2))}"`);
		return ` ${prefix}${nameStr}  ${taskPreview}`;
	}
	return ` ${prefix}${nameStr}`;
}

export function renderParallel(
	state: ParallelState,
	agents: AgentOption[],
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(" Parallel Builder ", width, theme));
	lines.push(row("", width, theme));

	const contentLines: string[] = [];

	if (state.mode === "browse") {
		clampSlotScroll(state, SLOT_VIEWPORT_BROWSE);
		const start = state.scrollOffset;
		const end = Math.min(state.slots.length, start + SLOT_VIEWPORT_BROWSE);
		for (let i = start; i < end; i++) {
			contentLines.push(renderSlotLine(state.slots[i]!, i + 1, i === state.cursor, width, theme));
		}
	} else if (state.mode === "add") {
		const slotLines = Math.min(state.slots.length, SLOT_VIEWPORT_COMPACT);
		const slotStart = Math.max(0, state.slots.length - slotLines);
		for (let i = slotStart; i < state.slots.length; i++) {
			contentLines.push(renderSlotLine(state.slots[i]!, i + 1, false, width, theme));
		}
		contentLines.push("");

		const searchIcon = theme.fg("dim", "◎");
		const cursor = theme.fg("accent", "│");
		const placeholder = theme.fg("dim", "\x1b[3msearch agents...\x1b[23m");
		const queryDisplay = state.addQuery ? `${state.addQuery}${cursor}` : `${cursor}${placeholder}`;
		contentLines.push(` ${searchIcon}  ${queryDisplay}`);

		const filtered = fuzzyFilter(agents, state.addQuery);
		const addStart = Math.max(0, Math.min(state.addCursor - ADD_RESULTS_MAX + 1, filtered.length - ADD_RESULTS_MAX));
		const addEnd = Math.min(filtered.length, addStart + ADD_RESULTS_MAX);
		for (let i = addStart; i < addEnd; i++) {
			const a = filtered[i]!;
			const isCursor = i === state.addCursor;
			const cur = isCursor ? theme.fg("accent", "▸") : " ";
			const nameStr = isCursor ? theme.fg("accent", a.name) : a.name;
			const descWidth = Math.max(0, width - 2 - 1 - 1 - 16 - 2);
			contentLines.push(` ${cur} ${pad(truncateToWidth(nameStr, 16), 16)}  ${theme.fg("dim", truncateToWidth(a.description, descWidth))}`);
		}
	} else if (state.mode === "edit-task") {
		const slotLines = Math.min(state.slots.length, SLOT_VIEWPORT_COMPACT);
		const slotStart = Math.max(0, Math.min(state.editIndex - Math.floor(slotLines / 2), state.slots.length - slotLines));
		for (let i = slotStart; i < slotStart + slotLines; i++) {
			contentLines.push(renderSlotLine(state.slots[i]!, i + 1, i === state.editIndex, width, theme));
		}
		contentLines.push("");

		const slot = state.slots[state.editIndex];
		const label = slot ? `Task for ${slot.agentName} (slot ${state.editIndex + 1}):` : "Task:";
		contentLines.push(` ${theme.fg("dim", label)}`);

		const innerW = width - 2;
		const boxInnerWidth = Math.max(10, innerW - 4);
		contentLines.push(` \u250C${"\u2500".repeat(boxInnerWidth)}\u2510`);

		if (state.editEditor) {
			const editorState = { ...state.editEditor };
			const wrapped = wrapText(editorState.buffer, boxInnerWidth);
			const cursorPos = getCursorDisplayPos(editorState.cursor, wrapped.starts);
			editorState.viewportOffset = ensureCursorVisible(cursorPos.line, 1, editorState.viewportOffset);
			const editorLine = renderEditor(editorState, boxInnerWidth, 1)[0] ?? "";
			contentLines.push(` \u2502${pad(editorLine, boxInnerWidth)}\u2502`);
		} else {
			contentLines.push(` \u2502${pad("", boxInnerWidth)}\u2502`);
		}

		contentLines.push(` \u2514${"\u2500".repeat(boxInnerWidth)}\u2518`);
		contentLines.push(` ${theme.fg("dim", "Empty = use shared task")}`);
	}

	for (const line of contentLines) lines.push(row(line, width, theme));
	for (let i = contentLines.length; i < CONTENT_HEIGHT; i++) lines.push(row("", width, theme));

	let statusText = "";
	if (state.mode === "browse") {
		if (state.slots.length < 2) {
			statusText = theme.fg("dim", `${state.slots.length} agent — add at least 2 for parallel`);
		} else {
			statusText = theme.fg("dim", formatSlotSummary(state.slots));
		}
	}
	lines.push(row(statusText ? ` ${statusText}` : "", width, theme));

	let footerText: string;
	if (state.mode === "add") {
		footerText = " [enter] add  [esc] cancel ";
	} else if (state.mode === "edit-task") {
		footerText = " [enter] save  [esc] cancel ";
	} else {
		footerText = " [ctrl+a] add  [del] remove  [enter] edit task  [ctrl+r] continue  [esc] back ";
	}
	lines.push(renderFooter(footerText, width, theme));

	return lines;
}

function formatSlotSummary(slots: ParallelSlot[]): string {
	const counts = new Map<string, number>();
	for (const s of slots) counts.set(s.agentName, (counts.get(s.agentName) ?? 0) + 1);
	return [...counts.entries()].map(([name, count]) => count > 1 ? `${count}\u00D7 ${name}` : name).join(" + ");
}

export function formatParallelTitle(slots: ParallelSlot[]): string {
	return `Parallel: ${formatSlotSummary(slots)}`;
}
