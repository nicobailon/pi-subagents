import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type KeybindingsManager, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

/** A single selectable row. `value` is returned on confirm; `label` is the primary text. */
export interface SelectorItem {
	value: string;
	label: string;
	/** Optional dimmed badge shown after the label (e.g. a provider name). */
	badge?: string;
	/** Marks the current selection (rendered with a ✓ checkmark). */
	current?: boolean;
}

export interface SelectorResult {
	confirmed: boolean;
	value?: string;
}

export interface SelectorOptions {
	title: string;
	/** Optional dimmed hint line under the title (e.g. the current value). */
	subtitle?: string;
	items: SelectorItem[];
	done: (result: SelectorResult) => void;
}

const MAX_VISIBLE = 10;

/**
 * A single-select list with a search field and a bounded scroll window that keeps the
 * highlighted row on screen with an `(n/total)` indicator, so the selection never scrolls
 * out of view when the option list is long. Composed from pi's own TUI primitives so it
 * matches the built-in `/model` picker.
 *
 * Colors come from the `theme` passed to the factory: the module-level `theme` singleton
 * is undefined under the extension's jiti module cache.
 */
export class SelectorComponent extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly items: SelectorItem[];
	private readonly done: (result: SelectorResult) => void;

	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private filtered: SelectorItem[];
	private selectedIndex = 0;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: SelectorOptions) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.items = options.items;
		this.done = options.done;
		this.filtered = [...this.items];

		const border = () => new DynamicBorder((str) => theme.fg("border", str));
		this.addChild(border());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(options.title)), 0, 0));
		if (options.subtitle) this.addChild(new Text(theme.fg("muted", options.subtitle), 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.addChild(new Text(rawKeyHint("↑↓", "navigate") + "  " + keyHint("tui.select.confirm", "select") + "  " + keyHint("tui.select.cancel", "cancel"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(border());

		const currentIndex = this.filtered.findIndex((item) => item.current);
		if (currentIndex >= 0) this.selectedIndex = currentIndex;
		this.updateList();
	}

	private applyFilter(query: string): void {
		const previous = this.filtered[this.selectedIndex]?.value;
		this.filtered = query
			? fuzzyFilter(this.items, query, (item) => `${item.label} ${item.value} ${item.badge ?? ""}`)
			: [...this.items];
		const keepIndex = this.filtered.findIndex((item) => item.value === previous);
		this.selectedIndex = keepIndex >= 0 ? keepIndex : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		const th = this.theme;
		this.listContainer.clear();
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filtered.length - MAX_VISIBLE));
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filtered.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filtered[i]!;
			const isSelected = i === this.selectedIndex;
			const badge = item.badge ? ` ${th.fg("muted", `[${item.badge}]`)}` : "";
			const checkmark = item.current ? th.fg("success", " ✓") : "";
			const line = isSelected
				? `${th.fg("accent", "→ ")}${th.fg("accent", item.label)}${badge}${checkmark}`
				: `  ${item.label}${badge}${checkmark}`;
			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filtered.length) {
			this.listContainer.addChild(new Text(th.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
		}
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(th.fg("muted", "  No matching entries"), 0, 0));
		}
	}

	private confirmSelection(): void {
		const selected = this.filtered[this.selectedIndex];
		this.done(selected ? { confirmed: true, value: selected.value } : { confirmed: false });
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.done({ confirmed: false });
		} else {
			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
			this.tui.requestRender();
		}
	}
}
