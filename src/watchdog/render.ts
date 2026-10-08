import type { WatchdogWarning, WatchdogWarningDetails } from "./types.ts";

function titleCase(value: string): string {
	return value.split("-").map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

export function stateLabels(warning: WatchdogWarning): string[] {
	const labels: string[] = [];
	if (warning.state === "displayed") labels.push("displayed");
	if (warning.stale || warning.state === "stale") labels.push("stale");
	if (warning.state === "failed") labels.push("failed review");
	if (warning.state === "stalemate") labels.push("stalemate");
	return labels;
}

export function formatWatchdogWarningRenderText(warning: WatchdogWarningDetails): string {
	const labels = stateLabels(warning);
	const subject = warning.severity === "blocker" ? "Blocker" : "Concern";
	const lines = [
		`Subagent watchdog ${subject}${labels.length ? ` (${labels.join(", ")})` : ""}: ${warning.summary}`,
		`Evidence: ${warning.evidence}`,
		`Recommended action: ${warning.recommendedAction}`,
		`Importance: ${titleCase(warning.importance)} · Category: ${titleCase(warning.category)} · Source: ${warning.source}${warning.agent ? ` · Agent: ${warning.agent}` : ""}${warning.runId ? ` · Run: ${warning.runId}` : ""}`,
	];
	if (warning.state === "failed" && warning.error) lines.push(`Failure: ${warning.error}`);
	if (warning.state === "stalemate" && warning.stalemateRepeats !== undefined) {
		lines.push(`Same warning ${warning.stalemateRepeats} time${warning.stalemateRepeats === 1 ? "" : "s"} in a row; the watchdog stopped continuing the run.`);
	}
	if (warning.stale || warning.state === "stale") lines.push("This warning arrived after the watchdog catch-up timeout.");
	return lines.join("\n");
}
