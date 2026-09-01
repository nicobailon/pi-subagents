import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { stableJsonDigest } from "../../shared/launch-contract.ts";
import type {
	CleanupEligibility,
	ParallelHandoffGroup,
	ParallelHandoffManifest,
	ParallelHandoffReference,
	ParallelHandoffLaneBinding,
	ParallelHandoffMergeEvidence,
	ParallelHandoffSupersessionEvidence,
	SubagentResultStatus,
	WorkflowLaneMetadata,
} from "../../shared/types.ts";
import type {
	WorktreeCleanupReport,
	WorktreeDiff,
	WorktreeSetup,
	WorktreeCleanupIntent,
} from "./worktree.ts";
import { cleanupWorktrees } from "./worktree.ts";
import { assertWorkflowLaneKey, normalizeWorkflowLaneMetadata } from "./lane-metadata.ts";

export interface ParallelHandoffResult {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	outputPath?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	sessionPath?: string;
	workflowKey?: string;
	runId?: string;
	lane?: WorkflowLaneMetadata;
}

function optionalIdentity(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value.trim();
}

function nonNegativeIndex(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer.`);
	return value as number;
}

function normalizeLaneBinding(value: unknown, label: string): ParallelHandoffLaneBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const binding = value as Record<string, unknown>;
	const unknown = Object.keys(binding).filter((field) => !["index", "taskIndex", "workflowKey", "runId", "lane"].includes(field));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
	const index = nonNegativeIndex(binding.index, `${label}.index`);
	const taskIndex = nonNegativeIndex(binding.taskIndex, `${label}.taskIndex`);
	const workflowKey = optionalIdentity(binding.workflowKey, `${label}.workflowKey`);
	const runId = optionalIdentity(binding.runId, `${label}.runId`);
	const lane = normalizeWorkflowLaneMetadata(binding.lane, `${label}.lane`);
	assertWorkflowLaneKey(lane, workflowKey, `${label}.lane`);
	return {
		index,
		taskIndex,
		...(workflowKey ? { workflowKey } : {}),
		...(runId ? { runId } : {}),
		...(lane ? { lane } : {}),
	};
}

function validateManifestIdentity(parsed: ParallelHandoffManifest, manifestPath: string): ParallelHandoffManifest {
	if (parsed.version !== 1 || !Array.isArray(parsed.groups)) {
		throw new Error(`Invalid parallel handoff manifest: ${manifestPath}`);
	}
	if (typeof parsed.runId !== "string" || !parsed.runId.trim()) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': runId must be a non-empty string.`);
	parsed.runId = parsed.runId.trim();
	const workflowKeys = new Set<string>();
	const childRunIds = new Set<string>();
	const childIndexes = new Set<number>();
	for (const [groupIndex, group] of parsed.groups.entries()) {
		if (!group || typeof group !== "object" || !Array.isArray(group.children) || !group.cleanup || !Array.isArray(group.cleanup.tasks)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}] is malformed.`);
		if (group.laneBindings !== undefined) {
			if (!Array.isArray(group.laneBindings)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].laneBindings must be an array.`);
			const taskIndexes = new Set<number>();
			const cleanupIndexes = new Set(group.cleanup.tasks.map((task) => task.index));
			group.laneBindings = group.laneBindings.map((binding, bindingIndex) => {
				const normalized = normalizeLaneBinding(binding, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].laneBindings[${bindingIndex}]`);
				if (taskIndexes.has(normalized.taskIndex)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}] has duplicate lane binding taskIndex ${normalized.taskIndex}.`);
				if (!cleanupIndexes.has(normalized.taskIndex)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].laneBindings[${bindingIndex}] has no cleanup task for taskIndex ${normalized.taskIndex}.`);
				taskIndexes.add(normalized.taskIndex);
				return normalized;
			});
		}
		const taskIndexes = new Set<number>();
		for (const [childIndex, child] of group.children.entries()) {
			if (!child || typeof child !== "object" || !child.patch || typeof child.patch !== "object") throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}] is malformed.`);
			const childRecord = child as unknown as Record<string, unknown>;
			const index = nonNegativeIndex(childRecord.index, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].index`);
			const taskIndex = nonNegativeIndex(childRecord.taskIndex, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].taskIndex`);
			if (taskIndexes.has(taskIndex)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}] has duplicate child taskIndex ${taskIndex}.`);
			taskIndexes.add(taskIndex);
			if (childIndexes.has(index)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': duplicate child index ${index}.`);
			childIndexes.add(index);
			if (!group.cleanup.tasks.some((task) => task.index === taskIndex)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}] has no cleanup task for taskIndex ${taskIndex}.`);
			const workflowKey = optionalIdentity(childRecord.workflowKey, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].workflowKey`);
			const runId = optionalIdentity(childRecord.runId, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].runId`);
			const lane = normalizeWorkflowLaneMetadata(childRecord.lane, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].lane`);
			assertWorkflowLaneKey(lane, workflowKey, `Invalid parallel handoff manifest '${manifestPath}': groups[${groupIndex}].children[${childIndex}].lane`);
			if (workflowKey && workflowKeys.has(workflowKey)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': duplicate workflow key '${workflowKey}'.`);
			if (workflowKey) workflowKeys.add(workflowKey);
			if (runId && childRunIds.has(runId)) throw new Error(`Invalid parallel handoff manifest '${manifestPath}': duplicate child run id '${runId}'.`);
			if (runId) childRunIds.add(runId);
			if (lane) childRecord.lane = lane;
			if (workflowKey) childRecord.workflowKey = workflowKey;
			if (runId) childRecord.runId = runId;
			childRecord.index = index;
			childRecord.taskIndex = taskIndex;
		}
	}
	return parsed;
}

export function readParallelHandoffManifest(manifestPath: string): ParallelHandoffManifest | undefined {
	if (!fs.existsSync(manifestPath)) return undefined;
	const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ParallelHandoffManifest;
	return validateManifestIdentity(parsed, manifestPath);
}

export function resolveParallelHandoffChild(input: {
	manifestPath: string;
	runId: string;
	workflowKey?: string;
	childRunId?: string;
}): { group: ParallelHandoffGroup; child: ParallelHandoffGroup["children"][number] } | undefined {
	const manifest = readParallelHandoffManifest(input.manifestPath);
	if (!manifest) return undefined;
	if (manifest.runId !== input.runId) throw new Error(`Managed worktree handoff belongs to run '${manifest.runId}', not '${input.runId}'.`);
	const workflowKey = input.workflowKey?.trim() || undefined;
	const childRunId = input.childRunId?.trim() || undefined;
	if (!workflowKey && !childRunId) throw new Error("Parallel handoff child resolution requires workflowKey or childRunId.");
	const matches = manifest.groups.flatMap((group) => group.children.map((child) => ({ group, child }))).filter(({ child }) => {
		if (workflowKey && child.workflowKey !== workflowKey) return false;
		if (childRunId && child.runId !== childRunId) return false;
		return true;
	});
	if (matches.length > 1) throw new Error(`Parallel handoff has multiple children matching workflow identity${workflowKey ? ` '${workflowKey}'` : ` '${childRunId}'`}.`);
	return matches[0];
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
	const manifest = readParallelHandoffManifest(manifestPath);
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
		...(Object.prototype.hasOwnProperty.call(manifest, "cleanupEligibility")
			? { cleanupEligibility: trustedStoredCleanupEligibility(manifest) }
			: {}),
	};
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const MANIFEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_ATTESTATION_ACTOR_LENGTH = 128;
const MAX_ATTESTATION_TIMESTAMP_LENGTH = 64;
const MAX_SUPERSESSION_ID_LENGTH = 128;

function boundedString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	const normalized = value.trim();
	if (normalized.includes("\n") || normalized.includes("\r")) throw new Error(`${label} must not contain newlines.`);
	if (Buffer.byteLength(normalized, "utf-8") > maxBytes) throw new Error(`${label} must be at most ${maxBytes} bytes.`);
	return normalized;
}

function commitString(value: unknown, label: string): string {
	const normalized = boundedString(value, label, 64).toLowerCase();
	if (!COMMIT_PATTERN.test(normalized)) throw new Error(`${label} must be a full 40-character commit SHA.`);
	return normalized;
}

function manifestDigestString(value: unknown, label: string): string {
	const normalized = boundedString(value, label, 64).toLowerCase();
	if (!MANIFEST_DIGEST_PATTERN.test(normalized)) throw new Error(`${label} must be a full 64-character SHA-256 digest.`);
	return normalized;
}

function manifestFactsDigest(manifest: ParallelHandoffManifest): string {
	return stableJsonDigest({
		version: manifest.version,
		runId: manifest.runId,
		mode: manifest.mode,
		source: manifest.source,
		cwd: manifest.cwd,
		groups: manifest.groups,
	});
}

function attestationTimestamp(value: unknown): string {
	const normalized = boundedString(value, "attestedAt", MAX_ATTESTATION_TIMESTAMP_LENGTH);
	if (!Number.isFinite(Date.parse(normalized))) throw new Error("attestedAt must be a valid timestamp.");
	return normalized;
}

function normalizeMergeEvidence(value: unknown): ParallelHandoffMergeEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("merge must be an object.");
	const merge = value as Record<string, unknown>;
	const prNumber = merge.prNumber;
	if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber < 1) throw new Error("merge.prNumber must be a positive integer.");
	const treeEquivalent = merge.treeEquivalent;
	if (treeEquivalent !== true && treeEquivalent !== false && treeEquivalent !== "unknown") throw new Error("merge.treeEquivalent must be true, false, or 'unknown'.");
	const postMergeChecks = merge.postMergeChecks;
	if (postMergeChecks !== "recorded" && postMergeChecks !== "unknown") throw new Error("merge.postMergeChecks must be 'recorded' or 'unknown'.");
	return {
		prNumber,
		reviewedHead: commitString(merge.reviewedHead, "merge.reviewedHead"),
		mergeCommit: commitString(merge.mergeCommit, "merge.mergeCommit"),
		treeEquivalent,
		postMergeChecks,
		attestedBy: boundedString(merge.attestedBy, "merge.attestedBy", MAX_ATTESTATION_ACTOR_LENGTH),
		attestedAt: attestationTimestamp(merge.attestedAt),
		...(merge.manifestDigest === undefined ? {} : { manifestDigest: manifestDigestString(merge.manifestDigest, "merge.manifestDigest") }),
	};
}

function normalizeSupersessionEvidence(value: unknown): ParallelHandoffSupersessionEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("supersession must be an object.");
	const supersession = value as Record<string, unknown>;
	return {
		supersededBy: boundedString(supersession.supersededBy, "supersession.supersededBy", MAX_SUPERSESSION_ID_LENGTH),
		attestedBy: boundedString(supersession.attestedBy, "supersession.attestedBy", MAX_ATTESTATION_ACTOR_LENGTH),
		attestedAt: attestationTimestamp(supersession.attestedAt),
		...(supersession.manifestDigest === undefined ? {} : { manifestDigest: manifestDigestString(supersession.manifestDigest, "supersession.manifestDigest") }),
	};
}

function normalizeStoredCleanupEligibility(value: unknown): CleanupEligibility {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unknown" };
	const eligibility = value as Record<string, unknown>;
	if (eligibility.state === "active" || eligibility.state === "terminal-eligible" || eligibility.state === "superseded-eligible" || eligibility.state === "unknown") {
		return { state: eligibility.state };
	}
	if (eligibility.state === "terminal-blocked" && typeof eligibility.reason === "string" && eligibility.reason.trim() && !eligibility.reason.includes("\n") && !eligibility.reason.includes("\r")) {
		return { state: "terminal-blocked", reason: eligibility.reason.trim().slice(0, 256) };
	}
	return { state: "unknown" };
}

const STORED_CHILD_STATUSES = new Set(["pending", "running", "completed", "complete", "failed", "paused", "stopped", "detached", "rejected"]);

export function isTerminalParallelHandoffChildStatus(status: unknown): boolean {
	return status === "completed" || status === "complete" || status === "failed" || status === "paused" || status === "stopped" || status === "rejected";
}

function hasValidStoredLaneShape(manifest: ParallelHandoffManifest): boolean {
	if (!manifest || typeof manifest !== "object" || manifest.version !== 1 || typeof manifest.runId !== "string" || !manifest.runId.trim() || !Array.isArray(manifest.groups) || manifest.groups.length === 0) return false;
	let hasManagedTask = false;
	const valid = manifest.groups.every((group) => {
		if (!group || typeof group !== "object" || typeof group.baseCommit !== "string" || !group.baseCommit.trim() || typeof group.repoRoot !== "string" || !group.repoRoot.trim()) return false;
		const cleanup = group.cleanup;
		if (!cleanup || typeof cleanup !== "object" || (cleanup.state !== "complete" && cleanup.state !== "partial") || !Array.isArray(cleanup.tasks) || !Array.isArray(group.children)) return false;
		if (cleanup.tasks.some((task) => !task || typeof task !== "object" || !Number.isSafeInteger(task.index) || task.index < 0 || typeof task.path !== "string" || !task.path.trim() || typeof task.branch !== "string" || !task.branch.trim())) return false;
		if (cleanup.tasks.length > 0) hasManagedTask = true;
		return group.children.every((child) => Boolean(child) && typeof child === "object" && typeof child.status === "string" && STORED_CHILD_STATUSES.has(child.status));
	});
	return valid && hasManagedTask;
}

function trustedStoredCleanupEligibility(manifest: ParallelHandoffManifest): CleanupEligibility {
	const eligibility = normalizeStoredCleanupEligibility(manifest.cleanupEligibility);
	if (!hasValidStoredLaneShape(manifest)) return { state: "unknown" };
	if (hasActiveChildren(manifest)) return { state: "active" };
	if (eligibility.state === "active") return cleanupEligibilityForEvidence(manifest);
	if (eligibility.state === "terminal-eligible" || eligibility.state === "superseded-eligible") {
		const current = cleanupEligibilityForEvidence(manifest);
		if (current.state === eligibility.state || (current.state === "terminal-blocked" && / evidence is stale$/.test(current.reason))) return current;
		return { state: "unknown" };
	}
	return eligibility;
}

function hasActiveChildren(manifest: ParallelHandoffManifest): boolean {
	return Array.isArray(manifest.groups) && manifest.groups.some((group) => {
		if (!group || typeof group !== "object") return false;
		const children = Array.isArray(group.children) ? group.children : [];
		if (children.length === 0 && Array.isArray(group.cleanup?.tasks) && group.cleanup.tasks.length > 0) return true;
		return children.some((child) => !child || typeof child !== "object" || !isTerminalParallelHandoffChildStatus(child.status));
	});
}

function hasManagedWorktreeTasks(manifest: ParallelHandoffManifest): boolean {
	return manifest.groups.length > 0 && manifest.groups.some((group) => Array.isArray(group.cleanup?.tasks) && group.cleanup.tasks.length > 0);
}

function validateManifestForLaneEvidence(manifest: ParallelHandoffManifest, laneId: string): void {
	if (manifest.runId !== laneId) throw new Error(`Lane '${laneId}' does not match manifest run '${manifest.runId}'.`);
	if (!hasValidStoredLaneShape(manifest)) throw new Error("Lane manifest is malformed.");
	if (!manifest.groups.length || !hasManagedWorktreeTasks(manifest)) throw new Error("Lane manifest has no managed worktree tasks.");
	if (hasActiveChildren(manifest)) throw new Error("Lane has an active child owner; merge evidence must be recorded after local reconciliation.");
	for (const group of manifest.groups) {
		if (typeof group.repoRoot !== "string" || !group.repoRoot.trim()) throw new Error("Lane manifest has no valid repository root.");
		if (group.cleanup.state !== "complete" && group.cleanup.state !== "partial") throw new Error("Lane manifest has an invalid cleanup state.");
		if (!Array.isArray(group.cleanup.tasks) || group.cleanup.tasks.some((task) => typeof task.path !== "string" || !task.path.trim() || typeof task.branch !== "string" || !task.branch.trim())) {
			throw new Error("Lane manifest has an invalid cleanup task.");
		}
		if (!Array.isArray(group.children)) throw new Error("Lane manifest has invalid child records.");
		for (const child of group.children) {
			if (!STORED_CHILD_STATUSES.has(child.status)) {
				throw new Error("Lane manifest has an invalid child status.");
			}
		}
	}
}

function cleanupEligibilityForEvidence(manifest: ParallelHandoffManifest): CleanupEligibility {
	if (hasActiveChildren(manifest)) return { state: "active" };
	let merge: ParallelHandoffMergeEvidence | undefined;
	if (manifest.merge) {
		try {
			merge = normalizeMergeEvidence(manifest.merge);
		} catch {
			return { state: "terminal-blocked", reason: "stored merge evidence is invalid" };
		}
	}
	if (manifest.supersession) {
		try {
			const supersession = normalizeSupersessionEvidence(manifest.supersession);
			if (supersession.manifestDigest !== manifestFactsDigest(manifest)) return { state: "terminal-blocked", reason: "stored supersession evidence is stale" };
		} catch {
			return { state: "terminal-blocked", reason: "stored supersession evidence is invalid" };
		}
		return { state: "superseded-eligible" };
	}
	if (!merge) return { state: "terminal-blocked", reason: "no merge or supersession evidence recorded" };
	if (merge.manifestDigest !== manifestFactsDigest(manifest)) return { state: "terminal-blocked", reason: "stored merge evidence is stale" };
	if (merge.treeEquivalent !== true) {
		return { state: "terminal-blocked", reason: merge.treeEquivalent === "unknown" ? "merged tree equivalence was not attested" : "merged tree is not equivalent to the reviewed head" };
	}
	if (merge.postMergeChecks !== "recorded") return { state: "terminal-blocked", reason: "required post-merge checks were not recorded" };
	return { state: "terminal-eligible" };
}

function sameMergeEvidence(left: ParallelHandoffMergeEvidence, right: ParallelHandoffMergeEvidence): boolean {
	return left.prNumber === right.prNumber
		&& left.reviewedHead === right.reviewedHead
		&& left.mergeCommit === right.mergeCommit
		&& left.treeEquivalent === right.treeEquivalent
		&& left.postMergeChecks === right.postMergeChecks
		&& left.attestedBy === right.attestedBy
		&& left.attestedAt === right.attestedAt;
}

function sameSupersessionEvidence(left: ParallelHandoffSupersessionEvidence, right: ParallelHandoffSupersessionEvidence): boolean {
	return left.supersededBy === right.supersededBy && left.attestedBy === right.attestedBy && left.attestedAt === right.attestedAt;
}

function firstRepositoryRoot(manifest: ParallelHandoffManifest): string | undefined {
	const repoRoot = Array.isArray(manifest.groups) ? manifest.groups[0]?.repoRoot : undefined;
	return typeof repoRoot === "string" && repoRoot.trim() ? repoRoot.trim() : undefined;
}

function formatCleanupCommand(manifestPath: string, manifest: ParallelHandoffManifest): string | undefined {
	const repoRoot = firstRepositoryRoot(manifest);
	return repoRoot ? `subagent({ action: "worktree.cleanup", repo: ${JSON.stringify(repoRoot)}, handoffPath: ${JSON.stringify(manifestPath)}, mode: "plan" })` : undefined;
}

export function formatStoredParallelHandoffCleanup(manifestPath: string, manifest?: ParallelHandoffManifest): string {
	let stored = manifest;
	if (!stored) {
		try {
			stored = readParallelHandoffManifest(manifestPath);
		} catch {
			stored = undefined;
		}
	}
	if (!stored) return ["Cleanup eligibility: unknown", "Reason: lane manifest is missing or invalid; removal is not safe.", `Plan command: subagent({ action: "worktree.cleanup", handoffPath: ${JSON.stringify(manifestPath)}, mode: "plan" })`].join("\n");
	const eligibility = trustedStoredCleanupEligibility(stored);
	const lines = [`Cleanup eligibility: ${eligibility.state}`];
	if (eligibility.state === "terminal-blocked") lines.push(`Reason: ${eligibility.reason}`);
	if (eligibility.state === "unknown") lines.push("Reason: stored eligibility is missing or invalid; removal is not safe.");
	if (eligibility.state === "active") lines.push("Reason: a child owner is still active; removal is not safe.");
	const command = formatCleanupCommand(manifestPath, stored);
	if (command) lines.push(`Plan command: ${command}`);
	return lines.join("\n");
}

export interface ParallelHandoffEvidenceResult {
	manifest: ParallelHandoffManifest;
	reference: ParallelHandoffReference;
	text: string;
}

export function recordParallelHandoffMerge(input: { manifestPath: string; laneId: string; merge: unknown; now?: number }): ParallelHandoffEvidenceResult {
	const manifest = readParallelHandoffManifest(input.manifestPath);
	if (!manifest) throw new Error(`Parallel handoff manifest not found: ${input.manifestPath}`);
	validateManifestForLaneEvidence(manifest, boundedString(input.laneId, "laneId", MAX_SUPERSESSION_ID_LENGTH));
	if (hasActiveChildren(manifest)) throw new Error("Lane has an active child owner; merge evidence must be recorded after local reconciliation.");
	const merge = { ...normalizeMergeEvidence(input.merge), manifestDigest: manifestFactsDigest(manifest) };
	if (manifest.merge) {
		const existing = normalizeMergeEvidence(manifest.merge);
		if (existing.reviewedHead !== merge.reviewedHead) throw new Error(`Lane manifest is stale: reviewed head is already recorded as ${existing.reviewedHead}.`);
		if (!sameMergeEvidence(existing, merge)) throw new Error("Lane manifest already contains different merge evidence for this reviewed head.");
	}
	const reconciled: ParallelHandoffManifest = { ...manifest, merge };
	delete reconciled.supersession;
	const updated: ParallelHandoffManifest = { ...reconciled, cleanupEligibility: cleanupEligibilityForEvidence(reconciled), updatedAt: input.now ?? Date.now() };
	writeAtomicJson(input.manifestPath, updated);
	return { manifest: updated, reference: referenceFor(input.manifestPath, updated), text: formatStoredParallelHandoffCleanup(input.manifestPath, updated) };
}

export function recordParallelHandoffSupersession(input: { manifestPath: string; laneId: string; supersession: unknown; now?: number }): ParallelHandoffEvidenceResult {
	const manifest = readParallelHandoffManifest(input.manifestPath);
	if (!manifest) throw new Error(`Parallel handoff manifest not found: ${input.manifestPath}`);
	const laneId = boundedString(input.laneId, "laneId", MAX_SUPERSESSION_ID_LENGTH);
	validateManifestForLaneEvidence(manifest, laneId);
	if (hasActiveChildren(manifest)) throw new Error("Lane has an active child owner; supersession must be recorded after local reconciliation.");
	const supersession = { ...normalizeSupersessionEvidence(input.supersession), manifestDigest: manifestFactsDigest(manifest) };
	if (supersession.supersededBy === laneId) throw new Error("supersession.supersededBy must identify a different replacement lane.");
	if (manifest.supersession) {
		const existing = normalizeSupersessionEvidence(manifest.supersession);
		if (!sameSupersessionEvidence(existing, supersession)) throw new Error("Lane manifest already contains different supersession evidence.");
	}
	const updated: ParallelHandoffManifest = { ...manifest, supersession, cleanupEligibility: cleanupEligibilityForEvidence({ ...manifest, supersession }), updatedAt: input.now ?? Date.now() };
	writeAtomicJson(input.manifestPath, updated);
	return { manifest: updated, reference: referenceFor(input.manifestPath, updated), text: formatStoredParallelHandoffCleanup(input.manifestPath, updated) };
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
	laneBindings?: ParallelHandoffLaneBinding[];
	now?: number;
}): ParallelHandoffReference {
	const now = input.now ?? Date.now();
	const existing = readParallelHandoffManifest(input.manifestPath);
	if (existing && (existing.runId !== input.runId || existing.mode !== input.mode || existing.source !== input.source)) {
		throw new Error(`Parallel handoff manifest belongs to a different run: ${input.manifestPath}`);
	}
	const laneBindings = input.laneBindings?.map((binding, index) => normalizeLaneBinding(binding, `parallel handoff lane binding ${index}`));
	if (laneBindings) {
		const taskIndexes = new Set<number>();
		for (const binding of laneBindings) {
			if (taskIndexes.has(binding.taskIndex)) throw new Error(`Parallel handoff has duplicate lane binding taskIndex ${binding.taskIndex}.`);
			if (!input.setup.worktrees.some((worktree) => worktree.index === binding.taskIndex)) throw new Error(`Parallel handoff lane binding taskIndex ${binding.taskIndex} has no managed worktree.`);
			if (binding.index !== input.flatStartIndex + binding.taskIndex) throw new Error(`Parallel handoff lane binding index ${binding.index} does not match taskIndex ${binding.taskIndex}.`);
			taskIndexes.add(binding.taskIndex);
		}
	}
	const bindingForTask = (taskIndex: number): ParallelHandoffLaneBinding | undefined => laneBindings?.find((binding) => binding.taskIndex === taskIndex);
	const group: ParallelHandoffGroup = {
		stepIndex: input.stepIndex,
		baseCommit: input.setup.baseCommit,
		repoRoot: input.setup.cwd,
		children: input.results.map((result, taskIndex) => {
			const binding = bindingForTask(taskIndex);
			const runId = optionalIdentity(result.runId ?? binding?.runId, `parallel handoff child ${taskIndex}.runId`);
			const lane = normalizeWorkflowLaneMetadata(result.lane ?? binding?.lane, `parallel handoff child ${taskIndex}.lane`);
			const workflowKey = optionalIdentity(result.workflowKey ?? binding?.workflowKey, `parallel handoff child ${taskIndex}.workflowKey`);
			assertWorkflowLaneKey(lane, workflowKey, `parallel handoff child ${taskIndex}.lane`);
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
				...(workflowKey ? { workflowKey } : {}),
				...(runId ? { runId } : {}),
				...(lane ? { lane } : {}),
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
		...(laneBindings && laneBindings.length > 0 && input.results.length === 0 ? { laneBindings } : {}),
		cleanup: input.cleanup ?? {
			state: "partial",
			pruned: false,
			tasks: input.setup.worktrees.map((worktree) => ({
				index: worktree.index,
				path: worktree.path,
				branch: worktree.branch,
				...(worktree.provider ? { provider: worktree.provider } : {}),
				...(worktree.naming ? { naming: worktree.naming } : {}),
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
	const manifestWithoutEligibility: ParallelHandoffManifest = {
		version: 1,
		runId: input.runId,
		mode: input.mode,
		source: input.source,
		cwd: input.cwd,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		groups,
		...(existing && Object.hasOwn(existing, "merge") ? { merge: existing.merge } : {}),
		...(existing && Object.hasOwn(existing, "supersession") ? { supersession: existing.supersession } : {}),
	};
	const carriesCleanupMetadata = existing !== undefined
		&& (Object.hasOwn(existing, "merge") || Object.hasOwn(existing, "supersession") || Object.hasOwn(existing, "cleanupEligibility"));
	const manifest: ParallelHandoffManifest = {
		...manifestWithoutEligibility,
		...(carriesCleanupMetadata
			? { cleanupEligibility: cleanupEligibilityForEvidence(manifestWithoutEligibility) }
			: {}),
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
	laneBindings?: ParallelHandoffLaneBinding[];
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
	const manifest = readParallelHandoffManifest(resolvedPath);
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
				...(task.provider ? { provider: task.provider } : {}),
				...(task.naming ? { naming: task.naming } : {}),
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
