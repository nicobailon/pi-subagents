/**
 * Chain Clarification TUI Component
 *
 * Shows templates and resolved behaviors for each step in a chain.
 * Supports editing templates, output paths, reads lists, and progress toggle.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import type { ResolvedStepBehavior } from "./settings.js";

/** Clarify TUI mode */
export type ClarifyMode = 'single' | 'parallel' | 'chain';

/** Model info for display */
export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;  // "provider/id"
}

/** Modified behavior overrides from TUI editing */
export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;  // Override agent's default model (format: "provider/id")
	skills?: string[] | false;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	/** User-modified behavior overrides per step (undefined = no changes) */
	behaviorOverrides: (BehaviorOverride | undefined)[];
}

type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";

/** Valid thinking levels */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	private selectedStep = 0;
	private editingStep: number | null = null;
	private editMode: EditMode = "template";
	private editBuffer: string = "";
	private editCursor: number = 0;
	private editViewportOffset: number = 0;

	/** Lines visible in full edit mode */
	private readonly EDIT_VIEWPORT_HEIGHT = 12;

	/** Track user modifications to behaviors (sparse - only stores changes) */
	private behaviorOverrides: Map<number, BehaviorOverride> = new Map();

	/** Model selector state */
	private modelSearchQuery: string = "";
	private modelSelectedIndex: number = 0;
	private filteredModels: ModelInfo[] = [];

	/** Max models visible in selector */
	private readonly MODEL_SELECTOR_HEIGHT = 10;

	/** Thinking level selector state */
	private thinkingSelectedIndex: number = 0;

	/** Skill selector state */
	private skillSearchQuery: string = "";
	private skillSelectedNames: Set<string> = new Set();
	private skillCursorIndex: number = 0;
	private filteredSkills: Array<{ name: string; source: string; description?: string }> = [];

	constructor(
		private tui: TUI,
		private theme: Theme,
		private agentConfigs: AgentConfig[],
		private templates: string[],
		private originalTask: string,
		private chainDir: string | undefined,  // undefined for single/parallel modes
		private resolvedBehaviors: ResolvedStepBehavior[],
		private availableModels: ModelInfo[],
		private availableSkills: Array<{ name: string; source: string; description?: string }>,
		private done: (result: ChainClarifyResult) => void,
		private mode: ClarifyMode = 'chain',   // Mode: 'single', 'parallel', or 'chain'
	) {
		// Initialize filtered models
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
		this.editViewportOffset = 0;
		this.tui.requestRender();
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Full edit mode methods
	// ─────────────────────────────────────────────────────────────────────────────

	/** Word-wrap text to specified width, tracking buffer positions */
	private wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
		const lines: string[] = [];
		const starts: number[] = [];

		// Guard against invalid width
		if (width <= 0) {
			return { lines: [text], starts: [0] };
		}

		// Handle empty text
		if (text.length === 0) {
			return { lines: [""], starts: [0] };
		}

		let pos = 0;
		while (pos < text.length) {
			starts.push(pos);

			// Take up to `width` characters
			const remaining = text.length - pos;
			const lineLen = Math.min(width, remaining);
			lines.push(text.slice(pos, pos + lineLen));
			pos += lineLen;
		}

		// Handle cursor at very end when text fills last line exactly
		// Cursor at position text.length needs a place to render
		if (text.length > 0 && text.length % width === 0) {
			starts.push(text.length);
			lines.push(""); // Empty line for cursor to sit on
		}

		return { lines, starts };
	}

	/** Convert buffer position to display line/column */
	private getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number } {
		for (let i = starts.length - 1; i >= 0; i--) {
			if (cursor >= starts[i]) {
				return { line: i, col: cursor - starts[i] };
			}
		}
		return { line: 0, col: 0 };
	}

	/** Calculate new viewport offset to keep cursor visible */
	private ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number {
		let offset = currentOffset;

		// Cursor above viewport - scroll up
		if (cursorLine < offset) {
			offset = cursorLine;
		}
		// Cursor below viewport - scroll down
		else if (cursorLine >= offset + viewportHeight) {
			offset = cursorLine - viewportHeight + 1;
		}

		return Math.max(0, offset);
	}

	/** Render the full-edit takeover view */
	private renderFullEditMode(): string[] {
		const innerW = this.width - 2;
		const textWidth = innerW - 2; // 1 char padding on each side
		const lines: string[] = [];

		// Word wrap the edit buffer
		const { lines: wrapped, starts } = this.wrapText(this.editBuffer, textWidth);

		// Find cursor display position
		const cursorPos = this.getCursorDisplayPos(this.editCursor, starts);

		// Auto-scroll to keep cursor visible
		this.editViewportOffset = this.ensureCursorVisible(
			cursorPos.line,
			this.EDIT_VIEWPORT_HEIGHT,
			this.editViewportOffset,
		);

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

		// Render visible lines from viewport
		for (let i = 0; i < this.EDIT_VIEWPORT_HEIGHT; i++) {
			const lineIdx = this.editViewportOffset + i;
			if (lineIdx < wrapped.length) {
				let content = wrapped[lineIdx];

				// Insert cursor if on this line
				if (lineIdx === cursorPos.line) {
					content = this.renderWithCursor(content, cursorPos.col);
				}

				lines.push(this.row(` ${content}`));
			} else {
				lines.push(this.row(""));
			}
		}

		// Scroll indicators
		const linesBelow = wrapped.length - this.editViewportOffset - this.EDIT_VIEWPORT_HEIGHT;
		const hasMore = linesBelow > 0;
		const hasLess = this.editViewportOffset > 0;
		let scrollInfo = "";
		if (hasLess) scrollInfo += "↑";
		if (hasMore) scrollInfo += `↓ ${linesBelow}+`;

		lines.push(this.row(""));

		// Footer with scroll indicators if applicable
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
	private getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior & { model?: string } {
		const base = this.resolvedBehaviors[stepIndex]!;
		const override = this.behaviorOverrides.get(stepIndex);
		if (!override) return base;

		return {
			output: override.output !== undefined ? override.output : base.output,
			reads: override.reads !== undefined ? override.reads : base.reads,
			progress: override.progress !== undefined ? override.progress : base.progress,
			skills: override.skills !== undefined ? override.skills : base.skills,
			model: override.model,
		};
	}

	/** Get the effective model for a step (override or agent default) */
	private getEffectiveModel(stepIndex: number): string {
		const override = this.behaviorOverrides.get(stepIndex);
		if (override?.model) return override.model;  // Override is already in provider/model format
		
		// Use agent's configured model or "default"
		const agentModel = this.agentConfigs[stepIndex]?.model;
		if (!agentModel) return "default";
		
		// Resolve model name to full provider/model format
		return this.resolveModelFullId(agentModel);
	}

	/** Resolve a model name to its full provider/model format */
	private resolveModelFullId(modelName: string): string {
		// If already in provider/model format, return as-is
		if (modelName.includes("/")) return modelName;
		
		// Handle thinking level suffixes (e.g., "claude-sonnet-4-5:high")
		// Strip the suffix for lookup, then add it back
		const colonIdx = modelName.lastIndexOf(":");
		const baseModel = colonIdx !== -1 ? modelName.substring(0, colonIdx) : modelName;
		const thinkingSuffix = colonIdx !== -1 ? modelName.substring(colonIdx) : "";
		
		// Look up base model in available models to find provider
		const match = this.availableModels.find(m => m.id === baseModel);
		if (match) {
			return thinkingSuffix ? `${match.fullId}${thinkingSuffix}` : match.fullId;
		}
		
		// Fallback to just the model name if not found
		return modelName;
	}

	/** Update a behavior override for a step */
	private updateBehavior(stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
		const existing = this.behaviorOverrides.get(stepIndex) ?? {};
		this.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
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

		// Navigation mode
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ confirmed: false, templates: [], behaviorOverrides: [] });
			return;
		}

		if (matchesKey(data, "return")) {
			// Build behavior overrides array
			const overrides: (BehaviorOverride | undefined)[] = [];
			for (let i = 0; i < this.agentConfigs.length; i++) {
				overrides.push(this.behaviorOverrides.get(i));
			}
			this.done({ confirmed: true, templates: this.templates, behaviorOverrides: overrides });
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

		// 'e' to edit template (all modes)
		if (data === "e") {
			this.enterEditMode("template");
			return;
		}

		// 'm' to select model (all modes)
		if (data === "m") {
			this.enterModelSelector();
			return;
		}

		// 't' to select thinking level (all modes)
		if (data === "t") {
			this.enterThinkingSelector();
			return;
		}

		// 's' to select skills (all modes)
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

		// 'w' to edit writes (single and chain only - not parallel)
		if (data === "w" && this.mode !== 'parallel') {
			this.enterEditMode("output");
			return;
		}

		// 'r' to edit reads (chain only)
		if (data === "r" && this.mode === 'chain') {
			this.enterEditMode("reads");
			return;
		}

		// 'p' to toggle progress for ALL steps (chain only - chains share a single progress.md)
		if (data === "p" && this.mode === 'chain') {
			// Check if any step has progress enabled
			const anyEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
			// Toggle all steps to the opposite state
			const newState = !anyEnabled;
			for (let i = 0; i < this.agentConfigs.length; i++) {
				this.updateBehavior(i, "progress", newState);
			}
			this.tui.requestRender();
			return;
		}
	}

	private enterEditMode(mode: EditMode): void {
		this.editingStep = this.selectedStep;
		this.editMode = mode;
		this.editViewportOffset = 0; // Reset scroll position

		if (mode === "template") {
			const template = this.templates[this.selectedStep] ?? "";
			// For template, use first line only (single-line editor)
			this.editBuffer = template.split("\n")[0] ?? "";
		} else if (mode === "output") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			this.editBuffer = behavior.output === false ? "" : (behavior.output || "");
		} else if (mode === "reads") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			this.editBuffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
		}

		this.editCursor = 0; // Start at beginning so cursor is visible
		this.tui.requestRender();
	}

	/** Enter model selector mode */
	private enterModelSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "model";
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];
		
		// Pre-select current model if it exists in the list
		const currentModel = this.getEffectiveModel(this.selectedStep);
		const currentIndex = this.filteredModels.findIndex(m => m.fullId === currentModel || m.id === currentModel);
		if (currentIndex >= 0) {
			this.modelSelectedIndex = currentIndex;
		}
		
		this.tui.requestRender();
	}

	/** Filter models based on search query (fuzzy match) */
	private filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		if (!query) {
			this.filteredModels = [...this.availableModels];
		} else {
			this.filteredModels = this.availableModels.filter(m => 
				m.fullId.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.provider.toLowerCase().includes(query)
			);
		}
		// Clamp selected index
		this.modelSelectedIndex = Math.min(this.modelSelectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	/** Handle input in model selector mode */
	private handleModelSelectorInput(data: string): void {
		// Escape or Ctrl+C - cancel and exit
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		// Enter - select current model
		if (matchesKey(data, "return")) {
			const selected = this.filteredModels[this.modelSelectedIndex];
			if (selected) {
				this.updateBehavior(this.editingStep!, "model", selected.fullId);
			}
			this.exitEditMode();
			return;
		}

		// Up arrow - move selection up
		if (matchesKey(data, "up")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === 0 
					? this.filteredModels.length - 1 
					: this.modelSelectedIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		// Down arrow - move selection down
		if (matchesKey(data, "down")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === this.filteredModels.length - 1 
					? 0 
					: this.modelSelectedIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		// Backspace - delete last character from search
		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			this.tui.requestRender();
			return;
		}

		// Printable character - add to search query
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}
	}

	/** Enter thinking level selector mode */
	private enterThinkingSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "thinking";
		
		// Pre-select current thinking level if set
		const currentModel = this.getEffectiveModel(this.selectedStep);
		const colonIdx = currentModel.lastIndexOf(":");
		if (colonIdx !== -1) {
			const suffix = currentModel.substring(colonIdx + 1);
			const levelIdx = THINKING_LEVELS.indexOf(suffix as ThinkingLevel);
			this.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : 0;
		} else {
			this.thinkingSelectedIndex = 0; // Default to "off"
		}
		
		this.tui.requestRender();
	}

	/** Handle input in thinking level selector mode */
	private handleThinkingSelectorInput(data: string): void {
		// Escape or Ctrl+C - cancel and exit
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		// Enter - select current thinking level
		if (matchesKey(data, "return")) {
			const selectedLevel = THINKING_LEVELS[this.thinkingSelectedIndex];
			this.applyThinkingLevel(selectedLevel);
			this.exitEditMode();
			return;
		}

		// Up arrow - move selection up
		if (matchesKey(data, "up")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === 0 
				? THINKING_LEVELS.length - 1 
				: this.thinkingSelectedIndex - 1;
			this.tui.requestRender();
			return;
		}

		// Down arrow - move selection down
		if (matchesKey(data, "down")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === THINKING_LEVELS.length - 1 
				? 0 
				: this.thinkingSelectedIndex + 1;
			this.tui.requestRender();
			return;
		}
	}

	/** Apply thinking level to the current step's model */
	private applyThinkingLevel(level: ThinkingLevel): void {
		const stepIndex = this.editingStep!;
		const currentModel = this.getEffectiveModel(stepIndex);
		
		// Strip any existing thinking level suffix
		const colonIdx = currentModel.lastIndexOf(":");
		let baseModel = currentModel;
		if (colonIdx !== -1) {
			const suffix = currentModel.substring(colonIdx + 1);
			if (THINKING_LEVELS.includes(suffix as ThinkingLevel)) {
				baseModel = currentModel.substring(0, colonIdx);
			}
		}
		
		// Apply new thinking level (don't add suffix for "off")
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
		const { lines: wrapped, starts } = this.wrapText(this.editBuffer, textWidth);
		const cursorPos = this.getCursorDisplayPos(this.editCursor, starts);

		// Escape - save and exit
		if (matchesKey(data, "escape")) {
			this.saveEdit();
			this.exitEditMode();
			return;
		}

		// Ctrl+C - discard and exit
		if (matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return;
		}

		// Enter - ignored (single-line editing, no newlines)
		if (matchesKey(data, "return")) {
			return;
		}

		// Left arrow - move cursor left
		if (matchesKey(data, "left")) {
			if (this.editCursor > 0) this.editCursor--;
			this.tui.requestRender();
			return;
		}

		// Right arrow - move cursor right
		if (matchesKey(data, "right")) {
			if (this.editCursor < this.editBuffer.length) this.editCursor++;
			this.tui.requestRender();
			return;
		}

		// Up arrow - move up one display line
		if (matchesKey(data, "up")) {
			if (cursorPos.line > 0) {
				const targetLine = cursorPos.line - 1;
				const targetCol = Math.min(cursorPos.col, wrapped[targetLine].length);
				this.editCursor = starts[targetLine] + targetCol;
			}
			this.tui.requestRender();
			return;
		}

		// Down arrow - move down one display line
		if (matchesKey(data, "down")) {
			if (cursorPos.line < wrapped.length - 1) {
				const targetLine = cursorPos.line + 1;
				const targetCol = Math.min(cursorPos.col, wrapped[targetLine].length);
				this.editCursor = starts[targetLine] + targetCol;
			}
			this.tui.requestRender();
			return;
		}

		// Page up (Shift+Up or PageUp)
		if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) {
			const targetLine = Math.max(0, cursorPos.line - this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editCursor = starts[targetLine] + targetCol;
			this.tui.requestRender();
			return;
		}

		// Page down (Shift+Down or PageDown)
		if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
			const targetLine = Math.min(wrapped.length - 1, cursorPos.line + this.EDIT_VIEWPORT_HEIGHT);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editCursor = starts[targetLine] + targetCol;
			this.tui.requestRender();
			return;
		}

		// Home - start of current display line
		if (matchesKey(data, "home")) {
			this.editCursor = starts[cursorPos.line];
			this.tui.requestRender();
			return;
		}

		// End - end of current display line
		if (matchesKey(data, "end")) {
			this.editCursor = starts[cursorPos.line] + wrapped[cursorPos.line].length;
			this.tui.requestRender();
			return;
		}

		// Ctrl+Home - start of text
		if (matchesKey(data, "ctrl+home")) {
			this.editCursor = 0;
			this.tui.requestRender();
			return;
		}

		// Ctrl+End - end of text
		if (matchesKey(data, "ctrl+end")) {
			this.editCursor = this.editBuffer.length;
			this.tui.requestRender();
			return;
		}

		// Backspace - delete character before cursor
		if (matchesKey(data, "backspace")) {
			if (this.editCursor > 0) {
				this.editBuffer =
					this.editBuffer.slice(0, this.editCursor - 1) +
					this.editBuffer.slice(this.editCursor);
				this.editCursor--;
			}
			this.tui.requestRender();
			return;
		}

		// Delete - delete character at cursor
		if (matchesKey(data, "delete")) {
			if (this.editCursor < this.editBuffer.length) {
				this.editBuffer =
					this.editBuffer.slice(0, this.editCursor) +
					this.editBuffer.slice(this.editCursor + 1);
			}
			this.tui.requestRender();
			return;
		}

		// Printable character - insert at cursor
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.editBuffer =
				this.editBuffer.slice(0, this.editCursor) +
				data +
				this.editBuffer.slice(this.editCursor);
			this.editCursor++;
			this.tui.requestRender();
			return;
		}
	}

	private saveEdit(): void {
		const stepIndex = this.editingStep!;

		if (this.editMode === "template") {
			// For template, preserve other lines if they existed
			const original = this.templates[stepIndex] ?? "";
			const originalLines = original.split("\n");
			originalLines[0] = this.editBuffer;
			this.templates[stepIndex] = originalLines.join("\n");
		} else if (this.editMode === "output") {
			// Capture OLD output before updating (for downstream propagation)
			const oldBehavior = this.getEffectiveBehavior(stepIndex);
			const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;

			// Empty string or whitespace means disable output
			const trimmed = this.editBuffer.trim();
			const newOutput = trimmed === "" ? false : trimmed;
			this.updateBehavior(stepIndex, "output", newOutput);

			// Propagate output filename change to downstream steps' reads
			if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
				this.propagateOutputChange(stepIndex, oldOutput, newOutput);
			}
		} else if (this.editMode === "reads") {
			// Parse comma-separated list, empty means disable reads
			const trimmed = this.editBuffer.trim();
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
		const innerW = this.width - 2;
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

		// Search input
		const searchPrefix = th.fg("dim", "Search: ");
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		const searchDisplay = this.modelSearchQuery + cursor;
		lines.push(this.row(` ${searchPrefix}${searchDisplay}`));
		lines.push(this.row(""));

		// Current model info
		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentLabel = th.fg("dim", "Current: ");
		lines.push(this.row(` ${currentLabel}${th.fg("warning", currentModel)}`));
		lines.push(this.row(""));

		// Model list with scroll
		if (this.filteredModels.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No matching models")}`));
		} else {
			// Calculate visible range (scroll to keep selection visible)
			const maxVisible = this.MODEL_SELECTOR_HEIGHT;
			let startIdx = 0;
			
			// Keep selection centered if possible
			if (this.filteredModels.length > maxVisible) {
				startIdx = Math.max(0, this.modelSelectedIndex - Math.floor(maxVisible / 2));
				startIdx = Math.min(startIdx, this.filteredModels.length - maxVisible);
			}
			
			const endIdx = Math.min(startIdx + maxVisible, this.filteredModels.length);

			// Show scroll indicator if needed
			if (startIdx > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
			}

			for (let i = startIdx; i < endIdx; i++) {
				const model = this.filteredModels[i]!;
				const isSelected = i === this.modelSelectedIndex;
				const isCurrent = model.fullId === currentModel || model.id === currentModel;
				
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const modelText = isSelected ? th.fg("accent", model.id) : model.id;
				const providerBadge = th.fg("dim", ` [${model.provider}]`);
				const currentBadge = isCurrent ? th.fg("success", " ✓") : "";
				
				lines.push(this.row(` ${prefix}${modelText}${providerBadge}${currentBadge}`));
			}

			// Show scroll indicator if needed
			const remaining = this.filteredModels.length - endIdx;
			if (remaining > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
			}
		}

		// Pad to consistent height
		const contentLines = lines.length;
		const targetHeight = 18; // Consistent height
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		// Footer
		const footerText = " [Enter] Select • [Esc] Cancel • Type to search ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	/** Render the thinking level selector view */
	private renderThinkingSelector(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		// Header (mode-aware terminology)
		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Thinking Level (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		// Current model info
		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentLabel = th.fg("dim", "Model: ");
		lines.push(this.row(` ${currentLabel}${th.fg("accent", currentModel)}`));
		lines.push(this.row(""));

		// Description
		lines.push(this.row(` ${th.fg("dim", "Select thinking level (extended thinking budget):")}`));
		lines.push(this.row(""));

		// Thinking level options
		const levelDescriptions: Record<ThinkingLevel, string> = {
			"off": "No extended thinking",
			"minimal": "Brief reasoning",
			"low": "Light reasoning",
			"medium": "Moderate reasoning",
			"high": "Deep reasoning",
			"xhigh": "Maximum reasoning (ultrathink)",
		};

		for (let i = 0; i < THINKING_LEVELS.length; i++) {
			const level = THINKING_LEVELS[i];
			const isSelected = i === this.thinkingSelectedIndex;
			const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
			const levelText = isSelected ? th.fg("accent", level) : level;
			const desc = th.fg("dim", ` - ${levelDescriptions[level]}`);
			lines.push(this.row(` ${prefix}${levelText}${desc}`));
		}

		// Pad to consistent height
		const contentLines = lines.length;
		const targetHeight = 16;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		// Footer
		const footerText = " [Enter] Select • [Esc] Cancel • ↑↓ Navigate ";
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

	/** Get footer text based on mode */
	private getFooterText(): string {
		switch (this.mode) {
			case 'single':
				return ' [Enter] Run • [Esc] Cancel • [e]dit [m]odel [t]hink [w]rite [s]kill ';
			case 'parallel':
				return ' [Enter] Run • [Esc] Cancel • [e]dit [m]odel [t]hink [s]kill • ↑↓ Nav ';
			case 'chain':
				return ' [Enter] Run • [Esc] Cancel • e m t w r p s • ↑↓ Nav ';
		}
	}

	/** Render single agent mode (simplified view) */
	private renderSingleMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		// Header with agent name
		const agentName = this.agentConfigs[0]?.name ?? "unknown";
		const maxHeaderLen = innerW - 4;
		const headerText = ` Agent: ${truncateToWidth(agentName, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		// Single step - always index 0, always selected
		const config = this.agentConfigs[0]!;
		const behavior = this.getEffectiveBehavior(0);

		// Agent name with selection indicator
		const stepLabel = config.name;
		lines.push(this.row(` ${th.fg("accent", "▶ " + stepLabel)}`));

		// Task line
		const template = (this.templates[0] ?? "").split("\n")[0] ?? "";
		const taskLabel = th.fg("dim", "task: ");
		lines.push(this.row(`     ${taskLabel}${truncateToWidth(template, innerW - 12)}`));

		// Model line
		const effectiveModel = this.getEffectiveModel(0);
		const override = this.behaviorOverrides.get(0);
		const isOverridden = override?.model !== undefined;
		const modelValue = isOverridden
			? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
			: effectiveModel;
		const modelLabel = th.fg("dim", "model: ");
		lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

		// Writes line (output file)
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

		lines.push(this.row(""));

		// Footer
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	/** Render parallel mode (multi-task view without chain features) */
	private renderParallelMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		// Header with task count
		const headerText = ` Parallel Tasks (${this.agentConfigs.length}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		// Each task
		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;

			// Task header (truncate agent name to prevent overflow)
			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const taskPrefix = `Task ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - taskPrefix.length;
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const taskLabel = `${taskPrefix}${agentName}`;
			lines.push(this.row(` ${th.fg(color, prefix + taskLabel)}`));

			// Task line
			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const taskTextLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${taskTextLabel}${truncateToWidth(template, innerW - 12)}`));

			// Model line
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

		// Footer
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	/** Render chain mode (step selection, preview) */
	private renderChainMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		// Header with chain name (truncate if too long)
		const chainLabel = this.agentConfigs.map((c) => c.name).join(" → ");
		const maxHeaderLen = innerW - 4;
		const headerText = ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));

		lines.push(this.row(""));

		// Original task (truncated) and chain dir
		const taskPreview = truncateToWidth(this.originalTask, innerW - 16);
		lines.push(this.row(` Original Task: ${taskPreview}`));
		// chainDir is guaranteed to be defined in chain mode
		const chainDirPreview = truncateToWidth(this.chainDir ?? "", innerW - 12);
		lines.push(this.row(` Chain Dir: ${th.fg("dim", chainDirPreview)}`));

		// Chain-wide progress setting
		const progressEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
		const progressValue = progressEnabled ? th.fg("success", "✓ enabled") : th.fg("dim", "✗ disabled");
		lines.push(this.row(` Progress: ${progressValue} ${th.fg("dim", "(press [p] to toggle)")}`));
		lines.push(this.row(""));

		// Each step
		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;
			const behavior = this.getEffectiveBehavior(i);

			// Step header (truncate agent name to prevent overflow)
			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const stepPrefix = `Step ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - stepPrefix.length; // 4 for " " prefix and padding
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const stepLabel = `${stepPrefix}${agentName}`;
			lines.push(
				this.row(` ${th.fg(color, prefix + stepLabel)}`),
			);

			// Template line (with syntax highlighting for variables)
			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const highlighted = template
				.replace(/\{task\}/g, th.fg("success", "{task}"))
				.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
				.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));

			const templateLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${templateLabel}${truncateToWidth(highlighted, innerW - 12)}`));

			// Model line (show override indicator if modified)
			const effectiveModel = this.getEffectiveModel(i);
			const override = this.behaviorOverrides.get(i);
			const isOverridden = override?.model !== undefined;
			const modelValue = isOverridden
				? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
				: effectiveModel;
			const modelLabel = th.fg("dim", "model: ");
			lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

			// Writes line (output file) - renamed from "output" for clarity
			const writesValue = behavior.output === false
				? th.fg("dim", "(disabled)")
				: (behavior.output || th.fg("dim", "(none)"));
			const writesLabel = th.fg("dim", "writes: ");
			lines.push(this.row(`     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

			// Reads line
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

			// Progress line - show when chain-wide progress is enabled
			// First step creates & updates, subsequent steps read & update
			if (progressEnabled) {
				const isFirstStep = i === 0;
				const progressAction = isFirstStep 
					? th.fg("success", "●") + th.fg("dim", " creates & updates progress.md")
					: th.fg("accent", "↔") + th.fg("dim", " reads & updates progress.md");
				const progressLabel = th.fg("dim", "progress: ");
				lines.push(this.row(`     ${progressLabel}${progressAction}`));
			}

			// Show {previous} indicator for all steps except the last
			// This shows that this step's text response becomes {previous} for the next step
			if (i < this.agentConfigs.length - 1) {
				const nextStepUsePrevious = (this.templates[i + 1] ?? "").includes("{previous}");
				if (nextStepUsePrevious) {
					const indicator = th.fg("dim", "     ↳ response → ") + th.fg("warning", "{previous}");
					lines.push(this.row(indicator));
				}
			}

			lines.push(this.row(""));
		}

		// Footer with keybindings
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	/** Render text with cursor at position (reverse video for visibility) */
	private renderWithCursor(text: string, cursorPos: number): string {
		const before = text.slice(0, cursorPos);
		const cursorChar = text[cursorPos] ?? " ";
		const after = text.slice(cursorPos + 1);
		// Use reverse video (\x1b[7m) for cursor, then disable reverse (\x1b[27m)
		return `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
	}

	invalidate(): void {}
	dispose(): void {}
}
