import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { formatTokens } from "../shared/formatters.ts";
import { DIRS, SLASH_RESULT_TYPE, type Details, type SingleResult, type SubagentState, type Usage } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { readWorkflowReceipt } from "../workflows/workflow-receipt.ts";
import { resolveSlashMessageDetails } from "./slash-live-state.ts";

/** Structured parent-plus-child accounting for one session; the source of `/subagent-cost` and the RPC `cost` method. */
export interface SubagentCostReport {
	version: 1;
	parent: Usage;
	children: SubagentCostChild[];
	childTotal: Usage;
	total: Usage;
	/** Async children whose usage metadata could not be resolved; the child total is a lower bound when this is non-zero. */
	unresolvedAsyncChildren: number;
}

export interface SubagentCostChild {
	label: string;
	agent?: string;
	runId?: string;
	usage: Usage;
	sessionFile?: string;
}

export const SUBAGENT_COST_REPORT_VERSION = 1 as const;

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function usageHasValue(usage: Usage): boolean {
	return usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageFromValue(value: unknown, turnsOverride?: number): Usage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const costValue = typeof record.cost === "object" && record.cost !== null && !Array.isArray(record.cost)
		? (record.cost as Record<string, unknown>).total
		: record.cost;
	const turnsValue = turnsOverride ?? record.turns;
	const usage = {
		input: nonNegativeNumber(record.input) ?? 0,
		output: nonNegativeNumber(record.output) ?? 0,
		cacheRead: nonNegativeNumber(record.cacheRead) ?? 0,
		cacheWrite: nonNegativeNumber(record.cacheWrite) ?? 0,
		cost: nonNegativeNumber(costValue) ?? 0,
		turns: nonNegativeNumber(turnsValue) ?? 0,
	};
	return Number.isSafeInteger(usage.turns) ? usage : undefined;
}

function assistantUsageFromMessage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const msg = message as { role?: unknown; usage?: unknown };
	return msg.role === "assistant" ? usageFromValue(msg.usage, 1) : undefined;
}

function compactionUsageFromEntry(entry: unknown): Usage | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; usage?: unknown };
	return record.type === "compaction" ? usageFromValue(record.usage, 0) : undefined;
}

const MAX_USAGE_METADATA_BYTES = 2 * 1024 * 1024;

function readUsageMetadata(metadataPath: string): Record<string, unknown> | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(metadataPath, "r");
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_USAGE_METADATA_BYTES) return undefined;
		const buffer = Buffer.allocUnsafe(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const bytesRead = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
			if (bytesRead <= 0) return undefined;
			offset += bytesRead;
		}
		const value: unknown = JSON.parse(buffer.toString("utf-8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function isSubagentDetails(value: unknown): value is Details {
	if (!value || typeof value !== "object") return false;
	const details = value as { mode?: unknown; results?: unknown };
	return typeof details.mode === "string" && Array.isArray(details.results);
}

function detailsFromSessionEntry(entry: unknown): Details | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; customType?: unknown; details?: unknown; message?: unknown };
	if (record.type === "custom_message" && record.customType === SLASH_RESULT_TYPE) {
		const details = resolveSlashMessageDetails(record.details)?.result.details;
		return isSubagentDetails(details) ? details : undefined;
	}
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	const message = record.message as { role?: unknown; toolName?: unknown; details?: unknown };
	if (message.role !== "toolResult" || (message.toolName !== "subagent" && message.toolName !== "bg_wait")) return undefined;
	return isSubagentDetails(message.details) ? message.details : undefined;
}

function metadataUsage(
	artifactsDirs: string[],
	input: { runId: string; agent: string },
): Usage | undefined {
	if (!/^[A-Za-z0-9._-]+$/.test(input.runId)) return undefined;
	for (const artifactsDir of artifactsDirs) {
		for (const index of [0, undefined] as const) {
			const metadataPath = getArtifactPaths(artifactsDir, input.runId, input.agent, index).metadataPath;
			try {
				const metadata = readUsageMetadata(metadataPath);
				if (!metadata) continue;
				if (metadata.runId !== input.runId || metadata.agent !== input.agent) continue;
				const usage = usageFromValue(metadata.usage);
				if (usage && usageHasValue(usage)) return usage;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to read subagent usage metadata '${metadataPath}':`, error);
			}
		}
	}
	return undefined;
}

/**
 * Collect parent and child usage for the current session branch. Foreground
 * children come from persisted `subagent`/`bg_wait` tool-result details; async
 * workflow children are resolved through receipts and artifact metadata.
 */
export function collectSubagentCost(
	ctx: ExtensionContext,
	state: Pick<SubagentState, "baseCwd" | "artifactDirPreference">,
): SubagentCostReport {
	const parent = emptyUsage();
	const childTotal = emptyUsage();
	const total = emptyUsage();
	const children: SubagentCostChild[] = [];
	const seenChildren = new Set<string>();
	const workflowRunIds = new Set<string>();
	let unresolvedAsyncChildren = 0;

	const addChild = (input: { agent?: string; runId?: string; usage?: Usage; sessionFile?: string }): boolean => {
		if (!input.usage || !usageHasValue(input.usage)) return false;
		const identity = input.runId ? `run:${input.runId}` : input.sessionFile ? `session:${input.sessionFile}` : undefined;
		if (identity && seenChildren.has(identity)) return true;
		if (identity) seenChildren.add(identity);
		const usage = { ...input.usage };
		children.push({
			label: `Child ${children.length + 1} (${input.agent ?? "unknown"})`,
			...(input.agent ? { agent: input.agent } : {}),
			...(input.runId ? { runId: input.runId } : {}),
			usage,
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		});
		addUsage(childTotal, usage);
		return true;
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		const message = entry.type === "message" ? (entry as { message?: unknown }).message : undefined;
		const parentUsage = assistantUsageFromMessage(message) ?? compactionUsageFromEntry(entry);
		if (parentUsage) addUsage(parent, parentUsage);
		const details = detailsFromSessionEntry(entry);
		if (!details) continue;
		if (details.mode === "workflow" && details.runId) workflowRunIds.add(details.runId);
		for (const result of details.results) {
			const resultRunId = (result as SingleResult & { runId?: unknown }).runId;
			addChild({ agent: result.agent, runId: typeof resultRunId === "string" ? resultRunId : undefined, usage: usageFromValue(result.usage), sessionFile: result.sessionFile });
		}
		for (const completion of details.completions ?? []) {
			if (completion.mode === "workflow") workflowRunIds.add(completion.runId);
			for (const result of completion.results ?? []) {
				addChild({ agent: result.agent, runId: result.runId, usage: usageFromValue(result.usage), sessionFile: result.sessionFile });
			}
		}
	}

	let sessionFile: string | null = null;
	try {
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
	} catch { /* an unpersisted session can still report direct child usage */ }
	const artifactsDirs = new Set<string>();
	const addArtifactsDir = (cwd: string | undefined): void => {
		try {
			artifactsDirs.add(getArtifactsDir(sessionFile, cwd, state.artifactDirPreference));
		} catch { /* invalid or unavailable project roots are ignored */ }
	};
	addArtifactsDir(ctx.cwd);
	addArtifactsDir(state.baseCwd);

	for (const workflowRunId of workflowRunIds) {
		try {
			const status = readStatus(path.join(DIRS.async, workflowRunId));
			addArtifactsDir(status?.cwd);
			const receipt = readWorkflowReceipt(DIRS.async, workflowRunId);
			const summaryChildren = new Map((receipt.workflowChildren?.children ?? []).map((child) => [child.childId, child]));
			const refsByRunId = new Map<string, { runId: string; agent?: string }>();
			const addRef = (runId: string | undefined, agent: string | undefined): void => {
				if (!runId) return;
				const existing = refsByRunId.get(runId);
				if (!existing || (!existing.agent && agent)) refsByRunId.set(runId, { runId, ...(agent ? { agent } : {}) });
			};
			for (const [key, entry] of Object.entries(receipt.entries)) {
				const summaryChild = summaryChildren.get(key);
				const runIds = entry.continuation?.runIds?.length
					? entry.continuation.runIds
					: entry.latestRunId ? [entry.latestRunId] : summaryChild?.runId ? [summaryChild.runId] : [];
				for (const runId of runIds) addRef(runId, entry.agent ?? summaryChild?.agent);
			}
			for (const child of receipt.workflowChildren?.children ?? []) {
				if (!Object.hasOwn(receipt.entries, child.childId)) addRef(child.runId, child.agent);
			}
			for (const ref of refsByRunId.values()) {
				if (seenChildren.has(`run:${ref.runId}`)) continue;
				if (!ref.agent) {
					unresolvedAsyncChildren += 1;
					continue;
				}
				const usage = metadataUsage([...artifactsDirs], { runId: ref.runId, agent: ref.agent });
				if (!usage || !addChild({ ...ref, usage })) unresolvedAsyncChildren += 1;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to resolve async subagent usage for '${workflowRunId}':`, error);
		}
	}

	addUsage(total, parent);
	addUsage(total, childTotal);
	return { version: SUBAGENT_COST_REPORT_VERSION, parent, children, childTotal, total, unresolvedAsyncChildren };
}

function formatCostUsage(label: string, usage: Usage): string {
	const extras = [
		usage.cacheRead ? `cache read ${formatTokens(usage.cacheRead)}` : "",
		usage.cacheWrite ? `cache write ${formatTokens(usage.cacheWrite)}` : "",
		usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${label}: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/** The `/subagent-cost` text rendering of a collected report. */
export function formatSubagentCostReport(report: SubagentCostReport): string {
	const lines = [
		"Subagent cost",
		"",
		formatCostUsage("Parent", report.parent),
	];
	if (report.children.length === 0) {
		lines.push("No subagent child usage found in this session.");
	} else {
		for (const child of report.children) {
			lines.push(formatCostUsage(child.label, child.usage));
			if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		}
	}
	if (report.unresolvedAsyncChildren > 0) lines.push(`Async child usage unavailable: ${report.unresolvedAsyncChildren}.`);
	lines.push("────────────────────────────", formatCostUsage("Children", report.childTotal), formatCostUsage("Total", report.total));
	return lines.join("\n");
}
