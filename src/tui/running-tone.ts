import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/model-info.ts";
import { isStaleExtensionContextError, isUnboundExtensionRuntimeError } from "../shared/extension-context.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;

let mainThinkingLevelSource: () => ThinkingLevel | undefined = () => undefined;

/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export function setMainThinkingLevelSource(source: () => ThinkingLevel | undefined): void {
	mainThinkingLevelSource = source;
}

/** Reads the main session's level through `read`; a stale or not-yet-bound Pi runtime has no level to show. */
export function readMainThinkingLevel(read: () => unknown): ThinkingLevel | undefined {
	try {
		const level = read();
		return THINKING_LEVELS.find((candidate) => candidate === level);
	} catch (error) {
		if (isStaleExtensionContextError(error) || isUnboundExtensionRuntimeError(error)) return undefined;
		throw error;
	}
}

/** The main session's current thinking level, read at render time. */
export function mainThinkingLevel(): ThinkingLevel | undefined {
	return mainThinkingLevelSource();
}

/** The running tone for a thinking level: Pi's prompt-box color for that level, else accent. */
export function runningTone(theme: Theme, level: ThinkingLevel | undefined): (text: string) => string {
	return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
