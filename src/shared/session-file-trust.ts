import * as fs from "node:fs";
import * as path from "node:path";

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function isTrustedRecordedSessionFile(realPath: string, recordedFiles: string[], sessionsBase: string | undefined): boolean {
	if (!sessionsBase || recordedFiles.length === 0) return false;
	try {
		const realSessionsBase = fs.realpathSync(sessionsBase);
		if (!pathWithin(realSessionsBase, realPath)) return false;
		return recordedFiles.some((file) => fs.realpathSync(path.resolve(file)) === realPath);
	} catch {
		return false;
	}
}
