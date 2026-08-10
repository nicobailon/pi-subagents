import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import type { Details, SubagentRunMode } from "../shared/types.ts";
import { validateMissionLaunch } from "./actions.ts";
import type { MissionArtifact, MissionRecord, MissionRunLink, MissionRunMode, MissionStatus, MissionStoreConfig, MissionStoreLocation } from "./types.ts";
import { createMission, MissionNotFoundError, missionRecordPath, readMission, resolveMissionStoreLocation, updateMission, validateMissionId } from "./store.ts";

export const MISSION_BINDING_FILE = "mission.json";

export interface MissionLaunchParams {
	missionId?: string;
	mission?: unknown;
	task?: string;
	tasks?: Array<{ task?: string }>;
	chain?: Array<{ task?: string; parallel?: Array<{ task?: string }> | { task?: string } }>;
}

export interface MissionLaunchBinding {
	missionId: string;
	location: MissionStoreLocation;
	autoCreated: boolean;
	announceInContent?: boolean;
}

interface PersistedMissionBinding {
	schemaVersion: 1;
	missionId: string;
	projectRoot: string;
	missionDir: string;
	globalIndexDir: string;
	writeGlobalIndex: boolean;
	retainTerminal?: number;
}

function workflowObjective(params: MissionLaunchParams): string | undefined {
	const objective = params.task?.trim()
		|| params.tasks?.find((task) => task.task?.trim())?.task?.trim()
		|| params.chain?.find((step) => step.task?.trim())?.task?.trim();
	if (objective) return objective;
	for (const step of params.chain ?? []) {
		const parallel = Array.isArray(step.parallel) ? step.parallel : step.parallel ? [step.parallel] : [];
		const task = parallel.find((child) => child.task?.trim())?.task?.trim();
		if (task) return task;
	}
	return undefined;
}

function conciseTitle(objective: string): string {
	const firstLine = objective.split(/\r?\n/, 1)[0]?.trim() || objective.trim();
	return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

export function prepareMissionLaunch(input: {
	params: MissionLaunchParams;
	projectRoot: string;
	config?: MissionStoreConfig;
	ownerSessionId?: string;
}): MissionLaunchBinding | undefined {
	const hasMissionId = input.params.missionId !== undefined;
	if (hasMissionId && input.params.mission !== undefined) throw new Error("Use missionId or mission, not both");
	if (input.params.mission === false) return undefined;
	const objective = workflowObjective(input.params);
	const missionsEnabled = input.config?.enabled !== false;
	const shouldCreate = input.params.mission !== undefined || (missionsEnabled && objective !== undefined);
	if (!hasMissionId && !shouldCreate) return undefined;
	const location = resolveMissionStoreLocation({ projectRoot: input.projectRoot, ...(input.config ? { config: input.config } : {}) });
	if (hasMissionId) {
		const missionId = validateMissionId(input.params.missionId);
		readMission(location, missionId);
		updateMission(location, missionId, { status: "active" });
		return { missionId, location, autoCreated: false, announceInContent: true };
	}
	const mission = input.params.mission !== undefined ? validateMissionLaunch(input.params.mission) : undefined;
	const title = mission?.title || conciseTitle(objective!);
	const record = createMission(location, {
		title,
		objective: mission?.objective || objective || title,
		...(mission?.goal === true ? { goal: true as const } : {}),
		...(mission?.budget ? { budget: mission.budget } : {}),
		status: "active",
		...(mission?.labels ? { labels: mission.labels } : {}),
		...(input.ownerSessionId ? { ownerSessionId: input.ownerSessionId } : {}),
	}, new Date(), input.config?.retainTerminal);
	return { missionId: record.id, location, autoCreated: true, announceInContent: true };
}

function toolResultIsError(result: AgentToolResult<Details>): boolean {
	return "isError" in result && result.isError === true;
}

function missionRunModeForResult(mode: Details["mode"]): MissionRunMode {
	return mode === "management" ? "external" : mode;
}

function runStatusForResult(result: AgentToolResult<Details>): string {
	if (result.details.asyncDir) return "active";
	if (result.details.results.some((child) => child.interrupted || child.detached)) return "paused";
	if (toolResultIsError(result) || result.details.results.some((child) => child.exitCode !== 0)) return "failed";
	return "completed";
}

function missionStatusForRun(record: MissionRecord, runId: string, runStatus: string): MissionStatus {
	if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return record.status;
	if (runStatus === "active" || runStatus === "queued" || runStatus === "running") return "active";
	if (record.goal) return "active";
	if (runStatus === "paused") return "waiting";
	const otherActive = record.runs.some((run) => run.runId !== runId && (run.status === "active" || run.status === "queued" || run.status === "running"));
	if (otherActive) return "active";
	if (runStatus === "completed" || runStatus === "complete") return "completed";
	if (runStatus === "stopped" || runStatus === "rejected" || runStatus === "cancelled") return "cancelled";
	return "failed";
}

function usageForResult(result: AgentToolResult<Details>): { tokens: number } | undefined {
	const tokens = result.details.results.reduce((total, child) => total + child.usage.input + child.usage.output, 0);
	return tokens > 0 ? { tokens } : undefined;
}

function usageFromUnknown(value: unknown): { tokens: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const total = (value as { total?: unknown }).total;
	return Number.isSafeInteger(total) && (total as number) >= 0 ? { tokens: total as number } : undefined;
}

function artifactsForResult(result: AgentToolResult<Details>): MissionArtifact[] {
	const artifacts: MissionArtifact[] = [];
	if (result.details.asyncDir) {
		artifacts.push(
			{ kind: "status", path: path.join(result.details.asyncDir, "status.json") },
			{ kind: "other", path: path.join(result.details.asyncDir, "events.jsonl"), description: "Lifecycle events" },
		);
	}
	for (const child of result.details.results) {
		if (child.artifactPaths?.outputPath) artifacts.push({ kind: "output", path: child.artifactPaths.outputPath });
		if (child.savedOutputPath) artifacts.push({ kind: "output", path: child.savedOutputPath });
		if (child.transcriptPath) artifacts.push({ kind: "other", path: child.transcriptPath, description: "Child transcript" });
		if (child.structuredOutputPath) artifacts.push({ kind: "output", path: child.structuredOutputPath, description: "Structured output" });
	}
	if (result.details.parallelHandoff?.path) artifacts.push({ kind: "manifest", path: result.details.parallelHandoff.path });
	return artifacts;
}

function firstText(result: AgentToolResult<Details>): string | undefined {
	const text = result.content.find((item) => item.type === "text")?.text.trim();
	if (!text) return undefined;
	return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

function persistedBinding(binding: MissionLaunchBinding): PersistedMissionBinding {
	return {
		schemaVersion: 1,
		missionId: binding.missionId,
		projectRoot: binding.location.projectRoot,
		missionDir: binding.location.missionDir,
		globalIndexDir: binding.location.globalIndexDir,
		writeGlobalIndex: binding.location.writeGlobalIndex,
		...(binding.location.retainTerminal !== undefined ? { retainTerminal: binding.location.retainTerminal } : {}),
	};
}

export function writeMissionAsyncBinding(asyncDir: string, binding: MissionLaunchBinding): void {
	writePrivateAtomicJson(path.join(asyncDir, MISSION_BINDING_FILE), persistedBinding(binding));
}

export function attachMissionToLaunchResult(input: {
	binding: MissionLaunchBinding;
	result: AgentToolResult<Details>;
}): AgentToolResult<Details> {
	const runId = input.result.details.runId ?? input.result.details.asyncId;
	if (!runId) {
		const current = readMission(input.binding.location, input.binding.missionId);
		const activeRunExists = current.runs.some((run) => run.status === "active" || run.status === "queued" || run.status === "running");
		const mission = toolResultIsError(input.result)
			? updateMission(input.binding.location, input.binding.missionId, {
					status: activeRunExists ? "active" : "failed",
					...(firstText(input.result) ? { summary: firstText(input.result)! } : {}),
				})
			: current;
		return {
			...input.result,
			details: {
				...input.result.details,
				missionId: input.binding.missionId,
				missionPath: missionRecordPath(input.binding.location, input.binding.missionId),
				mission,
			},
		};
	}
	const runStatus = runStatusForResult(input.result);
	const current = readMission(input.binding.location, input.binding.missionId);
	const startedAt = new Date().toISOString();
	const usage = usageForResult(input.result);
	const run: MissionRunLink = {
		runId,
		mode: missionRunModeForResult(input.result.details.mode),
		status: runStatus,
		startedAt,
		...(input.result.details.asyncDir ? { asyncDir: input.result.details.asyncDir } : {}),
		...(input.result.details.results.length === 1 && input.result.details.results[0]?.agent ? { agent: input.result.details.results[0].agent } : {}),
		...(runStatus !== "active" ? { completedAt: startedAt } : {}),
		...(usage ? { usage } : {}),
	};
	let mission = updateMission(input.binding.location, input.binding.missionId, {
		status: missionStatusForRun(current, runId, runStatus),
		addRuns: [run],
		addArtifacts: artifactsForResult(input.result),
		...(firstText(input.result) && runStatus !== "active" ? { summary: firstText(input.result)! } : {}),
		...(input.result.details.results.length === 1 && input.result.details.results[0]?.acceptance ? { acceptance: input.result.details.results[0].acceptance } : {}),
	});
	if (input.result.details.asyncDir) {
		writeMissionAsyncBinding(input.result.details.asyncDir, input.binding);
		const statusPath = path.join(input.result.details.asyncDir, "status.json");
		if (fs.existsSync(statusPath)) {
			try {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as { state?: unknown };
				if (typeof status.state === "string" && !["queued", "running"].includes(status.state)) {
					mission = syncMissionFromAsyncCompletion({
						runId,
						asyncDir: input.result.details.asyncDir,
						mode: input.result.details.mode,
						state: status.state,
						...(firstText(input.result) ? { summary: firstText(input.result) } : {}),
					}) ?? mission;
				}
			} catch (error) {
				throw new Error(`Failed to reconcile mission from terminal async status '${statusPath}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	const lastTextIndex = input.result.content.findLastIndex((item) => item.type === "text");
	const hasStructuredOutput = input.result.details.results.some((child) => child.structuredOutputPath !== undefined);
	const textIsJson = lastTextIndex >= 0 && (() => {
		try {
			JSON.parse((input.result.content[lastTextIndex] as { type: "text"; text: string }).text);
			return true;
		} catch {
			return false;
		}
	})();
	return {
		...input.result,
		content: input.binding.announceInContent === true && lastTextIndex >= 0 && !hasStructuredOutput && !textIsJson
			? input.result.content.map((item, index) => index === lastTextIndex && item.type === "text"
				? { ...item, text: `${item.text}\nMission: ${mission.id} (${mission.status})` }
				: item)
			: input.result.content,
		details: {
			...input.result.details,
			missionId: mission.id,
			missionPath: missionRecordPath(input.binding.location, mission.id),
			mission,
		},
	};
}

function parsePersistedBinding(value: unknown, source: string): MissionLaunchBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be an object`);
	const input = value as Record<string, unknown>;
	if (input.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1`);
	for (const field of ["projectRoot", "missionDir", "globalIndexDir"] as const) {
		if (typeof input[field] !== "string" || !input[field].trim()) throw new Error(`${source}.${field} must be a non-empty string`);
	}
	if (typeof input.writeGlobalIndex !== "boolean") throw new Error(`${source}.writeGlobalIndex must be boolean`);
	if (input.retainTerminal !== undefined && (!Number.isInteger(input.retainTerminal) || (input.retainTerminal as number) < 1)) throw new Error(`${source}.retainTerminal must be a positive integer`);
	return {
		missionId: validateMissionId(input.missionId, `${source}.missionId`),
		autoCreated: false,
		location: {
			projectRoot: input.projectRoot as string,
			missionDir: input.missionDir as string,
			globalIndexDir: input.globalIndexDir as string,
			writeGlobalIndex: input.writeGlobalIndex,
			...(input.retainTerminal !== undefined ? { retainTerminal: input.retainTerminal as number } : {}),
		},
	};
}

export function readMissionBinding(asyncDir: string): MissionLaunchBinding | undefined {
	const bindingPath = path.join(asyncDir, MISSION_BINDING_FILE);
	if (!fs.existsSync(bindingPath)) return undefined;
	return parsePersistedBinding(JSON.parse(fs.readFileSync(bindingPath, "utf-8")), bindingPath);
}

export function syncMissionFromAsyncCompletion(value: unknown): MissionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as Record<string, unknown>;
	if (typeof event.asyncDir !== "string" || !event.asyncDir.trim()) return undefined;
	const binding = readMissionBinding(event.asyncDir);
	if (!binding) return undefined;
	const runId = typeof event.runId === "string" ? event.runId : typeof event.id === "string" ? event.id : undefined;
	if (!runId) throw new Error("Async mission completion is missing runId");
	const runStatus = typeof event.state === "string" ? event.state : event.success === true ? "completed" : "failed";
	let current: MissionRecord;
	try {
		current = readMission(binding.location, binding.missionId);
	} catch (error) {
		if (!(error instanceof MissionNotFoundError)) throw error;
		try {
			fs.appendFileSync(path.join(event.asyncDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.mission.sync.skipped",
				ts: Date.now(),
				runId,
				missionId: binding.missionId,
				reason: "mission-record-missing",
				missionPath: missionRecordPath(binding.location, binding.missionId),
			})}\n`, "utf-8");
		} catch {
			// Mission bookkeeping is secondary to preserving the completed async result.
		}
		return undefined;
	}
	const completedAt = new Date().toISOString();
	const artifacts: MissionArtifact[] = [
		{ kind: "status", path: path.join(event.asyncDir, "status.json") },
		{ kind: "other", path: path.join(event.asyncDir, "events.jsonl"), description: "Lifecycle events" },
	];
	if (event.parallelHandoff && typeof event.parallelHandoff === "object" && typeof (event.parallelHandoff as { path?: unknown }).path === "string") {
		artifacts.push({ kind: "manifest", path: (event.parallelHandoff as { path: string }).path });
	}
	if (Array.isArray(event.results)) {
		for (const result of event.results) {
			if (!result || typeof result !== "object") continue;
			const child = result as Record<string, unknown>;
			if (typeof child.artifactPath === "string") artifacts.push({ kind: "output", path: child.artifactPath });
			if (child.artifactPaths && typeof child.artifactPaths === "object" && typeof (child.artifactPaths as { outputPath?: unknown }).outputPath === "string") {
				artifacts.push({ kind: "output", path: (child.artifactPaths as { outputPath: string }).outputPath });
			}
		}
	}
	const summary = typeof event.summary === "string" && event.summary.trim() ? event.summary.slice(0, 2000) : undefined;
	const usage = usageFromUnknown(event.totalTokens)
		?? (Array.isArray(event.results)
			? { tokens: event.results.reduce((total, result) => {
				if (!result || typeof result !== "object") return total;
				return total + (usageFromUnknown((result as { tokens?: unknown }).tokens)?.tokens ?? 0);
			}, 0) }
			: undefined);
	const workflowRunId = typeof event.parentWorkflowRunId === "string" && event.parentWorkflowRunId.trim() ? event.parentWorkflowRunId.trim() : undefined;
	const workflowKey = typeof event.workflowKey === "string" && event.workflowKey.trim() ? event.workflowKey.trim() : undefined;
	const workflowChildStatus = runStatus === "complete" || runStatus === "completed" || event.success === true
		? "completed"
		: runStatus === "paused"
			? "paused"
			: runStatus === "stopped"
				? "stopped"
				: "failed";
	const workflowChildTerminal = !["running", "queued", "active", "paused"].includes(workflowChildStatus);
	return updateMission(binding.location, binding.missionId, {
		status: missionStatusForRun(current, runId, runStatus),
		addRuns: [{ runId, mode: typeof event.mode === "string" && ["single", "parallel", "chain", "workflow"].includes(event.mode) ? event.mode as SubagentRunMode : "external", asyncDir: event.asyncDir, status: runStatus, completedAt, ...(usage && usage.tokens > 0 ? { usage } : {}) }],
		addArtifacts: artifacts,
		...(workflowRunId && workflowKey ? { upsertWorkflowChildren: [{
			workflowRunId,
			key: workflowKey,
			runId,
			status: workflowChildStatus,
			artifactPaths: artifacts.map((artifact) => artifact.path),
			...(workflowChildTerminal ? { completedAt } : {}),
			heartbeat: { status: workflowChildStatus, ...(summary ? { message: summary } : {}) },
		}] } : {}),
		...(summary ? { summary } : {}),
	});
}
