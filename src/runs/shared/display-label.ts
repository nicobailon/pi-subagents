const MAX_DISPLAY_LABEL_LENGTH = 64;
const MAX_DISPLAY_LABEL_WORDS = 7;

function collapseWhitespace(value: string): string {
	return value
		.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stripTaskBoilerplate(value: string): string {
	return value
		.replace(/^(?:goal|task|objective|assignment|request)\s*:\s*/i, "")
		.replace(/^(?:please\s+)?(?:your\s+)?(?:job\s+is\s+to\s+)?/i, "")
		.replace(/^[#>*`\-\s]+/, "")
		.trim();
}

function titleFromTask(task: string): string {
	const firstLine = task.split(/\r?\n/).map((line) => collapseWhitespace(line)).find(Boolean) ?? "";
	const cleaned = stripTaskBoilerplate(firstLine)
		.replace(/\{(?:task|previous|chain_dir|outputs\.[^}]+|item(?:\.[^}]+)?)\}/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	const words = cleaned.split(" ").slice(0, MAX_DISPLAY_LABEL_WORDS);
	return words.join(" ").replace(/[.,;:!?-]+$/, "");
}

export function sanitizeDisplayLabel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = collapseWhitespace(value);
	if (!collapsed) return undefined;
	return collapsed.slice(0, MAX_DISPLAY_LABEL_LENGTH).trim();
}

export function resolveDisplayLabel(input: {
	label?: unknown;
	task?: unknown;
	agent?: unknown;
	ordinal?: number;
}): string {
	const explicit = sanitizeDisplayLabel(input.label);
	if (explicit) return explicit;
	const task = typeof input.task === "string" ? titleFromTask(input.task) : "";
	const derived = sanitizeDisplayLabel(task);
	if (derived) return derived;
	const agent = sanitizeDisplayLabel(input.agent) ?? "Subagent";
	return input.ordinal !== undefined ? `${agent} ${input.ordinal}` : agent;
}

export function resolveSiblingDisplayLabels<T>(
	items: readonly T[],
	read: (item: T, index: number) => { label?: unknown; task?: unknown; agent?: unknown },
): string[] {
	const entries = items.map((item, index) => {
		const input = read(item, index);
		return {
			base: resolveDisplayLabel({ ...input, ordinal: index + 1 }),
			explicit: sanitizeDisplayLabel(input.label) !== undefined,
		};
	});
	const totals = new Map<string, number>();
	for (const entry of entries) totals.set(entry.base.toLowerCase(), (totals.get(entry.base.toLowerCase()) ?? 0) + 1);
	const seen = new Map<string, number>();
	return entries.map(({ base, explicit }) => {
		const key = base.toLowerCase();
		const ordinal = (seen.get(key) ?? 0) + 1;
		seen.set(key, ordinal);
		if (explicit || (totals.get(key) ?? 0) < 2) return base;
		const suffix = ` #${ordinal}`;
		return `${base.slice(0, Math.max(1, MAX_DISPLAY_LABEL_LENGTH - suffix.length)).trimEnd()}${suffix}`;
	});
}
