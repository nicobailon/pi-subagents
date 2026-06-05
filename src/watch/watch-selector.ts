import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WatchSection, WatchTarget, WatchTreeRow } from "./watch-types.ts";

function padToWidth(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

interface SelectableRow {
	section: string;
	row: WatchTreeRow;
	target?: WatchTarget;
}

export class WatchSelector implements Component {
	private selected = 0;
	private rows: SelectableRow[];
	private input: { tui: TUI; theme: Theme; sections: WatchSection[]; onSelect: (target: WatchTarget) => void; onClose: () => void };

	constructor(input: { tui: TUI; theme: Theme; sections: WatchSection[]; onSelect: (target: WatchTarget) => void; onClose: () => void }) {
		this.input = input;
		const byId = new Map(input.sections.flatMap((section) => section.targets.map((target) => [target.id, target] as const)));
		this.rows = input.sections.flatMap((section) => [
			{ section: section.title, row: { key: `${section.title}:header`, selectable: false, depth: 0, text: section.title } },
			...section.rows.map((row) => ({ section: section.title, row, target: row.targetId ? byId.get(row.targetId) : undefined })),
		]);
		const first = this.rows.findIndex((entry) => entry.row.selectable);
		this.selected = first === -1 ? 0 : first;
	}

	private move(delta: 1 | -1): void {
		if (this.rows.length === 0) return;
		let next = this.selected;
		for (let i = 0; i < this.rows.length; i += 1) {
			next = (next + delta + this.rows.length) % this.rows.length;
			if (this.rows[next]?.row.selectable) break;
		}
		this.selected = next;
	}

	render(width: number): string[] {
		const { theme } = this.input;
		const inner = Math.max(1, width - 4);
		const lines = [
			theme.fg("border", "┌" + "─".repeat(width - 2) + "┐"),
			this.frame(theme.bold(theme.fg("accent", "Subagent Watch · current session only")), width),
			theme.fg("border", "├" + "─".repeat(width - 2) + "┤"),
		];
		if (this.rows.length === 0) {
			lines.push(this.frame(theme.fg("dim", "No current-session async subagents are available."), width));
		} else {
			for (let index = 0; index < this.rows.length; index += 1) {
				const item = this.rows[index]!;
				const isHeader = !item.row.selectable && item.row.key.endsWith(":header");
				const prefix = item.row.selectable ? (index === this.selected ? theme.fg("accent", "› ") : "  ") : "";
				const indent = "  ".repeat(Math.max(0, item.row.depth));
				const raw = isHeader ? theme.bold(theme.fg("accent", item.row.text)) : `${prefix}${indent}${item.row.text}`;
				lines.push(this.frame(truncateToWidth(raw, inner, "...", true), width));
			}
		}
		lines.push(theme.fg("border", "├" + "─".repeat(width - 2) + "┤"));
		lines.push(this.frame(theme.fg("dim", "↑/↓ select · Enter open · Esc/q close"), width));
		lines.push(theme.fg("border", "└" + "─".repeat(width - 2) + "┘"));
		return lines;
	}

	private frame(content: string, width: number): string {
		const inner = Math.max(1, width - 4);
		const safe = truncateToWidth(content.replaceAll("\r", " "), inner, "...", true);
		return this.input.theme.fg("border", "│ ") + padToWidth(safe, inner) + this.input.theme.fg("border", " │");
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.input.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.move(-1);
			this.input.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.move(1);
			this.input.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const target = this.rows[this.selected]?.target;
			if (target) this.input.onSelect(target);
		}
	}

	invalidate(): void {}
}
