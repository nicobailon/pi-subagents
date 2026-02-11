import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";
import { formatDuration } from "./formatters.js";
import type { RunEntry } from "./run-history.js";
import { buildSkillInjection, resolveSkills } from "./skills.js";
import { ensureCursorVisible, getCursorDisplayPos, renderEditor, wrapText } from "./text-editor.js";
import type { TextEditorState } from "./text-editor.js";
import { pad, row, renderHeader, renderFooter, formatPath, formatScrollInfo } from "./render-helpers.js";

export interface DetailState {
	resolved: boolean;
	scrollOffset: number;
	recentRuns?: RunEntry[];
}

export type DetailAction =
	| { type: "back" }
	| { type: "edit" }
	| { type: "launch" };

const DETAIL_VIEWPORT_HEIGHT = 12;

function renderFieldLine(
	label: string,
	value: string,
	width: number,
	theme: Theme,
): string {
	const labelWidth = 10;
	const labelText = theme.fg("dim", pad(label, labelWidth));
	const available = Math.max(0, width - labelWidth);
	return `${labelText}${truncateToWidth(value, available)}`;
}

function formatRelativeTime(ts: number): string {
	const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

function buildDetailLines(
	agent: AgentConfig,
	resolved: boolean,
	recentRuns: RunEntry[] | undefined,
	cwd: string,
	width: number,
	theme: Theme,
): string[] {
	const contentWidth = width - 3;
	const lines: string[] = [];

	const tools = agent.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "(none)";
	const mcp = agent.mcpDirectTools && agent.mcpDirectTools.length > 0 ? agent.mcpDirectTools.join(", ") : "(none)";
	const skillsList = agent.skills && agent.skills.length > 0 ? agent.skills.join(", ") : "(none)";
	const output = agent.output ?? "(none)";
	const reads = agent.defaultReads && agent.defaultReads.length > 0 ? agent.defaultReads.join(", ") : "(none)";
	const progress = agent.defaultProgress ? "on" : "off";

	lines.push(renderFieldLine("Model:", agent.model ?? "default", contentWidth, theme));
	lines.push(renderFieldLine("Thinking:", agent.thinking ?? "off", contentWidth, theme));
	lines.push(renderFieldLine("Tools:", tools, contentWidth, theme));
	lines.push(renderFieldLine("MCP:", mcp, contentWidth, theme));
	lines.push(renderFieldLine("Skills:", skillsList, contentWidth, theme));
	const extensionsList = agent.extensions !== undefined
		? (agent.extensions.length > 0 ? agent.extensions.join(", ") : "(none)")
		: "(all)";
	lines.push(renderFieldLine("Extensions:", extensionsList, contentWidth, theme));
	lines.push(renderFieldLine("Output:", output, contentWidth, theme));
	lines.push(renderFieldLine("Reads:", reads, contentWidth, theme));
	lines.push(renderFieldLine("Progress:", progress, contentWidth, theme));

	if (agent.extraFields) {
		for (const [key, value] of Object.entries(agent.extraFields)) {
			lines.push(truncateToWidth(`${key}: ${value}`, contentWidth));
		}
	}

	lines.push("");
	const sectionTitle = `── System Prompt (${resolved ? "resolved" : "raw"}) ──`;
	lines.push(truncateToWidth(sectionTitle, contentWidth));

	let prompt = agent.systemPrompt ?? "";
	if (resolved) {
		const { resolved: resolvedSkills } = resolveSkills(agent.skills ?? [], cwd);
		const injection = buildSkillInjection(resolvedSkills);
		if (injection) prompt = `${prompt}\n\n${injection}`;
	}

	const wrapped = wrapText(prompt, contentWidth);
	lines.push(...wrapped.lines);
	lines.push("");
	lines.push(truncateToWidth("── Recent Runs ──", contentWidth));
	if (!recentRuns || recentRuns.length === 0) {
		lines.push(truncateToWidth("  (none)", contentWidth));
		return lines;
	}

	for (const run of recentRuns) {
		const when = pad(formatRelativeTime(run.ts), 8);
		const status = run.status === "ok" ? "✓" : "✗";
		const task = truncateToWidth(`"${run.task}"`, 34);
		const tail = run.status === "ok" ? formatDuration(run.duration) : `exit ${run.exit ?? 1}`;
		lines.push(truncateToWidth(`  ${when} ${status} ${task} ${tail}`, contentWidth));
	}

	return lines;
}

export function handleDetailInput(state: DetailState, data: string): DetailAction | undefined {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return { type: "back" };
	if (data === "e") return { type: "edit" };
	if (data === "l") return { type: "launch" };
	if (data === "v") { state.resolved = !state.resolved; state.scrollOffset = 0; return; }
	if (matchesKey(data, "up")) { state.scrollOffset--; return; }
	if (matchesKey(data, "down")) { state.scrollOffset++; return; }
	if (matchesKey(data, "pageup") || matchesKey(data, "shift+up")) { state.scrollOffset -= DETAIL_VIEWPORT_HEIGHT; return; }
	if (matchesKey(data, "pagedown") || matchesKey(data, "shift+down")) { state.scrollOffset += DETAIL_VIEWPORT_HEIGHT; return; }
	return;
}

export function renderDetail(
	state: DetailState,
	agent: AgentConfig,
	cwd: string,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const scopeBadge = agent.source === "user" ? "[user]" : "[proj]";
	const headerText = ` ${agent.name} ${scopeBadge} ${formatPath(agent.filePath)} `;
	lines.push(renderHeader(headerText, width, theme));
	lines.push(row("", width, theme));

	const contentLines = buildDetailLines(agent, state.resolved, state.recentRuns, cwd, width, theme);
	const maxOffset = Math.max(0, contentLines.length - DETAIL_VIEWPORT_HEIGHT);
	state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));

	const visible = contentLines.slice(state.scrollOffset, state.scrollOffset + DETAIL_VIEWPORT_HEIGHT);
	for (const line of visible) {
		lines.push(row(` ${line}`, width, theme));
	}
	for (let i = visible.length; i < DETAIL_VIEWPORT_HEIGHT; i++) {
		lines.push(row("", width, theme));
	}

	const scrollInfo = formatScrollInfo(state.scrollOffset, Math.max(0, contentLines.length - (state.scrollOffset + DETAIL_VIEWPORT_HEIGHT)));
	lines.push(row(scrollInfo ? ` ${theme.fg("dim", scrollInfo)}` : "", width, theme));

	lines.push(renderFooter(" [l]aunch  [e]dit  [v] raw/resolved  [↑↓] scroll  [esc] back ", width, theme));
	return lines;
}

export function renderTaskInput(
	title: string,
	editor: TextEditorState,
	skipClarify: boolean,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	lines.push(renderHeader(` ${title} `, width, theme));
	lines.push(row("", width, theme));
	lines.push(row(` ${theme.fg("dim", "Task:")}`, width, theme));

	const innerW = width - 2;
	const boxInnerWidth = Math.max(10, innerW - 4);
	const top = `┌${"─".repeat(boxInnerWidth)}┐`;
	const bottom = `└${"─".repeat(boxInnerWidth)}┘`;

	lines.push(row(` ${top}`, width, theme));
	const editorState = { ...editor };
	const { starts } = wrapText(editorState.buffer, boxInnerWidth);
	const cursorPos = getCursorDisplayPos(editorState.cursor, starts);
	editorState.viewportOffset = ensureCursorVisible(cursorPos.line, 2, editorState.viewportOffset);
	const editorLines = renderEditor(editorState, boxInnerWidth, 2);
	for (const line of editorLines) {
		lines.push(row(` │${pad(line, boxInnerWidth)}│`, width, theme));
	}
	lines.push(row(` ${bottom}`, width, theme));

	lines.push(row("", width, theme));
	const enterLabel = skipClarify ? "quick run" : "run";
	const quickLabel = skipClarify ? "on" : "off";
	lines.push(renderFooter(` [enter] ${enterLabel}  [tab] quick: ${quickLabel}  [esc] cancel `, width, theme));
	return lines;
}
