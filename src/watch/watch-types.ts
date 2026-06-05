import type { AsyncJobState, AsyncJobStep, NestedRunSummary } from "../shared/types.ts";

export type WatchSectionTitle = "Active" | "Queued" | "Done";
export type WatchTargetStatus = "pending" | "queued" | "running" | "complete" | "completed" | "failed" | "paused";
export type WatchTab = "transcript" | "status" | "log";

export interface WatchTarget {
	id: string;
	rootRunId: string;
	rootAsyncDir: string;
	rootStatus: AsyncJobState["status"];
	stepIndex?: number;
	nestedRunId?: string;
	agent: string;
	displayName: string;
	status: WatchTargetStatus;
	phase?: string;
	label?: string;
	taskPreview?: string;
	sessionFile?: string;
	outputLog?: string;
	rootLog?: string;
	eventsFile?: string;
	statusFile?: string;
	currentTool?: string;
	activityState?: string;
	lastActivityAt?: number;
	startedAt?: number;
	endedAt?: number;
	toolCount?: number;
	tokens?: { input: number; output: number; total: number };
	error?: string;
	ancestry: string[];
	depth: number;
	rawStep?: AsyncJobStep;
	rawNested?: NestedRunSummary;
}

export interface WatchTreeRow {
	key: string;
	selectable: boolean;
	targetId?: string;
	depth: number;
	text: string;
}

export interface WatchSection {
	title: WatchSectionTitle;
	rows: WatchTreeRow[];
	targets: WatchTarget[];
}
