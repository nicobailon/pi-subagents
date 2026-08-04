import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Details } from "../shared/types.ts";

export const WORKFLOW_CHAT_PROGRESS_MODES = ["auto", "off", "terminal", "milestones", "live-card"] as const;
export type WorkflowChatProgressMode = typeof WORKFLOW_CHAT_PROGRESS_MODES[number];
export type ResolvedWorkflowChatProgressMode = Exclude<WorkflowChatProgressMode, "auto">;

export interface GitRepositoryIdentity {
	root: string;
	commonDir: string;
}

export interface WorkflowChatProgressProjection {
	mode: ResolvedWorkflowChatProgressMode;
	repoRelation: "same" | "other";
	repoLabel?: string;
}

interface ResolveWorkflowChatProgressInput {
	requested: unknown;
	parentCwd: string;
	workflowCwd: string;
	background: boolean;
}

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) return undefined;
	const output = result.stdout.trim();
	return output || undefined;
}

function realPath(value: string): string {
	try {
		return fs.realpathSync.native(value);
	} catch {
		return path.resolve(value);
	}
}

export function resolveGitRepositoryIdentity(cwd: string): GitRepositoryIdentity | undefined {
	if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
	if (!root || !commonDir) return undefined;
	const commonDirPath = path.isAbsolute(commonDir)
		? commonDir
		: [path.resolve(cwd, commonDir), path.resolve(root, commonDir)].find((candidate) => fs.existsSync(candidate)) ?? path.resolve(root, commonDir);
	return {
		root: realPath(root),
		commonDir: realPath(commonDirPath),
	};
}

function isSameGitRepositoryIdentity(left: GitRepositoryIdentity | undefined, right: GitRepositoryIdentity | undefined): boolean {
	if (!left || !right) return false;
	return left.commonDir === right.commonDir || left.root === right.root;
}

export function isSameGitRepository(leftCwd: string, rightCwd: string): boolean {
	return isSameGitRepositoryIdentity(resolveGitRepositoryIdentity(leftCwd), resolveGitRepositoryIdentity(rightCwd));
}

function normalizeRequestedMode(value: unknown): { mode?: WorkflowChatProgressMode; error?: string } {
	if (value === undefined) return { mode: "auto" };
	if (typeof value !== "string" || !WORKFLOW_CHAT_PROGRESS_MODES.includes(value as WorkflowChatProgressMode)) {
		return { error: `chatProgress must be one of: ${WORKFLOW_CHAT_PROGRESS_MODES.join(", ")}.` };
	}
	return { mode: value as WorkflowChatProgressMode };
}

export function resolveWorkflowChatProgress(input: ResolveWorkflowChatProgressInput): { projection?: WorkflowChatProgressProjection; error?: string } {
	const requested = normalizeRequestedMode(input.requested);
	if (requested.error) return { error: requested.error };
	const parentIdentity = resolveGitRepositoryIdentity(input.parentCwd);
	const workflowIdentity = resolveGitRepositoryIdentity(input.workflowCwd);
	const sameRepo = !!(
		parentIdentity
		&& workflowIdentity
		&& (parentIdentity.commonDir === workflowIdentity.commonDir || parentIdentity.root === workflowIdentity.root)
	);
	const repoLabel = workflowIdentity ? path.basename(workflowIdentity.root) : undefined;
	const repoRelation = sameRepo ? "same" : "other";

	const requestedMode = requested.mode ?? "auto";
	let mode: ResolvedWorkflowChatProgressMode;
	if (requestedMode === "auto") mode = sameRepo ? (input.background ? "milestones" : "live-card") : "terminal";
	else mode = requestedMode;

	if (mode === "live-card" && !sameRepo) return { error: "chatProgress: 'live-card' is only available for workflowScript runs in the same Git repository." };
	if (mode === "live-card" && input.background) return { error: "chatProgress: 'live-card' requires a watched foreground workflow; pass async:false." };
	return { projection: { mode, repoRelation, ...(repoLabel ? { repoLabel } : {}) } };
}

export interface WorkflowChatProgressRow {
	key: string;
	state: "running" | "complete" | "failed";
	label?: string;
	phase?: string;
	runId?: string;
	durationMs?: number;
	error?: string;
}

function cleanLabel(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildWorkflowChatProgressRows(trace: NonNullable<Details["workflow"]>["trace"]): WorkflowChatProgressRow[] {
	const rows = new Map<string, WorkflowChatProgressRow>();
	for (const entry of trace) {
		if (entry.operation !== "run") continue;
		const existing = rows.get(entry.key);
		if (entry.state === "reused") {
			if (existing) {
				const label = cleanLabel(entry.label);
				const phase = cleanLabel(entry.phase);
				if (label) existing.label = label;
				if (phase) existing.phase = phase;
			}
			continue;
		}
		const next: WorkflowChatProgressRow = existing ?? { key: entry.key, state: "running" };
		next.state = entry.state === "completed" ? "complete" : entry.state === "failed" ? "failed" : "running";
		const label = cleanLabel(entry.label);
		const phase = cleanLabel(entry.phase);
		if (label) next.label = label;
		if (phase) next.phase = phase;
		if (entry.runId === undefined) delete next.runId;
		else next.runId = entry.runId;
		if (entry.durationMs === undefined) delete next.durationMs;
		else next.durationMs = entry.durationMs;
		if (entry.error === undefined) delete next.error;
		else next.error = entry.error;
		rows.set(entry.key, next);
	}
	return [...rows.values()];
}
