import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

export const WATCHDOG_GUIDANCE_FILE = "WATCHDOG.md";
export const WATCHDOG_GUIDANCE_MAX_CHARS = 8_000;

function readGuidanceFile(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * Standing instructions for the watchdog reviewer, read fresh for every review.
 * Project guidance (`<project config dir>/WATCHDOG.md`) comes first, then user guidance
 * (`<agent dir>/WATCHDOG.md`). Missing files are not errors; the result is capped at
 * `WATCHDOG_GUIDANCE_MAX_CHARS` from the head.
 */
export function loadWatchdogGuidance(cwd: string, enabled: boolean): string {
	if (!enabled) return "";
	const candidates = [
		path.join(getProjectConfigDir(cwd), WATCHDOG_GUIDANCE_FILE),
		path.join(getAgentDir(), WATCHDOG_GUIDANCE_FILE),
	];
	const sections = candidates.map(readGuidanceFile).filter(Boolean);
	if (!sections.length) return "";
	const combined = sections.join("\n\n");
	return combined.length > WATCHDOG_GUIDANCE_MAX_CHARS ? combined.slice(0, WATCHDOG_GUIDANCE_MAX_CHARS) : combined;
}
