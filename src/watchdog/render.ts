import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { WatchdogWarningDetails } from "./types.ts";

type WatchdogTheme = {
	fg(name: string, value: string): string;
	bold?(value: string): string;
};

function titleCase(value: string): string {
	return value.split("-").map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function stateLabels(warning: WatchdogWarningDetails): string[] {
	const labels: string[] = [];
	if (warning.state === "displayed") labels.push("displayed");
	if (warning.stale || warning.state === "stale") labels.push("stale · no auto-follow");
	if (warning.state === "failed") labels.push("failed review");
	if (warning.state === "stalemate") labels.push("stalemate · auto-follow stopped");
	if (warning.autoFollowAttempt !== undefined) labels.push(`auto-follow attempt ${warning.autoFollowAttempt}`);
	return labels;
}

export function formatWatchdogWarningRenderText(warning: WatchdogWarningDetails): string {
	const labels = stateLabels(warning);
	const subject = warning.severity === "blocker" ? "Blocker" : "Concern";
	const lines = [
		`Subagent watchdog ${subject}${labels.length ? ` (${labels.join(", ")})` : ""}: ${warning.summary}`,
		`Evidence: ${warning.evidence}`,
		`Recommended action: ${warning.recommendedAction}`,
		`Category: ${titleCase(warning.category)} · Source: ${warning.source}${warning.agent ? ` · Agent: ${warning.agent}` : ""}${warning.runId ? ` · Run: ${warning.runId}` : ""}`,
	];
	if (warning.state === "failed" && warning.error) lines.push(`Failure: ${warning.error}`);
	if (warning.state === "stalemate" && warning.stalemateRepeats !== undefined) {
		lines.push(`Auto-follow stopped after ${warning.stalemateRepeats} repeated blocker warning${warning.stalemateRepeats === 1 ? "" : "s"}.`);
	}
	if (warning.stale || warning.state === "stale") lines.push("This warning arrived after the watchdog catch-up timeout and must not auto-follow.");
	return lines.join("\n");
}

export function renderWatchdogWarning(warning: WatchdogWarningDetails, options: { expanded: boolean }, theme: WatchdogTheme): Component {
	const text = formatWatchdogWarningRenderText(warning);
	const lines = text.split("\n");
	const container = new Container();
	const color = warning.severity === "blocker" ? "error" : "warning";
	const bold = theme.bold ?? ((value: string) => value);
	container.addChild(new Text(theme.fg(color, bold(lines[0] ?? "Subagent watchdog warning")), 0, 0));
	if (options.expanded) {
		container.addChild(new Spacer(1));
		for (const line of lines.slice(1)) container.addChild(new Text(theme.fg("dim", line), 0, 0));
	} else if (lines[1]) {
		container.addChild(new Text(theme.fg("dim", `  ⎿  ${lines[1]}`), 0, 0));
	}
	return container;
}
