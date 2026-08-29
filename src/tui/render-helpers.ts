import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<T extends { name: string; description: string; model?: string }>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({ item, score: Math.max(fuzzyScore(q, item.name), fuzzyScore(q, item.description) * 0.8, fuzzyScore(q, item.model ?? "") * 0.6) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}

/** Remove a repeated job name from a child label when a safe separator follows it. */
export function stripRepeatedAgentPrefix(label: string, jobName: string | undefined): string {
	const value = label.trim();
	const prefix = jobName?.trim();
	if (!prefix || !value.startsWith(prefix)) return value;

	const suffix = value.slice(prefix.length);
	if (!suffix || !/^(?::|·|\s)/u.test(suffix)) return value;
	return suffix.replace(/^\s*(?::|·)?\s*/u, "").trim();
}

/** Whether a status label may omit the one logical step marker. */
export function shouldSuppressSingleStep(chainStepCount?: number, stepsTotal?: number): boolean {
	return (chainStepCount ?? stepsTotal) === 1;
}

/** Add an Agent fraction only when visible candidates collide. */
export function withDuplicateLabelDiscriminators<T extends { index: number; displayName: string }>(
	rows: readonly T[],
	total: number,
): Array<T & { rowLabel: string }> {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.displayName, (counts.get(row.displayName) ?? 0) + 1);
	return rows.map((row) => ({
		...row,
		rowLabel: (counts.get(row.displayName) ?? 0) > 1
			? `Agent ${row.index + 1}/${total}: ${row.displayName}`
			: row.displayName,
	}));
}

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
	const clipped = truncateToWidth(singleLine, innerW);
	return theme.fg("border", "│") + pad(clipped, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function formatPath(filePath: string): string {
	const home = process.env.HOME;
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}
