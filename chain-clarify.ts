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

/** Modified behavior overrides from TUI editing */
export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	/** User-modified behavior overrides per step (undefined = no changes) */
	behaviorOverrides: (BehaviorOverride | undefined)[];
}

type EditMode = "template" | "output" | "reads";

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

	constructor(
		private tui: TUI,
		private theme: Theme,
		private agentConfigs: AgentConfig[],
		private templates: string[],
		private originalTask: string,
		private chainDir: string,
		private resolvedBehaviors: ResolvedStepBehavior[],
		private done: (result: ChainClarifyResult) => void,
	) {}

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
		const maxAgentLen = innerW - 30; // Reserve space for " Editing X (Step N: ) "
		const agentName = rawAgentName.length > maxAgentLen
			? rawAgentName.slice(0, maxAgentLen - 1) + "…"
			: rawAgentName;
		const headerText = ` Editing ${fieldName} (Step ${this.editingStep! + 1}: ${agentName}) `;
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
	private getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior {
		const base = this.resolvedBehaviors[stepIndex]!;
		const override = this.behaviorOverrides.get(stepIndex);
		if (!override) return base;

		return {
			output: override.output !== undefined ? override.output : base.output,
			reads: override.reads !== undefined ? override.reads : base.reads,
			progress: override.progress !== undefined ? override.progress : base.progress,
		};
	}

	/** Update a behavior override for a step */
	private updateBehavior(stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
		const existing = this.behaviorOverrides.get(stepIndex) ?? {};
		this.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
	}

	handleInput(data: string): void {
		if (this.editingStep !== null) {
			this.handleEditInput(data);
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

		// 'e' to edit template
		if (data === "e") {
			this.enterEditMode("template");
			return;
		}

		// 'o' to edit output
		if (data === "o") {
			this.enterEditMode("output");
			return;
		}

		// 'r' to edit reads
		if (data === "r") {
			this.enterEditMode("reads");
			return;
		}

		// 'p' to toggle progress
		if (data === "p") {
			const current = this.getEffectiveBehavior(this.selectedStep);
			this.updateBehavior(this.selectedStep, "progress", !current.progress);
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
			// Empty string or whitespace means disable output
			const trimmed = this.editBuffer.trim();
			this.updateBehavior(stepIndex, "output", trimmed === "" ? false : trimmed);
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

	render(_width: number): string[] {
		if (this.editingStep !== null) {
			return this.renderFullEditMode();
		}
		return this.renderNavigationMode();
	}

	/** Render navigation mode (step selection, preview) */
	private renderNavigationMode(): string[] {
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
		const chainDirPreview = truncateToWidth(this.chainDir, innerW - 12);
		lines.push(this.row(` Chain Dir: ${th.fg("dim", chainDirPreview)}`));
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

			// Output line
			const outputValue = behavior.output === false
				? th.fg("dim", "(disabled)")
				: (behavior.output || th.fg("dim", "(none)"));
			const outputLabel = th.fg("dim", "output: ");
			lines.push(this.row(`     ${outputLabel}${truncateToWidth(outputValue, innerW - 14)}`));

			// Reads line
			const readsValue = behavior.reads === false
				? th.fg("dim", "(disabled)")
				: (behavior.reads && behavior.reads.length > 0
					? behavior.reads.join(", ")
					: th.fg("dim", "(none)"));
			const readsLabel = th.fg("dim", "reads: ");
			lines.push(this.row(`     ${readsLabel}${truncateToWidth(readsValue, innerW - 13)}`));

			// Progress line
			const progressValue = behavior.progress ? th.fg("success", "✓ enabled") : th.fg("dim", "✗ disabled");
			const progressLabel = th.fg("dim", "progress: ");
			lines.push(this.row(`     ${progressLabel}${progressValue}`));

			lines.push(this.row(""));
		}

		// Footer with keybindings
		const footerText = " [Enter] Run • [Esc] Cancel • [e]dit [o]utput [r]eads [p]rogress ";
		lines.push(this.renderFooter(footerText));

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
