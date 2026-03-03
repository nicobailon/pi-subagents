/**
 * Parallel execution utilities for the async runner.
 * Kept minimal and self-contained so the standalone runner can use them
 * without pulling in the full extension dependency tree.
 */

/** A single agent step in the runner config */
export interface RunnerSubagentStep {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	skills?: string[];
	outputPath?: string;
}

/** Parallel step group — multiple agents running concurrently */
export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray((step as ParallelStepGroup).parallel);
}

/** Flatten runner steps into individual SubagentSteps for status tracking */
export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else {
			flat.push(step);
		}
	}
	return flat;
}

/** Run async tasks with bounded concurrency, preserving result order.
 *  `staggerMs` adds a small delay between each worker's start to avoid
 *  file-lock contention when multiple subagents read shared config. */
export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
	staggerMs = 150,
): Promise<R[]> {
	// Clamp to at least 1; NaN/undefined/0/negative all become 1
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(workerIndex: number): Promise<void> {
		if (staggerMs > 0 && workerIndex > 0) {
			await new Promise((r) => setTimeout(r, workerIndex * staggerMs));
		}
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)),
	);
	return results;
}

/** Aggregate outputs from parallel tasks into a single string for {previous} */
export function aggregateParallelOutputs(
	results: Array<{ agent: string; output: string; exitCode: number | null; error?: string }>,
): string {
	return results
		.map((r, i) => {
			const header = `=== Parallel Task ${i + 1} (${r.agent}) ===`;
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.exitCode === -1
					? "⏭️ SKIPPED"
					: r.exitCode !== 0
						? `⚠️ FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: !hasOutput
							? "⚠️ EMPTY OUTPUT"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export const MAX_PARALLEL_CONCURRENCY = 4;
