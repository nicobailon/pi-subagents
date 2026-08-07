import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.ts";
import { assertWorkflowJsonValue } from "../workflows/scripted-workflow.ts";
import type { MissionStoreLocation } from "./types.ts";
import { validateMissionId } from "./store.ts";

const STATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MISSION_STATE_MAX_BYTES = 256 * 1024;

export interface MissionWorkflowState {
	path: string;
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

export function missionStatePath(location: MissionStoreLocation, missionId: string): string {
	return path.join(location.missionDir, validateMissionId(missionId), "state.json");
}

function validateStateKey(value: unknown): string {
	if (typeof value !== "string" || !STATE_KEY_PATTERN.test(value)) {
		throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
	}
	return value;
}

export function createMissionWorkflowState(location: MissionStoreLocation, missionId: string): MissionWorkflowState {
	const filePath = missionStatePath(location, missionId);
	let loaded = false;
	let values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

	const load = (): Record<string, unknown> => {
		if (loaded) return values;
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				loaded = true;
				return values;
			}
			throw new Error(`Failed to read mission state '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
		const bytes = Buffer.byteLength(raw);
		if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state file '${filePath}' exceeds the 256 KiB limit (${bytes} bytes).`);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be a JSON object");
			assertWorkflowJsonValue(parsed, "mission state");
			values = Object.assign(Object.create(null) as Record<string, unknown>, parsed);
			loaded = true;
			return values;
		} catch (error) {
			throw new Error(`Invalid mission state file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	return {
		path: filePath,
		get(key) {
			const validKey = validateStateKey(key);
			const current = load();
			return Object.hasOwn(current, validKey) ? current[validKey] : undefined;
		},
		set(key, value) {
			const validKey = validateStateKey(key);
			assertWorkflowJsonValue(value, `state.set('${validKey}') value`);
			const next = Object.assign(Object.create(null) as Record<string, unknown>, load(), { [validKey]: value });
			const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
			if (bytes > MISSION_STATE_MAX_BYTES) throw new Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
			writePrivateAtomicJson(filePath, next);
			values = next;
			loaded = true;
		},
	};
}
