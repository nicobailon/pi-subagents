import {
	SUBAGENT_WATCHDOG_WARNING_TYPE,
	type WatchdogWarning,
	type WatchdogWarningDetails,
	type WatchdogWarningMessage,
} from "./types.ts";

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, "&quot;");
}

function tag(name: string, value: string | number | boolean | undefined): string | undefined {
	if (value === undefined) return undefined;
	return `<${name}>${escapeXmlText(String(value))}</${name}>`;
}

export function normalizeWatchdogWarningDetails(warning: WatchdogWarning, extras: Partial<WatchdogWarningDetails> = {}): WatchdogWarningDetails {
	return {
		...warning,
		category: warning.category ?? extras.category ?? "other",
		source: warning.source ?? extras.source ?? "main",
		...extras,
	};
}

export function formatWatchdogWarningContent(warning: WatchdogWarning): string {
	const details = normalizeWatchdogWarningDetails(warning);
	const attrs = [
		`severity="${escapeXmlAttribute(details.severity)}"`,
		`category="${escapeXmlAttribute(details.category)}"`,
		`source="${escapeXmlAttribute(details.source)}"`,
		`guidance="weigh, don't blindly obey"`,
	];
	const optionalTags = [
		tag("confidence", details.confidence),
		tag("agent", details.agent),
		tag("run_id", details.runId),
		tag("state", details.state),
		tag("stale", details.stale),
		tag("auto_follow_attempt", details.autoFollowAttempt),
	];
	return [
		`<subagent_watchdog ${attrs.join(" ")}>`,
		`<summary>${escapeXmlText(details.summary)}</summary>`,
		`<evidence>${escapeXmlText(details.evidence)}</evidence>`,
		`<recommended_action>${escapeXmlText(details.recommendedAction)}</recommended_action>`,
		...optionalTags.filter((line): line is string => Boolean(line)),
		details.severity === "blocker"
			? "<blocker_guidance>If this warning changes the outcome, produce a new self-contained final answer after addressing it.</blocker_guidance>"
			: undefined,
		"</subagent_watchdog>",
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function createWatchdogWarningMessage(
	warning: WatchdogWarning,
	options: { display?: boolean; details?: Partial<WatchdogWarningDetails> } = {},
): WatchdogWarningMessage {
	const details = normalizeWatchdogWarningDetails(warning, options.details);
	return {
		customType: SUBAGENT_WATCHDOG_WARNING_TYPE,
		content: formatWatchdogWarningContent(details),
		display: options.display ?? true,
		details,
	};
}
