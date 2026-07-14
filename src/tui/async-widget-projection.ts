import type { AsyncJobState, AsyncJobStep, AsyncToolActivity } from "../shared/types.ts";
import { sanitizeObservableText } from "../runs/background/live-observability.ts";

export type AsyncDisplayLifecycle = "running" | "queued" | "completed" | "failed" | "paused" | "stopped";
export interface AsyncWidgetChild { id: string; rootId: string; index: number; agent: string; status: AsyncDisplayLifecycle; source: AsyncJobStep | AsyncJobState; root: AsyncJobState; attention: boolean; }
export interface AsyncWidgetProjection { children: AsyncWidgetChild[]; counts: Record<AsyncDisplayLifecycle, number> & { attention: number }; elapsedMs?: number; }

/** Normalize duration-bearing persisted reasons at the widget trust boundary. */
export function normalizeWidgetDurationText(value: unknown): string | undefined {
	const safe = sanitizeObservableText(value);
	// Match a complete numeric token: plain digits, correctly comma-grouped
	// thousands, or a leading decimal. The left guard prevents starting midway
	// through a malformed/grouped token.
	return safe?.replace(/(?<![\w.,])((?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+))\s*ms\b/gi, (_match, amount: string) => formatWidgetDuration(Number(amount.replaceAll(",", ""))));
}

function sanitizeSource<T extends AsyncJobStep | AsyncJobState>(source: T, previewsEnabled: boolean): T {
	const sanitizeActivities = (items: AsyncToolActivity[] | undefined) => items?.map((item) => ({ ...item, tool: sanitizeObservableText(item.tool) ?? "tool", args: sanitizeObservableText(item.args), path: sanitizeObservableText(item.path), failureSummary: normalizeWidgetDurationText(item.failureSummary) }));
	// Persisted snapshots are an untrusted display boundary, including old nested
	// snapshots whose identity is rendered as an agent fallback.
	const sanitizeNested = (value: unknown): unknown => {
		if (!value || typeof value !== "object") return value;
		const nested = value as Record<string, unknown>;
		return {
			...nested,
			id: sanitizeObservableText(nested.id) ?? "nested",
			agent: sanitizeObservableText(nested.agent),
			currentTool: sanitizeObservableText(nested.currentTool),
			currentToolArgs: sanitizeObservableText(nested.currentToolArgs),
			currentPath: sanitizeObservableText(nested.currentPath),
			attentionReason: normalizeWidgetDurationText(nested.attentionReason),
			error: normalizeWidgetDurationText(nested.error),
			...(Array.isArray(nested.path) ? { path: nested.path.map((part) => part && typeof part === "object" ? { ...(part as Record<string, unknown>), runId: sanitizeObservableText((part as Record<string, unknown>).runId) ?? "run", agent: sanitizeObservableText((part as Record<string, unknown>).agent) } : part) } : {}),
			...(Array.isArray(nested.children) ? { children: nested.children.map(sanitizeNested) } : {}),
		};
	};
	const children = "children" in source && Array.isArray(source.children) ? source.children.map(sanitizeNested) : undefined;
	return { ...source, agent: sanitizeObservableText(source.agent), currentTool: sanitizeObservableText(source.currentTool), currentToolArgs: sanitizeObservableText(source.currentToolArgs), currentPath: sanitizeObservableText(source.currentPath), attentionReason: normalizeWidgetDurationText(source.attentionReason), error: normalizeWidgetDurationText(source.error), model: sanitizeObservableText(source.model), thinking: sanitizeObservableText(source.thinking), ...(previewsEnabled ? { latestVisibleMessagePreview: sanitizeObservableText(source.latestVisibleMessagePreview) } : { latestVisibleMessagePreview: undefined, latestVisibleMessageAt: undefined }), recentToolActivities: sanitizeActivities(source.recentToolActivities), ...(children ? { children } : {}) } as T;
}

export function displayLifecycle(status: string): AsyncDisplayLifecycle {
	if (status === "pending" || status === "queued") return "queued";
	if (status === "complete" || status === "completed") return "completed";
	if (status === "failed") return "failed";
	if (status === "paused") return "paused";
	if (status === "stopped") return "stopped";
	return "running";
}

/** Pure complete-step projection. Steps replace their root so parallel work is never double counted. */
export function projectAsyncWidget(jobs: AsyncJobState[], previewsEnabled = true, nowMs?: number): AsyncWidgetProjection {
	const children: AsyncWidgetChild[] = [];
	for (const root of [...jobs].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.asyncId.localeCompare(b.asyncId))) {
		const sources = root.steps?.length ? root.steps.map((step, index) => ({ source: step, index, fallback: false })) : [{ source: root, index: 0, fallback: true }];
		for (const { source: rawSource, index, fallback } of sources) {
			// Snapshots may have been persisted by older versions. The projection is
			// the trust boundary before any status-derived text reaches the TUI.
			const source = sanitizeSource(rawSource as AsyncJobStep | AsyncJobState, previewsEnabled);
			const step = source as AsyncJobStep;
			const status = displayLifecycle("status" in source ? source.status : root.status);
			const attention = source.activityState === "needs_attention" || Boolean(source.attentionReason);
			const fallbackAgent = sanitizeObservableText(step.agent ?? root.agents?.[index] ?? root.agents?.[0] ?? root.mode) ?? "subagent";
			children.push({ id: fallback ? root.asyncId : `${root.asyncId}:step:${step.index ?? index}`, rootId: root.asyncId, index: step.index ?? index, agent: fallbackAgent, status, source, root, attention });
		}
	}
	const counts = { running: 0, queued: 0, completed: 0, failed: 0, paused: 0, stopped: 0, attention: 0 };
	for (const child of children) { counts[child.status]++; if (child.attention) counts.attention++; }
	const starts = jobs.map((job) => job.startedAt).filter((at): at is number => at !== undefined);
	return { children, counts, ...(starts.length && nowMs !== undefined ? { elapsedMs: Math.max(0, nowMs - Math.min(...starts)) } : {}) };
}

export function formatWidgetDuration(ms: number): string {
	const safeMs = Math.max(0, ms);
	if (safeMs < 60_000) return `${Math.floor(safeMs / 1000)}s`;
	return `${Math.floor(safeMs / 60_000)}m${Math.floor((safeMs % 60_000) / 1000)}s`;
}

export function compactEvidence(child: AsyncWidgetChild, previewsEnabled: boolean, nowMs = child.root.updatedAt ?? 0): string | undefined {
	const source = child.source;
	return sanitizeObservableText(source.attentionReason) ?? sanitizeObservableText(source.error)
		?? (previewsEnabled ? sanitizeObservableText(source.latestVisibleMessagePreview) : undefined)
		?? latestToolOutcome(source.recentToolActivities)
		?? (source.lastActivityAt !== undefined ? `last activity ${formatWidgetDuration(nowMs - source.lastActivityAt)} ago` : undefined);
}

export function latestToolOutcome(activities: AsyncToolActivity[] | undefined): string | undefined {
	const item = activities?.at(-1);
	return item ? `${item.tool} ${item.outcome}${item.durationMs !== undefined ? ` · ${formatWidgetDuration(item.durationMs)}` : ""}` : undefined;
}

export function selectCompactChildren(projection: AsyncWidgetProjection, optionalRunningSlots: number): { rows: AsyncWidgetChild[]; hiddenRunning: number } {
	const mandatory = projection.children.filter((child) => child.attention || child.status === "failed" || child.status === "paused");
	const seen = new Set(mandatory.map((child) => child.id));
	const running = projection.children.filter((child) => child.status === "running" && !seen.has(child.id));
	const rows = [...mandatory, ...running.slice(0, Math.max(0, optionalRunningSlots))];
	return { rows, hiddenRunning: Math.max(0, running.length - Math.max(0, optionalRunningSlots)) };
}

export function collapseRecentSuccesses(items: AsyncToolActivity[]): Array<AsyncToolActivity & { count?: number }> {
	const output: Array<AsyncToolActivity & { count?: number }> = [];
	for (const item of items.slice(-5)) {
		const previous = output.at(-1);
		if (item.outcome === "success" && previous?.outcome === "success" && previous.tool === item.tool && previous.args === item.args && previous.path === item.path) previous.count = (previous.count ?? 1) + 1;
		else output.push({ ...item });
	}
	return output;
}
