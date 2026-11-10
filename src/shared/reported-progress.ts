import { sanitizeDisplayText } from "./display-text.ts";

const MAX_REPORTED_PROGRESS_LENGTH = 512;

export function extractReportedProgress(toolName: string, args: unknown): string | undefined {
	if (toolName !== "contact_supervisor" || typeof args !== "object" || args === null) return undefined;
	const call = args as { reason?: unknown; message?: unknown };
	if (call.reason !== "progress_update" || typeof call.message !== "string") return undefined;
	const firstLine = call.message.split(/\r?\n/, 1)[0] ?? "";
	const sanitized = sanitizeDisplayText(firstLine).replace(/^(?:progress|update):\s*/i, "");
	return sanitized ? sanitized.slice(0, MAX_REPORTED_PROGRESS_LENGTH) : undefined;
}
