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
	expanded: boolean;
	isError: boolean;
	expandKey: string;
}

export interface ToolResultDisplayOptions {
	warn?: (message: string) => void;
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

function managementLabel(args: ToolResultDisplayArgs, action: string): string {
	if (action === "status") {
		if (args.view === "fleet") return "Subagent fleet";
		if (args.view === "transcript") return "Subagent transcript";
		return "Subagent status";
	}
	return `Subagent ${action.replace(/[.-]/g, " ")}`;
}

function asyncLaunchLabel(mode: unknown): string {
	if (mode === "parallel") return "Async subagent parallel";
	if (mode === "chain") return "Async subagent chain";
	return "Async subagent";
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

	const parts = [managementAction ? managementLabel(input.args, managementAction) : asyncLaunchLabel(input.details?.mode)];
	if (managementAction) {
		const agent = nonEmptyString(input.args.agent);
		const chainName = nonEmptyString(input.args.chainName);
		if (agent) parts.push(`agent ${agent}`);
		else if (chainName) parts.push(`chain ${chainName}`);
		else if (managementAction === "schedule" && Array.isArray(input.args.tasks)) parts.push(`parallel (${input.args.tasks.length})`);
		else if (managementAction === "schedule" && Array.isArray(input.args.chain)) parts.push(`chain (${input.args.chain.length})`);
	}
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
