export const MISSION_STATUSES = [
	"planned",
	"active",
	"waiting",
	"needs_decision",
	"completed",
	"failed",
	"cancelled",
] as const;

export type MissionStatus = typeof MISSION_STATUSES[number];
export type MissionRunMode = "single" | "parallel" | "chain" | "workflow" | "scheduled" | "external";
export type MissionArtifactKind = "status" | "output" | "patch" | "manifest" | "review" | "note" | "other";
export type MissionReceiptKind = "pull_request" | "ci" | "deployment" | "release";
export type MissionReceiptStatus = "pending" | "ready" | "succeeded" | "failed";
export type MissionGoalStatus = "active" | "paused" | "budget-exhausted";

export interface MissionGoal {
	status: MissionGoalStatus;
}

export interface MissionTokenBudget {
	tokens: number;
}

export interface MissionTokenUsage {
	tokens: number;
}

export interface MissionRunLink {
	runId: string;
	asyncDir?: string;
	childIndex?: number;
	agent?: string;
	mode: MissionRunMode;
	status?: string;
	startedAt?: string;
	completedAt?: string;
	usage?: MissionTokenUsage;
}

export interface MissionDecision {
	id: string;
	status: "open" | "resolved";
	title: string;
	prompt?: string;
	options?: string[];
	recommendation?: string;
	createdAt: string;
	resolvedAt?: string;
	resolution?: string;
}

export interface MissionArtifact {
	kind: MissionArtifactKind;
	path: string;
	description?: string;
}

export interface MissionReceipt {
	kind: MissionReceiptKind;
	status: MissionReceiptStatus;
	title: string;
	url: string;
	createdAt: string;
	description?: string;
}

export interface MissionRecord {
	schemaVersion: 1;
	id: string;
	title: string;
	objective: string;
	goal?: MissionGoal;
	budget?: MissionTokenBudget;
	usage?: MissionTokenUsage;
	status: MissionStatus;
	createdAt: string;
	updatedAt: string;
	cwd?: string;
	ownerSessionId?: string;
	runs: MissionRunLink[];
	decisions: MissionDecision[];
	artifacts: MissionArtifact[];
	receipts: MissionReceipt[];
	summary?: string;
	acceptance?: unknown;
	labels?: string[];
}

export interface MissionIndexEntry {
	schemaVersion: 1;
	missionId: string;
	projectRoot: string;
	recordPath: string;
	title: string;
	status: MissionStatus;
	updatedAt: string;
	lastRunId?: string;
}

export interface MissionStoreConfig {
	enabled?: boolean;
	directory?: string;
	globalIndex?: boolean;
	globalIndexDir?: string;
	retainTerminal?: number;
}

export interface MissionStoreLocation {
	projectRoot: string;
	missionDir: string;
	globalIndexDir: string;
	writeGlobalIndex: boolean;
	retainTerminal?: number;
}

export interface MissionListResult {
	records: MissionRecord[];
	warnings: string[];
}

export interface GlobalMissionIndexRecord extends MissionIndexEntry {
	stale: boolean;
	staleReason?: string;
}

export interface GlobalMissionListResult {
	entries: GlobalMissionIndexRecord[];
	warnings: string[];
}

export interface MissionCreateInput {
	title: string;
	objective: string;
	goal?: boolean;
	budget?: MissionTokenBudget;
	status?: MissionStatus;
	labels?: string[];
	ownerSessionId?: string;
}

export interface MissionUpdateInput {
	title?: string;
	objective?: string;
	goal?: MissionGoal | false;
	budget?: MissionTokenBudget;
	usage?: MissionTokenUsage;
	status?: MissionStatus;
	summary?: string;
	labels?: string[];
	acceptance?: unknown;
	addRuns?: MissionRunLink[];
	addArtifacts?: MissionArtifact[];
	addDecisions?: Array<Omit<MissionDecision, "id" | "status" | "createdAt">>;
	addReceipts?: Array<Omit<MissionReceipt, "createdAt">>;
}
