import type { AsyncStatus, ManagedWorktreeProvider, WorktreeNaming, WorkflowLaneMetadata, WorkflowLaneMode } from "../../shared/types.ts";

export const WORKFLOW_LANE_KEY_MAX_BYTES = 128;
export const WORKFLOW_LANE_SOURCE_REF_MAX_BYTES = 128;
export const WORKFLOW_LANE_CLAIM_MAX_BYTES = 160;
export const WORKFLOW_LANE_CLAIMS_MAX = 20;
export const WORKFLOW_LANE_OUTPUT_PATH_MAX_BYTES = 256;
export const WORKFLOW_LANE_OUTPUT_PATHS_MAX = 10;
export const WORKTREE_STATUS_PATH_MAX_BYTES = 4096;
export const WORKTREE_STATUS_BRANCH_MAX_BYTES = 256;
export const WORKTREE_STATUS_NAMING_LABEL_MAX_BYTES = 256;

const WORKFLOW_LANE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKFLOW_LANE_MODES = new Set<WorkflowLaneMode>(["mutation", "review", "scout", "gate"]);

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedNonEmptyString(value: unknown, label: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	const normalized = value.trim();
	if (byteLength(normalized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
	if ([...normalized].some((character) => character === "\n" || character === "\r" || character === "\u0000")) throw new Error(`${label} must not contain newlines or NUL bytes.`);
	return normalized;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
		throw new Error(`${label} must be a plain JSON object.`);
	}
}

function assertKnownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
	const unknown = Object.keys(value).filter((field) => !fields.includes(field));
	if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
}

function boundedStringArray(value: unknown, label: string, maxItems: number, maxBytes: number): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	if (value.length > maxItems) throw new Error(`${label} supports at most ${maxItems} entries.`);
	return value.map((entry, index) => {
		if (!Object.hasOwn(value, index)) throw new Error(`${label} must not contain sparse entries.`);
		return boundedNonEmptyString(entry, `${label}[${index}]`, maxBytes);
	});
}

/** Normalize and validate launch-declared lane metadata. */
export function normalizeWorkflowLaneMetadata(value: unknown, label = "lane"): WorkflowLaneMetadata | undefined {
	if (value === undefined) return undefined;
	assertPlainObject(value, label);
	assertKnownFields(value, ["version", "key", "mode", "sourceRef", "claims", "outputPaths"], label);
	if (value.version !== 1) throw new Error(`${label}.version must be 1.`);
	const key = boundedNonEmptyString(value.key, `${label}.key`, WORKFLOW_LANE_KEY_MAX_BYTES);
	if (!WORKFLOW_LANE_KEY_PATTERN.test(key)) throw new Error(`${label}.key is invalid.`);
	const mode = value.mode;
	if (mode !== undefined && (typeof mode !== "string" || !WORKFLOW_LANE_MODES.has(mode as WorkflowLaneMode))) throw new Error(`${label}.mode is invalid.`);
	const sourceRef = value.sourceRef === undefined ? undefined : boundedNonEmptyString(value.sourceRef, `${label}.sourceRef`, WORKFLOW_LANE_SOURCE_REF_MAX_BYTES);
	const claims = value.claims === undefined ? undefined : boundedStringArray(value.claims, `${label}.claims`, WORKFLOW_LANE_CLAIMS_MAX, WORKFLOW_LANE_CLAIM_MAX_BYTES);
	const outputPaths = value.outputPaths === undefined ? undefined : boundedStringArray(value.outputPaths, `${label}.outputPaths`, WORKFLOW_LANE_OUTPUT_PATHS_MAX, WORKFLOW_LANE_OUTPUT_PATH_MAX_BYTES);
	return {
		version: 1,
		key,
		...(mode !== undefined ? { mode: mode as WorkflowLaneMode } : {}),
		...(sourceRef !== undefined ? { sourceRef } : {}),
		...(claims !== undefined ? { claims } : {}),
		...(outputPaths !== undefined ? { outputPaths } : {}),
	};
}

export function assertWorkflowLaneKey(lane: WorkflowLaneMetadata | undefined, workflowKey: string | undefined, label = "lane"): void {
	if (!lane || workflowKey === undefined) return;
	if (lane.key !== workflowKey) throw new Error(`${label}.key '${lane.key}' does not match workflow key '${workflowKey}'.`);
}

export interface WorktreeStatusReference {
	worktreePath: string;
	branch: string;
	provider?: ManagedWorktreeProvider;
	naming?: WorktreeNaming;
}

function normalizeWorktreeNaming(value: unknown, label: string): WorktreeNaming {
	assertPlainObject(value, label);
	assertKnownFields(value, ["requestedBranch", "branchPrefix", "label", "sanitizedPathComponent", "collision", "collisionSuffix"], label);
	const collision = value.collision;
	if (collision !== undefined && collision !== "branch" && collision !== "path" && collision !== "both") throw new Error(`${label}.collision is invalid.`);
	return {
		requestedBranch: boundedNonEmptyString(value.requestedBranch, `${label}.requestedBranch`, WORKTREE_STATUS_BRANCH_MAX_BYTES),
		branchPrefix: boundedNonEmptyString(value.branchPrefix, `${label}.branchPrefix`, WORKTREE_STATUS_BRANCH_MAX_BYTES),
		label: boundedNonEmptyString(value.label, `${label}.label`, WORKTREE_STATUS_NAMING_LABEL_MAX_BYTES),
		sanitizedPathComponent: boundedNonEmptyString(value.sanitizedPathComponent, `${label}.sanitizedPathComponent`, WORKTREE_STATUS_NAMING_LABEL_MAX_BYTES),
		...(collision !== undefined ? { collision } : {}),
		...(value.collisionSuffix !== undefined ? { collisionSuffix: boundedNonEmptyString(value.collisionSuffix, `${label}.collisionSuffix`, WORKTREE_STATUS_NAMING_LABEL_MAX_BYTES) } : {}),
	};
}

/** Validate the display-only worktree fields copied into status.json. */
export function normalizeWorktreeStatusReference(value: unknown, label = "worktree status reference"): WorktreeStatusReference | undefined {
	if (value === undefined) return undefined;
	assertPlainObject(value, label);
	assertKnownFields(value, ["worktreePath", "branch", "provider", "naming"], label);
	if (value.provider !== undefined && value.provider !== "native" && value.provider !== "worktrunk") throw new Error(`${label}.provider is invalid.`);
	return {
		worktreePath: boundedNonEmptyString(value.worktreePath, `${label}.worktreePath`, WORKTREE_STATUS_PATH_MAX_BYTES),
		branch: boundedNonEmptyString(value.branch, `${label}.branch`, WORKTREE_STATUS_BRANCH_MAX_BYTES),
		...(value.provider !== undefined ? { provider: value.provider as ManagedWorktreeProvider } : {}),
		...(value.naming !== undefined ? { naming: normalizeWorktreeNaming(value.naming, `${label}.naming`) } : {}),
	};
}

/** Validate only the additive lane/worktree fields of a persisted async status. */
export function validateAsyncStatusLaneMetadata(status: Pick<AsyncStatus, "runId" | "workflowKey" | "lane" | "steps">, label = "async status"): void {
	const lane = normalizeWorkflowLaneMetadata(status.lane, `${label}.lane`);
	assertWorkflowLaneKey(lane, status.workflowKey, `${label}.lane`);
	if (lane) status.lane = lane;
	for (const [index, step] of (status.steps ?? []).entries()) {
		const stepLane = normalizeWorkflowLaneMetadata(step.lane, `${label}.steps[${index}].lane`);
		assertWorkflowLaneKey(stepLane, step.workflowKey, `${label}.steps[${index}].lane`);
		if (stepLane) step.lane = stepLane;
		const hasPath = step.worktreePath !== undefined;
		const hasBranch = step.branch !== undefined;
		if (hasPath !== hasBranch) throw new Error(`${label}.steps[${index}] must include both worktreePath and branch.`);
		if (hasPath) normalizeWorktreeStatusReference({ worktreePath: step.worktreePath, branch: step.branch, ...(step.provider ? { provider: step.provider } : {}), ...(step.naming ? { naming: step.naming } : {}) }, `${label}.steps[${index}]`);
	}
}
