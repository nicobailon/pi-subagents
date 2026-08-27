import { previewDisplayText } from "./display-text.ts";
import { PROMPT_REDACTED } from "./utils.ts";

/**
 * Human-readable display name for a child session, derived at launch time from
 * the agent name and its task (or workflow node label). The parent computes it
 * once and threads it two ways:
 *
 *  1. Into the child process via `PI_SUBAGENT_SESSION_NAME`, where the prompt
 *     runtime calls `pi.setSessionName(...)` so the child's own session file
 *     is identifiable in `pi --resume` and host session browsers.
 *  2. Into the `sessionName` field of result/progress payloads, so hosts
 *     rendering the parent stream can label each child row.
 *
 * The name is display-only metadata. When the intercom bridge is active the
 * child keeps its machine intercom target as the session name instead — that
 * name is a routing address and must win (see subagent-prompt-runtime).
 */

/** Longest task excerpt kept in the name; the full string is capped below. */
const TASK_EXCERPT_MAX_CHARS = 60;
/** Hard cap on the final name so host UI rows stay one line. */
export const CHILD_SESSION_NAME_MAX_CHARS = 80;

export function deriveChildSessionName(input: {
	agent?: string;
	task?: string;
	/** Workflow node label; preferred over the task excerpt when present. */
	label?: string;
}): string | undefined {
	const agent = input.agent?.trim() ?? "";
	const rawLabel = input.label?.trim() ?? "";
	const rawTask = input.task?.trim() ?? "";
	// Never build a name from redacted text — the excerpt would be meaningless
	// and the redaction marker itself carries no information.
	const excerptSource =
		rawLabel && rawLabel !== PROMPT_REDACTED
			? rawLabel
			: rawTask && rawTask !== PROMPT_REDACTED
				? rawTask
				: "";
	const excerpt = excerptSource ? previewDisplayText(excerptSource, TASK_EXCERPT_MAX_CHARS) : "";
	const base = agent && excerpt ? `${agent}: ${excerpt}` : agent || excerpt;
	if (!base) return undefined;
	return previewDisplayText(base, CHILD_SESSION_NAME_MAX_CHARS);
}
