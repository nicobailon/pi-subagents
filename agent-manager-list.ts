import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentSource } from "./agents.ts";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { pad, row, renderHeader, renderFooter, fuzzyFilter, formatScrollInfo } from "./render-helpers.ts";

export interface ListAgent {
	id: string;
	name: string;
	description: string;
	model?: string;
	source: AgentSource;
	overrideScope?: "user" | "project";
	disabled?: boolean;
	kind: "agent" | "chain";
	stepCount?: number;
}

export interface ListState {
	cursor: number;
	scrollOffset: number;
	filterQuery: string;
	selected: string[];
}

export type ListAction =
	| { type: "open-detail"; id: string }
	| { type: "clone"; id: string }
	| { type: "new" }
	| { type: "delete"; id: string }
	| { type: "run-chain"; ids: string[] }
	| { type: "run-parallel"; ids: string[] }
	| { type: "close" };

const LIST_VIEWPORT_HEIGHT = 8;

function selectionCount(selected: string[], id: string): number {
	let count = 0;
	for (const s of selected) if (s === id) count++;
	return count;
}

function clampCursor(state: ListState, filtered: ListAgent[]): void {
	if (filtered.length === 0) {
		state.cursor = 0;
		state.scrollOffset = 0;
		return;
	}

	state.cursor = Math.max(0, Math.min(state.cursor, filtered.length - 1));
	const maxOffset = Math.max(0, filtered.length - LIST_VIEWPORT_HEIGHT);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));

	if (state.cursor < state.scrollOffset) {
		state.scrollOffset = state.cursor;
	} else if (state.cursor >= state.scrollOffset + LIST_VIEWPORT_HEIGHT) {
		state.scrollOffset = state.cursor - LIST_VIEWPORT_HEIGHT + 1;
	}
}

export function handleListInput(state: ListState, agents: ListAgent[], data: string): ListAction | undefined {
	const filtered = fuzzyFilter(agents, state.filterQuery);

	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
		if (state.filterQuery.length > 0) {
			state.filterQuery = "";
			state.cursor = 0;
			state.scrollOffset = 0;
			return;
		}
		if (state.selected.length > 0) {
			state.selected.length = 0;
			return;
		}
		return { type: "close" };
	}

	if (matchesKey(data, "return")) {
		if (filtered.length > 0) {
			const agent = filtered[state.cursor];
			if (agent) return { type: "open-detail", id: agent.id };
		}
		return;
	}

	if (matchesKey(data, "up") || matchesKey(data, "down")) {
		if (matchesKey(data, "up")) state.cursor -= 1;
		if (matchesKey(data, "down")) state.cursor += 1;
		clampCursor(state, filtered);
		return;
	}

	if (matchesKey(data, "backspace")) {
		if (state.filterQuery.length > 0) {
			state.filterQuery = state.filterQuery.slice(0, -1);
			state.cursor = 0;
			state.scrollOffset = 0;
		}
		return;
	}

	if (matchesKey(data, "alt+n")) {
		return { type: "new" };
	}

	if (matchesKey(data, "ctrl+k")) {
		const agent = filtered[state.cursor];
		if (agent) return { type: "clone", id: agent.id };
		return;
	}

	if (matchesKey(data, "ctrl+d") || matchesKey(data, "delete")) {
		const agent = filtered[state.cursor];
		if (agent) return { type: "delete", id: agent.id };
		return;
	}

	if (matchesKey(data, "tab")) {
		const agent = filtered[state.cursor];
		if (!agent) return;
		if (agent.kind !== "agent") return;
		state.selected.push(agent.id);
		return;
	}

	if (matchesKey(data, "shift+tab")) {
		const agent = filtered[state.cursor];
		if (!agent) return;
		const lastIdx = state.selected.lastIndexOf(agent.id);
		if (lastIdx >= 0) state.selected.splice(lastIdx, 1);
		return;
	}

	if (matchesKey(data, "ctrl+r")) {
		if (state.selected.length > 0) return { type: "run-chain", ids: [...state.selected] };
		const agent = filtered[state.cursor];
		if (agent && agent.kind === "agent") return { type: "run-chain", ids: [agent.id] };
		return;
	}

	if (matchesKey(data, "ctrl+p")) {
		if (state.selected.length > 0) return { type: "run-parallel", ids: [...state.selected] };
		const agent = filtered[state.cursor];
		if (agent && agent.kind === "agent") return { type: "run-parallel", ids: [agent.id] };
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		state.filterQuery += data;
		state.cursor = 0;
		state.scrollOffset = 0;
		return;
	}

	return;
}

export function renderList(
	state: ListState,
	agents: ListAgent[],
	width: number,
	theme: Theme,
	statusMessage?: { text: string; type: "error" | "info" },
): string[] {
	const lines: string[] = [];
	const filtered = fuzzyFilter(agents, state.filterQuery);
	clampCursor(state, filtered);

	const agentCount = agents.filter((a) => a.kind === "agent").length;
	const chainCount = agents.filter((a) => a.kind === "chain").length;
	const headerText = chainCount
		? ` Subagents [${agentCount} agents  ${chainCount} chains] `
		: ` Subagents [${agentCount}] `;
	lines.push(renderHeader(headerText, width, theme));
	lines.push(row("", width, theme));

	const cursor = theme.fg("accent", "│");
	const searchIcon = theme.fg("dim", "◎");
	const placeholder = theme.fg("dim", "\x1b[3mtype to filter...\x1b[23m");
	const queryDisplay = state.filterQuery ? `${state.filterQuery}${cursor}` : `${cursor}${placeholder}`;
	lines.push(row(` ${searchIcon}  ${queryDisplay}`, width, theme));
	lines.push(row("", width, theme));

	const userNames = new Set(agents.filter((a) => a.source === "user" && a.kind === "agent").map((a) => a.name));
	const startIdx = state.scrollOffset;
	const endIdx = Math.min(filtered.length, startIdx + LIST_VIEWPORT_HEIGHT);
	const visible = filtered.slice(startIdx, endIdx);

	if (filtered.length === 0) {
		lines.push(row(` ${theme.fg("dim", "No matching agents")}`, width, theme));
		for (let i = 1; i < LIST_VIEWPORT_HEIGHT; i++) lines.push(row("", width, theme));
	} else {
		const innerW = width - 2;
		const nameWidth = 16;
		const modelWidth = 12;
		const scopeWidth = 21;

		for (let i = 0; i < visible.length; i++) {
			const agent = visible[i]!;
			const index = startIdx + i;
			const isCursor = index === state.cursor;
			const count = selectionCount(state.selected, agent.id);
			const isShadowed = agent.kind === "agent" && agent.source === "project" && userNames.has(agent.name);

			const cursorChar = isCursor ? theme.fg("accent", ">") : " ";
			const selectBadge = count > 0 ? theme.fg("accent", String(count).padStart(2)) : "  ";
			const shadowMarker = isShadowed ? theme.fg("warning", "!") : " ";
			const prefix = `${cursorChar}${selectBadge}${shadowMarker} `;

			const modelRaw = agent.kind === "chain" ? `${agent.stepCount ?? 0} steps` : (agent.model ?? "default");
			const modelDisplay = modelRaw.includes("/") ? modelRaw.split("/").pop() ?? modelRaw : modelRaw;
			const nameText = isCursor ? theme.fg("accent", agent.name) : agent.name;
			const modelText = theme.fg("dim", modelDisplay);
			const scopeLabel = agent.kind === "chain"
				? "[chain]"
				: agent.source === "builtin"
					? (agent.disabled
						? (agent.overrideScope ? `[builtin off+${agent.overrideScope}]` : "[builtin off]")
						: (agent.overrideScope ? `[builtin+${agent.overrideScope}]` : "[builtin]"))
					: agent.source === "project"
						? "[proj]"
						: "[user]";
			const scopeBadge = theme.fg("dim", scopeLabel);
			const descText = theme.fg("dim", agent.description);

			const descWidth = Math.max(0, innerW - 1 - visibleWidth(prefix) - nameWidth - modelWidth - scopeWidth - 3);
			const line =
				prefix +
				pad(truncateToWidth(nameText, nameWidth), nameWidth) +
				" " +
				pad(truncateToWidth(modelText, modelWidth), modelWidth) +
				" " +
				pad(scopeBadge, scopeWidth) +
				" " +
				truncateToWidth(descText, descWidth);

			lines.push(row(` ${line}`, width, theme));
		}

		for (let i = visible.length; i < LIST_VIEWPORT_HEIGHT; i++) {
			lines.push(row("", width, theme));
		}
	}

	const scrollInfo = formatScrollInfo(state.scrollOffset, Math.max(0, filtered.length - (state.scrollOffset + LIST_VIEWPORT_HEIGHT)));
	const selectedNames = state.selected
		.map((id) => agents.find((a) => a.id === id))
		.filter((a): a is ListAgent => Boolean(a))
		.map((a) => a.name);
	const preview = selectedNames.length > 0 ? truncateToWidth(selectedNames.join(" → "), width - 4) : "";

	lines.push(row("", width, theme));

	if (statusMessage) {
		const color = statusMessage.type === "error" ? "error" : "success";
		lines.push(row(` ${theme.fg(color, truncateToWidth(statusMessage.text, width - 4))}`, width, theme));
	} else if (preview) {
		lines.push(row(` ${theme.fg("dim", preview)}`, width, theme));
	} else {
		const cursorAgent = filtered[state.cursor];
		const desc = cursorAgent ? truncateToWidth(cursorAgent.description, width - 4) : "";
		const content = desc || scrollInfo;
		lines.push(row(content ? ` ${theme.fg("dim", content)}` : "", width, theme));
	}

	lines.push(row("", width, theme));

	const selCount = state.selected.length;
	const footerText = selCount > 1
		? ` [ctrl+r] chain  [ctrl+p] parallel  [tab] add  [shift+tab] remove  [esc] clear (${selCount}) `
		: selCount === 1
			? " [ctrl+r] run  [ctrl+p] parallel  [tab] add more  [shift+tab] remove  [esc] clear "
			: " [enter] view  [ctrl+r] run  [tab] select  [alt+n] new  [esc] close ";
	lines.push(renderFooter(footerText, width, theme));

	return lines;
}
