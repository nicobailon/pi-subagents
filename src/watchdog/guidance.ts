import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

export const WATCHDOG_GUIDANCE_MAX_CHARS = 8_000;

function readOptional(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * Standing reviewer instructions, read fresh for every review: `<project config dir>/WATCHDOG.md`
 * first, then `<agent dir>/WATCHDOG.md`, joined and capped at WATCHDOG_GUIDANCE_MAX_CHARS from the head.
 */
export function loadWatchdogGuidance(cwd: string, enabled: boolean): string {
	if (!enabled) return "";
	const sections = [getProjectConfigDir(cwd), getAgentDir()].map((dir) => readOptional(path.join(dir, "WATCHDOG.md"))).filter(Boolean);
	return sections.join("\n\n").slice(0, WATCHDOG_GUIDANCE_MAX_CHARS);
}
