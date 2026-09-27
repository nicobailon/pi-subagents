import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;

/** Where a child's thinking level is recorded: the level its Pi session reported, and the configured launch level. */
export type ChildThinkingSource = { sessionThinking?: string; thinking?: string } | undefined;

function knownLevel(value: string | undefined): ThinkingLevel | undefined {
	return THINKING_LEVELS.find((level) => level === value);
}

/** The level a glyph for one child reflects: a session-reported level from any source first, then the configured level. */
export function childThinkingLevel(...sources: ChildThinkingSource[]): ThinkingLevel | undefined {
	for (const source of sources) {
		const level = knownLevel(source?.sessionThinking);
		if (level) return level;
	}
	for (const source of sources) {
		const level = knownLevel(source?.thinking);
		if (level) return level;
	}
	return undefined;
}

/** The running tone of a glyph that stands for one child: Pi's prompt-box color for its thinking level, else accent. */
export function childRunningTone(theme: Theme, level: ThinkingLevel | undefined): (text: string) => string {
	return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
