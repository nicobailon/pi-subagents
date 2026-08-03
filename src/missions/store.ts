import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import { getAgentDir } from "../shared/utils.ts";
import {
	MISSION_STATUSES,
	type GlobalMissionIndexRecord,
	type GlobalMissionListResult,
	type MissionArtifact,
	type MissionArtifactKind,
	type MissionCreateInput,
	type MissionDecision,
	type MissionIndexEntry,
	type MissionListResult,
	type MissionReceipt,
	type MissionReceiptKind,
	type MissionReceiptStatus,
	type MissionRecord,
	type MissionRunLink,
	type MissionRunMode,
	type MissionStatus,
	type MissionStoreConfig,
	type MissionStoreLocation,
	type MissionUpdateInput,
} from "./types.ts";

const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MISSION_RUN_MODES = new Set<MissionRunMode>(["single", "parallel", "chain", "workflow", "scheduled", "external"]);
const MISSION_ARTIFACT_KINDS = new Set<MissionArtifactKind>(["status", "output", "patch", "manifest", "review", "note", "other"]);
const MISSION_RECEIPT_KINDS = new Set<MissionReceiptKind>(["pull_request", "ci", "deployment", "release"]);
const MISSION_RECEIPT_STATUSES = new Set<MissionReceiptStatus>(["pending", "ready", "succeeded", "failed"]);
const MISSION_STATUS_SET = new Set<MissionStatus>(MISSION_STATUSES);
const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["completed", "failed", "cancelled"]);
const DEFAULT_TERMINAL_MISSION_RETENTION = 200;

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, label);
}

function timestamp(value: unknown, label: string): string {
	const result = requiredString(value, label);
	if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp`);
	return result;
}

function missionStatus(value: unknown, label: string): MissionStatus {
	if (typeof value !== "string" || !MISSION_STATUS_SET.has(value as MissionStatus)) {
		throw new Error(`${label} must be one of ${MISSION_STATUSES.join(", ")}`);
	}
	return value as MissionStatus;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array of non-empty strings`);
	const result = value.map((item, index) => requiredString(item, `${label}[${index}]`).trim());
	return [...new Set(result)];
}

export function validateMissionId(value: unknown, label = "missionId"): string {
	const id = requiredString(value, label);
	if (!MISSION_ID_PATTERN.test(id) || id.includes("..")) {
		throw new Error(`${label} must contain only letters, numbers, '.', '_', or '-' and cannot contain '..'`);
	}
	return id;
}

function parseRunLink(value: unknown, label: string): MissionRunLink {
	const input = asObject(value, label);
	const runId = requiredString(input.runId, `${label}.runId`);
	const mode = requiredString(input.mode, `${label}.mode`) as MissionRunMode;
	if (!MISSION_RUN_MODES.has(mode)) throw new Error(`${label}.mode is invalid`);
	if (input.childIndex !== undefined && (!Number.isInteger(input.childIndex) || (input.childIndex as number) < 0)) {
		throw new Error(`${label}.childIndex must be a non-negative integer`);
	}
	return {
		runId,
		mode,
		...(optionalString(input.asyncDir, `${label}.asyncDir`) ? { asyncDir: input.asyncDir as string } : {}),
		...(input.childIndex !== undefined ? { childIndex: input.childIndex as number } : {}),
		...(optionalString(input.agent, `${label}.agent`) ? { agent: input.agent as string } : {}),
		...(optionalString(input.status, `${label}.status`) ? { status: input.status as string } : {}),
		...(input.startedAt !== undefined ? { startedAt: timestamp(input.startedAt, `${label}.startedAt`) } : {}),
		...(input.completedAt !== undefined ? { completedAt: timestamp(input.completedAt, `${label}.completedAt`) } : {}),
	};
}

function parseDecision(value: unknown, label: string): MissionDecision {
	const input = asObject(value, label);
	const status = input.status;
	if (status !== "open" && status !== "resolved") throw new Error(`${label}.status must be "open" or "resolved"`);
	return {
		id: validateMissionId(input.id, `${label}.id`),
		status,
		title: requiredString(input.title, `${label}.title`),
		createdAt: timestamp(input.createdAt, `${label}.createdAt`),
		...(optionalString(input.prompt, `${label}.prompt`) ? { prompt: input.prompt as string } : {}),
		...(input.options !== undefined ? { options: stringArray(input.options, `${label}.options`) } : {}),
		...(optionalString(input.recommendation, `${label}.recommendation`) ? { recommendation: input.recommendation as string } : {}),
		...(input.resolvedAt !== undefined ? { resolvedAt: timestamp(input.resolvedAt, `${label}.resolvedAt`) } : {}),
		...(optionalString(input.resolution, `${label}.resolution`) ? { resolution: input.resolution as string } : {}),
	};
}

function parseArtifact(value: unknown, label: string): MissionArtifact {
	const input = asObject(value, label);
	const kind = requiredString(input.kind, `${label}.kind`) as MissionArtifactKind;
	if (!MISSION_ARTIFACT_KINDS.has(kind)) throw new Error(`${label}.kind is invalid`);
	return {
		kind,
		path: requiredString(input.path, `${label}.path`),
		...(optionalString(input.description, `${label}.description`) ? { description: input.description as string } : {}),
	};
}

function parseReceipt(value: unknown, label: string): MissionReceipt {
	const input = asObject(value, label);
	const kind = requiredString(input.kind, `${label}.kind`) as MissionReceiptKind;
	const status = requiredString(input.status, `${label}.status`) as MissionReceiptStatus;
	if (!MISSION_RECEIPT_KINDS.has(kind)) throw new Error(`${label}.kind is invalid`);
	if (!MISSION_RECEIPT_STATUSES.has(status)) throw new Error(`${label}.status is invalid`);
	const url = requiredString(input.url, `${label}.url`);
	try {
		new URL(url);
	} catch {
		throw new Error(`${label}.url must be an absolute URL`);
	}
	return {
		kind,
		status,
		title: requiredString(input.title, `${label}.title`),
		url,
		createdAt: timestamp(input.createdAt, `${label}.createdAt`),
		...(optionalString(input.description, `${label}.description`) ? { description: input.description as string } : {}),
	};
}

export function parseMissionRecord(value: unknown, source = "mission record"): MissionRecord {
	const input = asObject(value, source);
	if (input.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1`);
	if (!Array.isArray(input.runs)) throw new Error(`${source}.runs must be an array`);
	if (!Array.isArray(input.decisions)) throw new Error(`${source}.decisions must be an array`);
	if (!Array.isArray(input.artifacts)) throw new Error(`${source}.artifacts must be an array`);
	if (input.receipts !== undefined && !Array.isArray(input.receipts)) throw new Error(`${source}.receipts must be an array`);
	const runs = input.runs as unknown[];
	const decisions = input.decisions as unknown[];
	const artifacts = input.artifacts as unknown[];
	const receipts = (input.receipts ?? []) as unknown[];
	return {
		schemaVersion: 1,
		id: validateMissionId(input.id, `${source}.id`),
		title: requiredString(input.title, `${source}.title`),
		goal: requiredString(input.goal, `${source}.goal`),
		status: missionStatus(input.status, `${source}.status`),
		createdAt: timestamp(input.createdAt, `${source}.createdAt`),
		updatedAt: timestamp(input.updatedAt, `${source}.updatedAt`),
		runs: runs.map((item, index) => parseRunLink(item, `${source}.runs[${index}]`)),
		decisions: decisions.map((item, index) => parseDecision(item, `${source}.decisions[${index}]`)),
		artifacts: artifacts.map((item, index) => parseArtifact(item, `${source}.artifacts[${index}]`)),
		receipts: receipts.map((item, index) => parseReceipt(item, `${source}.receipts[${index}]`)),
		...(optionalString(input.cwd, `${source}.cwd`) ? { cwd: input.cwd as string } : {}),
		...(optionalString(input.ownerSessionId, `${source}.ownerSessionId`) ? { ownerSessionId: input.ownerSessionId as string } : {}),
		...(optionalString(input.summary, `${source}.summary`) ? { summary: input.summary as string } : {}),
		...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
		...(input.labels !== undefined ? { labels: stringArray(input.labels, `${source}.labels`) } : {}),
	};
}

function expandConfiguredPath(value: string, projectRoot: string): string {
	const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
	return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(projectRoot, expanded);
}

export function validateMissionStoreConfig(value: unknown, label = "config.missions"): MissionStoreConfig | undefined {
	if (value === undefined) return undefined;
	const input = asObject(value, label);
	for (const key of Object.keys(input)) {
		if (key !== "enabled" && key !== "directory" && key !== "globalIndex" && key !== "globalIndexDir" && key !== "retainTerminal") {
			throw new Error(`${label}.${key} is unknown`);
		}
	}
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error(`${label}.enabled must be boolean`);
	if (input.globalIndex !== undefined && typeof input.globalIndex !== "boolean") throw new Error(`${label}.globalIndex must be boolean`);
	if (input.retainTerminal !== undefined && (!Number.isInteger(input.retainTerminal) || (input.retainTerminal as number) < 1)) {
		throw new Error(`${label}.retainTerminal must be a positive integer`);
	}
	const directory = optionalString(input.directory, `${label}.directory`);
	const globalIndexDir = optionalString(input.globalIndexDir, `${label}.globalIndexDir`);
	return {
		...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
		...(directory ? { directory } : {}),
		...(typeof input.globalIndex === "boolean" ? { globalIndex: input.globalIndex } : {}),
		...(globalIndexDir ? { globalIndexDir } : {}),
		...(input.retainTerminal !== undefined ? { retainTerminal: input.retainTerminal as number } : {}),
	};
}

export function resolveMissionStoreLocation(input: {
	projectRoot: string;
	config?: MissionStoreConfig;
	agentDir?: string;
}): MissionStoreLocation {
	const projectRoot = path.resolve(input.projectRoot);
	const missionDir = input.config?.directory
		? expandConfiguredPath(input.config.directory, projectRoot)
		: path.join(projectRoot, ".pi-subagents", "missions");
	const globalIndexDir = input.config?.globalIndexDir
		? expandConfiguredPath(input.config.globalIndexDir, projectRoot)
		: path.join(input.agentDir ?? getAgentDir(), "missions", "index");
	return {
		projectRoot,
		missionDir,
		globalIndexDir,
		writeGlobalIndex: input.config?.globalIndex !== false,
		...(input.config?.retainTerminal !== undefined ? { retainTerminal: input.config.retainTerminal } : {}),
	};
}

export function missionRecordPath(location: MissionStoreLocation, missionId: string): string {
	return path.join(location.missionDir, `${validateMissionId(missionId)}.json`);
}

function parseIndexEntry(value: unknown, source: string): MissionIndexEntry {
	const input = asObject(value, source);
	if (input.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1`);
	return {
		schemaVersion: 1,
		missionId: validateMissionId(input.missionId, `${source}.missionId`),
		projectRoot: requiredString(input.projectRoot, `${source}.projectRoot`),
		recordPath: requiredString(input.recordPath, `${source}.recordPath`),
		title: requiredString(input.title, `${source}.title`),
		status: missionStatus(input.status, `${source}.status`),
		updatedAt: timestamp(input.updatedAt, `${source}.updatedAt`),
		...(optionalString(input.lastRunId, `${source}.lastRunId`) ? { lastRunId: input.lastRunId as string } : {}),
	};
}

function indexPath(location: MissionStoreLocation, record: MissionRecord): string {
	const key = createHash("sha256").update(`${location.projectRoot}\0${record.id}`).digest("hex");
	return path.join(location.globalIndexDir, `${key}.json`);
}

function writeMission(location: MissionStoreLocation, record: MissionRecord): MissionRecord {
	const validated = parseMissionRecord(record);
	writePrivateAtomicJson(missionRecordPath(location, validated.id), validated);
	if (location.writeGlobalIndex) {
		const lastRunId = validated.runs.at(-1)?.runId;
		const entry: MissionIndexEntry = {
			schemaVersion: 1,
			missionId: validated.id,
			projectRoot: location.projectRoot,
			recordPath: missionRecordPath(location, validated.id),
			title: validated.title,
			status: validated.status,
			updatedAt: validated.updatedAt,
			...(lastRunId ? { lastRunId } : {}),
		};
		writePrivateAtomicJson(indexPath(location, validated), entry);
	}
	return validated;
}

function pruneTerminalMissions(location: MissionStoreLocation, maxTerminal: number): void {
	const terminal = listMissions(location).records
		.filter((record) => TERMINAL_MISSION_STATUSES.has(record.status))
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	for (const record of terminal.slice(maxTerminal)) {
		try {
			fs.rmSync(missionRecordPath(location, record.id), { force: true });
			if (location.writeGlobalIndex) fs.rmSync(indexPath(location, record), { force: true });
		} catch {
			// Retention is best-effort and must never block a launch.
		}
	}
}

export function createMission(location: MissionStoreLocation, input: MissionCreateInput, now = new Date(), retainTerminal = location.retainTerminal ?? DEFAULT_TERMINAL_MISSION_RETENTION): MissionRecord {
	const createdAt = now.toISOString();
	const record: MissionRecord = {
		schemaVersion: 1,
		id: randomUUID(),
		title: requiredString(input.title, "mission.title").trim(),
		goal: requiredString(input.goal, "mission.goal").trim(),
		status: input.status ?? "planned",
		createdAt,
		updatedAt: createdAt,
		cwd: location.projectRoot,
		runs: [],
		decisions: [],
		artifacts: [],
		receipts: [],
		...(input.ownerSessionId ? { ownerSessionId: requiredString(input.ownerSessionId, "mission.ownerSessionId") } : {}),
		...(input.labels ? { labels: stringArray(input.labels, "mission.labels") } : {}),
	};
	const created = writeMission(location, record);
	pruneTerminalMissions(location, retainTerminal);
	return created;
}

export function readMission(location: MissionStoreLocation, missionId: string): MissionRecord {
	const filePath = missionRecordPath(location, missionId);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Mission '${missionId}' was not found in ${location.missionDir}`);
		throw error;
	}
	try {
		return parseMissionRecord(JSON.parse(raw), filePath);
	} catch (error) {
		throw new Error(`Invalid mission file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function listMissions(location: MissionStoreLocation): MissionListResult {
	if (!fs.existsSync(location.missionDir)) return { records: [], warnings: [] };
	const records: MissionRecord[] = [];
	const warnings: string[] = [];
	for (const name of fs.readdirSync(location.missionDir).filter((item) => item.endsWith(".json")).sort()) {
		const filePath = path.join(location.missionDir, name);
		try {
			records.push(parseMissionRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath));
		} catch (error) {
			warnings.push(`Skipped corrupt mission '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return { records, warnings };
}

export function updateMission(location: MissionStoreLocation, missionId: string, update: MissionUpdateInput, now = new Date(), retainTerminal = location.retainTerminal ?? DEFAULT_TERMINAL_MISSION_RETENTION): MissionRecord {
	const current = readMission(location, missionId);
	const runs = [...current.runs];
	for (const candidate of update.addRuns ?? []) {
		const run = parseRunLink(candidate, "mission.update.addRuns[]");
		const existingIndex = runs.findIndex((item) => item.runId === run.runId && item.childIndex === run.childIndex);
		if (existingIndex === -1) runs.push(run);
		else runs[existingIndex] = { ...runs[existingIndex]!, ...run };
	}
	const artifacts = [...current.artifacts];
	for (const candidate of update.addArtifacts ?? []) {
		const artifact = parseArtifact(candidate, "mission.update.addArtifacts[]");
		const existingIndex = artifacts.findIndex((item) => item.kind === artifact.kind && path.resolve(item.path) === path.resolve(artifact.path));
		if (existingIndex === -1) artifacts.push(artifact);
		else artifacts[existingIndex] = { ...artifacts[existingIndex]!, ...artifact };
	}
	const createdAt = now.toISOString();
	const receipts = [...current.receipts];
	for (const candidate of update.addReceipts ?? []) {
		const receipt = parseReceipt({ ...candidate, createdAt }, "mission.update.addReceipts[]");
		const existingIndex = receipts.findIndex((item) => item.kind === receipt.kind && item.url === receipt.url);
		if (existingIndex === -1) receipts.push(receipt);
		else receipts[existingIndex] = { ...receipt, createdAt: receipts[existingIndex]!.createdAt };
	}
	const decisions = [
		...current.decisions,
		...(update.addDecisions ?? []).map((decision): MissionDecision => ({
			id: randomUUID(),
			status: "open",
			title: requiredString(decision.title, "mission.update.addDecisions[].title"),
			createdAt,
			...(decision.prompt ? { prompt: requiredString(decision.prompt, "mission.update.addDecisions[].prompt") } : {}),
			...(decision.options ? { options: stringArray(decision.options, "mission.update.addDecisions[].options") } : {}),
			...(decision.recommendation ? { recommendation: requiredString(decision.recommendation, "mission.update.addDecisions[].recommendation") } : {}),
		})),
	];
	const next: MissionRecord = {
		...current,
		updatedAt: createdAt,
		runs,
		artifacts,
		receipts,
		decisions,
		...(update.title !== undefined ? { title: requiredString(update.title, "mission.update.title").trim() } : {}),
		...(update.goal !== undefined ? { goal: requiredString(update.goal, "mission.update.goal").trim() } : {}),
		...(update.status !== undefined ? { status: missionStatus(update.status, "mission.update.status") } : {}),
		...(update.summary !== undefined ? { summary: requiredString(update.summary, "mission.update.summary") } : {}),
		...(update.labels !== undefined ? { labels: stringArray(update.labels, "mission.update.labels") } : {}),
		...(update.acceptance !== undefined ? { acceptance: update.acceptance } : {}),
	};
	const updated = writeMission(location, next);
	if (TERMINAL_MISSION_STATUSES.has(updated.status)) pruneTerminalMissions(location, retainTerminal);
	return updated;
}

export function listGlobalMissions(globalIndexDir: string): GlobalMissionListResult {
	if (!fs.existsSync(globalIndexDir)) return { entries: [], warnings: [] };
	const entries: GlobalMissionIndexRecord[] = [];
	const warnings: string[] = [];
	for (const name of fs.readdirSync(globalIndexDir).filter((item) => item.endsWith(".json")).sort()) {
		const filePath = path.join(globalIndexDir, name);
		try {
			const entry = parseIndexEntry(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath);
			try {
				const record = parseMissionRecord(JSON.parse(fs.readFileSync(entry.recordPath, "utf-8")), entry.recordPath);
				if (record.id !== entry.missionId) throw new Error(`record id '${record.id}' does not match index id '${entry.missionId}'`);
				entries.push({ ...entry, stale: false });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					try {
						fs.rmSync(filePath, { force: true });
						warnings.push(`Removed stale global mission pointer '${filePath}' because '${entry.recordPath}' no longer exists.`);
					} catch (removeError) {
						warnings.push(`Failed to remove stale global mission pointer '${filePath}': ${removeError instanceof Error ? removeError.message : String(removeError)}`);
					}
					continue;
				}
				entries.push({ ...entry, stale: true, staleReason: error instanceof Error ? error.message : String(error) });
			}
		} catch (error) {
			warnings.push(`Skipped corrupt global mission index entry '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return { entries, warnings };
}
