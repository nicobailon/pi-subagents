import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { discoverAgents, discoverAgentsAll, type ChainConfig } from "../agents/agents.ts";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { isDynamicParallelStep, isParallelStep, type ChainStep } from "../shared/settings.ts";
import { assertJsonSchemaObject } from "../runs/shared/structured-output.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import {
	applySlashUpdate,
	buildSlashInitialResult,
	failSlashResult,
	finalizeSlashResult,
} from "./slash-live-state.ts";
import {
	SLASH_RESULT_TYPE,
	SLASH_SUBAGENT_CANCEL_EVENT,
	SLASH_SUBAGENT_REQUEST_EVENT,
	SLASH_SUBAGENT_RESPONSE_EVENT,
	SLASH_SUBAGENT_STARTED_EVENT,
	SLASH_SUBAGENT_UPDATE_EVENT,
	type JsonSchemaObject,
	type SingleResult,
	type SubagentState,
} from "../shared/types.ts";

interface InlineConfig {
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	model?: string;
	skill?: string[] | false;
	progress?: boolean;
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

	const lastArrow = prefix.lastIndexOf(" -> ");
	const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;
	if (segment.includes(" -- ") || segment.includes('"') || segment.includes("'")) return null;

	const lastWord = (prefix.match(/(\S*)$/) || ["", ""])[1];
	const beforeLastWord = prefix.slice(0, prefix.length - lastWord.length);

	if (lastWord === "->") {
		return agents.map((a) => ({ value: `${prefix} ${a.name}`, label: a.name }));
	}

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
			ctx.ui.setStatus("subagent-slash", `${count} tools${tool} | Ctrl+O live detail`);
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

		pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });

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
			display: true,
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
			display: true,
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


export interface ParsedStep { kind: "step"; name: string; config: InlineConfig; task?: string }
export interface ParsedGroup { kind: "group"; tasks: ParsedStep[] }
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

export function parseGroupSegment(segment: string): ParsedGroup {
	const trimmed = segment.trim();
	if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
		throw new SlashParseError(`Parallel group must be wrapped in parentheses: '${trimmed}'`);
	}
	const inner = trimmed.slice(1, -1);
	if (findUnmatchedCloseParen(inner)) {
		throw new SlashParseError(`Unmatched parentheses in group: '${trimmed}'`);
	}
	const rawParts = splitGroupTasks(inner).map((p) => p.trim()).filter((p) => p.length > 0);
	if (rawParts.length < 2) {
		throw new SlashParseError("Parallel group must contain at least two tasks separated by ' | '");
	}
	return { kind: "group", tasks: rawParts.map((part) => parseSingleTaskToken(part)) };
}

// True if `input` uses inline parallel-group syntax outside quotes. Only parentheses
// mark a group — a bare `|` is meaningful only inside `( ... )`, so leaving it out keeps
// legacy `-- task | with pipe` working as a plain single-agent chain.
export function hasGroupSyntax(input: string): boolean {
	let inSingle = false, inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (inSingle) { if (ch === "'") inSingle = false; continue; }
		if (inDouble) { if (ch === '"') inDouble = false; continue; }
		if (ch === "'") { inSingle = true; continue; }
		if (ch === '"') { inDouble = true; continue; }
		if (ch === "(" || ch === ")") return true;
	}
	return false;
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
		if (t.includes("(") || t.includes(")")) {
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
};

const mapParsedTaskToStepObject = (
	step: ParsedStep,
	fallbackTask: string | undefined,
	isFirst: boolean,
): ChainStepObject => {
	const { name, config, task: stepTask } = step;
	return {
		agent: name,
		...(stepTask ? { task: stepTask } : isFirst && fallbackTask ? { task: fallbackTask } : {}),
		...(config.output !== undefined ? { output: config.output } : {}),
		...(config.outputMode !== undefined ? { outputMode: config.outputMode } : {}),
		...(config.reads !== undefined ? { reads: config.reads } : {}),
		...(config.model ? { model: config.model } : {}),
		...(config.skill !== undefined ? { skill: config.skill } : {}),
		...(config.progress !== undefined ? { progress: config.progress } : {}),
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
		const chain: ChainStep[] = parsed.steps.map((step, i) =>
			mapParsedTaskToStepObject(step, parsed.task || undefined, i === 0),
		);
		return { chain, task: parsed.task };
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
	const chain: ChainStep[] = expression.steps.map((step) => {
		if (step.kind === "group") {
			return { parallel: step.tasks.map((t) => mapParsedTaskToStepObject(t, undefined, false)) };
		}
		return mapParsedTaskToStepObject(step, sharedTask || undefined, false);
	});
	return { chain, task: sharedTask };
}

export function registerSlashCommands(
	pi: ExtensionAPI,
	state: SubagentState,
): void {
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


	pi.registerCommand("subagents-doctor", {
		description: "Show subagent diagnostics",
		handler: async (_args, ctx) => {
			await runSlashSubagent(pi, ctx, { action: "doctor" });
		},
	});

}
