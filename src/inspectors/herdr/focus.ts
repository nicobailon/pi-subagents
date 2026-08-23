import type { HerdrClient, HerdrErrorCode } from "./client.ts";

export type HerdrFocusErrorCode = HerdrErrorCode | "PANE_FOCUS_UNSUPPORTED" | "INVALID_PANE_RESPONSE";

export type HerdrPaneFocusResult =
	| { ok: true; data: { paneId: string; tabId?: string; workspaceId?: string } }
	| { ok: false; error: { code: HerdrFocusErrorCode; message: string; details?: unknown } };

export function herdrPaneRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	return record.pane && typeof record.pane === "object" && !Array.isArray(record.pane)
		? record.pane as Record<string, unknown>
		: record;
}

function text(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
	return undefined;
}

export function herdrPaneFocusTarget(value: unknown): { paneId?: string; tabId?: string; workspaceId?: string } {
	const pane = herdrPaneRecord(value);
	if (!pane) return {};
	return {
		paneId: text(pane, "pane_id", "paneId", "id"),
		tabId: text(pane, "tab_id", "tabId"),
		workspaceId: text(pane, "workspace_id", "workspaceId"),
	};
}

export async function focusHerdrPane(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<HerdrPaneFocusResult> {
	const live = await client.run(["pane", "get", paneId], { timeoutMs: 5_000, signal });
	if (live.ok === false) return live;
	const target = herdrPaneFocusTarget(live.data);
	if (!target.paneId) {
		return { ok: false, error: { code: "INVALID_PANE_RESPONSE", message: `Herdr pane get returned no pane id for '${paneId}'.`, details: live.data } };
	}
	if (target.tabId) {
		const focused = await client.run(["tab", "focus", target.tabId], { timeoutMs: 5_000, signal });
		return focused.ok ? { ok: true, data: { paneId: target.paneId, tabId: target.tabId, ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}) } } : focused;
	}
	if (target.workspaceId) {
		const focused = await client.run(["workspace", "focus", target.workspaceId], { timeoutMs: 5_000, signal });
		return focused.ok ? { ok: true, data: { paneId: target.paneId, workspaceId: target.workspaceId } } : focused;
	}
	return {
		ok: false,
		error: {
			code: "PANE_FOCUS_UNSUPPORTED",
			message: `Herdr pane '${paneId}' has no tab_id or workspace_id. Select it in Herdr manually, or upgrade Herdr focus support.`,
			details: live.data,
		},
	};
}
