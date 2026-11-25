import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expandKeyHint, truncLine } from "./render.ts";

type Theme = ExtensionContext["ui"]["theme"];

export function withTeachingNotes(base: Component, result: Pick<AgentToolResult<unknown>, "content">, expanded: boolean, theme: Theme): Component {
	const notes = result.content.slice(1).flatMap((part) => part.type === "text" && part.text.trim() ? [part.text.trim()] : []);
	if (notes.length === 0) return base;
	const dim = (text: string) => theme.fg("dim", text);
	if (expanded) {
		const container = new Container();
		container.addChild(base);
		for (const note of notes) container.addChild(new Text(note.split("\n").map(dim).join("\n"), 0, 0));
		return container;
	}
	return {
		render(width: number) {
			const lines = base.render(width);
			const hintPrefix = expandKeyHint("").trimEnd();
			const baseHasHint = lines.some((line) => stripTerminalSequences(line).includes(hintPrefix));
			let cut = false;
			const noteLines = notes.map((note) => {
				const [first = "", ...rest] = note.split("\n");
				const line = `↳ ${first}`;
				if (rest.some((part) => part.trim()) || visibleWidth(line) > width) cut = true;
				return dim(truncLine(line, width));
			});
			const hint = cut && !baseHasHint ? [truncLine(theme.fg("accent", expandKeyHint("to expand")), width)] : [];
			return [...lines, ...noteLines, ...hint];
		},
		invalidate() {
			base.invalidate?.();
		},
	};
}
