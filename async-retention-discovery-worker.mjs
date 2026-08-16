import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";

const ACTIVE_RUN_INDEX_DIR = ".active-runs";
const RESULT_TOMBSTONE_PREFIX = ".deleting-result-";

function compareRelative(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function insertSmallest(entries, candidate, limit) {
	if (limit <= 0) return;
	const index = entries.findIndex((entry) => compareRelative(candidate.relative, entry.relative) < 0);
	if (index === -1) entries.push(candidate);
	else entries.splice(index, 0, candidate);
	if (entries.length > limit) entries.pop();
}

function streamDirWindow(dir, limit, after, relativePath, usable) {
	if (limit <= 0) return { entries: [], rawReads: 0, exhausted: true, cursorCleared: false };
	let handle;
	try {
		handle = fs.opendirSync(dir);
		const next = [];
		const wrapped = [];
		let rawReads = 0;
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			rawReads += 1;
			const relative = relativePath(entry);
			if (!usable(entry, relative)) continue;
			const candidate = { relative, name: entry.name };
			insertSmallest(wrapped, candidate, limit);
			if (after === undefined || compareRelative(relative, after) > 0) insertSmallest(next, candidate, limit);
		}
		const cursorCleared = after !== undefined && next.length === 0;
		return { entries: cursorCleared ? wrapped : next, rawReads, exhausted: true, cursorCleared };
	} catch (error) {
		if (error?.code === "ENOENT") return { entries: [], rawReads: 0, exhausted: true, cursorCleared: false };
		throw error;
	} finally {
		handle?.closeSync();
	}
}

function discover(request) {
	const startedAt = Date.now();
	const cursor = structuredClone(request.cursor);
	const raw = { reads: 0, exhausted: {} };
	const record = (source, scan) => {
		raw.reads += scan.rawReads;
		raw.exhausted[source] = scan.exhausted;
	};
	const runScan = streamDirWindow(
		request.asyncDirRoot,
		request.runBudget,
		cursor.runAfter,
		(entry) => entry.name,
		(entry) => entry.isDirectory() && entry.name !== ACTIVE_RUN_INDEX_DIR,
	);
	record("runs", runScan);
	if (runScan.cursorCleared) delete cursor.runAfter;
	const runCandidates = runScan.entries.slice(0, request.runBudget);
	for (const candidate of runCandidates) cursor.runAfter = candidate.relative;

	const resultCandidates = [];
	const sourceLimit = Math.max(1, Math.ceil(request.resultBudget / 4));
	const addFiles = (dir, kind, cursorTarget, source, budget = sourceLimit) => {
		const remaining = Math.min(budget, request.resultBudget - resultCandidates.length);
		if (remaining <= 0) return 0;
		const before = resultCandidates.length;
		const after = cursorTarget.type === "pending"
			? cursor.resultPendingAfterBySession?.[cursorTarget.session]
			: cursor[cursorTarget.key];
		const scan = streamDirWindow(
			dir,
			remaining,
			after,
			(entry) => path.relative(request.resultsDir, path.join(dir, entry.name)),
			(entry) => entry.isFile() && (entry.name.startsWith(RESULT_TOMBSTONE_PREFIX) || entry.name.endsWith(".json")),
		);
		record(source, scan);
		if (scan.cursorCleared) {
			if (cursorTarget.type === "pending") delete cursor.resultPendingAfterBySession?.[cursorTarget.session];
			else delete cursor[cursorTarget.key];
		}
		for (const candidate of scan.entries.slice(0, remaining)) {
			const tombstone = candidate.name.startsWith(RESULT_TOMBSTONE_PREFIX);
			resultCandidates.push({
				name: candidate.name,
				relative: candidate.relative,
				kind: tombstone ? "tombstone" : kind,
				cursor: cursorTarget,
			});
			if (cursorTarget.type === "pending") {
				cursor.resultPendingAfterBySession ??= {};
				cursor.resultPendingAfterBySession[cursorTarget.session] = candidate.relative;
			} else cursor[cursorTarget.key] = candidate.relative;
		}
		return resultCandidates.length - before;
	};

	addFiles(request.resultsDir, "public", { type: "result", key: "resultPublicAfter" }, "results.public");
	const pendingRoot = path.join(request.resultsDir, "result-pending");
	const pendingRemaining = Math.min(request.resultBudget, sourceLimit, request.resultBudget - resultCandidates.length);
	const pendingScan = streamDirWindow(
		pendingRoot,
		pendingRemaining,
		cursor.pendingSessionAfter,
		(entry) => entry.name,
		(entry) => entry.isDirectory(),
	);
	record("results.pendingSessions", pendingScan);
	const livePendingSessions = new Set(pendingScan.entries.map((entry) => entry.relative));
	if (cursor.resultPendingAfterBySession) {
		let pruned = 0;
		for (const session of Object.keys(cursor.resultPendingAfterBySession).sort()) {
			if (pruned >= request.resultBudget) break;
			if (!livePendingSessions.has(session) && !fs.existsSync(path.join(pendingRoot, session))) {
				delete cursor.resultPendingAfterBySession[session];
				pruned += 1;
			}
		}
		if (Object.keys(cursor.resultPendingAfterBySession).length === 0) delete cursor.resultPendingAfterBySession;
	}
	if (pendingScan.cursorCleared) delete cursor.pendingSessionAfter;
	const pendingSessions = pendingScan.entries.slice(0, pendingRemaining);
	let pendingFileBudget = Math.min(sourceLimit, request.resultBudget - resultCandidates.length);
	for (const session of pendingSessions) {
		if (pendingFileBudget <= 0) break;
		cursor.pendingSessionAfter = session.relative;
		pendingFileBudget -= addFiles(
			path.join(pendingRoot, session.name),
			"pending",
			{ type: "pending", session: session.relative },
			`results.pending.${session.name}`,
			pendingFileBudget,
		);
	}
	addFiles(path.join(request.resultsDir, "completion-replay"), "replay", { type: "result", key: "resultReplayAfter" }, "results.replay");
	addFiles(path.join(request.resultsDir, "output-archives"), "archive", { type: "result", key: "resultArchiveAfter" }, "results.archive");

	const cursorOps = [];
	for (const key of ["runAfter", "resultPublicAfter", "resultReplayAfter", "resultArchiveAfter", "pendingSessionAfter"]) {
		if (cursor[key] === request.cursor[key]) continue;
		cursorOps.push(cursor[key] === undefined ? { type: "delete", key } : { type: "set", key, value: cursor[key] });
	}
	const oldPending = request.cursor.resultPendingAfterBySession ?? {};
	const nextPending = cursor.resultPendingAfterBySession ?? {};
	for (const session of new Set([...Object.keys(oldPending), ...Object.keys(nextPending)])) {
		if (oldPending[session] === nextPending[session]) continue;
		cursorOps.push(nextPending[session] === undefined
			? { type: "delete-pending", session }
			: { type: "set-pending", session, value: nextPending[session] });
	}
	return {
		type: "result",
		passId: request.passId,
		discoveryDurationMs: Math.max(0, Date.now() - startedAt),
		rawReads: raw.reads,
		sourceExhausted: raw.exhausted,
		runCandidates,
		resultCandidates,
		cursorOps,
	};
}

if (!parentPort) throw new Error("Async retention discovery requires a worker parent port.");
parentPort.on("message", (request) => {
	const passId = request?.passId;
	try {
		parentPort.postMessage(discover(request));
	} catch (error) {
		parentPort.postMessage({ type: "error", passId, error: error instanceof Error ? error.message : String(error) });
	}
});
