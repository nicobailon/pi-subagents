import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Details } from "../shared/types.ts";
import { expandKeyHint, truncLine } from "./render.ts";

type Theme = ExtensionContext["ui"]["theme"];

const GUIDE_AGENTS_SHOWN = 5;

export function withHeldBadge(line: string, held: () => boolean, badge: string): Text {
	const call = new Text(line, 0, 0);
	const render = call.render.bind(call);
	let shown = line;
	call.render = (width: number) => {
		const text = held() ? `${line}${badge}` : line;
		if (shown !== text) {
			shown = text;
			call.setText(text);
		}
		return render(width);
	};
	return call;
}

export function guideView(details: Details | undefined, theme: Theme, oneLine: boolean): Component | undefined {
	if (!details || (!details.guide && details.heldLaunch === undefined && !details.guideTopic)) return undefined;
	const dim = (text: string) => theme.fg("dim", text);
	const rows: string[] = [];
	if (details.heldLaunch !== undefined && !oneLine) rows.push(details.heldLaunch);
	if (details.guide) {
		const { tokens, launch, manage, agents } = details.guide;
		rows.push(dim(`↳ guide (~${tokens.toLocaleString("en-US")} tok, once)`));
		if (!oneLine) {
			const more = agents.length > GUIDE_AGENTS_SHOWN ? [`+${agents.length - GUIDE_AGENTS_SHOWN}`] : [];
			rows.push(dim(`   Launch  ${launch.join(" · ")}`));
			rows.push(dim(`   Manage  ${manage.join(" · ")}`));
			rows.push(dim(`   Agents  ${agents.length ? [...agents.slice(0, GUIDE_AGENTS_SHOWN), ...more].join(", ") : "none found"}`));
		}
	}
	if (details.guideTopic) {
		rows.push(dim(`↳ ${details.guideTopic.title}`));
		if (!oneLine && details.guideTopic.lead) rows.push(dim(`   ${details.guideTopic.lead}`));
	}
	if (!oneLine) rows.push(theme.fg("accent", expandKeyHint(details.guide ? "to read it all" : "to read it")));
	if (rows.length === 0) return undefined;
	return {
		render: (width: number) => rows.map((row) => truncLine(row, width)),
		invalidate() {},
	};
}

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
