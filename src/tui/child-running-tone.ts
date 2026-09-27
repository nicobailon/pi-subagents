import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../shared/model-info.ts";

export { childThinkingLevel } from "../shared/model-info.ts";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "getThinkingBorderColor">;

/** The running tone of a glyph that stands for one child: Pi's prompt-box color for its thinking level, else accent. */
export function childRunningTone(theme: Theme, level: ThinkingLevel | undefined): (text: string) => string {
	return level ? theme.getThinkingBorderColor(level) : (text) => theme.fg("accent", text);
}
