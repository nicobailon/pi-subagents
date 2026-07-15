import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatDuration, formatModelThinking, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	type ActivityState,
	type AsyncJobStep,
	type AsyncStatus,
	type Details,
	type NestedRunSummary,
	type SubagentRunMode,
	type SubagentState,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatAsyncRunOutputPath, formatAsyncRunProgressLabel, listAsyncRuns, type AsyncRunSummary } from "./async-status.ts";

const DEFAULT_TRANSCRIPT_LINES = 80;
const MAX_TRANSCRIPT_LINES = 500;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
type ForegroundRun = NonNullable<SubagentState["foregroundRuns"]> extends Map<string, infer T> ? T : never;

interface FleetViewParams {
	lines?: number;
}

interface FleetViewDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	state?: SubagentState;
	childSafe?: boolean;
}

interface TranscriptOptions {
	index?: number;
	lines?: number;
	sessionRoots?: string[];
}

interface TextTailResult {
	path: string;
	lines: string[];
	truncated: boolean;
	error?: string;
}

function transcriptLineLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TRANSCRIPT_LINES;
	if (!Number.isFinite(value)) return DEFAULT_TRANSCRIPT_LINES;
	return Math.max(1, Math.min(MAX_TRANSCRIPT_LINES, Math.trunc(value)));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function resolveMaybeRelative(asyncDir: string, filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	return path.resolve(asyncDir, filePath);
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readTextTail(filePath: string, maxLines: number): TextTailResult {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (error) {
		if (isNotFoundError(error)) return { path: filePath, lines: [], truncated: false };
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (stat.size === 0) return { path: filePath, lines: [], truncated: false };

	let fd: number | undefined;
	try {
		const bytesToRead = Math.min(stat.size, TRANSCRIPT_TAIL_BYTES);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.alloc(bytesToRead);
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
		const content = buffer.subarray(0, bytesRead).toString("utf-8");
		let lines = content.split(/\r?\n/);
		if (start > 0 && lines.length > 0) lines = lines.slice(1);
		if (lines.at(-1) === "") lines = lines.slice(0, -1);
		return { path: filePath, lines: lines.slice(-maxLines), truncated: start > 0 || lines.length > maxLines };
	} catch (error) {
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function readContainedTextTail(filePath: string, maxLines: number, trustedRoots: string[], label: string): TextTailResult {
	if (trustedRoots.length === 0) return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path without a trusted root: ${filePath}` };
	const resolvedPath = path.resolve(filePath);
	if (!trustedRoots.some((root) => pathWithin(root, resolvedPath))) {
		return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path outside trusted roots: ${filePath}` };
	}
	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(resolvedPath);
	} catch (error) {
		if (isNotFoundError(error)) return { path: filePath, lines: [], truncated: false };
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (lstat.isSymbolicLink()) return { path: filePath, lines: [], truncated: false, error: `Refusing to read symlink ${label} transcript path: ${filePath}` };
	if (!lstat.isFile()) return { path: filePath, lines: [], truncated: false, error: `Refusing to read non-file ${label} transcript path: ${filePath}` };
	let realPath: string;
	let realRoots: string[];
	try {
		realPath = fs.realpathSync(resolvedPath);
		realRoots = trustedRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
	} catch (error) {
		return { path: filePath, lines: [], truncated: false, error: getErrorMessage(error) };
	}
	if (!realRoots.some((root) => pathWithin(root, realPath))) {
		return { path: filePath, lines: [], truncated: false, error: `Refusing to read ${label} transcript path outside trusted roots: ${filePath}` };
	}
	return readTextTail(resolvedPath, maxLines);
}

function stringifyJsonPreview(value: unknown, maxLength = 240): string {
	let raw: string;
	if (typeof value === "string") raw = value;
	else raw = JSON.stringify(value);
	return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const entry = part as { type?: unknown; text?: unknown; name?: unknown; toolName?: unknown; args?: unknown; result?: unknown; content?: unknown };
		if (typeof entry.text === "string") return entry.text;
		if (entry.type === "toolCall" || entry.type === "tool_call") {
			const name = typeof entry.name === "string" ? entry.name : typeof entry.toolName === "string" ? entry.toolName : "tool";
			return `[tool: ${name}${entry.args === undefined ? "" : ` ${stringifyJsonPreview(entry.args)}`}]`;
		}
		if (entry.type === "toolResult" || entry.type === "tool_result") {
			return `[tool result${entry.result === undefined ? "" : `: ${stringifyJsonPreview(entry.result)}`}]`;
		}
		if (entry.content !== undefined) return stringifyJsonPreview(entry.content);
		return "";
	}).filter(Boolean).join("\n");
}

function sessionMessageLine(record: unknown): string | undefined {
	if (!record || typeof record !== "object") return undefined;
	const outer = record as { message?: unknown; role?: unknown; content?: unknown; type?: unknown };
	const message = outer.message && typeof outer.message === "object" ? outer.message as { role?: unknown; content?: unknown } : outer;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (!role) return undefined;
	const text = contentText(message.content).trim();
	if (!text) return undefined;
	return `${role}: ${text}`;
}

function readSessionTranscriptTail(sessionFile: string, maxLines: number, trustedRoots: string[]): { lines: string[]; warnings: string[] } {
	const tail = readContainedTextTail(sessionFile, Math.max(maxLines * 4, maxLines), trustedRoots, "session");
	const warnings: string[] = [];
	if (tail.error) warnings.push(`Session read failed for ${sessionFile}: ${tail.error}`);
	const lines: string[] = [];
	let malformed = 0;
	for (const line of tail.lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const messageLine = sessionMessageLine(parsed);
			if (messageLine) lines.push(messageLine);
		} catch {
			malformed++;
		}
	}
	if (malformed > 0) warnings.push(`Skipped ${malformed} malformed session tail line${malformed === 1 ? "" : "s"}.`);
	return { lines: lines.slice(-maxLines), warnings };
}

function formatActivityFacts(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	tokens?: { total: number };
}): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.tokens?.total) facts.push(`${formatTokens(input.tokens.total)} tok`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function foregroundModeName(control: ForegroundControl): string {
	if (control.mode === "single" && control.currentAgent) return control.currentAgent;
	return control.mode;
}

function formatForegroundFleetLines(controls: ForegroundControl[]): string[] {
	if (controls.length === 0) return [];
	const lines = ["Foreground runs:"];
	const ordered = [...controls].sort((left, right) => right.updatedAt - left.updatedAt);
	for (const control of ordered) {
		const activity = formatActivityFacts({
			activityState: control.currentActivityState,
			lastActivityAt: control.lastActivityAt,
			currentTool: control.currentTool,
			currentToolStartedAt: control.currentToolStartedAt,
			currentPath: control.currentPath,
			turnCount: control.turnCount,
			toolCount: control.toolCount,
			...(control.tokens !== undefined ? { tokens: { total: control.tokens } } : {}),
		});
		const current = control.currentAgent ? ` | ${control.currentAgent}${control.currentIndex !== undefined ? ` #${control.currentIndex}` : ""}` : "";
		lines.push(`- ${control.runId} | running | ${foregroundModeName(control)}${current}${activity ? ` | ${activity}` : ""}`);
		lines.push(`  status: subagent({ action: "status", id: "${control.runId}" })`);
		lines.push("  transcript: live in the expanded foreground result; persisted session transcript appears after completion when sessions are enabled.");
		lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "  ", commandHints: true, maxLines: 12 }));
	}
	return lines;
}

function formatDetachedForegroundFleetLines(runs: ForegroundRun[]): string[] {
	if (runs.length === 0) return [];
	const lines = ["Detached foreground runs:"];
	const ordered = [...runs].sort((left, right) => right.updatedAt - left.updatedAt);
	for (const run of ordered) {
		const detachedChildren = run.children.filter((child) => child.status === "detached");
		const childSummary = detachedChildren.map((child) => `${child.agent} #${child.index}`).join(", ");
		lines.push(`- ${run.runId} | detached | ${run.mode}${childSummary ? ` | ${childSummary}` : ""}`);
		lines.push(`  status: subagent({ action: "status", id: "${run.runId}" })`);
		lines.push(`  recovery: reply to the supervisor request first, then wait with subagent_wait({ id: "${run.runId}" }); do not resume or launch a replacement while any child remains detached.`);
	}
	return lines;
}

function formatAsyncFleetLines(runs: AsyncRunSummary[]): string[] {
	if (runs.length === 0) return [];
	const lines = ["Async runs:"];
	for (const run of runs) {
		const progress = formatAsyncRunProgressLabel(run);
		const activity = formatActivityFacts(run);
		const cwd = run.cwd ? shortenPath(run.cwd) : shortenPath(run.asyncDir);
		const pending = run.pendingAppends ? ` | ${run.pendingAppends} pending append${run.pendingAppends === 1 ? "" : "s"}` : "";
		lines.push(`- ${run.id} | ${run.state}${activity ? ` | ${activity}` : ""} | ${run.mode} | ${progress}${pending} | ${cwd}`);
		lines.push(`  status: subagent({ action: "status", id: "${run.id}" })`);
		lines.push(`  transcript: subagent({ action: "status", id: "${run.id}", view: "transcript" })`);
		for (const step of run.steps) {
			const display = step.label ? `${step.label} (${step.agent})` : step.agent;
			const phase = step.phase ? `[${step.phase}] ` : "";
			const stepActivity = formatActivityFacts(step);
			const modelThinking = formatModelThinking(step.model, step.thinking);
			const parts = [`${step.index}. ${phase}${display}`, step.status, stepActivity, modelThinking].filter(Boolean);
			lines.push(`  ${parts.join(" | ")}`);
			const output = path.join(run.asyncDir, `output-${step.index}.log`);
			if (fs.existsSync(output)) lines.push(`    output: ${shortenPath(output)}`);
			if (step.sessionFile) lines.push(`    session: ${shortenPath(step.sessionFile)}`);
			if (step.status === "running" || step.recentOutput?.length || fs.existsSync(output)) {
				lines.push(`    transcript: subagent({ action: "status", id: "${run.id}", index: ${step.index}, view: "transcript" })`);
			}
			lines.push(...formatNestedRunStatusLines(step.children, { indent: "    ", commandHints: true, maxLines: 12 }));
		}
		const attached = new Set(run.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
		const unattached = run.nestedChildren?.filter((child) => !attached.has(child.id)) ?? [];
		lines.push(...formatNestedRunStatusLines(unattached, { indent: "  ", commandHints: true, maxLines: 12 }));
		if (run.error) lines.push(`  error: ${run.error}`);
		for (const warning of run.nestedWarnings ?? []) lines.push(`  warning: ${warning}`);
		const outputPath = formatAsyncRunOutputPath(run);
		if (outputPath) lines.push(`  output: ${shortenPath(outputPath)}`);
		if (run.sessionFile) lines.push(`  session: ${shortenPath(run.sessionFile)}`);
	}
	return lines;
}

export function inspectSubagentFleet(_params: FleetViewParams, deps: FleetViewDeps = {}): AgentToolResult<Details> {
	if (deps.childSafe) {
		return {
			content: [{ type: "text", text: "Child-safe subagent fleet view is unavailable without an explicit run id. Use subagent({ action: \"status\", id: \"...\" }) for the delegated run you can see." }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}

	let asyncRuns: AsyncRunSummary[];
	try {
		asyncRuns = listAsyncRuns(deps.asyncDirRoot ?? ASYNC_DIR, {
			states: ["queued", "running"],
			sessionId: deps.state?.currentSessionId ?? undefined,
			resultsDir: deps.resultsDir ?? RESULTS_DIR,
			kill: deps.kill,
			now: deps.now,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
	}

	const foregroundControls = deps.state ? [...deps.state.foregroundControls.values()] : [];
	const activeForegroundIds = new Set(foregroundControls.map((control) => control.runId));
	const detachedForegroundRuns = deps.state?.foregroundRuns
		? [...deps.state.foregroundRuns.values()].filter((run) => run.sessionId === deps.state?.currentSessionId && !activeForegroundIds.has(run.runId) && run.children.some((child) => child.status === "detached"))
		: [];
	const total = foregroundControls.length + detachedForegroundRuns.length + asyncRuns.length;
	if (total === 0) {
		return {
			content: [{ type: "text", text: "No active subagent fleet. Background runs that already finished are available through completion notifications or subagent({ action: \"status\", id: \"...\" })." }],
			details: { mode: "management", results: [] },
		};
	}

	const lines = [`Subagent fleet: ${total} tracked`, ""];
	const foregroundLines = formatForegroundFleetLines(foregroundControls);
	if (foregroundLines.length) lines.push(...foregroundLines, "");
	const detachedForegroundLines = formatDetachedForegroundFleetLines(detachedForegroundRuns);
	if (detachedForegroundLines.length) lines.push(...detachedForegroundLines, "");
	const asyncLines = formatAsyncFleetLines(asyncRuns);
	if (asyncLines.length) lines.push(...asyncLines, "");
	lines.push("Commands:");
	lines.push("  Refresh fleet: subagent({ action: \"status\", view: \"fleet\" })");
	lines.push("  Tail run transcript: subagent({ action: \"status\", id: \"<run-id>\", view: \"transcript\" })");
	lines.push("  Tail child transcript: subagent({ action: \"status\", id: \"<run-id>\", index: 0, view: \"transcript\" })");

	return { content: [{ type: "text", text: lines.join("\n").trimEnd() }], details: { mode: "management", results: [] } };
}

function validateTranscriptIndex(index: number | undefined, steps: AsyncJobStep[]): number | undefined {
	if (index === undefined) return undefined;
	if (!Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index < 0 || index >= steps.length) throw new Error(`Transcript index ${index} is out of range for ${steps.length} child step${steps.length === 1 ? "" : "s"}.`);
	return index;
}

function selectTranscriptStep(status: AsyncStatus, options: TranscriptOptions): { index?: number; step?: AsyncJobStep; hint?: string } {
	const steps = status.steps ?? [];
	let selectedIndex = validateTranscriptIndex(options.index, steps);
	if (selectedIndex === undefined) {
		if (status.state === "running" && typeof status.currentStep === "number" && status.currentStep >= 0 && status.currentStep < steps.length) {
			selectedIndex = status.currentStep;
		} else if (steps.length === 1) {
			selectedIndex = 0;
		}
	}
	const step = selectedIndex !== undefined ? steps[selectedIndex] : undefined;
	const hint = options.index === undefined && steps.length > 1
		? `Tip: pass index to inspect a specific child transcript (${steps.map((candidate, index) => `${index}=${candidate.agent}`).join(", ")}).`
		: undefined;
	return { index: selectedIndex, step, hint };
}

function stepStateLine(mode: SubagentRunMode, index: number | undefined, step: AsyncJobStep | undefined): string | undefined {
	if (index === undefined || !step) return undefined;
	const modelThinking = formatModelThinking(step.model, step.thinking);
	const parts = [
		`${mode === "parallel" ? "Agent" : "Step"}: ${index} (${step.agent})`,
		step.status,
		formatActivityFacts(step),
		modelThinking,
		step.error ? `error: ${step.error}` : undefined,
	].filter(Boolean);
	return parts.join(" | ");
}

function appendKnownArtifacts(lines: string[], input: { outputPaths: string[]; sessionFile?: string; eventsPath?: string; logPath?: string; resultPath?: string }): void {
	const artifacts: string[] = [];
	for (const outputPath of input.outputPaths) artifacts.push(`Output: ${outputPath}`);
	if (input.sessionFile) artifacts.push(`Session: ${input.sessionFile}`);
	if (input.eventsPath) artifacts.push(`Events: ${input.eventsPath}`);
	if (input.logPath) artifacts.push(`Log: ${input.logPath}`);
	if (input.resultPath) artifacts.push(`Result: ${input.resultPath}`);
	if (!artifacts.length) return;
	lines.push("Artifacts:");
	for (const artifact of artifacts) lines.push(`  ${artifact}`);
}

function appendTranscriptBody(lines: string[], sourceLabel: string, sourceLines: string[], truncated: boolean): void {
	lines.push(`${sourceLabel}${truncated ? " (tail truncated)" : ""}:`);
	if (sourceLines.length === 0) {
		lines.push("  (no transcript lines available yet)");
		return;
	}
	for (const line of sourceLines) lines.push(`  ${line}`);
}

export function formatAsyncRunTranscript(status: AsyncStatus, asyncDir: string, options: TranscriptOptions = {}): string {
	const lineLimit = transcriptLineLimit(options.lines);
	const selected = selectTranscriptStep(status, options);
	const stepOutputPath = selected.index !== undefined ? path.join(asyncDir, `output-${selected.index}.log`) : undefined;
	const runOutputPath = resolveMaybeRelative(asyncDir, status.outputFile);
	const logPath = path.join(asyncDir, `subagent-log-${status.runId}.md`);
	const outputPaths = selected.index !== undefined
		? uniqueStrings([stepOutputPath, runOutputPath && stepOutputPath && path.resolve(runOutputPath) === path.resolve(stepOutputPath) ? runOutputPath : undefined])
		: uniqueStrings([runOutputPath]);
	const sessionFile = selected.index !== undefined ? selected.step?.sessionFile : status.sessionFile;
	const eventsPath = path.join(asyncDir, "events.jsonl");

	const lines = [
		`Run: ${status.runId}`,
		`State: ${status.state}`,
		`Mode: ${status.mode}`,
		stepStateLine(status.mode, selected.index, selected.step),
		selected.hint,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths, sessionFile, eventsPath: fs.existsSync(eventsPath) ? eventsPath : undefined, logPath: fs.existsSync(logPath) ? logPath : undefined });

	const warnings: string[] = [];
	let transcriptLines: string[] = [];
	let transcriptSource = "Transcript tail";
	let truncated = false;
	for (const outputPath of outputPaths) {
		const tail = readContainedTextTail(outputPath, lineLimit, [asyncDir], "output");
		if (tail.error) warnings.push(`Output read failed for ${tail.path}: ${tail.error}`);
		if (tail.lines.length === 0) continue;
		transcriptLines = tail.lines;
		transcriptSource = `Transcript tail from ${tail.path}`;
		truncated = tail.truncated;
		break;
	}
	if (transcriptLines.length === 0 && selected.step?.recentOutput?.length) {
		transcriptLines = selected.step.recentOutput.slice(-lineLimit);
		transcriptSource = "Recent output from status.json";
	}
	if (transcriptLines.length === 0 && sessionFile) {
		const sessionTail = readSessionTranscriptTail(sessionFile, lineLimit, options.sessionRoots ?? []);
		transcriptLines = sessionTail.lines;
		warnings.push(...sessionTail.warnings);
		if (transcriptLines.length > 0) transcriptSource = `Session transcript tail from ${sessionFile}`;
	}

	if (warnings.length) {
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`  ${warning}`);
	}
	appendTranscriptBody(lines, transcriptSource, transcriptLines, truncated);
	return lines.join("\n");
}

export function formatNestedRunTranscript(run: NestedRunSummary, options: TranscriptOptions = {}): string {
	if (run.asyncDir) {
		const status = readStatus(run.asyncDir);
		if (status) return formatAsyncRunTranscript(status, run.asyncDir, options);
	}
	const lineLimit = transcriptLineLimit(options.lines);
	const lines = [
		`Nested run: ${run.id}`,
		`State: ${run.state}`,
		run.mode ? `Mode: ${run.mode}` : undefined,
		run.agent ? `Agent: ${run.agent}` : run.agents?.length ? `Agents: ${run.agents.join(", ")}` : undefined,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths: [], sessionFile: run.sessionFile });
	if (!run.sessionFile) {
		appendTranscriptBody(lines, "Transcript tail", [], false);
		return lines.join("\n");
	}
	const sessionTail = readSessionTranscriptTail(run.sessionFile, lineLimit, options.sessionRoots ?? []);
	if (sessionTail.warnings.length) {
		lines.push("Warnings:");
		for (const warning of sessionTail.warnings) lines.push(`  ${warning}`);
	}
	appendTranscriptBody(lines, `Session transcript tail from ${run.sessionFile}`, sessionTail.lines, false);
	return lines.join("\n");
}

export function formatAsyncResultTranscript(data: {
	id?: string;
	runId?: string;
	state?: string;
	success?: boolean;
	summary?: string;
	output?: string;
	sessionFile?: string;
	agent?: string;
	exitCode?: number | null;
	results?: Array<{ agent?: string; output?: string; summary?: string; sessionFile?: string; state?: string; success?: boolean; exitCode?: number | null }>;
}, resultPath: string, options: TranscriptOptions = {}): string {
	const lineLimit = transcriptLineLimit(options.lines);
	const runId = data.runId ?? data.id ?? path.basename(resultPath, ".json");
	const children = Array.isArray(data.results)
		? data.results
		: data.agent
			? [{ agent: data.agent, output: data.output, summary: data.summary, sessionFile: data.sessionFile, state: data.state, success: data.success, exitCode: data.exitCode }]
			: [];
	let index = options.index;
	if (index !== undefined && !Number.isInteger(index)) throw new Error("Transcript index must be an integer.");
	if (index === undefined && children.length === 1) index = 0;
	if (index !== undefined && (index < 0 || index >= children.length)) throw new Error(`Transcript index ${index} is out of range for ${children.length} result child${children.length === 1 ? "" : "ren"}.`);
	const child = index !== undefined ? children[index] : undefined;
	const output = index !== undefined
		? child?.output ?? child?.summary ?? (children.length === 1 ? data.output ?? data.summary : undefined) ?? ""
		: data.output ?? data.summary ?? "";
	const transcriptLines = output.split(/\r?\n/).slice(-lineLimit);
	const sessionFile = child?.sessionFile ?? data.sessionFile;
	const lines = [
		`Run: ${runId}`,
		`State: ${data.state ?? (data.success ? "complete" : "failed")}`,
		index !== undefined && child ? `Child: ${index} (${child.agent ?? "subagent"})` : undefined,
		index === undefined && children.length > 1 ? `Tip: pass index to inspect a specific child transcript (${children.map((candidate, childIndex) => `${childIndex}=${candidate.agent ?? "subagent"}`).join(", ")}).` : undefined,
	].filter((line): line is string => Boolean(line));
	appendKnownArtifacts(lines, { outputPaths: [], sessionFile, resultPath });
	appendTranscriptBody(lines, "Result transcript tail", transcriptLines.filter((line) => line.trim()), output.split(/\r?\n/).length > lineLimit);
	return lines.join("\n");
}
