import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { BUILTIN_AGENT_NAMES, discoverAgents, discoverAgentsAll, type ChainConfig } from "../agents/agents.ts";
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
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../shared/settings.ts";
import { findModelInfo, toModelInfo } from "../shared/model-info.ts";
import { formatTokens, shortenPath } from "../shared/formatters.ts";
import { listAsyncRuns, formatAsyncRunProgressLabel, type AsyncRunSummary } from "../runs/background/async-status.ts";
import { scheduledRunStorePath } from "../runs/background/scheduled-runs.ts";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { assertJsonSchemaObject } from "../runs/shared/structured-output.ts";
import { validateAcceptanceInput } from "../runs/shared/acceptance.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import { registerPromptWorkflowCommands } from "./prompt-workflows.ts";
import { openSubagentsAdmin } from "./subagents-admin.ts";
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
	ASYNC_DIR,
	type Details,
	type JsonSchemaObject,
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
	progress?: boolean;
	as?: string;
	label?: string;
	phase?: string;
	cwd?: string;
	count?: number;
	outputSchema?: string;
	acceptance?: string;
}

const parseInlineConfig = (raw: string): InlineConfig => {
	const config: InlineConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) {
			if (trimmed === "progress") config.progress = true;
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		switch (key) {
			case "output": config.output = val === "false" ? false : val; break;
			case "outputMode": if (val === "inline" || val === "file-only") config.outputMode = val; break;
			case "reads": config.reads = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "model": config.model = val || undefined; break;
			case "skill": case "skills": config.skill = val === "false" ? false : val.split("+").filter(Boolean); break;
			case "progress": config.progress = val !== "false"; break;
			case "as": config.as = val || undefined; break;
			case "label": config.label = val || undefined; break;
			case "phase": config.phase = val || undefined; break;
			case "cwd": config.cwd = val || undefined; break;
			case "count": { const n = Number(val); if (Number.isInteger(n) && n > 0) config.count = n; break; }
			case "outputSchema": config.outputSchema = val || undefined; break;
			case "acceptance": config.acceptance = val || undefined; break;
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

const makeAgentCompletions = (state: SubagentState, multiAgent: boolean) => (prefix: string) => {
	if (!state.baseCwd) return null;
	const agents = discoverAgents(state.baseCwd, "both").agents;
	if (!multiAgent) {
		if (prefix.includes(" ")) return null;
		return agents.filter((a) => a.name.startsWith(prefix)).map((a) => ({ value: a.name, label: a.name }));
	}

	// Find the start of the current chain step: after the last top-level `->` arrow or `(`,
	// or after a `|` *inside* a group. A `|` at depth 0 is plain task text (only `(` opens a
	// group), so it must not restart agent completion — otherwise `scout -- do x | wr` would
	// wrongly resume suggesting agents past the `--` task. Quotes are tracked so separators
	// inside a task are ignored.
	let inSingle = false, inDouble = false, depth = 0, segStart = 0;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") {
			if (!prefix.slice(segStart, i).includes(" -- ")) {
				depth++;
				segStart = i + 1;
			}
		}
		else if (ch === ")") {
			if (depth > 0) {
				depth--;
				segStart = i + 1;
			}
		}
		else if (ch === "|" && depth > 0) segStart = i + 1;
		else if (ch === ">" && prefix[i - 1] === "-" && depth === 0) segStart = i + 1;
	}
	// Inside an open quote, or once the task has started (`--` / a quote), we are no
	// longer typing an agent name.
	if (inSingle || inDouble) return null;
	const segment = prefix.slice(segStart);
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (segment.match(/(\S*)$/) || ["", ""])[1];
	let beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);
	// A bare `->` or `|` just typed (no trailing space) needs a separating space;
	// `(` glues naturally to the agent name.
	if (lastWord === "" && /[>|]$/.test(beforeLastWord)) beforeLastWord = `${beforeLastWord} `;

	return agents.filter((a) => a.name.startsWith(lastWord)).map((a) => ({ value: `${beforeLastWord}${a.name}`, label: a.name }));
};

const discoverSavedChains = (cwd: string): ChainConfig[] => {
	const chainsByName = new Map<string, ChainConfig>();
	for (const chain of discoverAgentsAll(cwd).chains) {
		chainsByName.set(chain.name, chain);
	}
	return Array.from(chainsByName.values());
};

const makeChainCompletions = (state: SubagentState) => (prefix: string) => {
	if (prefix.includes(" ") || !state.baseCwd) return null;
	return discoverSavedChains(state.baseCwd)
		.filter((chain) => chain.name.startsWith(prefix))
		.map((chain) => ({ value: chain.name, label: chain.name }));
};

const makeBuiltinAgentNameCompletions = () => (prefix: string) => {
	if (prefix.includes(" ")) return null;
	return BUILTIN_AGENT_NAMES
		.filter((name) => name.startsWith(prefix))
		.map((name) => ({ value: name, label: name }));
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
		? `subagent({ action: "schedule-cancel", id: ${JSON.stringify(target.id)} })`
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

function scheduledStopTargets(ctx: ExtensionContext, state: SubagentState): StopSelectorTarget[] {
	const sessionId = state.currentSessionId ?? ctx.sessionManager.getSessionId();
	if (!sessionId) return [];
	const storePath = scheduledRunStorePath(ctx.cwd, sessionId);
	if (!fs.existsSync(storePath)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(storePath, "utf-8"));
	} catch {
		return [];
	}
	const jobs = parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
		? (parsed as { jobs: Array<Record<string, unknown>> }).jobs
		: [];
	return jobs
		.filter((job) => job.state === "scheduled" && typeof job.id === "string" && typeof job.name === "string" && typeof job.runAt === "number")
		.sort((left, right) => Number(left.runAt) - Number(right.runAt))
		.map((job) => ({
			kind: "scheduled" as const,
			id: String(job.id),
			label: `${String(job.id)} · ${String(job.name)}`,
			detail: `scheduled · ${new Date(Number(job.runAt)).toISOString()}`,
			actionLabel: "cancel scheduled run",
		}));
}

function discoverStopTargets(ctx: ExtensionContext, state: SubagentState): StopSelectorTarget[] {
	const sessionId = state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined;
	const asyncTargets = listAsyncRuns(ASYNC_DIR, {
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
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(this.targets.length - 1, this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return")) {
			this.confirming = true;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const contentWidth = Math.max(40, Math.min(this.width, width || this.width));
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
			lines.push(this.theme.fg("dim", "↑/↓ select · Enter confirm · Esc cancel"));
		}
		return lines;
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

function assistantUsageFromMessage(message: unknown): Usage | undefined {
	if (!message || typeof message !== "object") return undefined;
	const msg = message as { role?: unknown; usage?: unknown };
	if (msg.role !== "assistant" || !msg.usage || typeof msg.usage !== "object") return undefined;
	const usage = msg.usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	return {
		input: typeof usage.input === "number" ? usage.input : 0,
		output: typeof usage.output === "number" ? usage.output : 0,
		cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
		cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
		cost: typeof usage.cost?.total === "number" ? usage.cost.total : 0,
		turns: 1,
	};
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
	if (message.role !== "toolResult" || message.toolName !== "subagent") return undefined;
	return isSubagentDetails(message.details) ? message.details : undefined;
}

function formatCostUsage(label: string, usage: Usage): string {
	const extras = [
		usage.cacheRead ? `cache read ${formatTokens(usage.cacheRead)}` : "",
		usage.cacheWrite ? `cache write ${formatTokens(usage.cacheWrite)}` : "",
		usage.turns ? `${usage.turns} turn${usage.turns === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return `${label}: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} $${usage.cost.toFixed(4)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function buildSubagentCostReport(ctx: ExtensionContext): string {
	const parent = emptyUsage();
	const childTotal = emptyUsage();
	const total = emptyUsage();
	const children: Array<{ label: string; usage: Usage; sessionFile?: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const message = entry.type === "message" ? (entry as { message?: unknown }).message : undefined;
		const parentUsage = assistantUsageFromMessage(message);
		if (parentUsage) addUsage(parent, parentUsage);
		const details = detailsFromSessionEntry(entry);
		if (!details) continue;
		for (const result of details.results) {
			if (!usageHasValue(result.usage)) continue;
			const usage = { ...result.usage };
			children.push({
				label: `Child ${children.length + 1} (${result.agent})`,
				usage,
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			});
			addUsage(childTotal, usage);
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

function loadSavedOutputSchema(chain: ChainConfig, stepAgent: string, outputSchema: unknown): JsonSchemaObject | undefined {
	if (outputSchema === undefined) return undefined;
	if (typeof outputSchema === "string") {
		const schemaPath = path.isAbsolute(outputSchema)
			? outputSchema
			: path.join(path.dirname(chain.filePath), outputSchema);
		const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as unknown;
		assertJsonSchemaObject(parsed, `outputSchema for chain '${chain.name}' step '${stepAgent}' (${schemaPath})`);
		return parsed;
	}
	assertJsonSchemaObject(outputSchema, `outputSchema for chain '${chain.name}' step '${stepAgent}'`);
	return outputSchema;
}

const mapSavedChainSteps = (chain: ChainConfig, worktree = false): ChainStep[] => {
	return (chain.steps as unknown as Array<ChainStep & { skills?: string[] | false }>).map((step) => {
		if (isParallelStep(step)) {
			const parallel = step.parallel.map((task) => {
				const { outputSchema: rawOutputSchema, ...rest } = task as typeof task & { outputSchema?: unknown };
				const outputSchema = loadSavedOutputSchema(chain, task.agent, rawOutputSchema);
				return { ...rest, ...(outputSchema ? { outputSchema } : {}) };
			});
			return { ...step, parallel, ...(worktree ? { worktree: true } : {}) };
		}
		if (isDynamicParallelStep(step)) {
			const { outputSchema: rawOutputSchema, ...parallelRest } = step.parallel as typeof step.parallel & { outputSchema?: unknown };
			const outputSchema = loadSavedOutputSchema(chain, step.parallel.agent, rawOutputSchema);
			const collectSchema = loadSavedOutputSchema(chain, `${step.collect.as} collection`, step.collect.outputSchema);
			return {
				...step,
				parallel: { ...parallelRest, ...(outputSchema ? { outputSchema } : {}) },
				collect: { ...step.collect, ...(collectSchema ? { outputSchema: collectSchema } : {}) },
			};
		}
		const outputSchema = loadSavedOutputSchema(chain, step.agent, (step as { outputSchema?: unknown }).outputSchema);
		return {
			agent: step.agent,
			task: step.task || undefined,
			...(step.phase ? { phase: step.phase } : {}),
			...(step.label ? { label: step.label } : {}),
			...(step.as ? { as: step.as } : {}),
			...(outputSchema ? { outputSchema } : {}),
			...((step as { acceptance?: unknown }).acceptance !== undefined ? { acceptance: (step as { acceptance?: unknown }).acceptance } : {}),
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skill: step.skill ?? step.skills,
			model: step.model,
		};
	});
};

async function requestSlashRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	requestId: string,
	params: SubagentParamsLike,
): Promise<SlashSubagentResponse> {
	return new Promise((resolve, reject) => {
		let done = false;
		let started = false;

		const startTimeoutMs = 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(
				"Slash subagent bridge did not start within 15s. Ensure the extension is loaded correctly.",
			)));
		}, startTimeoutMs);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			if ((data as { requestId?: unknown }).requestId !== requestId) return;
			started = true;
			clearTimeout(startTimeout);
			if (ctx.hasUI) ctx.ui.setStatus("subagent-slash", "running...");
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const response = data as Partial<SlashSubagentResponse>;
			if (response.requestId !== requestId) return;
			clearTimeout(startTimeout);
			finish(() => resolve(response as SlashSubagentResponse));
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as SlashSubagentUpdate;
			if (update.requestId !== requestId) return;
			applySlashUpdate(requestId, update);
			if (!ctx.hasUI) return;
			const tool = update.currentTool ? ` ${update.currentTool}` : "";
			const count = update.toolCount ?? 0;
			const liveDetailKey = keyText("app.tools.expand");
			ctx.ui.setStatus("subagent-slash", `${count} tools${tool} | ${liveDetailKey} live detail`);
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

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubStarted();
			unsubResponse();
			unsubUpdate();
			onTerminalInput?.();
			next();
		};

		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params, ctx });

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
): Promise<void> {
	if (ctx.hasUI) ctx.ui.setToolsExpanded(false);
	const requestId = randomUUID();
	const initialDetails = buildSlashInitialResult(requestId, params);
	const initialText = extractSlashMessageText(initialDetails.result.content) || "Running subagent...";
	pi.sendMessage({
		customType: SLASH_RESULT_TYPE,
		content: initialText,
		display: true,
		details: initialDetails,
	});
	persistSlashSessionSnapshot(ctx);

	try {
		const response = await requestSlashRun(pi, ctx, requestId, params);
		const finalDetails = finalizeSlashResult(response);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: buildSlashExportText(response),
			display: !ctx.hasUI,
			details: finalDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (response.isError && ctx.hasUI) {
			ctx.ui.notify(response.errorText || "Subagent failed", "error");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failedDetails = failSlashResult(requestId, params, message);
		pi.sendMessage({
			customType: SLASH_RESULT_TYPE,
			content: `## Subagent result\n\n${message}`,
			display: !ctx.hasUI,
			details: failedDetails,
		});
		persistSlashSessionSnapshot(ctx);
		if (ctx.hasUI) {
			ctx.ui.setStatus("subagent-slash", undefined);
		}
		if (message === "Cancelled") {
			if (ctx.hasUI) ctx.ui.notify("Cancelled", "warning");
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(message, "error");
	}
}


export interface GroupConfig { concurrency?: number; failFast?: boolean; worktree?: boolean }
export interface ParsedStep { kind: "step"; name: string; config: InlineConfig; task?: string }
export interface ParsedGroup { kind: "group"; tasks: ParsedStep[]; config: GroupConfig }
export type ParsedGroupStep = ParsedStep | ParsedGroup;

export const PARALLEL_GROUP_USAGE =
	'Usage: /chain agent "task" -> (agent2 "task" | agent3 "task") -> agent4';

export class SlashParseError extends Error {}

// Walk `input` tracking quote/paren state; returns true if parens are unbalanced.
function findUnmatchedCloseParen(input: string): boolean {
	let depth = 0, inSingle = false, inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") { depth--; if (depth < 0) return true; }
	}
	return depth !== 0;
}

// Split on top-level " -> ", ignoring arrows inside quotes or parentheses.
function splitOnArrow(input: string): string[] {
	const segments: string[] = [];
	let depth = 0, inSingle = false, inDouble = false, start = 0;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (depth === 0 && ch === "-" && input[i + 1] === ">" && input[i + 2] === " ") {
			segments.push(input.slice(start, i));
			i += 2;
			start = i + 1;
		}
	}
	segments.push(input.slice(start));
	return segments;
}

// Split a group's inner text on top-level " | ", ignoring pipes inside quotes/parens.
function splitGroupTasks(inner: string): string[] {
	const parts: string[] = [];
	let depth = 0, inSingle = false, inDouble = false, start = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) {
			parts.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(inner.slice(start));
	return parts;
}

export function parseSingleTaskToken(token: string): ParsedStep {
	let agentPart: string;
	let task: string | undefined;
	const qMatch = token.match(/^(\S+(?:\[[^\]]*\])?)\s+(?:"([^"]*)"|'([^']*)')$/);
	if (qMatch) {
		agentPart = qMatch[1]!;
		task = (qMatch[2] ?? qMatch[3]) || undefined;
	} else {
		const dashIdx = token.indexOf(" -- ");
		if (dashIdx !== -1) {
			agentPart = token.slice(0, dashIdx).trim();
			task = token.slice(dashIdx + 4).trim() || undefined;
		} else {
			agentPart = token;
		}
	}
	return { kind: "step", ...parseAgentToken(agentPart), task };
}

const parseGroupConfig = (raw: string): GroupConfig => {
	const config: GroupConfig = {};
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		const key = eq === -1 ? trimmed : trimmed.slice(0, eq).trim();
		const val = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
		switch (key) {
			case "concurrency": { const n = Number(val); if (Number.isInteger(n) && n > 0) config.concurrency = n; break; }
			case "failFast": config.failFast = eq === -1 ? true : val !== "false"; break;
			case "worktree": config.worktree = eq === -1 ? true : val !== "false"; break;
		}
	}
	return config;
};

// Split `(...)` from an optional trailing `[...]` group-config suffix, respecting
// quotes and nested parens. Returns the inner group text and the parsed config.
const splitGroupBody = (trimmed: string): { inner: string; config: GroupConfig } => {
	let depth = 0, inSingle = false, inDouble = false, closeIdx = -1;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") { depth--; if (depth === 0) { closeIdx = i; break; } }
	}
	if (closeIdx === -1) throw new SlashParseError(`Unmatched parentheses in group: '${trimmed}'`);
	const inner = trimmed.slice(1, closeIdx);
	const suffix = trimmed.slice(closeIdx + 1).trim();
	if (!suffix) return { inner, config: {} };
	if (!suffix.startsWith("[") || !suffix.endsWith("]")) {
		throw new SlashParseError(`Group options must be wrapped in [...]: '${suffix}'`);
	}
	return { inner, config: parseGroupConfig(suffix.slice(1, -1)) };
};

export function parseGroupSegment(segment: string): ParsedGroup {
	const trimmed = segment.trim();
	if (!trimmed.startsWith("(")) {
		throw new SlashParseError(`Parallel group must be wrapped in parentheses: '${trimmed}'`);
	}
	const { inner, config } = splitGroupBody(trimmed);
	const rawParts = splitGroupTasks(inner).map((p) => p.trim()).filter((p) => p.length > 0);
	if (rawParts.length < 2) {
		throw new SlashParseError("Parallel group must contain at least two tasks separated by ' | '");
	}
	return { kind: "group", tasks: rawParts.map((part) => parseSingleTaskToken(part)), config };
}

// True if `input` uses inline parallel-group syntax. A group is a *step* that begins
// with `(` at the top level, so we split on top-level ` -> ` arrows and look for a
// segment that opens with `(`. Parentheses appearing inside a task (e.g.
// `scout -- inspect auth (backend)`) do not count, which keeps legacy shared-task
// `-- task` parsing — including a bare `|` inside the task — on the single-agent path.
export function hasGroupSyntax(input: string): boolean {
	return splitOnArrow(input).some((seg) => seg.trim().startsWith("("));
}

export function parseChainExpression(input: string): { steps: ParsedGroupStep[] } {
	const trimmed = input.trim();
	if (!trimmed.includes(" -> ")) {
		throw new SlashParseError('Parallel groups in /chain require " -> " between steps');
	}
	if (findUnmatchedCloseParen(trimmed)) {
		throw new SlashParseError("Unmatched parentheses in /chain expression");
	}
	const steps: ParsedGroupStep[] = [];
	for (const seg of splitOnArrow(trimmed)) {
		const t = seg.trim();
		if (!t) continue;
		if (t.startsWith("(")) {
			steps.push(parseGroupSegment(t));
			continue;
		}
		if (findUnmatchedCloseParen(t)) {
			throw new SlashParseError(`Unmatched parentheses in chain segment: '${t}'`);
		}
		steps.push(parseSingleTaskToken(t));
	}
	if (steps.length === 0) {
		throw new SlashParseError("/chain expression must include at least one step");
	}
	return { steps };
}

const parseAgentArgs = (
	state: SubagentState,
	args: string,
	command: string,
	ctx: ExtensionContext,
): { steps: ParsedStep[]; task: string } | null => {
	const input = args.trim();
	const usage = `Usage: /${command} agent1 "task1" -> agent2 "task2"`;
	let steps: ParsedStep[];
	let sharedTask: string;
	let perStep = false;

	if (input.includes(" -> ")) {
		perStep = true;
		const segments = input.split(" -> ");
		steps = [];
		for (const seg of segments) {
			const trimmed = seg.trim();
			if (!trimmed) continue;
			steps.push(parseSingleTaskToken(trimmed));
		}
		sharedTask = steps.find((s) => s.task)?.task ?? "";
	} else {
		const delimiterIndex = input.indexOf(" -- ");
		if (delimiterIndex === -1) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		const agentsPart = input.slice(0, delimiterIndex).trim();
		sharedTask = input.slice(delimiterIndex + 4).trim();
		if (!agentsPart || !sharedTask) {
			ctx.ui.notify(usage, "error");
			return null;
		}
		steps = agentsPart.split(/\s+/).filter(Boolean).map((t) => parseSingleTaskToken(t));
	}

	if (steps.length === 0) {
		ctx.ui.notify(usage, "error");
		return null;
	}
	if (!state.baseCwd) {
		ctx.ui.notify("Subagent session cwd is not initialized yet", "error");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	for (const step of steps) {
		if (!agents.find((a) => a.name === step.name)) {
			ctx.ui.notify(`Unknown agent: ${step.name}`, "error");
			return null;
		}
	}
	if (command === "chain" && !steps[0]?.task && (perStep || !sharedTask)) {
		ctx.ui.notify(`First step must have a task: /chain agent "task" -> agent2`, "error");
		return null;
	}
	if (command === "parallel" && !steps.some((s) => s.task) && !sharedTask) {
		ctx.ui.notify("At least one step must have a task", "error");
		return null;
	}
	return { steps, task: sharedTask };
};

type ChainStepObject = {
	agent: string;
	task?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
	as?: string;
	label?: string;
	phase?: string;
	cwd?: string;
	count?: number;
	outputSchema?: JsonSchemaObject;
	acceptance?: string;
};

const INLINE_ACCEPTANCE_LEVELS = new Set(["auto", "attested", "checked"]);

function validateInlineAcceptanceInput(value: string, agent: string): void {
	const errors = validateAcceptanceInput(value, `acceptance for step '${agent}'`);
	if (errors.length > 0) throw new SlashParseError(errors[0]!);
	if (!INLINE_ACCEPTANCE_LEVELS.has(value)) {
		throw new SlashParseError(`Inline acceptance for step '${agent}' supports auto, attested, or checked. Use the subagent tool API or a saved .chain.json file for none or verified acceptance contracts; reviewed is inferred-only.`);
	}
}

// Load an inline `outputSchema=<path>` JSON file, resolved against the session cwd.
// Throws (SlashParseError / fs / JSON) on a missing or malformed schema.
function loadInlineOutputSchema(baseCwd: string, agent: string, value: string): JsonSchemaObject {
	const schemaPath = path.isAbsolute(value) ? value : path.join(baseCwd, value);
	const label = `outputSchema for step '${agent}' (${schemaPath})`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
	} catch (error) {
		throw new SlashParseError(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertJsonSchemaObject(parsed, label);
	return parsed;
}

// Build a ChainStep object from a parsed token. `inGroup` enables `count` (parallel-only).
// May throw SlashParseError for an invalid acceptance level or outputSchema path.
const mapParsedTaskToStepObject = (
	step: ParsedStep,
	fallbackTask: string | undefined,
	isFirst: boolean,
	opts: { baseCwd: string; inGroup: boolean },
): ChainStepObject => {
	const { name, config, task: stepTask } = step;
	if (config.acceptance !== undefined) validateInlineAcceptanceInput(config.acceptance, name);
	return {
		agent: name,
		...(stepTask ? { task: stepTask } : isFirst && fallbackTask ? { task: fallbackTask } : {}),
		...(config.output !== undefined ? { output: config.output } : {}),
		...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
		...(config.reads !== undefined ? { reads: config.reads } : {}),
		...(config.model ? { model: config.model } : {}),
		...(config.skill !== undefined ? { skill: config.skill } : {}),
		...(config.progress !== undefined ? { progress: config.progress } : {}),
		...(config.as ? { as: config.as } : {}),
		...(config.label ? { label: config.label } : {}),
		...(config.phase ? { phase: config.phase } : {}),
		...(config.cwd ? { cwd: config.cwd } : {}),
		...(opts.inGroup && config.count !== undefined ? { count: config.count } : {}),
		...(config.outputSchema ? { outputSchema: loadInlineOutputSchema(opts.baseCwd, name, config.outputSchema) } : {}),
		...(config.acceptance ? { acceptance: config.acceptance } : {}),
	};
};

export function buildChainExpressionSteps(
	state: SubagentState,
	input: string,
	ctx: ExtensionContext,
): { chain: ChainStep[]; task: string } | null {
	const notify = (message: string) => ctx.ui.notify(message, "error");
	if (!hasGroupSyntax(input)) {
		const parsed = parseAgentArgs(state, input, "chain", ctx);
		if (!parsed) return null;
		const baseCwd = state.baseCwd!; // parseAgentArgs already verified baseCwd is set
		try {
			const chain: ChainStep[] = parsed.steps.map((step, i) =>
				mapParsedTaskToStepObject(step, parsed.task || undefined, i === 0, { baseCwd, inGroup: false }),
			);
			return { chain, task: parsed.task };
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error));
			return null;
		}
	}

	let expression: { steps: ParsedGroupStep[] };
	try {
		expression = parseChainExpression(input);
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error));
		return null;
	}
	if (!state.baseCwd) {
		notify("Subagent session cwd is not initialized yet");
		return null;
	}
	const agents = discoverAgents(state.baseCwd, "both").agents;
	const stepAgentNames = expression.steps.flatMap((step) =>
		step.kind === "group" ? step.tasks.map((t) => t.name) : [step.name],
	);
	for (const name of stepAgentNames) {
		if (!agents.find((a) => a.name === name)) {
			notify(`Unknown agent: ${name}`);
			return null;
		}
	}
	// Every task inside a parallel group needs its own task; there is no shared-task fallback.
	for (const step of expression.steps) {
		if (step.kind === "group" && step.tasks.some((t) => !t.task)) {
			notify('Each task in a parallel group needs a task: (agent "a" | agent "b")');
			return null;
		}
	}
	const firstStep = expression.steps[0]!;
	const firstHasTask =
		firstStep.kind === "group"
			? firstStep.tasks.some((t) => Boolean(t.task))
			: Boolean(firstStep.task);
	if (!firstHasTask) {
		notify('First step must have a task: /chain agent "task" -> agent2');
		return null;
	}
	const sharedTask =
		firstStep.kind === "group"
			? (firstStep.tasks.find((t) => t.task)?.task ?? "")
			: (firstStep.task ?? "");
	const baseCwd = state.baseCwd;
	let chain: ChainStep[];
	try {
		chain = expression.steps.map((step) => {
			if (step.kind === "group") {
				const parallel = step.tasks.map((t) => mapParsedTaskToStepObject(t, undefined, false, { baseCwd, inGroup: true }));
				return {
					parallel,
					...(step.config.concurrency !== undefined ? { concurrency: step.config.concurrency } : {}),
					...(step.config.failFast !== undefined ? { failFast: step.config.failFast } : {}),
					...(step.config.worktree !== undefined ? { worktree: step.config.worktree } : {}),
				};
			}
			return mapParsedTaskToStepObject(step, sharedTask || undefined, false, { baseCwd, inGroup: false });
		});
	} catch (error) {
		notify(error instanceof Error ? error.message : String(error));
		return null;
	}
	return { chain, task: sharedTask };
}

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
	let fleetOpen = false;
	const showFleet = async (ctx: ExtensionContext) => {
		state.lastUiContext = ctx;
		if (!ctx.hasUI) {
			await runSlashSubagent(pi, ctx, { action: "status", view: "fleet" });
			return;
		}
		if (fleetOpen) {
			ctx.ui.notify("Subagent fleet inspector is already open.", "info");
			return;
		}
		fleetOpen = true;
		try {
			await openSubagentFleet(ctx, state);
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
		description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, false),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const input = cleanedArgs.trim();
			const firstSpace = input.indexOf(" ");
			if (!input) { ctx.ui.notify("Usage: /run <agent> [task] [--bg] [--fork]", "error"); return; }
			const { name: agentName, config: inline } = parseAgentToken(firstSpace === -1 ? input : input.slice(0, firstSpace));
			const task = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();

			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const agents = discoverAgents(state.baseCwd, "both").agents;
			if (!agents.find((a) => a.name === agentName)) { ctx.ui.notify(`Unknown agent: ${agentName}`, "error"); return; }

			let finalTask = task;
			if (inline.reads && Array.isArray(inline.reads) && inline.reads.length > 0) {
				finalTask = `[Read from: ${inline.reads.join(", ")}]\n\n${finalTask}`;
			}
			const params: SubagentParamsLike = { agent: agentName, task: finalTask, clarify: false, agentScope: "both" };
			if (inline.output !== undefined) params.output = inline.output;
			if (inline.outputMode !== undefined) params.outputMode = inline.outputMode;
			if (inline.skill !== undefined) params.skill = inline.skill;
			if (inline.model) params.model = inline.model;
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("chain", {
		description: "Run agents in sequence: /chain scout \"task\" -> planner [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const built = buildChainExpressionSteps(state, cleanedArgs, ctx);
			if (!built) return;
			const params: SubagentParamsLike = { chain: built.chain, task: built.task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("run-chain", {
		description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]",
		getArgumentCompletions: makeChainCompletions(state),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const delimiterIndex = cleanedArgs.indexOf(" -- ");
			const usage = "Usage: /run-chain <chainName> -- <task> [--bg] [--fork]";
			if (delimiterIndex === -1) {
				ctx.ui.notify(usage, "error");
				return;
			}
			const chainName = cleanedArgs.slice(0, delimiterIndex).trim();
			const task = cleanedArgs.slice(delimiterIndex + 4).trim();
			if (!chainName || !task) {
				ctx.ui.notify(usage, "error");
				return;
			}
			if (!state.baseCwd) { ctx.ui.notify("Subagent session cwd is not initialized yet", "error"); return; }
			const chain = discoverSavedChains(state.baseCwd).find((candidate) => candidate.name === chainName);
			if (!chain) {
				ctx.ui.notify(`Unknown chain: ${chainName}`, "error");
				return;
			}
			const params: SubagentParamsLike = { chain: mapSavedChainSteps(chain), task, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("parallel", {
		description: "Run agents in parallel: /parallel scout \"task1\" -> reviewer \"task2\" [--bg] [--fork]",
		getArgumentCompletions: makeAgentCompletions(state, true),
		handler: async (args, ctx) => {
			const { args: cleanedArgs, bg, fork } = extractExecutionFlags(args);
			const parsed = parseAgentArgs(state, cleanedArgs, "parallel", ctx);
			if (!parsed) return;
			const tasks = parsed.steps.map(({ name, config, task: stepTask }) => ({
				agent: name,
				task: stepTask ?? parsed.task,
				...(config.output !== undefined ? { output: config.output } : {}),
				...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
				...(config.reads !== undefined ? { reads: config.reads } : {}),
				...(config.model ? { model: config.model } : {}),
				...(config.skill !== undefined ? { skill: config.skill } : {}),
				...(config.progress !== undefined ? { progress: config.progress } : {}),
			}));
			const params: SubagentParamsLike = { tasks, clarify: false, agentScope: "both" };
			if (bg) params.async = true;
			if (fork) params.context = "fork";
			await runSlashSubagent(pi, ctx, params);
		},
	});

	pi.registerCommand("subagent-cost", {
		description: "Show parent and subagent child usage cost for this session",
		handler: async (_args, ctx) => {
			sendSlashText(pi, buildSubagentCostReport(ctx));
		},
	});

	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "doctor" });
		},
	});

	pi.registerCommand("subagents-fleet", {
		description: "Open the live, inspection-only subagent fleet",
		handler: async (_args, ctx) => showFleet(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("f"), {
		description: "Open subagent fleet inspector",
		handler: async (ctx) => showFleet(ctx),
	});

	pi.registerCommand("subagents-stop", {
		description: "Stop a current-session async subagent run",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id) {
				await runSlashSubagent(pi, ctx, { action: "stop", id });
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
				await runSlashSubagent(pi, ctx, { action: "schedule-cancel", id: result.target.id });
				return;
			}
			await runSlashSubagent(pi, ctx, { action: "stop", id: result.target.id });
		},
	});

	registerPromptWorkflowCommands({
		pi,
		run: (params, ctx) => runSlashSubagent(pi, ctx, params),
	});

	pi.registerCommand("subagents-models", {
		description: "Show runtime-loaded builtin subagent models",
		getArgumentCompletions: makeBuiltinAgentNameCompletions(),
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await runSlashSubagent(pi, ctx, { action: "models" });
				return;
			}
			const parts = trimmed.split(/\s+/).filter(Boolean);
			if (parts.length !== 1) {
				ctx.ui.notify("Usage: /subagents-models [builtin-agent-name]", "error");
				return;
			}
			const agent = parts[0]!;
			if (!(BUILTIN_AGENT_NAMES as readonly string[]).includes(agent)) {
				ctx.ui.notify(`Unknown builtin agent: ${agent}`, "error");
				return;
			}
			await runSlashSubagent(pi, ctx, { action: "models", agent });
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
			if (!parsed.ok) {
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
			if (!parsed.ok) {
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
			if (!parsed.ok) {
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
			if (!parsed.ok) {
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

}
