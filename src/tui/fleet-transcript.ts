import { getLanguageFromPath, highlightCode, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import { safeTerminalText as safeDisplayText } from "../shared/display-text.ts";
import { objectValue, safeTranscriptEvent, type FleetTranscript, type FleetTranscriptEvent } from "../shared/fleet-transcript-reader.ts";

const TOOL_PREVIEW_LINES = 7;

type Theme = ExtensionContext["ui"]["theme"];

function statusGlyph(event: Extract<FleetTranscriptEvent, { kind: "tool" }>, theme: Theme): string {
	if (event.status === "running") return theme.fg("warning", "●");
	if (event.status === "error") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function jsonScalar(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function parseToolArgs(event: Extract<FleetTranscriptEvent, { kind: "tool" }>): Record<string, unknown> | undefined {
	if (!event.argsPayload) return undefined;
	try {
		return objectValue(JSON.parse(event.argsPayload));
	} catch {
		return undefined;
	}
}

function toolDuration(event: Extract<FleetTranscriptEvent, { kind: "tool" }>): string | undefined {
	if (event.startedAt === undefined || event.endedAt === undefined) return undefined;
	return `${((event.endedAt - event.startedAt) / 1000).toFixed(1)}s`;
}

function renderExpandedTool(
	event: Extract<FleetTranscriptEvent, { kind: "tool" }>,
	width: number,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const args = parseToolArgs(event);
	const glyph = statusGlyph(event, theme);
	const output = event.output ?? event.error;
	const outputColor = event.status === "error" ? "error" : "toolOutput";
	if (event.name === "bash") {
		const command = jsonScalar(args?.command) ?? event.args ?? "(unknown command)";
		lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(`$ ${command}`))}`, width, theme));
		if (output) {
			for (const outputLine of output.replace(/\s+$/, "").split(/\r?\n/)) {
				for (const wrapped of renderWrapped(theme.fg(outputColor, outputLine), Math.max(1, width - 4))) {
					lines.push(railLine(`  ${wrapped}`, width, theme));
				}
			}
		}
		const duration = toolDuration(event);
		if (duration) lines.push(railLine(theme.fg("dim", `  Took ${duration}`), width, theme));
		return lines;
	}
	if (event.name === "read") {
		const filePath = jsonScalar(args?.path ?? args?.file_path);
		const language = filePath ? getLanguageFromPath(filePath) : undefined;
		const rendered = !output
			? []
			: event.status === "error"
				? output.split("\n").map((line) => theme.fg("error", line))
				: language
					? highlightCode(output, language)
					: output.split("\n");
		lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(`read ${filePath ?? event.args ?? ""}`))}`, width, theme));
		for (const line of rendered) {
			for (const wrapped of renderWrapped(line, Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
		return lines;
	}
	lines.push(railLine(`${glyph} ${theme.fg("toolTitle", theme.bold(event.name))}`, width, theme));
	if (event.argsPayload) {
		lines.push(railLine(theme.fg("dim", "  args"), width, theme));
		for (const argLine of event.argsPayload.split(/\r?\n/)) {
			for (const wrapped of renderWrapped(theme.fg("muted", argLine), Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
	}
	if (output) {
		lines.push(railLine(theme.fg(event.status === "error" ? "error" : "dim", event.status === "error" ? "  error" : "  output"), width, theme));
		for (const outputLine of output.split(/\r?\n/)) {
			for (const wrapped of renderWrapped(theme.fg(outputColor, outputLine), Math.max(1, width - 4))) lines.push(railLine(`  ${wrapped}`, width, theme));
		}
	}
	return lines;
}

function bounded(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width));
}

function railLine(content: string, width: number, theme: Theme): string {
	return bounded(`${theme.fg("borderMuted", "│")} ${content}`, width);
}

function renderWrapped(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width));
}

export function renderFleetTranscript(
	transcript: FleetTranscript,
	width: number,
	theme: Theme,
	markdownTheme: MarkdownTheme,
	options: { expandedTools?: boolean } = {},
): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	if (transcript.truncated) lines.push(bounded(theme.fg("dim", "↑ Earlier activity omitted"), width));
	if (transcript.warning) {
		for (const line of renderWrapped(safeDisplayText(transcript.warning), Math.max(1, width - 2))) {
			lines.push(bounded(`${theme.fg("warning", "!")} ${theme.fg("warning", line)}`, width));
		}
	}

	for (const rawEvent of transcript.events) {
		const event = safeTranscriptEvent(rawEvent);
		if (event.kind === "tool") {
			if (options.expandedTools && (event.output || event.argsPayload || event.error)) {
				lines.push(...renderExpandedTool(event, width, theme));
				lines.push(railLine(theme.fg("dim", "  x to collapse"), width, theme));
				continue;
			}
			const title = theme.fg("toolTitle", theme.bold(event.name));
			const args = event.args ? ` ${theme.fg("dim", event.args)}` : "";
			const suffix = event.status === "running" ? theme.fg("warning", " running") : "";
			lines.push(bounded(`${theme.fg("borderMuted", "├─")} ${statusGlyph(event, theme)} ${title}${args}${suffix}`, width));
			if (event.output && event.status !== "error" && event.name === "bash") {
				const outputLines = event.output.replace(/\s+$/, "").split(/\r?\n/);
				const visible = outputLines.slice(-TOOL_PREVIEW_LINES);
				const hidden = Math.max(0, outputLines.length - visible.length);
				for (const outputLine of visible) {
					for (const wrapped of renderWrapped(theme.fg("toolOutput", outputLine), Math.max(1, width - 4))) {
						lines.push(railLine(`  ${wrapped}`, width, theme));
					}
				}
				if (hidden > 0) lines.push(railLine(theme.fg("dim", `  … ${hidden} earlier lines · x to expand`), width, theme));
				const duration = toolDuration(event);
				lines.push(railLine(theme.fg("dim", `  Took${duration ? ` ${duration}` : ""}`), width, theme));
			} else if (event.output && event.status !== "error") {
				const summary = truncateToWidth(event.output.replace(/\s+/g, " ").trim(), Math.max(1, width - 18), "…");
				if (summary) lines.push(railLine(theme.fg("dim", `  ${summary} · x to expand`), width, theme));
			}
			if (event.error) {
				for (const errorLine of renderWrapped(event.error, Math.max(1, width - 4))) {
					lines.push(railLine(theme.fg("error", `  ${errorLine}`), width, theme));
				}
			}
			continue;
		}
		if (event.kind === "notice") {
			const color = event.tone === "error" ? "error" : event.tone === "warning" ? "warning" : "dim";
			for (const noticeLine of renderWrapped(event.text, Math.max(1, width - 2))) {
				lines.push(railLine(theme.fg(color, noticeLine), width, theme));
			}
			continue;
		}

		const assistant = event.kind === "assistant";
		const label = assistant ? "Assistant" : "Supervisor";
		const marker = assistant ? theme.fg("accent", "◆") : theme.fg("warning", "◇");
		const model = assistant && event.model ? theme.fg("dim", ` · ${event.model}`) : "";
		lines.push(bounded(`${marker} ${theme.bold(label)}${model}`, width));
		if (assistant) {
			const rendered = new Markdown(event.text, 0, 0, markdownTheme).render(Math.max(1, width - 2));
			for (const markdownLine of rendered) lines.push(railLine(markdownLine, width, theme));
		} else {
			for (const userLine of renderWrapped(event.text, Math.max(1, width - 2))) {
				lines.push(railLine(userLine, width, theme));
			}
		}
		lines.push(theme.fg("borderMuted", "│"));
	}

	while (lines.length > 0 && visibleWidth(lines.at(-1) ?? "") === 1) lines.pop();
	return lines;
}
