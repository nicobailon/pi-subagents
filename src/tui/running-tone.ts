import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/model-info.ts";
import { isStaleExtensionContextError, isUnboundExtensionRuntimeError } from "../shared/extension-context.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;

let mainThinkingLevelSource: () => ThinkingLevel | undefined = () => undefined;

/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export function setMainThinkingLevelSource(source: () => ThinkingLevel | undefined): void {
	mainThinkingLevelSource = source;
}

/** Reads the main session's level through `read`; a stale or not-yet-bound Pi runtime has no level to show. */
export function readMainThinkingLevel(read: () => ThinkingLevel): ThinkingLevel | undefined {
	try {
		return read();
	} catch (error) {
		if (isStaleExtensionContextError(error) || isUnboundExtensionRuntimeError(error)) return undefined;
		throw error;
	}
}

/** The running tone of a glyph: Pi's prompt-box color for the recorded level of the one child it stands for, else for the main session's current level, else accent. */
export function runningTone(theme: Theme, childLevel?: ThinkingLevel): (text: string) => string {
	const level = childLevel ?? mainThinkingLevelSource();
	return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
