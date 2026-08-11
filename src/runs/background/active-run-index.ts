import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncStatus } from "../../shared/types.ts";

export const ACTIVE_RUN_INDEX_DIR = ".active-runs";

function indexDir(asyncDirRoot: string): string {
	return path.join(asyncDirRoot, ACTIVE_RUN_INDEX_DIR);
}

function markerPath(asyncDir: string): string {
	return path.join(indexDir(path.dirname(asyncDir)), path.basename(asyncDir));
}

export function isActiveAsyncState(state: AsyncStatus["state"]): boolean {
	return state === "queued" || state === "running";
}

export function updateActiveRunIndex(asyncDir: string, state: AsyncStatus["state"]): void {
	const marker = markerPath(asyncDir);
	if (isActiveAsyncState(state)) {
		fs.mkdirSync(path.dirname(marker), { recursive: true });
		fs.writeFileSync(marker, "", { flag: "a" });
		return;
	}
	try {
		fs.rmSync(marker);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function readActiveRunIndex(asyncDirRoot: string): string[] | undefined {
	try {
		return fs.readdirSync(indexDir(asyncDirRoot), { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
