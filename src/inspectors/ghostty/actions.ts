import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams } from "../types.ts";

/** Static Ghostty 1.3 AppleScript; dynamic values arrive as `on run argv` arguments. */
export const GHOSTTY_APPLESCRIPT = `on run argv
  set launchCommand to item 1 of argv
  set launchCwd to item 2 of argv
  set shouldFocus to item 3 of argv
  tell application "Ghostty"
    set sourceWindow to front window
    set sourceTab to selected tab of sourceWindow
    set sourceTerminal to focused terminal of sourceTab
    set surfaceConfiguration to new surface configuration
    set initial working directory of surfaceConfiguration to launchCwd
    set command of surfaceConfiguration to launchCommand
    set newTerminal to split sourceTerminal direction right with configuration surfaceConfiguration
    if shouldFocus is "true" then
      focus newTerminal
    else
      focus sourceTerminal
    end if
    return id of newTerminal
  end tell
end run`;

export type GhosttyRunner = (args: readonly string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string; stderr: string }>;

function defaultRunner(args: readonly string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/osascript", [...args], options, (error, stdout, stderr) => {
			if (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				reject(failure);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function result(text: string, isError = false): AgentToolResult<Details> {
	const response: AgentToolResult<Details> = {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
	};
	if (isError) response.isError = true;
	return response;
}

const failureHint = "Ghostty inspector requires Ghostty 1.3+ and Automation permission for osascript.";

export async function openGhosttyInspector(
	context: InspectorContext,
	launch: InspectorLaunch,
	params: InspectorParams,
	runner: GhosttyRunner = defaultRunner,
): Promise<AgentToolResult<Details>> {
	try {
		const output = await runner(["-e", GHOSTTY_APPLESCRIPT, "--", launch.displayCommand, context.target.status.cwd ?? context.cwd, params.focus === true ? "true" : "false"], {
			signal: context.signal,
			timeout: 15_000,
			encoding: "utf8",
			maxBuffer: 64 * 1024,
		});
		const id = output.stdout.trim();
		if (!id) return result(`Ghostty inspector error: Ghostty returned an empty terminal id. ${failureHint}`, true);
		return result(`Opened read-only Ghostty inspector terminal ${id} for async run ${context.target.runId}. Status and close are unavailable because this plugin writes no binding.`);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return result(`Ghostty inspector error: ${message}. ${failureHint}`, true);
	}
}
