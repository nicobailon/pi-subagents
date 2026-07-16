import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { SUBAGENT_ACTIONS, type ExtensionConfig, type ToolResultDisplay } from "../shared/types.ts";

export interface ToolResultDisplayArgs {
	action?: unknown;
	agent?: unknown;
	chainName?: unknown;
	id?: unknown;
	runId?: unknown;
	dir?: unknown;
	index?: unknown;
	view?: unknown;
	tasks?: unknown;
	chain?: unknown;
}

export interface ToolResultDisplayDetails {
	mode?: unknown;
	asyncId?: unknown;
	runId?: unknown;
}

export interface CompactToolResultDisplayInput {
	toolResultDisplay: ToolResultDisplay;
	args: ToolResultDisplayArgs;
	details?: ToolResultDisplayDetails;
	content?: string;
	expanded: boolean;
	isError: boolean;
	expandKey: string;
}

export interface ToolResultDisplayOptions {
	warn?: (message: string) => void;
}

interface CompactToolCallState {
	compactToolCallBase?: string;
	compactToolCallComponent?: Text;
}

interface ToolCallRenderContext {
	state?: Record<string, unknown>;
	lastComponent?: Component;
}

export function renderCompactAwareToolCall(baseText: string, context?: ToolCallRenderContext): Text {
	const previous = context?.lastComponent;
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(baseText);
	if (context?.state) {
		const state = context.state as CompactToolCallState;
		state.compactToolCallBase = baseText;
		state.compactToolCallComponent = component;
	}
	return component;
}

export function renderCompactResultOnToolCall(styledSummary: string, stateValue: Record<string, unknown>): Component {
	const state = stateValue as CompactToolCallState;
	if (!state.compactToolCallComponent || !state.compactToolCallBase) return new Text(styledSummary, 0, 0);
	state.compactToolCallComponent.setText(`${state.compactToolCallBase} ${styledSummary}`);
	return new Container();
}

function warn(options: ToolResultDisplayOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export function resolveToolResultDisplay(
	config: Pick<ExtensionConfig, "toolResultDisplay">,
	options?: ToolResultDisplayOptions,
): ToolResultDisplay {
	const display = config.toolResultDisplay;
	if (display === undefined || display === "full") return "full";
	if (display === "compact") return "compact";
	warn(options, `Ignoring invalid toolResultDisplay ${JSON.stringify(display)}; expected "full" or "compact".`);
	return "full";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function plural(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function countListSection(content: string, heading: string, nextHeading?: string): number | undefined {
	const start = content.indexOf(`${heading}:`);
	if (start < 0) return undefined;
	const tail = content.slice(start + heading.length + 1);
	const nextSection = nextHeading ? tail.indexOf(`\n${nextHeading}:`) : -1;
	const blankLine = tail.search(/\r?\n\r?\n/);
	const ends = [nextSection, blankLine].filter((value) => value >= 0);
	const section = ends.length > 0 ? tail.slice(0, Math.min(...ends)) : tail;
	return section.split(/\r?\n/).filter((line) => /^-\s+/.test(line) && !/^-\s+\(none\)/i.test(line)).length;
}

function summarizeList(content: string): string[] {
	const agents = countListSection(content, "Executable agents", "Chains");
	const chains = countListSection(content, "Chains", "Chain diagnostics");
	if (agents === undefined && chains === undefined) return ["done"];
	return [plural(agents ?? 0, "agent"), plural(chains ?? 0, "chain")];
}

function summarizeRunStates(content: string): string[] {
	const counts = new Map<string, number>();
	for (const match of content.matchAll(/^-\s+[^|\n]+\|\s*(queued|running|detached|paused|stale)\b/gim)) {
		const state = match[1]!.toLowerCase();
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return ["running", "queued", "detached", "paused", "stale"]
		.flatMap((state) => counts.has(state) ? [`${counts.get(state)!} ${state}`] : []);
}

function summarizeStatus(args: ToolResultDisplayArgs, content: string): string[] {
	if (args.view === "fleet") {
		if (/^No active subagent fleet\b/im.test(content)) return ["0 active"];
		const tracked = content.match(/^Subagent fleet:\s*(\d+)\s+tracked\b/im)?.[1];
		return [tracked ? `${tracked} tracked` : "fleet", ...summarizeRunStates(content)];
	}
	const state = content.match(/^State:\s*([^\r\n]+)/im)?.[1]?.trim();
	const progress = content.match(/^Progress:\s*([^\r\n]+)/im)?.[1]?.trim();
	if (args.view === "transcript") return ["transcript", ...(state ? [state] : [])];
	if (!nonEmptyString(args.id) && !nonEmptyString(args.runId) && !nonEmptyString(args.dir)) {
		if (/^No active async runs\./im.test(content)) return ["0 active"];
		const active = content.match(/^Active async runs:\s*(\d+)/im)?.[1];
		if (active) return [`${active} active`, ...summarizeRunStates(content)];
	}
	return [...(state ? [state] : ["done"]), ...(progress ? [progress] : [])];
}

function summarizeManagement(action: string, args: ToolResultDisplayArgs, content: string): string[] {
	if (action === "list") return summarizeList(content);
	if (action === "status") return summarizeStatus(args, content);
	if (action === "schedule-list") {
		if (/^No scheduled\b/im.test(content)) return ["0 jobs"];
		const count = content.match(/^Scheduled (?:runs|jobs):\s*(\d+)/im)?.[1];
		if (count) return [plural(Number(count), "job")];
	}
	return [action === "schedule" ? "scheduled" : "done"];
}

function compactDirectoryTarget(value: string): string {
	const segments = value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
	return (segments.at(-1) ?? value).slice(0, 20);
}

/**
 * Builds a collapsed presentation-only summary for successful management calls
 * and detached async launch acknowledgements. Returning undefined tells the
 * caller to use the existing full result renderer.
 */
export function buildCompactToolResultDisplay(input: CompactToolResultDisplayInput): string | undefined {
	if (input.toolResultDisplay !== "compact" || input.expanded || input.isError) return undefined;

	const action = nonEmptyString(input.args.action);
	const managementAction = action && (SUBAGENT_ACTIONS as readonly string[]).includes(action) ? action : undefined;
	const asyncId = nonEmptyString(input.details?.asyncId);
	if (!managementAction && !asyncId) return undefined;

	const parts = managementAction
		? summarizeManagement(managementAction, input.args, input.content ?? "")
		: ["started"];
	if (managementAction === "schedule" && Array.isArray(input.args.tasks)) parts.push(`parallel ${input.args.tasks.length}`);
	else if (managementAction === "schedule" && Array.isArray(input.args.chain)) parts.push(`chain ${input.args.chain.length}`);
	const runId = nonEmptyString(input.args.id)
		?? nonEmptyString(input.args.runId)
		?? asyncId
		?? nonEmptyString(input.details?.runId);
	if (runId) parts.push(`${managementAction?.startsWith("schedule") ? "job" : "run"} ${runId.slice(0, 8)}`);
	else {
		const dir = nonEmptyString(input.args.dir);
		if (dir) parts.push(`dir ${compactDirectoryTarget(dir)}`);
	}
	if (typeof input.args.index === "number" && Number.isInteger(input.args.index) && input.args.index >= 0) {
		parts.push(`child ${input.args.index + 1}`);
	}
	parts.push(`${input.expandKey} expand`);
	return parts.join(" · ");
}

export interface CompactWaitResultDisplayInput {
	toolResultDisplay: ToolResultDisplay;
	args: { id?: unknown; all?: unknown };
	content: string;
	expanded: boolean;
	isError: boolean;
	expandKey: string;
}

export function buildCompactWaitResultDisplay(input: CompactWaitResultDisplayInput): string | undefined {
	if (input.toolResultDisplay !== "compact" || input.expanded || input.isError) return undefined;
	const status = /timed out/i.test(input.content)
		? "timed out"
		: /attention required|need attention/i.test(input.content)
			? "attention"
			: /aborted/i.test(input.content)
				? "aborted"
				: /no active|nothing to wait|no current-session/i.test(input.content)
					? "idle"
					: "done";
	const parts = [status];
	const elapsed = input.content.match(/^Waited\s+(\S+)/i)?.[1]?.replace(/[;,]$/, "");
	if (elapsed) parts.push(elapsed);
	const runId = nonEmptyString(input.args.id);
	if (runId) parts.push(`run ${runId.slice(0, 8)}`);
	else if (input.args.all === true) parts.push("all work");
	parts.push(`${input.expandKey} expand`);
	return parts.join(" · ");
}
