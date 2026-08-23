/** Public, read-only current-work projection contract. */

export const CURRENT_WORK_PROJECTION_VERSION = 1 as const;
export const CURRENT_WORK_PROJECTION_KIND = "subagents.current-work" as const;
export const CURRENT_WORK_MAX_ROOTS = 32 as const;
export const CURRENT_WORK_MAX_CHILDREN = 32 as const;
export const CURRENT_WORK_MAX_DEPTH = 4 as const;
export const CURRENT_WORK_MAX_STRING_LENGTH = 160 as const;
export const CURRENT_WORK_MAX_SERIALIZED_BYTES = 32768 as const;

export type CurrentWorkState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
export type CurrentWorkMode = "single" | "chain" | "parallel";
export type CurrentWorkAttentionState = "active_long_running" | "needs_attention";

export interface CurrentWorkTokensV1 {
	input: number;
	output: number;
	total: number;
}

export interface CurrentWorkActivityV1 {
	state?: CurrentWorkAttentionState;
	currentTool?: string;
	lastActivityAt?: number;
	currentToolStartedAt?: number;
	turnCount?: number;
	toolCount?: number;
}

export interface CurrentWorkNodeV1 {
	/** Opaque, session-local reconciliation key. */
	key: string;
	goal?: string;
	agent?: string;
	role?: string;
	mode: CurrentWorkMode;
	state: CurrentWorkState;
	startedAt?: number;
	updatedAt?: number;
	endedAt?: number;
	activity?: CurrentWorkActivityV1;
	tokens?: CurrentWorkTokensV1;
	children?: CurrentWorkNodeV1[];
}

export interface CurrentWorkCapsV1 {
	maxRoots: number;
	maxChildrenPerNode: number;
	maxDepth: number;
	maxStringLength: number;
	maxSerializedBytes: number;
}

export interface CurrentWorkOmittedV1 {
	roots: number;
	children: number;
	byteLimitExceeded: boolean;
}

export interface CurrentWorkProjectionV1 {
	kind: typeof CURRENT_WORK_PROJECTION_KIND;
	version: typeof CURRENT_WORK_PROJECTION_VERSION;
	generatedAt: number;
	caps: CurrentWorkCapsV1;
	omitted: CurrentWorkOmittedV1;
	roots: CurrentWorkNodeV1[];
}
