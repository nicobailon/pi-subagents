export type ResolvedRunnerConfig = import("../../shared/types.ts").AgentRunnerConfig;

export interface RunnerSubagentStep {
	/** Session id of the direct parent session for permission-system ask forwarding. */
	parentSessionId?: string;
	/** Resolved opt-in rules for native Pi child tool calls. */
	permissionRules?: import("./permissions.ts").PermissionRules;
	agent: string;
	task: string;
	runner?: ResolvedRunnerConfig;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	importAsyncRoot?: {
		runId: string;
		asyncDir: string;
		resultPath: string;
		index: number;
	};
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
	cwd?: string;
	model?: string;
	thinking?: string;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	completionGuard?: boolean;
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	outputPath?: string;
	/** Defer the authoritative output instruction until a dynamic fanout item is materialized. */
	namespaceOutputPath?: boolean;
	outputMode?: "inline" | "file-only";
	sessionFile?: string;
	maxSubagentDepth?: number;
	timeoutMs?: number;
	/** Resolved configured hard per-tool-call timeout (ms); fast tools still have a default when undefined. */
	toolTimeoutMs?: number;
	waitToolEnabled?: boolean;
	structuredOutput?: {
		schema: import("../../shared/types.ts").JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
	structuredOutputSchema?: import("../../shared/types.ts").JsonSchemaObject;
	agentContract?: import("../../shared/types.ts").AgentContract;
	definitionDigest?: string;
	launchBindingTask?: string;
	launchContractDigest?: string;
	launchResolvedExtensions?: import("../../shared/types.ts").LaunchResolvedChildExtensionsV1;
	runtimeAcknowledgedExtensions?: import("../../shared/types.ts").RuntimeAcknowledgedChildExtensionsV1;
	effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
	acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
	acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
	gateOn?: import("../../shared/types.ts").ChainGateLayer;
	toolBudget?: import("../../shared/types.ts").ResolvedToolBudget;
	capabilityCeiling?: import("./capability-ceiling.ts").ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: import("./capability-ceiling.ts").SubagentCapabilityAudit;
	/** Private stable logical-child path for inherited run fan-out accounting. */
	runFanoutPath?: string;
	/** Run this single child in one managed worktree. */
	worktree?: boolean;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

export interface DynamicRunnerGroup {
	expand: import("../../shared/settings.ts").DynamicExpandSpec;
	parallel: RunnerSubagentStep;
	collect: import("../../shared/settings.ts").DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	phase?: string;
	label?: string;
	sessionFiles?: (string | undefined)[];
	thinkingOverrides?: (string | undefined)[];
	effectiveAcceptance?: import("../../shared/types.ts").ResolvedAcceptanceConfig;
	acceptanceInput?: import("../../shared/types.ts").AcceptanceInput;
	acceptanceRole?: import("../../shared/types.ts").AcceptanceRole;
	agentContract?: import("../../shared/types.ts").AgentContract;
	gateOn?: import("../../shared/types.ts").ChainGateLayer;
	capabilityCeiling?: import("./capability-ceiling.ts").ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: import("./capability-ceiling.ts").SubagentCapabilityAudit;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | DynamicRunnerGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray(step.parallel);
}

export function isDynamicRunnerGroup(step: RunnerStep): step is DynamicRunnerGroup {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else if (isDynamicRunnerGroup(step)) {
			continue;
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;

/**
 * A promise-based semaphore for limiting concurrent access across multiple
 * mapConcurrent calls within a single run. Enforces a global cap on the total
 * number of subagent tasks executing simultaneously, regardless of each step's
 * per-step concurrency limit.
 */
export class Semaphore {
	private available: number;
	private readonly queue: Array<() => void> = [];

	constructor(limit: number) {
		this.available = Math.max(1, Math.floor(limit) || 1);
	}

	acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			this.available++;
		}
	}
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
	globalSemaphore?: Semaphore,
	/** Invoked after every worker has stopped, including workers outliving an early rejection. */
	onSchedulingSettled?: () => void,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;
	let liveWorkers = Math.min(safeLimit, items.length);
	const notifySchedulingSettled = () => {
		try {
			onSchedulingSettled?.();
		} catch {
			// Scheduling lifecycle cleanup must not replace the worker result.
		}
	};

	async function worker(_workerIndex: number): Promise<void> {
		try {
			while (next < items.length) {
				const i = next++;
				if (!(i in items)) throw new Error(`Missing parallel item at index ${i}`);
				const item = items[i] as T;
				if (globalSemaphore) {
					await globalSemaphore.acquire();
					try {
						results[i] = await fn(item, i);
					} finally {
						globalSemaphore.release();
					}
				} else {
					results[i] = await fn(item, i);
				}
			}
		} finally {
			liveWorkers--;
			if (liveWorkers === 0) notifySchedulingSettled();
		}
	}

	if (liveWorkers === 0) notifySchedulingSettled();
	await Promise.all(
		Array.from({ length: liveWorkers }, (_, wi) => worker(wi)),
	);
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	timedOut?: boolean;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.timedOut
					? `TIMED OUT${r.error ? `: ${r.error}` : ""}`
					: r.exitCode === -1
					? "SKIPPED"
					: r.exitCode !== 0 && r.exitCode !== null
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
