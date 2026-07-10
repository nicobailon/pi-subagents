/**
 * Chain Clarification TUI Component
 *
 * Shows templates and resolved behaviors for each step in a chain.
 * Supports runtime editing of templates, output paths, reads lists, and progress toggle.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { resolveModelCandidate, splitThinkingSuffix } from "../shared/model-fallback.ts";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo, type ThinkingLevel } from "../../shared/model-info.ts";

type ClarifyMode = 'single' | 'parallel' | 'chain';

export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;
	skills?: string[] | false;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	behaviorOverrides: (BehaviorOverride | undefined)[];
	runInBackground?: boolean;
}

type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";


interface TextEditorState {
	buffer: string;
	cursor: number;
	viewportOffset: number;
}

function createEditorState(initial = ""): TextEditorState {
	return { buffer: initial, cursor: 0, viewportOffset: 0 };
}

function wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
	if (width <= 0) return { lines: [text], starts: [0] };
	if (text.length === 0) return { lines: [""], starts: [0] };

	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	const segments = text.split("\n");
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) {
			starts.push(offset);
			lines.push("");
		} else {
			let lineStart = 0;
			let pos = 0;
			let lineWidth = 0;
			while (pos < segment.length) {
				const char = String.fromCodePoint(segment.codePointAt(pos)!);
				const charWidth = visibleWidth(char);
				if (lineWidth > 0 && lineWidth + charWidth > width) {
					starts.push(offset + lineStart);
					lines.push(segment.slice(lineStart, pos));
					lineStart = pos;
					lineWidth = 0;
					continue;
				}
				pos += char.length;
				lineWidth += charWidth;
			}
			starts.push(offset + lineStart);
			lines.push(segment.slice(lineStart));
		}
		offset += segment.length + (index < segments.length - 1 ? 1 : 0);
	}
	if (!text.endsWith("\n") && text.length > 0 && visibleWidth(lines[lines.length - 1] ?? "") === width) {
		starts.push(text.length);
		lines.push("");
	}
	return { lines, starts };
}

function getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number } {
	for (let i = starts.length - 1; i >= 0; i--) {
		if (cursor >= starts[i]!) return { line: i, col: cursor - starts[i]! };
	}
	return { line: 0, col: 0 };
}

function ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number {
	if (cursorLine < currentOffset) return Math.max(0, cursorLine);
	if (cursorLine >= currentOffset + viewportHeight) return Math.max(0, cursorLine - viewportHeight + 1);
	return Math.max(0, currentOffset);
}

function isWordChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function wordBackward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos > 0 && !isWordChar(buffer[pos - 1]!)) pos--;
	while (pos > 0 && isWordChar(buffer[pos - 1]!)) pos--;
	return pos;
}

function wordForward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos < buffer.length && isWordChar(buffer[pos]!)) pos++;
	while (pos < buffer.length && !isWordChar(buffer[pos]!)) pos++;
	return pos;
}

function normalizeInsertText(data: string): string | null {
	let text = data.split("\x1b[200~").join("").split("\x1b[201~").join("");
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const newline = text.indexOf("\n");
	if (newline !== -1) text = text.slice(0, newline);
	text = text.replace(/\t/g, "    ");
	if (text.length === 0) return null;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 32) return null;
	}
	return text;
}

function handleEditorInput(state: TextEditorState, data: string, textWidth: number): TextEditorState | null {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) return null;

	const { lines: wrapped, starts } = wrapText(state.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);

	if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left")) return { ...state, cursor: wordBackward(state.buffer, state.cursor) };
	if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right")) return { ...state, cursor: wordForward(state.buffer, state.cursor) };
	if (matchesKey(data, "left")) return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state;
	if (matchesKey(data, "right")) return state.cursor < state.buffer.length ? { ...state, cursor: state.cursor + 1 } : state;
	if (matchesKey(data, "up") && cursorPos.line > 0) {
		const targetLine = cursorPos.line - 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "down") && cursorPos.line < wrapped.length - 1) {
		const targetLine = cursorPos.line + 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "home")) return { ...state, cursor: starts[cursorPos.line]! };
	if (matchesKey(data, "end")) return { ...state, cursor: starts[cursorPos.line]! + (wrapped[cursorPos.line]?.length ?? 0) };
	if (matchesKey(data, "ctrl+home")) return { ...state, cursor: 0 };
	if (matchesKey(data, "ctrl+end")) return { ...state, cursor: state.buffer.length };
	if (matchesKey(data, "alt+backspace")) {
		const target = wordBackward(state.buffer, state.cursor);
		return target === state.cursor ? state : { ...state, buffer: state.buffer.slice(0, target) + state.buffer.slice(state.cursor), cursor: target };
	}
	if (matchesKey(data, "backspace")) {
		return state.cursor > 0
			? { ...state, buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor), cursor: state.cursor - 1 }
			: state;
	}
	if (matchesKey(data, "delete")) {
		return state.cursor < state.buffer.length
			? { ...state, buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1) }
			: state;
	}

	const insert = normalizeInsertText(data);
	return insert
		? { ...state, buffer: state.buffer.slice(0, state.cursor) + insert + state.buffer.slice(state.cursor), cursor: state.cursor + insert.length }
		: null;
}

function renderWithCursor(text: string, cursorPos: number): string {
	const before = text.slice(0, cursorPos);
	const cursorChar = text[cursorPos] ?? " ";
	const after = text.slice(cursorPos + 1);
	return `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
}

function renderEditor(state: TextEditorState, width: number, viewportHeight: number): string[] {
	const { lines: wrapped, starts } = wrapText(state.buffer, width);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);
	const lines: string[] = [];
	for (let i = 0; i < viewportHeight; i++) {
		const lineIdx = state.viewportOffset + i;
		let content = lineIdx < wrapped.length ? wrapped[lineIdx] ?? "" : "";
		if (lineIdx === cursorPos.line) content = renderWithCursor(content, cursorPos.col);
		lines.push(content);
	}
	return lines;
}

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	private selectedStep = 0;
	private editingStep: number | null = null;
	private editMode: EditMode = "template";
	private editState: TextEditorState = createEditorState();

	private readonly EDIT_VIEWPORT_HEIGHT = 12;
	private behaviorOverrides: Map<number, BehaviorOverride> = new Map();
	private modelSearchQuery: string = "";
	private modelSelectedIndex: number = 0;
	private filteredModels: ModelInfo[] = [];
	private readonly MODEL_SELECTOR_HEIGHT = 10;
	private thinkingSelectedIndex: number = 0;
	private skillSearchQuery: string = "";
	private skillSelectedNames: Set<string> = new Set();
	private skillCursorIndex: number = 0;
	private filteredSkills: Array<{ name: string; source: string; description?: string }> = [];
	private noticeMessage: { text: string; type: "info" | "error" } | null = null;
	private noticeMessageTimer: ReturnType<typeof setTimeout> | null = null;
	/** Run in background (async) mode */
	private runInBackground = false;
	private tui: TUI;
	private theme: Theme;
	private agentConfigs: AgentConfig[];
	private templates: string[];
	private originalTask: string;
	private chainDir: string | undefined;
	private resolvedBehaviors: ResolvedStepBehavior[];
	private availableModels: ModelInfo[];
	private preferredProvider: string | undefined;
	private availableSkills: Array<{ name: string; source: string; description?: string }>;
	private done: (result: ChainClarifyResult) => void;
	private mode: ClarifyMode;

	constructor(
		tui: TUI,
		theme: Theme,
		agentConfigs: AgentConfig[],
		templates: string[],
		originalTask: string,
		chainDir: string | undefined,
		resolvedBehaviors: ResolvedStepBehavior[],
		availableModels: ModelInfo[],
		preferredProvider: string | undefined,
		availableSkills: Array<{ name: string; source: string; description?: string }>,
		done: (result: ChainClarifyResult) => void,
		mode: ClarifyMode = 'chain',
	) {
		this.tui = tui;
		this.theme = theme;
		this.agentConfigs = agentConfigs;
		this.templates = templates;
		this.originalTask = originalTask;
		this.chainDir = chainDir;
		this.resolvedBehaviors = resolvedBehaviors;
		this.availableModels = availableModels;
		this.preferredProvider = preferredProvider;
		this.availableSkills = availableSkills;
		this.done = done;
		this.mode = mode;
		this.filteredModels = [...availableModels];
		this.filteredSkills = [...availableSkills];
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Helper methods for rendering
	// ─────────────────────────────────────────────────────────────────────────────

	/** Pad string to specified visible width */
	private pad(s: string, len: number): string {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	}

	/** Create a row with border characters */
	private row(content: string): string {
		const innerW = this.width - 2;
		return this.theme.fg("border", "│") + this.pad(content, innerW) + this.theme.fg("border", "│");
	}

	/** Render centered header line with border */
	private renderHeader(text: string): string {
		const innerW = this.width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			this.theme.fg("border", "╭" + "─".repeat(padLeft)) +
			this.theme.fg("accent", text) +
			this.theme.fg("border", "─".repeat(padRight) + "╮")
		);
	}

	/** Render centered footer line with border */
	private renderFooter(text: string): string {
		const innerW = this.width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			this.theme.fg("border", "╰" + "─".repeat(padLeft)) +
			this.theme.fg("dim", text) +
			this.theme.fg("border", "─".repeat(padRight) + "╯")
		);
	}

	/** Exit edit mode and reset state */
	private exitEditMode(): void {
		this.editingStep = null;
		this.editState = createEditorState();
		this.tui.requestRender();
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Full edit mode methods
	// ─────────────────────────────────────────────────────────────────────────────

	/** Render the full-edit takeover view */
	private renderFullEditMode(): string[] {
		const innerW = this.width - 2;
		const textWidth = innerW - 2; // 1 char padding on each side
		const lines: string[] = [];

		const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
		this.editState = {
			...this.editState,
			viewportOffset: ensureCursorVisible(
				cursorPos.line,
				this.EDIT_VIEWPORT_HEIGHT,
				this.editState.viewportOffset,
			),
		};

		// Header (truncate agent name to prevent overflow)
		const fieldName = this.editMode === "template" ? "task" : this.editMode;
		const rawAgentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const maxAgentLen = innerW - 30; // Reserve space for " Editing X (Step/Task N: ) "
		const agentName = rawAgentName.length > maxAgentLen
			? rawAgentName.slice(0, maxAgentLen - 1) + "…"
			: rawAgentName;
		// Use mode-appropriate terminology
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Editing ${fieldName} (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const editorLines = renderEditor(this.editState, textWidth, this.EDIT_VIEWPORT_HEIGHT);
		for (const line of editorLines) {
			lines.push(this.row(` ${line}`));
		}

		const linesBelow = wrapped.length - this.editState.viewportOffset - this.EDIT_VIEWPORT_HEIGHT;
		const hasMore = linesBelow > 0;
		const hasLess = this.editState.viewportOffset > 0;
		let scrollInfo = "";
		if (hasLess) scrollInfo += "↑";
		if (hasMore) scrollInfo += `↓ ${linesBelow}+`;

		lines.push(this.row(""));

		const footerText = scrollInfo
			? ` [Esc] Done • [Ctrl+C] Discard • ${scrollInfo} `
			: " [Esc] Done • [Ctrl+C] Discard ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Behavior helpers
	// ─────────────────────────────────────────────────────────────────────────────

	/** Get effective behavior for a step (with user overrides applied) */
	private getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior {
		const base = this.resolvedBehaviors[stepIndex]!;
		const override = this.behaviorOverrides.get(stepIndex);
		if (!override) return base;

		return {
			output: override.output !== undefined ? override.output : base.output,
			outputMode: base.outputMode,
			reads: override.reads !== undefined ? override.reads : base.reads,
			progress: override.progress !== undefined ? override.progress : base.progress,
			skills: override.skills !== undefined ? override.skills : base.skills,
			model: override.model !== undefined ? override.model : base.model,
		};
	}

	/** Get the effective model for a step (override or agent default) */
	private getEffectiveModel(stepIndex: number): string {
		const override = this.behaviorOverrides.get(stepIndex);
		if (override?.model) return this.resolveModelFullId(override.model);

		const baseModel = this.resolvedBehaviors[stepIndex]?.model;
		if (baseModel) return this.resolveModelFullId(baseModel);
		return "default";
	}

	/** Resolve a model name to its full provider/model format */
	private resolveModelFullId(modelName: string): string {
		return resolveModelCandidate(modelName, this.availableModels, this.preferredProvider) ?? modelName;
	}

	/** Update a behavior override for a step */
	private updateBehavior(stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
		const existing = this.behaviorOverrides.get(stepIndex) ?? {};
		this.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
	}

	private showNotice(text: string, type: "info" | "error"): void {
		this.noticeMessage = { text, type };
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = setTimeout(() => {
			this.noticeMessage = null;
			this.noticeMessageTimer = null;
			this.tui.requestRender();
		}, 2000);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.editingStep !== null) {
			if (this.editMode === "model") {
				this.handleModelSelectorInput(data);
			} else if (this.editMode === "thinking") {
				this.handleThinkingSelectorInput(data);
			} else if (this.editMode === "skills") {
				this.handleSkillSelectorInput(data);
			} else {
				this.handleEditInput(data);
			}
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ confirmed: false, templates: [], behaviorOverrides: [] });
			return;
		}

		if (matchesKey(data, "return")) {
			const overrides: (BehaviorOverride | undefined)[] = [];
			for (let i = 0; i < this.agentConfigs.length; i++) {
				overrides.push(this.behaviorOverrides.get(i));
			}
			this.done({ confirmed: true, templates: this.templates, behaviorOverrides: overrides, runInBackground: this.runInBackground });
			return;
		}

		if (matchesKey(data, "up")) {
			this.selectedStep = Math.max(0, this.selectedStep - 1);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			const maxStep = Math.max(0, this.agentConfigs.length - 1);
			this.selectedStep = Math.min(maxStep, this.selectedStep + 1);
			this.tui.requestRender();
			return;
		}

		if (data === "e") {
			this.enterEditMode("template");
			return;
		}

		if (data === "m") {
			this.enterModelSelector();
			return;
		}

		if (data === "t") {
			this.enterThinkingSelector();
			return;
		}

		if (data === "s") {
			this.editingStep = this.selectedStep;
			this.editMode = "skills";
			this.skillSearchQuery = "";
			this.skillCursorIndex = 0;
			this.filteredSkills = [...this.availableSkills];
			const current = this.getEffectiveBehavior(this.selectedStep).skills;
			this.skillSelectedNames.clear();
			if (current !== false && current.length > 0) {
				current.forEach((skillName) => this.skillSelectedNames.add(skillName));
			}
			this.tui.requestRender();
			return;
		}

		if (data === "w" && this.mode !== 'parallel') {
			this.enterEditMode("output");
			return;
		}

		if (data === "r" && this.mode === 'chain') {
			this.enterEditMode("reads");
			return;
		}

		if (data === "p" && this.mode === 'chain') {
			const anyEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
			const newState = !anyEnabled;
			for (let i = 0; i < this.agentConfigs.length; i++) {
				this.updateBehavior(i, "progress", newState);
			}
			this.tui.requestRender();
			return;
		}

		if (data === "b") {
			this.runInBackground = !this.runInBackground;
			this.tui.requestRender();
			return;
		}

	}

	private enterEditMode(mode: EditMode): void {
		this.editingStep = this.selectedStep;
		this.editMode = mode;
		let buffer = "";

		if (mode === "template") {
			const template = this.templates[this.selectedStep] ?? "";
			buffer = template.split("\n")[0] ?? "";
		} else if (mode === "output") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.output === false ? "" : (behavior.output || "");
		} else if (mode === "reads") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
		}

		this.editState = createEditorState(buffer);
		this.tui.requestRender();
	}

	/** Enter model selector mode */
	private enterModelSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "model";
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];
		const currentModel = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep)).baseModel;
		const currentIndex = this.filteredModels.findIndex((m) => m.fullId === currentModel || m.id === currentModel);
		if (currentIndex >= 0) {
			this.modelSelectedIndex = currentIndex;
		}

		this.tui.requestRender();
	}

	/** Filter models based on search query */
	private filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		if (!query) {
			this.filteredModels = [...this.availableModels];
		} else {
			this.filteredModels = this.availableModels.filter((m) =>
				m.fullId.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.provider.toLowerCase().includes(query)
			);
		}
		this.modelSelectedIndex = Math.min(this.modelSelectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private handleModelSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = this.filteredModels[this.modelSelectedIndex];
			if (selected) {
				const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.editingStep!));
				const requestedLevel = thinkingSuffix.slice(1);
				const selectedModel = findModelInfo(selected.fullId, this.availableModels, this.preferredProvider);
				const suffix = getSupportedThinkingLevels(selectedModel).some((level) => level === requestedLevel) ? thinkingSuffix : "";
				this.updateBehavior(this.editingStep!, "model", `${selected.fullId}${suffix}`);
			}
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === 0
					? this.filteredModels.length - 1
					: this.modelSelectedIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === this.filteredModels.length - 1
					? 0
					: this.modelSelectedIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			this.tui.requestRender();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}
	}

	private getAvailableThinkingLevels(stepIndex: number): ThinkingLevel[] {
		return getSupportedThinkingLevels(findModelInfo(this.getEffectiveModel(stepIndex), this.availableModels, this.preferredProvider));
	}

	/** Enter thinking level selector mode */
	private enterThinkingSelector(): void {
		if (!this.getEffectiveBehavior(this.selectedStep).model) {
			this.showNotice("Select a model first", "error");
			return;
		}
		this.editingStep = this.selectedStep;
		this.editMode = "thinking";

		const levels = this.getAvailableThinkingLevels(this.selectedStep);
		const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep));
		const suffix = thinkingSuffix.slice(1);
		const levelIdx = levels.findIndex((level) => level === suffix);
		this.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : Math.max(0, levels.indexOf("off"));

		this.tui.requestRender();
	}

	private handleThinkingSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		const levels = this.getAvailableThinkingLevels(this.editingStep!);
		if (levels.length === 0) return;

		if (matchesKey(data, "return")) {
			const selectedLevel = levels[this.thinkingSelectedIndex] ?? "off";
			this.applyThinkingLevel(selectedLevel);
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "up")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === 0
				? levels.length - 1
				: this.thinkingSelectedIndex - 1;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === levels.length - 1
				? 0
				: this.thinkingSelectedIndex + 1;
			this.tui.requestRender();
			return;
		}
	}

	/** Apply thinking level to the current step's model */
	private applyThinkingLevel(level: ThinkingLevel): void {
		const stepIndex = this.editingStep!;
		const currentModel = this.getEffectiveBehavior(stepIndex).model;
		if (!currentModel) return;

		const { baseModel } = splitThinkingSuffix(currentModel);
		const newModel = level === "off" ? baseModel : `${baseModel}:${level}`;
		this.updateBehavior(stepIndex, "model", newModel);
	}

	private filterSkills(): void {
		const query = this.skillSearchQuery.toLowerCase();
		if (!query) {
			this.filteredSkills = [...this.availableSkills];
		} else {
			this.filteredSkills = this.availableSkills.filter((s) =>
				s.name.toLowerCase().includes(query) ||
				(s.description?.toLowerCase().includes(query) ?? false),
			);
		}
		this.skillCursorIndex = Math.min(this.skillCursorIndex, Math.max(0, this.filteredSkills.length - 1));
	}

	private handleSkillSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = [...this.skillSelectedNames];
			this.updateBehavior(this.editingStep!, "skills", selected);
			this.exitEditMode();
			return;
		}

		if (data === " ") {
			if (this.filteredSkills.length > 0) {
				const skill = this.filteredSkills[this.skillCursorIndex];
				if (skill) {
					if (this.skillSelectedNames.has(skill.name)) {
						this.skillSelectedNames.delete(skill.name);
					} else {
						this.skillSelectedNames.add(skill.name);
					}
				}
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === 0
					? this.filteredSkills.length - 1
					: this.skillCursorIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === this.filteredSkills.length - 1
					? 0
					: this.skillCursorIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.skillSearchQuery.length > 0) {
				this.skillSearchQuery = this.skillSearchQuery.slice(0, -1);
				this.filterSkills();
			}
			this.tui.requestRender();
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.skillSearchQuery += data;
			this.filterSkills();
			this.tui.requestRender();
			return;
		}
	}

	private handleEditInput(data: string): void {
		const textWidth = this.width - 4; // Must match render: innerW - 2 = (width - 2) - 2
		if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.max(0, cursorPos.line - this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.min(wrapped.length - 1, cursorPos.line + this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "tab")) return;

		const nextState = handleEditorInput(this.editState, data, textWidth);
		if (nextState) {
			this.editState = nextState;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			this.saveEdit();
			this.exitEditMode();
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}
	}

	private saveEdit(): void {
		const stepIndex = this.editingStep!;

		if (this.editMode === "template") {
			// For template, preserve other lines if they existed
			const original = this.templates[stepIndex] ?? "";
			const originalLines = original.split("\n");
			originalLines[0] = this.editState.buffer;
			this.templates[stepIndex] = originalLines.join("\n");
		} else if (this.editMode === "output") {
			// Capture OLD output before updating (for downstream propagation)
			const oldBehavior = this.getEffectiveBehavior(stepIndex);
			const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;

			// Empty string or whitespace means disable output
			const trimmed = this.editState.buffer.trim();
			const newOutput = trimmed === "" ? false : trimmed;
			this.updateBehavior(stepIndex, "output", newOutput);

			// Propagate output filename change to downstream steps' reads
			if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
				this.propagateOutputChange(stepIndex, oldOutput, newOutput);
			}
		} else if (this.editMode === "reads") {
			// Parse comma-separated list, empty means disable reads
			const trimmed = this.editState.buffer.trim();
			if (trimmed === "") {
				this.updateBehavior(stepIndex, "reads", false);
			} else {
				const files = trimmed.split(",").map(f => f.trim()).filter(f => f !== "");
				this.updateBehavior(stepIndex, "reads", files.length > 0 ? files : false);
			}
		}
	}

	/**
	 * When a step's output filename changes, update downstream steps that read from it.
	 * This maintains the chain dependency automatically.
	 */
	private propagateOutputChange(changedStepIndex: number, oldOutput: string, newOutput: string): void {
		// Check all downstream steps (steps that come after the changed step)
		for (let i = changedStepIndex + 1; i < this.agentConfigs.length; i++) {
			const behavior = this.getEffectiveBehavior(i);
			
			// Skip if reads is disabled or empty
			if (behavior.reads === false || !behavior.reads || behavior.reads.length === 0) {
				continue;
			}

			// Check if this step reads the old output file
			const readsArray = behavior.reads;
			const oldIndex = readsArray.indexOf(oldOutput);
			
			if (oldIndex !== -1) {
				// Replace old filename with new filename in reads
				const newReads = [...readsArray];
				newReads[oldIndex] = newOutput;
				this.updateBehavior(i, "reads", newReads);
			}
		}
	}

	render(_width: number): string[] {
		if (this.editingStep !== null) {
			if (this.editMode === "model") {
				return this.renderModelSelector();
			}
			if (this.editMode === "thinking") {
				return this.renderThinkingSelector();
			}
			if (this.editMode === "skills") {
				return this.renderSkillSelector();
			}
			return this.renderFullEditMode();
		}
		// Mode-based navigation rendering
		switch (this.mode) {
			case 'single': return this.renderSingleMode();
			case 'parallel': return this.renderParallelMode();
			case 'chain': return this.renderChainMode();
		}
	}

	/** Render the model selector view */
	private renderModelSelector(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Header (mode-aware terminology)
		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Select Model (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const searchPrefix = th.fg("dim", "Search: ");
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		const searchDisplay = this.modelSearchQuery + cursor;
		lines.push(this.row(` ${searchPrefix}${searchDisplay}`));
		lines.push(this.row(""));

		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentModelBase = splitThinkingSuffix(currentModel).baseModel;
		const currentLabel = th.fg("dim", "Current: ");
		lines.push(this.row(` ${currentLabel}${th.fg("warning", currentModel)}`));
		lines.push(this.row(""));

		if (this.filteredModels.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No matching models")}`));
		} else {
			const maxVisible = this.MODEL_SELECTOR_HEIGHT;
			let startIdx = 0;

			if (this.filteredModels.length > maxVisible) {
				startIdx = Math.max(0, this.modelSelectedIndex - Math.floor(maxVisible / 2));
				startIdx = Math.min(startIdx, this.filteredModels.length - maxVisible);
			}

			const endIdx = Math.min(startIdx + maxVisible, this.filteredModels.length);

			if (startIdx > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
			}

			for (let i = startIdx; i < endIdx; i++) {
				const model = this.filteredModels[i]!;
				const isSelected = i === this.modelSelectedIndex;
				const isCurrent = model.fullId === currentModelBase || model.id === currentModelBase;
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const modelText = isSelected ? th.fg("accent", model.id) : model.id;
				const providerBadge = th.fg("dim", ` [${model.provider}]`);
				const currentBadge = isCurrent ? th.fg("success", " current") : "";

				lines.push(this.row(` ${prefix}${modelText}${providerBadge}${currentBadge}`));
			}

			const remaining = this.filteredModels.length - endIdx;
			if (remaining > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
			}
		}

		const contentLines = lines.length;
		const targetHeight = 18;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		const footerText = " [Enter] Select • [Esc] Cancel • Type to search ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	/** Render the thinking level selector view */
	private renderThinkingSelector(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Thinking Level (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentLabel = th.fg("dim", "Model: ");
		lines.push(this.row(` ${currentLabel}${th.fg("accent", currentModel)}`));
		lines.push(this.row(""));

		lines.push(this.row(` ${th.fg("dim", "Select thinking level (extended thinking budget):")}`));
		lines.push(this.row(""));

		const levelDescriptions: Record<ThinkingLevel, string> = {
			"off": "No extended thinking",
			"minimal": "Brief reasoning",
			"low": "Light reasoning",
			"medium": "Moderate reasoning",
			"high": "Deep reasoning",
			"xhigh": "Maximum reasoning (ultrathink)",
			"max": "Maximum available reasoning",
		};

		const levels = this.getAvailableThinkingLevels(this.editingStep!);
		if (levels.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No supported thinking levels")}`));
		} else {
			for (let i = 0; i < levels.length; i++) {
				const level = levels[i]!;
				const isSelected = i === this.thinkingSelectedIndex;
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const levelText = isSelected ? th.fg("accent", level) : level;
				const desc = th.fg("dim", ` - ${levelDescriptions[level]}`);
				lines.push(this.row(` ${prefix}${levelText}${desc}`));
			}
		}

		const contentLines = lines.length;
		const targetHeight = 16;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		const footerText = levels.length === 0
			? " [Esc] Cancel "
			: " [Enter] Select • [Esc] Cancel • ↑↓ Navigate ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	private renderSkillSelector(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single'
			? agentName
			: this.mode === 'parallel'
				? `Task ${this.editingStep! + 1}: ${agentName}`
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		lines.push(this.renderHeader(` Select Skills (${stepLabel}) `));
		lines.push(this.row(""));

		const cursor = "\x1b[7m \x1b[27m";
		lines.push(this.row(` ${th.fg("dim", "Search: ")}${this.skillSearchQuery}${cursor}`));
		lines.push(this.row(""));

		const selected = [...this.skillSelectedNames].join(", ") || th.fg("dim", "(none)");
		lines.push(this.row(` ${th.fg("dim", "Selected: ")}${truncateToWidth(selected, innerW - 12)}`));
		lines.push(this.row(""));

		const selectorHeight = 10;
		if (this.filteredSkills.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No matching skills")}`));
		} else {
			let startIdx = 0;
			if (this.filteredSkills.length > selectorHeight) {
				startIdx = Math.max(0, this.skillCursorIndex - Math.floor(selectorHeight / 2));
				startIdx = Math.min(startIdx, this.filteredSkills.length - selectorHeight);
			}
			const endIdx = Math.min(startIdx + selectorHeight, this.filteredSkills.length);

			if (startIdx > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
			}

			for (let i = startIdx; i < endIdx; i++) {
				const skill = this.filteredSkills[i]!;
				const isCursor = i === this.skillCursorIndex;
				const isSelected = this.skillSelectedNames.has(skill.name);

				const prefix = isCursor ? th.fg("accent", "→ ") : "  ";
				const checkbox = isSelected ? th.fg("success", "[x]") : "[ ]";
				const nameText = isCursor ? th.fg("accent", skill.name) : skill.name;
				const sourceBadge = th.fg("dim", ` [${skill.source}]`);
				const desc = skill.description
					? th.fg("dim", ` - ${truncateToWidth(skill.description, 25)}`)
					: "";

				lines.push(this.row(` ${prefix}${checkbox} ${nameText}${sourceBadge}${desc}`));
			}

			const remaining = this.filteredSkills.length - endIdx;
			if (remaining > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
			}
		}

		const targetHeight = 18;
		for (let i = lines.length; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		lines.push(this.renderFooter(" [Enter] Confirm • [Space] Toggle • [Esc] Cancel "));
		return lines;
	}

	private getShortcutHelpText(): string {
		const th = this.theme;
		const shortcut = (key: string, label: string) =>
			th.fg("accent", `[${key}]`) + th.fg("dim", label);
		const backgroundState = this.runInBackground ? "ON" : "OFF";
		const background = shortcut("b", `Background:${backgroundState}`);

		switch (this.mode) {
			case 'single':
				return ` ${shortcut("e", "Task")} ${shortcut("m", "Model")} ${shortcut("t", "Think")} ${shortcut("w", "Output")} ${shortcut("s", "Skills")} ${background}`;
			case 'parallel':
				return ` ${shortcut("e", "Task")} ${shortcut("m", "Model")} ${shortcut("t", "Think")} ${shortcut("s", "Skills")} ${background}`;
			case 'chain':
				return ` ${shortcut("e", "Task")} ${shortcut("m", "Model")} ${shortcut("t", "Think")} ${shortcut("w", "Output")} ${shortcut("r", "Reads")} ${shortcut("p", "Prog")} ${shortcut("s", "Skills")} ${background}`;
		}
	}

	private getFooterText(): string {
		return this.mode === 'single'
			? " [Enter] Run • [Esc] Cancel "
			: " [Enter] Run • [Esc] Cancel • [↑↓] Navigate ";
	}

	private appendNotice(lines: string[]): void {
		if (!this.noticeMessage) return;
		const color = this.noticeMessage.type === "error" ? "error" : "success";
		lines.push(this.row(` ${this.theme.fg(color, this.noticeMessage.text)}`));
	}

	private renderSingleMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[0]?.name ?? "unknown";
		const maxHeaderLen = innerW - 4;
		const headerText = ` Agent: ${truncateToWidth(agentName, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const config = this.agentConfigs[0]!;
		const behavior = this.getEffectiveBehavior(0);

		const stepLabel = config.name;
		lines.push(this.row(` ${th.fg("accent", "▶ " + stepLabel)}`));

		const template = (this.templates[0] ?? "").split("\n")[0] ?? "";
		const taskLabel = th.fg("dim", "task: ");
		lines.push(this.row(`     ${taskLabel}${truncateToWidth(template, innerW - 12)}`));

		const effectiveModel = this.getEffectiveModel(0);
		const override = this.behaviorOverrides.get(0);
		const isOverridden = override?.model !== undefined;
		const modelValue = isOverridden
			? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
			: effectiveModel;
		const modelLabel = th.fg("dim", "model: ");
		lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

		const writesValue = behavior.output === false
			? th.fg("dim", "(disabled)")
			: (behavior.output || th.fg("dim", "(none)"));
		const writesLabel = th.fg("dim", "writes: ");
		lines.push(this.row(`     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

		const skillsValue = behavior.skills === false
			? th.fg("dim", "(disabled)")
			: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
		const skillsLabel = th.fg("dim", "skills: ");
		lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

		lines.push(this.row(this.getShortcutHelpText()));

		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	private renderParallelMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const headerText = ` Parallel Tasks (${this.agentConfigs.length}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;

			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const taskPrefix = `Task ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - taskPrefix.length;
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const taskLabel = `${taskPrefix}${agentName}`;
			lines.push(this.row(` ${th.fg(color, prefix + taskLabel)}`));

			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const taskTextLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${taskTextLabel}${truncateToWidth(template, innerW - 12)}`));

			const effectiveModel = this.getEffectiveModel(i);
			const override = this.behaviorOverrides.get(i);
			const isOverridden = override?.model !== undefined;
			const modelValue = isOverridden
				? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
				: effectiveModel;
			const modelLabel = th.fg("dim", "model: ");
			lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

			const behavior = this.getEffectiveBehavior(i);
			const skillsValue = behavior.skills === false
				? th.fg("dim", "(disabled)")
				: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
			const skillsLabel = th.fg("dim", "skills: ");
			lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

			lines.push(this.row(""));
		}

		if (this.agentConfigs.length > 0) lines.pop();
		lines.push(this.row(this.getShortcutHelpText()));
		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	private renderChainMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const chainLabel = this.agentConfigs.map((c) => c.name).join(" → ");
		const maxHeaderLen = innerW - 4;
		const headerText = ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));

		lines.push(this.row(""));

		const taskPreview = truncateToWidth(this.originalTask, innerW - 16);
		lines.push(this.row(` Original Task: ${taskPreview}`));
		const chainDirPreview = truncateToWidth(this.chainDir ?? "", innerW - 12);
		lines.push(this.row(` Chain Dir: ${th.fg("dim", chainDirPreview)}`));

		const progressEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
		const progressValue = progressEnabled ? th.fg("success", "enabled") : th.fg("dim", "disabled");
		lines.push(this.row(` Progress: ${progressValue} ${th.fg("dim", "(press [p] to toggle)")}`));
		lines.push(this.row(""));

		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;
			const behavior = this.getEffectiveBehavior(i);

			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const stepPrefix = `Step ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - stepPrefix.length;
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const stepLabel = `${stepPrefix}${agentName}`;
			lines.push(
				this.row(` ${th.fg(color, prefix + stepLabel)}`),
			);

			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const highlighted = template
				.replace(/\{task\}/g, th.fg("success", "{task}"))
				.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
				.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));

			const templateLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${templateLabel}${truncateToWidth(highlighted, innerW - 12)}`));

			const effectiveModel = this.getEffectiveModel(i);
			const override = this.behaviorOverrides.get(i);
			const isOverridden = override?.model !== undefined;
			const modelValue = isOverridden
				? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
				: effectiveModel;
			const modelLabel = th.fg("dim", "model: ");
			lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

			const writesValue = behavior.output === false
				? th.fg("dim", "(disabled)")
				: (behavior.output || th.fg("dim", "(none)"));
			const writesLabel = th.fg("dim", "writes: ");
			lines.push(this.row(`     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

			const readsValue = behavior.reads === false
				? th.fg("dim", "(disabled)")
				: (behavior.reads && behavior.reads.length > 0
					? behavior.reads.join(", ")
					: th.fg("dim", "(none)"));
			const readsLabel = th.fg("dim", "reads: ");
			lines.push(this.row(`     ${readsLabel}${truncateToWidth(readsValue, innerW - 13)}`));

			const skillsValue = behavior.skills === false
				? th.fg("dim", "(disabled)")
				: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
			const skillsLabel = th.fg("dim", "skills: ");
			lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

			if (progressEnabled) {
				const isFirstStep = i === 0;
				const progressAction = isFirstStep 
					? th.fg("success", "writes progress.md")
					: th.fg("accent", "reads progress.md");
				const progressLabel = th.fg("dim", "progress: ");
				lines.push(this.row(`     ${progressLabel}${progressAction}`));
			}

			if (i < this.agentConfigs.length - 1) {
				const nextStepUsePrevious = (this.templates[i + 1] ?? "").includes("{previous}");
				if (nextStepUsePrevious) {
					const indicator = th.fg("dim", "     ↳ response → ") + th.fg("warning", "{previous}");
					lines.push(this.row(indicator));
				}
			}

			lines.push(this.row(""));
		}

		if (this.agentConfigs.length > 0) lines.pop();
		lines.push(this.row(this.getShortcutHelpText()));
		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = null;
	}
}
