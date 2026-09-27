import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/model-info.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;

let mainThinkingLevelSource: () => ThinkingLevel | undefined = () => undefined;

/** Registers where the main session's current thinking level is read; glyphs that stand for several children take its color. */
export function setMainThinkingLevelSource(source: () => ThinkingLevel | undefined): void {
	mainThinkingLevelSource = source;
}

/** The main session's current thinking level, read at render time. */
export function mainThinkingLevel(): ThinkingLevel | undefined {
	return mainThinkingLevelSource();
}

/** The running tone for a thinking level: Pi's prompt-box color for that level, else accent. */
export function runningTone(theme: Theme, level: ThinkingLevel | undefined): (text: string) => string {
	return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
