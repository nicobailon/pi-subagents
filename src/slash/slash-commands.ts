import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { discoverAgentSnapshot, discoverAgents, findBlockingAgentDiagnostic, formatUnknownAgentError, resolveAgentName, unknownAgentDiagnosticContext, type AgentConfig, type AgentDiscoveryDiagnostic, type AgentScope, type UnknownAgentDiagnosticContext } from "../agents/agents.ts";
import { listRuntimeAgentConfigs, mergeRuntimeAgents } from "../agents/runtime-agent-registry.ts";
import { resolveExistingReadPaths } from "../shared/settings.ts";
import {
	DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS,
	applySubagentProfile,
	checkSubagentProfile,
	generateProfilesForProvider,
	listSubagentProfiles,
	readSubagentProfile,
	refreshProviderModelCatalog,
} from "../profiles/profiles.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { findModelInfo, toModelInfo } from "../shared/model-info.ts";
import { formatTokens, shortenPath } from "../shared/formatters.ts";
import { listAsyncRuns, formatAsyncRunProgressLabel, type AsyncRunSummary } from "../runs/background/async-status.ts";
import { encodeInspectReply, handleInspectRpcArgs, INSPECT_WIDGET_KEY } from "../runs/background/inspect-rpc.ts";
import { listScheduledRunSummaries } from "../runs/background/scheduled-runs.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { resolveAsyncStatusChild } from "../runs/shared/child-identity.ts";
import { readStatus } from "../shared/utils.ts";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.ts";
import { readWorkflowReceipt } from "../workflows/workflow-receipt.ts";
import { FLEET_OPEN_SHORTCUT } from "../shared/shortcuts.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import { registerPromptWorkflowCommands } from "./prompt-workflows.ts";
import { openSubagentsAdmin } from "./subagents-admin.ts";
import { SUBAGENT_GUIDE_TOPICS } from "../extension/subagent-guide.ts";
import { openSubagentFleet } from "../tui/fleet.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
	resolveSlashMessageDetails,
} from "./slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_TEXT_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	DIRS,
	type Details,
	type FleetKeybindingsConfig,
	type SingleResult,
	type SubagentState,
	type Usage,
} from "../shared/types.ts";

interface InlineConfig {
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
}

const parseInlineConfig = (raw: string): InlineConfig => {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output": config.output = val === "false" ? false : val; break;
			case "outputMode": if (val === "inline" || val === "file-only") config.outputMode = val; break;
			case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "model": config.model = val || undefined; break;
			case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
		}
	}
	return config;
};

const parseAgentToken = (token: string): { name: string; config: InlineConfig } => {
	const bracket = token.indexOf("[");
	if (bracket === -1) return { name: token, config: {} };
	const end = token.lastIndexOf("]");
	return { name: token.slice(0, bracket), config: parseInlineConfig(token.slice(bracket + 1, end !== -1 ? end : undefined)) };
};

const extractExecutionFlags = (rawArgs: string): { args: string; bg: boolean; fork: boolean } => {
	let args = rawArgs.trim();
	let bg = false;
	let fork = false;

	while (true) {
		if (args.endsWith(" --bg") || args === "--bg") {
			bg = true;
			args = args === "--bg" ? "" : args.slice(0, -5).trim();
			continue;
		}
		if (args.endsWith(" --fork") || args === "--fork") {
			fork = true;
			args = args === "--fork" ? "" : args.slice(0, -7).trim();
			continue;
		}
		break;
	}

	return { args, bg, fork };
};

function discoverSlashAgents(pi: ExtensionAPI, cwd: string, scope: AgentScope): { agents: AgentConfig[]; agentDiagnostics?: AgentDiscoveryDiagnostic[]; unknownAgentDiagnosticContext: UnknownAgentDiagnosticContext } {
	if (listRuntimeAgentConfigs(pi).length === 0) {
		const discovered = discoverAgents(cwd, scope);
		return { ...discovered, unknownAgentDiagnosticContext: unknownAgentDiagnosticContext(discovered) };
	}
	const snapshot = discoverAgentSnapshot(cwd, scope, undefined, { includeChains: false });
	const discovered = snapshot.effective;
	const all = snapshot.all;
	const configuredAgents: AgentConfig[] = [
		...all.builtin,
		...all.package,
		...(scope !== "project" ? all.user : []),
		...(scope !== "user" ? all.project : []),
	];
	const merged = mergeRuntimeAgents(pi, discovered, configuredAgents);
	return { ...merged, unknownAgentDiagnosticContext: { ...unknownAgentDiagnosticContext(discovered), agents: merged.agents } };
}

const makeAgentCompletions = (pi: ExtensionAPI, state: SubagentState) => (prefix: string) => {
	if (!state.baseCwd || prefix.includes(" ")) return null;
	return discoverSlashAgents(pi, state.baseCwd, "both").agents
		.filter((agent) => agent.name.startsWith(prefix))
		.map((agent) => ({ value: agent.name, label: agent.name }));
};

const makeProviderCompletions = (state: SubagentState) => (prefix: string) => {
	if (prefix.includes(" ")) return null;
	const available = state.lastUiContext?.modelRegistry?.getAvailable?.();
	if (!Array.isArray(available)) return null;
	const providers = [...new Set(available
		.map((model) => typeof model?.provider === "string" ? model.provider : "")
		.filter(Boolean))]
		.sort((a, b) => a.localeCompare(b));
	return providers
		.filter((provider) => provider.startsWith(prefix))
		.map((provider) => ({ value: provider, label: provider }));
};

function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SLASH_TEXT_RESULT_TYPE, content: text, display: true });
}

async function withSlashStatus<T>(
	ctx: ExtensionContext,
	text: string,
	run: () => Promise<T>,
): Promise<T> {
	if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", text);
	try {
		return await run();
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", undefined);
	}
}

type Theme = ExtensionContext["ui"]["theme"];

type StopSelectorTarget = {
	kind: "async" | "scheduled";
	id: string;
	label: string;
	detail: string;
	actionLabel: string;
};

type StopSelectorResult = { confirmed: boolean; target?: StopSelectorTarget };

function commandForTarget(target: StopSelectorTarget): string {
	return target.kind === "scheduled"
		? `subagent({ action: "schedule.pause", id: ${JSON.stringify(target.id)} })`
		: `subagent({ action: "stop", id: ${JSON.stringify(target.id)} })`;
}

function formatAsyncStopTarget(run: AsyncRunSummary): StopSelectorTarget {
	const progress = formatAsyncRunProgressLabel(run);
	const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
	return {
		kind: "async",
		id: run.id,
		label: `${run.id} · ${run.mode} · ${progress}`,
		detail: `${run.state} · ${cwd}`,
		actionLabel: "stop async run",
	};
}

function scheduledStopTargets(ctx: ExtensionContext, _state: SubagentState): StopSelectorTarget[] {
	try {
		return listScheduledRunSummaries(ctx.cwd)
			.filter((schedule) => !schedule.paused && !schedule.activeRunId && schedule.trigger.nextRunAt)
			.sort((left, right) => left.trigger.nextRunAt!.localeCompare(right.trigger.nextRunAt!))
			.map((schedule) => ({
				kind: "scheduled" as const,
				id: schedule.id,
				label: `${schedule.id} · ${schedule.name}`,
				detail: `scheduled · ${schedule.trigger.nextRunAt}`,
				actionLabel: "pause schedule",
			}));
	} catch {
		return [];
	}
}

function discoverStopTargets(ctx: ExtensionContext, state: SubagentState): StopSelectorTarget[] {
	const sessionId = state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined;
	const asyncTargets = listAsyncRuns(DIRS.async, {
		states: ["queued", "running"],
		...(sessionId ? { sessionId } : {}),
	}).map(formatAsyncStopTarget);
	return [...asyncTargets, ...scheduledStopTargets(ctx, state)];
}

function stopFallbackText(targets: StopSelectorTarget[]): string {
	if (targets.length === 0) return "No active current-session async runs or scheduled subagent runs to stop.";
	const lines = ["Subagent stop targets:", ""];
	for (const target of targets) {
		lines.push(`- ${target.label}`);
		lines.push(`  ${target.detail}`);
		lines.push(`  ${target.actionLabel}: ${commandForTarget(target)}`);
		if (target.kind === "async") lines.push(`  slash: /subagents-stop ${target.id}`);
	}
	return lines.join("\n");
}

function selectForegroundDetachControl(state: SubagentState, requested: string) {
	const controls = [...state.foregroundControls.values()];
	if (requested) {
		const matches = controls.filter((control) => control.runId === requested || control.runId.startsWith(requested));
		if (matches.length > 1) throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((control) => control.runId).join(", ")}. Provide a longer id.`);
		return matches[0];
	}
	const singleControls = controls.filter((control) => control.mode === "single");
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest?.mode === "single") return latest;
	}
	return singleControls.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

class SubagentsStopSelector implements Component {
	readonly width = 84;
	private selected = 0;
	private confirming = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly targets: StopSelectorTarget[];
	private readonly done: (result: StopSelectorResult) => void;

	constructor(tui: TUI, theme: Theme, targets: StopSelectorTarget[], done: (result: StopSelectorResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.targets = targets;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ confirmed: false });
			return;
		}
		if (this.confirming) {
			if (matchesKey(data, "return") || data.toLowerCase() === "y") {
				this.done({ confirmed: true, target: this.targets[this.selected] });
				return;
			}
			if (data.toLowerCase() === "n" || matchesKey(data, "backspace")) {
				this.confirming = false;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selected = Math.min(this.targets.length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			this.confirming = true;
			this.tui.requestRender();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(0, Math.min(this.width, Math.floor(width)));
		const lines = [this.theme.bold("Stop subagent run"), this.theme.fg("dim", "Select a current-session async run to stop, or a scheduled run to cancel."), ""];
		const maxRows = 10;
		const start = Math.max(0, Math.min(this.selected - maxRows + 1, Math.max(0, this.targets.length - maxRows)));
		for (let index = start; index < Math.min(this.targets.length, start + maxRows); index++) {
			const target = this.targets[index]!;
			const selected = index === this.selected;
			const marker = selected ? "›" : " ";
				const actionLabel = target.actionLabel;
			const action = target.kind === "scheduled" ? this.theme.fg("warning", actionLabel) : this.theme.fg("accent", actionLabel);
			const labelWidth = Math.max(0, contentWidth - marker.length - actionLabel.length - 2);
			lines.push(`${marker} ${action} ${target.label.slice(0, labelWidth)}`);
			if (selected) lines.push(this.theme.fg("dim", `  ${target.detail}`.slice(0, contentWidth)));
		}
		if (this.targets.length > maxRows) lines.push(this.theme.fg("dim", `Showing ${start + 1}-${Math.min(this.targets.length, start + maxRows)} of ${this.targets.length}`));
		lines.push("");
		if (this.confirming) {
			const target = this.targets[this.selected]!;
			lines.push(this.theme.fg("warning", `Confirm: ${target.actionLabel} ${target.id}?`));
			if (target.kind === "async") lines.push(this.theme.fg("dim", "Stop ends this run; use interrupt for a resumable pause."));
			lines.push(this.theme.fg("dim", "Enter/Y confirms · N returns · Esc cancels"));
		} else {
			lines.push(this.theme.fg("dim", "↑↓/jk select · Enter confirm · Esc cancel"));
		}
		return lines.map((line) => truncateToWidth(line, contentWidth));
	}
}

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

function formatCostUsage(label: string, usage: Usage): string {
	const extras = [
		usage.cacheRead ? `cache read ${formatTokens(usage.cacheRead)}` : "",
		usage.cacheWrite ? `cache write ${formatTokens(usage.cacheWrite)}` : "",
		usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${label}: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function buildSubagentCostReport(ctx: ExtensionContext, state: SubagentState): string {
	const parent = emptyUsage();
	const childTotal = emptyUsage();
	const total = emptyUsage();
	const children: Array<{ label: string; usage: Usage; sessionFile?: string }> = [];
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
			const refsByRunId = new Map<string, { runId: string; agent: string }>();
			const addRef = (runId: string | undefined, agent: string | undefined): void => {
				if (!runId || !agent || refsByRunId.has(runId)) return;
				refsByRunId.set(runId, { runId, agent });
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
			const refs = [...refsByRunId.values()];
			for (const ref of refs) {
				if (seenChildren.has(`run:${ref.runId}`)) continue;
				const usage = metadataUsage([...artifactsDirs], ref);
				if (!usage || !addChild({ ...ref, usage })) unresolvedAsyncChildren += 1;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to resolve async subagent usage for '${workflowRunId}':`, error);
		}
	}

	addUsage(total, parent);
	addUsage(total, childTotal);
	const lines = [
		"Subagent cost",
		"",
		formatCostUsage("Parent", parent),
	];
	if (children.length === 0) {
		lines.push("No subagent child usage found in this session.");
	} else {
		for (const child of children) {
			lines.push(formatCostUsage(child.label, child.usage));
			if (child.sessionFile) lines.push(`  Session: ${child.sessionFile}`);
		}
	}
	if (unresolvedAsyncChildren > 0) lines.push(`Async child usage unavailable: ${unresolvedAsyncChildren}.`);
	lines.push("────────────────────────────", formatCostUsage("Children", childTotal), formatCostUsage("Total", total));
	return lines.join("\n");
}

function parseSingleRequiredArg(args: string, usage: string): { ok: true; value: string } | { ok: false; message: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 1) return { ok: false, message: usage };
	return { ok: true, value: parts[0]! };
}

function getProfileWorkerModel(profile: { subagents?: { agentOverrides?: Record<string, { model?: string }> } }): string | undefined {
	const model = profile.subagents?.agentOverrides?.worker?.model;
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error
		&& (error.message.includes("This extension ctx is stale")
			|| error.message.includes("Extension context no longer active"));
}

function slashHasUI(ctx: ExtensionContext): boolean | undefined {
	try {
		return ctx.hasUI;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}


async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: SubagentParamsLike,
	signal?: AbortSignal,
): Promise<SlashSubagentResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;
		let startTimeout: ReturnType<typeof setTimeout> | undefined;

		const onStarted = (data: unknown) => {
			if (done || signal?.aborted || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			if (startTimeout) clearTimeout(startTimeout);
			try {
				if (ctx.hasUI) ctx.ui.setStatus("subagent-slash", "running...");
			} catch (error) {
				if (isStaleExtensionContextError(error)) {
					finish(() => reject(error));
					return;
				}
				throw error;
			}
		};

		const onResponse = (data: unknown) => {
			if (done || signal?.aborted || !data || typeof data !== "object") return;
			const response = data as Partial<SlashSubagentResponse>;
			if (response.requestId !== requestId) return;
			if (startTimeout) clearTimeout(startTimeout);
			finish(() => resolve(response as SlashSubagentResponse));
		};

		const onUpdate = (data: unknown) => {
			if (done || signal?.aborted || !data || typeof data !== "object") return;
			const update = data as SlashSubagentUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			try {
				if (!ctx.hasUI) return;
				const tool = update.currentTool ? ` ${update.currentTool}` : "";
				const count = update.toolCount ?? 0;
				const liveDetailKey = keyText("app.tools.expand");
				ctx.ui.setStatus("subagent-slash", `${count} tools${tool} | ${liveDetailKey} live detail`);
			} catch (error) {
				if (isStaleExtensionContextError(error)) {
					finish(() => reject(error));
					return;
				}
				throw error;
			}
		};

		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId });
				finish(() => reject(new Error("Cancelled")));
				return { consume: true };
			})
			: undefined;

		const unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate);

		let onAbort: () => void;
		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			if (startTimeout) clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			try {
				onTerminalInput?.();
			} catch (error) {
				if (!isStaleExtensionContextError(error)) throw error;
			}
			signal?.removeEventListener("abort", onAbort);
			next();
		};
		onAbort = () => finish(() => reject(new Error("Slash subagent request canceled during session replacement or reload.")));
		startTimeout = setTimeout(() => {
			finish(() => reject(new Error(
				"Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly.",
			)));
		}, 15_000);

		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params, ctx });
		} catch (error) {
			if (isStaleExtensionContextError(error)) {
				finish(() => reject(error));
				return;
			}
			throw error;
		}

		// Bridge emits STARTED synchronously during REQUEST emit.
		// If not started, no bridge received the request.
		if (!started && done) return;
		if (!started) {
			finish(() => reject(new Error(
				"No slash subagent bridge responded. Ensure the subagent extension is loaded correctly.",
			)));
		}
	});
}

function extractSlashMessageText(content: string | Array<{ type?: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function formatExportPathList(paths: string[]): string {
	return paths.map((file) => `- \`${file}\``).join("\n");
}

function collectResultPaths(results: SingleResult[], getPath: (result: SingleResult) => string | undefined): string[] {
	return results
		.map(getPath)
		.filter((file): file is string => typeof file === "string" && file.length > 0);
}

function buildSlashExportText(response: SlashSubagentResponse): string {
	const output = extractSlashMessageText(response.result.content) || response.errorText || "(no output)";
	const results = response.result.details?.results ?? [];
	const sessionFiles = collectResultPaths(results, (result) => result.sessionFile);
	const savedOutputs = collectResultPaths(results, (result) => result.savedOutputPath);
	const artifactOutputs = collectResultPaths(results, (result) => result.artifactPaths?.outputPath);
	const sections = ["## Subagent result", output];
	if (sessionFiles.length > 0) sections.push("## Child session exports", formatExportPathList(sessionFiles));
	if (savedOutputs.length > 0) sections.push("## Saved outputs", formatExportPathList(savedOutputs));
	if (artifactOutputs.length > 0) sections.push("## Artifact outputs", formatExportPathList(artifactOutputs));
	return sections.join("\n\n");
}

function persistSlashSessionSnapshot(ctx: ExtensionContext): void {
	try {
		if (!ctx.sessionManager) return;
		const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
			_rewriteFile?: () => void;
			flushed?: boolean;
		};
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile || typeof sessionManager._rewriteFile !== "function") return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		sessionManager._rewriteFile();
		sessionManager.flushed = true;
	} catch (error) {
		console.error("Failed to persist slash session snapshot for export:", error);
	}
}

async function runSlashSubagent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: SubagentParamsLike,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	const initialHasUI = slashHasUI(ctx);
	if (initialHasUI === undefined) return;
	try {
		if (initialHasUI) ctx.ui.setToolsExpanded(false);
	} catch (error) {
		if (isStaleExtensionContextError(error)) return;
		throw error;
	}
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running subagent...";
	try {
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: initialText,
			display: true,
			details: initialDetails,
		});
	} catch (error) {
		if (isStaleExtensionContextError(error)) return;
		throw error;
	}
	persistSlashSessionSnapshot(ctx);

	try {
		const response = await requestSlashRun(pi, ctx, requestId, params, signal);
		if (signal?.aborted) return;
		const hasUI = slashHasUI(ctx);
		if (hasUI === undefined) return;
		const finalDetails = finalizeSlashResult(response);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: buildSlashExportText(response),
			display: !hasUI,
			details: finalDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (response.isError && hasUI) {
			ctx.ui.notify(response.errorText || "Subagent failed", "error");
		}
	} catch (error) {
		if (signal?.aborted || isStaleExtensionContextError(error)) return;
		const message = error instanceof Error ? error.message : String(error);
		const hasUI = slashHasUI(ctx);
		if (hasUI === undefined) return;
		const failedDetails = failSlashResult(requestId, params, message);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: `## Subagent result\n\n${message}`,
			display: !hasUI,
			details: failedDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (message === "Cancelled") {
			if (hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (hasUI) ctx.ui.notify(message, "error");
	}
}

function slashRunWorkflowScript(key: string, child: Record<string, unknown>): string {
	return `return runs.run(${JSON.stringify(key)}, ${JSON.stringify(child)})`;
}

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
	options: { fleetKeybindings?: FleetKeybindingsConfig; foregroundDetachShortcut?: string } = {},
): { dispose: () => void } {
	let fleetOpen = false;
	let disposed = false;
	const pendingRequests = new Set<AbortController>();
	const runCommand = (ctx: ExtensionContext, params: SubagentParamsLike): Promise<void> => {
		if (disposed) return Promise.resolve();
		const controller = new AbortController();
		pendingRequests.add(controller);
		return runSlashSubagent(pi, ctx, params, controller.signal).finally(() => pendingRequests.delete(controller));
	};
	const launchCommand = (ctx: ExtensionContext, params: SubagentParamsLike): void => {
		void runCommand(ctx, params);
	};
	const showFleet = async (ctx: ExtensionContext) => {
		state.lastUiContext = ctx;
		if (!ctx.hasUI) {
			await runCommand(ctx, { action: "status", view: "fleet" });
			return;
		}
		if (fleetOpen) {
			ctx.ui.notify("Subagent fleet inspector is already open.", "info");
			return;
		}
		fleetOpen = true;
		try {
			await openSubagentFleet(ctx, state, { asyncDirRoot: DIRS.async, resultsDir: DIRS.results, fleetKeybindings: options.fleetKeybindings });
		} finally {
			fleetOpen = false;
		}
	};

	pi.registerCommand("subagents", {
		description: "Administer subagents: inspect metadata and update models, thinking, or prompts",
		handler: async (args, ctx) => {
			await openSubagentsAdmin(pi, ctx, args);
		},
	});

	pi.registerCommand("run", {
		description: "Run one subagent through workflowScript: /run agent[output=file] [task] [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(pi, state),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (!input) { ctx.ui.notify("Usage: /run <agent> [task] [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
			const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();

			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const discovered = discoverSlashAgents(pi, state.baseCwd, "both");
			const resolvedAgent = resolveAgentName(agentName, discovered.agents);
			const candidates = resolvedAgent.error
				? discovered.agents.filter((agent) => resolveAgentName(agentName, [agent]).agent)
				: resolvedAgent.agent;
			const diagnostic = findBlockingAgentDiagnostic(agentName, candidates, discovered.agentDiagnostics);
			if (diagnostic || resolvedAgent.error || !resolvedAgent.agent) {
				ctx.ui.notify(diagnostic ? `Agent '${agentName}' has invalid configuration: ${diagnostic.error}` : resolvedAgent.error ?? formatUnknownAgentError(agentName, discovered.unknownAgentDiagnosticContext), "error");
				return;
			}

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				const existingReads = inline.reads.filter((read) => resolveExistingReadPaths([read], state.baseCwd).length > 0);
				if (existingReads.length > 0) finalTask = `[Read from: ${existingReads.join(", ")}]\n\n${finalTask}`;
			}
			const child: Record<string, unknown> = { agent: agentName, task: finalTask, agentScope: "both" };
			if (inline.output !== undefined) child.output = inline.output;
			if (inline.outputMode !== undefined) child.outputMode = inline.outputMode;
			if (inline.skill !== undefined) child.skill = inline.skill;
			if (inline.model) child.model = inline.model;
			if (fork) child.context = "fork";
			launchCommand(ctx, { workflowScript: slashRunWorkflowScript("run", child), async: bg ? true : false });
		},
	});

	pi.registerCommand("subagent-cost", {
		description: "Show parent and subagent child usage cost for this session",
		handler: async (_args, ctx) => {
			sendSlashText(pi, buildSubagentCostReport(ctx, state));
		},
	});

	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runCommand(ctx, { action: "doctor" });
		},
	});

	pi.registerCommand("subagents-inspect-rpc", {
		description: "Host integration bridge: answer an async child inspection request with a correlated widget payload (no model turn)",
		handler: async (args, ctx) => {
			if (ctx.mode === "tui") {
				ctx.ui.notify("Inspection replies are emitted only on RPC surfaces. Use /subagents or subagent({ action: \"status\", view: \"transcript\" }) interactively.", "info");
				return;
			}
			if (!ctx.hasUI) return;
			const reply = handleInspectRpcArgs(args, { state });
			// Emit-then-retract in one handler: stdio delivers the two widget
			// updates in order, the host buffers the payload by requestId, and
			// the dedicated key never accumulates visible state.
			ctx.ui.setWidget(INSPECT_WIDGET_KEY, encodeInspectReply(reply));
			ctx.ui.setWidget(INSPECT_WIDGET_KEY, undefined);
		},
	});

	pi.registerCommand("subagents-guide", {
		description: "Show a packaged subagents guide topic",
		getArgumentCompletions: (prefix) => prefix.includes(" ") ? null : SUBAGENT_GUIDE_TOPICS
			.filter((topic) => topic.startsWith(prefix))
			.map((topic) => ({ value: topic, label: topic })),
		handler: async (args, ctx) => {
			const topic = args.trim();
			if (topic.includes(" ")) {
				ctx.ui.notify("Usage: /subagents-guide [topic]", "error");
				return;
			}
			await runCommand(ctx, { action: "guide", ...(topic ? { topic } : {}) });
		},
	});

	pi.registerCommand("subagents-refine", {
		description: "Generate a bounded project-local refinement overlay for one subagent",
		getArgumentCompletions: makeAgentCompletions(pi, state),
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length !== 1) {
				ctx.ui.notify("Usage: /subagents-refine <agent>", "error");
				return;
			}
			await runCommand(ctx, { action: "refine", agent: parts[0] });
		},
	});

	pi.registerCommand("subagents-fleet", {
		description: "Open the live subagent fleet inspector",
		handler: async (_args, ctx) => showFleet(ctx),
	});

	pi.registerShortcut(FLEET_OPEN_SHORTCUT, {
		description: "Open subagent fleet inspector",
		handler: async (ctx) => showFleet(ctx),
	});

	const detachForegroundRun = (args: string, ctx: ExtensionContext): void => {
		const id = args.trim();
		let control: ReturnType<typeof selectForegroundDetachControl>;
		try {
			control = selectForegroundDetachControl(state, id);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		if (!control) {
			ctx.ui.notify(id ? `No active foreground run found for '${id}'.` : "No active foreground single-subagent run to detach.", "info");
			return;
		}
		if (control.mode !== "single") {
			ctx.ui.notify("/subagents-detach currently supports single-subagent runs only.", "error");
			return;
		}
		if (!control.detach?.()) {
			ctx.ui.notify(`Foreground run ${control.runId} is not currently detachable.`, "info");
			return;
		}
		sendSlashText(pi, `Detached foreground run ${control.runId} without terminating its child. Use subagent({ action: "status", id: ${JSON.stringify(control.runId)} }) or bg_wait({ id: ${JSON.stringify(control.runId)} }) to recover the eventual result. This does not daemonize the process or guarantee survival across Pi reload/restart.`);
	};

	pi.registerCommand("subagents-detach", {
		description: "Detach the active foreground single-subagent run without terminating it",
		handler: async (args, ctx) => detachForegroundRun(args, ctx),
	});

	if (options.foregroundDetachShortcut) {
		pi.registerShortcut(options.foregroundDetachShortcut as KeyId, {
			description: "Detach the active foreground subagent and keep it running in the background",
			handler: async (ctx) => detachForegroundRun("", ctx),
		});
	}

	pi.registerCommand("subagents-stop", {
		description: "Stop a current-session async subagent run, or one child of it with /subagents-stop <run-id> <child-id>",
		handler: async (args, ctx) => {
			const [id, childId, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (extra.length > 0) {
				sendSlashText(pi, "Usage: /subagents-stop [run-id] [child-id]");
				return;
			}
			if (id) {
				await runCommand(ctx, childId ? { action: "stop", id, childId } : { action: "stop", id });
				return;
			}

			if (process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1") {
				sendSlashText(pi, "Selector unavailable in child-safe fanout mode. Pass an explicit current-session top-level async run id, for example `/subagents-stop <run-id>` or `subagent({ action: \"stop\", id: \"<run-id>\" })`.");
				return;
			}

			let targets: StopSelectorTarget[];
			try {
				targets = discoverStopTargets(ctx, state);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				return;
			}
			if (!ctx.hasUI) {
				sendSlashText(pi, stopFallbackText(targets));
				return;
			}
			if (targets.length === 0) {
				ctx.ui.notify("No active current-session async runs or scheduled subagent runs to stop.", "info");
				return;
			}

			const result = await ctx.ui.custom<StopSelectorResult>(
				(tui, theme, _kb, done) => new SubagentsStopSelector(tui, theme, targets, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: 88, maxHeight: "80%" } },
			);
			if (!result?.confirmed || !result.target) return;
			if (result.target.kind === "scheduled") {
				await runCommand(ctx, { action: "schedule.pause", id: result.target.id });
				return;
			}
			await runCommand(ctx, { action: "stop", id: result.target.id });
		},
	});

	pi.registerCommand("subagents-steer", {
		description: "Steer a live async subagent run with a message, or one child of it with --child <child-id>",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const usage = "Usage: /subagents-steer <run-id> [--child <child-id>] <message>";
			const [id, ...rest] = tokens;
			if (!id || id.startsWith("--")) {
				sendSlashText(pi, usage);
				return;
			}
			// Only the optional child selector is parsed as a flag. Everything
			// after the run id (or selector) is free-form message text, including
			// a leading token such as `--verbose`.
			let childId: string | undefined;
			let messageStart = 0;
			if (rest[0] === "--child" && rest[1] && !rest[1].startsWith("--")) {
				childId = rest[1];
				messageStart = 2;
			}
			const message = rest.slice(messageStart).join(" ").trim();
			if (!message) {
				sendSlashText(pi, usage);
				return;
			}
			let targetId = id;
			let childIndex: number | undefined;
			if (childId !== undefined) {
				const sessionId = state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined;
				const run = listAsyncRuns(DIRS.async, {
					runId: id,
					states: ["queued", "running", "paused"],
					...(sessionId ? { sessionId } : {}),
				})[0];
				const status = run ? readStatus(run.asyncDir) : null;
				if (!run || !status) {
					sendSlashText(pi, `No current-session async run found for '${id}'.`);
					return;
				}
				const resolutionStatus = {
					...status,
					steps: status.steps?.map((step, index) => ({ ...step, children: run.steps[index]?.children ?? step.children })),
				};
				const resolution = resolveAsyncStatusChild(resolutionStatus, childId, { includeNested: true });
				if (!resolution.ok) {
					sendSlashText(pi, resolution.message);
					return;
				}
				if (resolution.child.nested) targetId = resolution.child.nested.id;
				else if (resolution.child.step.runId) targetId = resolution.child.step.runId;
				else childIndex = resolution.child.index;
			}
			await runCommand(ctx, {
				action: "steer",
				id: targetId,
				message,
				...(childIndex !== undefined ? { index: childIndex } : {}),
				// Host-style exact-child authority, matching the extension RPC
				// nonRecoveringSteer guarantee: never swap the addressed child for
				// a pause-and-revive replacement after a missed acknowledgment.
				steeringRecovery: false,
			});
		},
	});

	registerPromptWorkflowCommands({
		pi,
		run: async (params, ctx) => {
			launchCommand(ctx, params);
		},
	});

	pi.registerCommand("subagents-models", {
		description: "Show model mappings for discovered subagents",
		getArgumentCompletions: makeAgentCompletions(pi, state),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await runCommand(ctx, { action: "models" });
				return;
			}
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length !== 1) {
				ctx.ui.notify("Usage: /subagents-models [agent-name]", "error");
				return;
			}
			await runCommand(ctx, { action: "models", agent: parts[0]! });
		},
	});

	pi.registerCommand("subagents-profiles", {
		description: "List saved subagent profiles",
		handler: async (_args, _ctx) => {
			const profiles = listSubagentProfiles();
			if (profiles.length === 0) {
				sendSlashText(pi, "Subagent profiles\n\nNo subagent profiles found in ~/.pi/agent/profiles/pi-subagents/");
				return;
			}
			sendSlashText(pi, `Subagent profiles\n\n${profiles.join("\n")}`);
		},
	});

	pi.registerCommand("subagents-load-profile", {
		description: "Load a subagent profile into ~/.pi/agent/settings.json",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return listSubagentProfiles()
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-load-profile <name>");
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Loading profile ${parsed.value}…`, async () => {
					const { profile } = readSubagentProfile(parsed.value);
					const workerModel = getProfileWorkerModel(profile);
					const result = applySubagentProfile(parsed.value);
					const lines = [
						`Loaded subagent profile: ${parsed.value}`,
						`Profile: ${result.filePath}`,
						`Updated: ${result.settingsPath}`,
					];

					if (workerModel && typeof pi.setModel === "function" && typeof ctx.modelRegistry?.find === "function" && typeof ctx.modelRegistry?.getAvailable === "function") {
						const shouldSwitch = await ctx.ui.confirm(
							"",
							`Profile loaded. Also switch this session to the profile worker model?\n\n${workerModel}`,
						);
						if (shouldSwitch) {
							const modelInfo = findModelInfo(workerModel, ctx.modelRegistry.getAvailable().map(toModelInfo));
							const model = modelInfo ? ctx.modelRegistry.find(modelInfo.provider, modelInfo.id) : undefined;
							if (!modelInfo || !model) {
								lines.push(`Could not switch current session model: '${workerModel}' is not available in the current model registry.`);
							} else {
								const success = await pi.setModel(model);
								if (success) lines.push(`Current session model switched to: ${modelInfo.fullId}`);
								else lines.push(`Could not switch current session model to '${workerModel}': no API key or provider access is available.`);
							}
						}
					} else if (workerModel) {
						lines.push(`Profile worker model: ${workerModel}`);
					}

					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-refresh-provider-models", {
		description: "Refresh the cached model catalog for one provider",
		getArgumentCompletions: makeProviderCompletions(state),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const force = /(?:^|\s)--force$/.test(trimmed) || /(?:^|\s)force$/.test(trimmed);
			const withoutForce = trimmed.replace(/(?:^|\s)(?:--force|force)$/, "").trim();
			const parsed = parseSingleRequiredArg(withoutForce, "Usage: /subagents-refresh-provider-models <provider> [--force]");
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Refreshing provider models for ${parsed.value}…`, async () => {
					const result = await refreshProviderModelCatalog(pi, ctx, parsed.value, { force, maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS });
					const lines = [
						"Provider model catalog",
						`Provider: ${parsed.value}`,
						`Status: ${result.reused ? "fresh cache reused" : "refreshed"}`,
						`File: ${result.filePath}`,
						`Models: ${result.catalog.models.length}`,
						`Refreshed at: ${result.catalog.refreshedAt}`,
					];
					if (result.heuristicFallbackCount > 0) {
						lines.push(`Warning: ${result.heuristicFallbackCount} model${result.heuristicFallbackCount === 1 ? " was" : "s were"} classified with name heuristics fallback.`);
					}
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-generate-profiles", {
		description: "Generate <provider>.quota and <provider>.quality subagent profiles",
		getArgumentCompletions: makeProviderCompletions(state),
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-generate-profiles <provider>");
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Generating profiles for ${parsed.value}…`, async () => {
					const result = await generateProfilesForProvider(pi, ctx, parsed.value, { maxAgeDays: DEFAULT_PROVIDER_MODELS_MAX_AGE_DAYS });
					const lines = [
						"Generated subagent profiles",
						`Provider: ${parsed.value}`,
						`Catalog: ${result.catalogPath}`,
						`Quota: ${result.quotaPath}`,
						`  cheap=${result.quotaModels.cheap}`,
						`  medium=${result.quotaModels.medium}`,
						`  strong=${result.quotaModels.strong}`,
						`Quality: ${result.qualityPath}`,
						`  cheap=${result.qualityModels.cheap}`,
						`  medium=${result.qualityModels.medium}`,
						`  strong=${result.qualityModels.strong}`,
					];
					if (result.selectedHeuristicFallbackCount > 0) {
						lines.push(`Warning: generated profiles depend on heuristic-only classification for ${result.selectedHeuristicFallbackCount} selected model${result.selectedHeuristicFallbackCount === 1 ? "" : "s"}.`);
					} else if (result.heuristicFallbackCount > 0) {
						lines.push(`Warning: provider catalog still contains ${result.heuristicFallbackCount} heuristic-classified model${result.heuristicFallbackCount === 1 ? "" : "s"}.`);
					}
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagents-check-profile", {
		description: "Check whether a saved profile still points to usable models",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return listSubagentProfiles()
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const parsed = parseSingleRequiredArg(args, "Usage: /subagents-check-profile <name>");
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, `Checking profile ${parsed.value}…`, async () => {
					const result = await checkSubagentProfile(pi, ctx, parsed.value);
					const lines = [
						"Subagent profile check",
						`Profile: ${result.profileName}`,
						`File: ${result.filePath}`,
						"",
						...result.results.map((entry) => `${entry.agent} → ${entry.model} — registry ${entry.inRegistry ? "ok" : "missing"}; probe ${entry.probe.status}${entry.probe.message ? ` (${entry.probe.message.split(/\r?\n/, 1)[0]})` : ""}`),
					];
					sendSlashText(pi, lines.join("\n"));
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			// A reload revokes the command context; do not let delayed responses
			// resume a command against the old Pi context.
			for (const controller of pendingRequests) controller.abort();
			pendingRequests.clear();
		},
	};
}
