import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type {
	ParallelHandoffGroup,
	ParallelHandoffManifest,
	ParallelHandoffReference,
	SubagentResultStatus,
} from "../../shared/types.ts";
import type {
	WorktreeCleanupReport,
	WorktreeDiff,
	WorktreeSetup,
	WorktreeCleanupIntent,
} from "./worktree.ts";
import { cleanupWorktrees } from "./worktree.ts";

export interface ParallelHandoffResult {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	outputPath?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	sessionPath?: string;
}

function readManifest(manifestPath: string): ParallelHandoffManifest | undefined {
	if (!fs.existsSync(manifestPath)) return undefined;
	const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ParallelHandoffManifest;
	if (parsed.version !== 1 || !Array.isArray(parsed.groups)) {
		throw new Error(`Invalid parallel handoff manifest: ${manifestPath}`);
	}
	return parsed;
}

function resolveExistingPath(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function pathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolveRetainedWorktreeCwd(manifestPath: string, runId: string, childIndex: number): string | undefined {
	const manifest = readManifest(manifestPath);
	if (!manifest) return undefined;
	if (manifest.runId !== runId) throw new Error(`Managed worktree handoff belongs to run '${manifest.runId}', not '${runId}'.`);
	const match = manifest.groups
		.flatMap((group) => group.children.map((child) => ({ group, child })))
		.find(({ child }) => child.index === childIndex);
	if (!match) return undefined;
	const cleanup = match.group.cleanup.tasks.find((task) => task.index === match.child.taskIndex);
	if (!cleanup) throw new Error(`Async run '${runId}' child ${childIndex} has no managed worktree cleanup record.`);
	const relativeCwd = path.relative(resolveExistingPath(match.group.repoRoot), resolveExistingPath(manifest.cwd));
	if (path.isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) throw new Error(`Async run '${runId}' has an invalid managed worktree cwd.`);
	const requiredCwd = path.join(cleanup.path, relativeCwd);
	if (cleanup.worktreeRemoved || cleanup.branchRemoved) throw new Error(`Async run '${runId}' required managed worktree was removed: ${requiredCwd}`);
	let worktreeRoot = "";
	let resolvedRequiredCwd = "";
	try {
		const rootStat = fs.lstatSync(cleanup.path);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("worktree root is not a directory");
		worktreeRoot = fs.realpathSync(cleanup.path);
		if (!fs.statSync(requiredCwd).isDirectory()) throw new Error("path is not a directory");
		resolvedRequiredCwd = fs.realpathSync(requiredCwd);
	} catch (error) {
		throw new Error(`Async run '${runId}' required managed worktree cwd is missing: ${requiredCwd}`, { cause: error instanceof Error ? error : undefined });
	}
	if (!pathInside(worktreeRoot, resolvedRequiredCwd)) throw new Error(`Async run '${runId}' has an invalid managed worktree cwd.`);
	return requiredCwd;
}

function referenceFor(manifestPath: string, manifest: ParallelHandoffManifest): ParallelHandoffReference {
	const children = manifest.groups.flatMap((group) => group.children);
	return {
		version: 1,
		path: manifestPath,
		groupCount: manifest.groups.length,
		childCount: children.length,
		changedPatches: children.filter((child) => child.patch.changed).length,
		cleanupState: manifest.groups.every((group) => group.cleanup.state === "complete") ? "complete" : "partial",
	};
}

function safeHandoffAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function missingDiff(input: { manifestPath: string; stepIndex: number; taskIndex: number; agent: string; branch?: string }): WorktreeDiff {
	const patchPath = path.join(path.dirname(input.manifestPath), `missing-diff-step-${input.stepIndex}-task-${input.taskIndex}-${safeHandoffAgentName(input.agent)}.patch`);
	try {
		fs.mkdirSync(path.dirname(patchPath), { recursive: true });
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Handoff records the artifact failure below; patch creation remains best-effort.
	}
	return {
		index: input.taskIndex,
		agent: input.agent,
		branch: input.branch ?? "",
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
		error: "diff artifact unavailable; no patch was captured",
	};
}

export function writeParallelHandoffGroup(input: {
	manifestPath: string;
	runId: string;
	mode: "single" | "parallel" | "chain";
	source: "foreground" | "async";
	cwd: string;
	stepIndex: number;
	flatStartIndex: number;
	setup: WorktreeSetup;
	diffs: WorktreeDiff[];
	cleanup?: WorktreeCleanupReport;
	results: ParallelHandoffResult[];
	now?: number;
}): ParallelHandoffReference {
	const now = input.now ?? Date.now();
	const existing = readManifest(input.manifestPath);
	if (existing && (existing.runId !== input.runId || existing.mode !== input.mode || existing.source !== input.source)) {
		throw new Error(`Parallel handoff manifest belongs to a different run: ${input.manifestPath}`);
	}
	const group: ParallelHandoffGroup = {
		stepIndex: input.stepIndex,
		baseCommit: input.setup.baseCommit,
		repoRoot: input.setup.cwd,
		children: input.results.map((result, taskIndex) => {
			const diff = input.diffs[taskIndex] ?? missingDiff({
				manifestPath: input.manifestPath,
				stepIndex: input.stepIndex,
				taskIndex,
				agent: result.agent,
				branch: input.setup.worktrees[taskIndex]?.branch,
			});
			return {
				index: input.flatStartIndex + taskIndex,
				taskIndex,
				agent: result.agent,
				status: result.status,
				summary: result.summary,
				...(result.outputPath ? { outputPath: result.outputPath } : {}),
				...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
				...(result.structuredOutputPath ? { structuredOutputPath: result.structuredOutputPath } : {}),
				...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
				patch: {
					path: diff.patchPath,
					branch: diff.branch,
					changed: diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0,
					diffStat: diff.diffStat,
					filesChanged: diff.filesChanged,
					insertions: diff.insertions,
					deletions: diff.deletions,
					...(diff.error ? { error: diff.error } : {}),
				},
			};
		}),
		cleanup: input.cleanup ?? {
			state: "partial",
			pruned: false,
			tasks: input.setup.worktrees.map((worktree) => ({
				index: worktree.index,
				path: worktree.path,
				branch: worktree.branch,
				worktreeRemoved: false,
				branchRemoved: false,
				preserved: true,
				reason: "cleanup pending durable handoff capture",
			})),
		},
	};
	const groups = existing?.groups.filter((candidate) => candidate.stepIndex !== input.stepIndex) ?? [];
	groups.push(group);
	groups.sort((left, right) => left.stepIndex - right.stepIndex);
	const manifest: ParallelHandoffManifest = {
		version: 1,
		runId: input.runId,
		mode: input.mode,
		source: input.source,
		cwd: input.cwd,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		groups,
	};
	writeAtomicJson(input.manifestPath, manifest);
	return referenceFor(input.manifestPath, manifest);
}

export function parallelHandoffPath(baseDir: string, runId?: string): string {
	return runId ? path.join(baseDir, "handoffs", `${runId}.json`) : path.join(baseDir, "handoff.json");
}

export function writePendingParallelHandoff(input: {
	manifestPath: string;
	runId: string;
	mode: "single" | "parallel" | "chain";
	source: "foreground" | "async";
	cwd: string;
	stepIndex: number;
	flatStartIndex: number;
	setup: WorktreeSetup;
}): ParallelHandoffReference {
	return writeParallelHandoffGroup({ ...input, diffs: [], results: [] });
}

export function formatParallelHandoffReference(reference: ParallelHandoffReference): string {
	return `Worktree handoff: ${reference.path} (${reference.childCount} children, ${reference.changedPatches} changed patches, cleanup ${reference.cleanupState})`;
}

export function formatParallelHandoffError(error: unknown): string {
	return `Worktree handoff unavailable: ${error instanceof Error ? error.message : String(error)}`;
}

export function discardPreservedWorktrees(
	manifestPath: string,
	authorization: Extract<WorktreeCleanupIntent, { kind: "discard" }>["authorization"],
): { manifest: ParallelHandoffManifest; text: string } {
	const resolvedPath = path.resolve(manifestPath);
	const manifest = readManifest(resolvedPath);
	if (!manifest) throw new Error(`Parallel handoff manifest not found: ${resolvedPath}`);
	let attempted = 0;
	for (const group of manifest.groups) {
		const pending = group.cleanup.tasks.filter((task) => task.preserved && (!task.worktreeRemoved || !task.branchRemoved));
		if (pending.length === 0) continue;
		attempted += pending.length;
		const report = cleanupWorktrees({
			cwd: group.repoRoot,
			baseCommit: group.baseCommit,
			worktrees: pending.map((task) => ({
				path: task.path,
				agentCwd: task.path,
				branch: task.branch,
				index: task.index,
				nodeModulesLinked: false,
				syntheticPaths: [],
			})),
		}, { kind: "discard", authorization });
		const updates = new Map(report.tasks.map((task) => [task.index, task.worktreeRemoved && task.branchRemoved
			? task
			: { ...task, preserved: true, reason: task.reason ?? "discard cleanup remains incomplete" }]));
		group.cleanup = {
			state: group.cleanup.tasks.every((task) => {
				const next = updates.get(task.index) ?? task;
				return next.worktreeRemoved && next.branchRemoved;
			}) && report.pruned ? "complete" : "partial",
			tasks: group.cleanup.tasks.map((task) => updates.get(task.index) ?? task),
			pruned: report.pruned,
			...(report.errors ? { errors: report.errors } : {}),
		};
	}
	manifest.updatedAt = Date.now();
	writeAtomicJson(resolvedPath, manifest);
	const remaining = manifest.groups.flatMap((group) => group.cleanup.tasks.map((task) => ({ group, task })))
		.filter(({ task }) => task.preserved && (!task.worktreeRemoved || !task.branchRemoved));
	const lines = attempted === 0
		? [`No preserved worktrees remain in ${resolvedPath}.`]
		: [`Discard processed ${attempted} preserved worktree${attempted === 1 ? "" : "s"}.`, `Manifest: ${resolvedPath}`];
	if (remaining.length > 0) {
		lines.push("", "Some worktrees remain. Inspect and remove them manually if appropriate:");
		for (const { group, task } of remaining) {
			lines.push(
				`  git -C ${JSON.stringify(group.repoRoot)} status --short`,
				`  git -C ${JSON.stringify(group.repoRoot)} worktree remove --force ${JSON.stringify(task.path)}`,
				`  git -C ${JSON.stringify(group.repoRoot)} branch -D ${JSON.stringify(task.branch)}`,
			);
		}
	}
	return { manifest, text: lines.join("\n") };
}
