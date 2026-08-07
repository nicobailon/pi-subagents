import * as fs from "node:fs";
import * as path from "node:path";
import { DIRS, type SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { findAsyncRunPrefixMatches, type AsyncRunLocation } from "./async-resume.ts";
import { assertSafeNestedId, findNestedRunMatchesById, type NestedRoute, type NestedRunMatch, type NestedRunResolutionScope } from "../shared/nested-events.ts";

export type ResolvedSubagentRunId =
	| { kind: "foreground"; id: string }
	| { kind: "async"; id: string; location: AsyncRunLocation }
	| { kind: "nested"; id: string; match: NestedRunMatch };

export interface ResolveSubagentRunIdDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	nested?: NestedRunResolutionScope;
}

function exactAsyncLocation(id: string, asyncDirRoot: string, resultsDir: string): AsyncRunLocation | undefined {
	const asyncDir = path.join(asyncDirRoot, id);
	const resultPath = path.join(resultsDir, `${id}.json`);
	if (!fs.existsSync(asyncDir) && !fs.existsSync(resultPath)) return undefined;
	return {
		asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
		resultPath: fs.existsSync(resultPath) ? resultPath : null,
		resolvedId: id,
	};
}

type AsyncRunMatch = { id: string; location: AsyncRunLocation };

type WorkflowResultIdentity = {
	id?: string;
	runId?: string;
	toolCallId?: string;
};

function readWorkflowResultIdentity(resultPath: string): WorkflowResultIdentity | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as unknown;
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	return {
		...(typeof record.id === "string" ? { id: record.id } : {}),
		...(typeof record.runId === "string" ? { runId: record.runId } : {}),
		...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
	};
}

function directoryEntries(root: string): string[] {
	try {
		return fs.readdirSync(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function resultPathFor(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	return fs.existsSync(resultPath) ? resultPath : null;
}

function toolCallIdMatches(value: string | undefined, query: string, options: { prefix?: boolean }): boolean {
	if (value === undefined) return false;
	return options.prefix === true ? value.startsWith(query) : value === query;
}

function toolCallIdAsyncLocations(toolCallId: string, asyncDirRoot: string, resultsDir: string, options: { prefix?: boolean } = {}): AsyncRunMatch[] {
	const byId = new Map<string, AsyncRunLocation>();
	for (const entry of directoryEntries(asyncDirRoot)) {
		const asyncDir = path.join(asyncDirRoot, entry);
		const status = readStatus(asyncDir);
		if (!status || !toolCallIdMatches(status.toolCallId, toolCallId, options)) continue;
		const runId = status.runId || entry;
		byId.set(runId, { asyncDir, resultPath: resultPathFor(resultsDir, runId), resolvedId: runId });
	}
	for (const entry of directoryEntries(resultsDir)) {
		if (!entry.endsWith(".json")) continue;
		const resultPath = path.join(resultsDir, entry);
		const identity = readWorkflowResultIdentity(resultPath);
		if (!identity || !toolCallIdMatches(identity.toolCallId, toolCallId, options)) continue;
		const runId = identity.runId ?? identity.id ?? entry.slice(0, -".json".length);
		const asyncDir = path.join(asyncDirRoot, runId);
		byId.set(runId, { asyncDir: fs.existsSync(asyncDir) ? asyncDir : null, resultPath, resolvedId: runId });
	}
	return [...byId.entries()].map(([id, location]) => ({ id, location }));
}

function foregroundIds(state: SubagentState | undefined): string[] {
	if (!state) return [];
	const remembered = state.currentSessionId
		? [...(state.foregroundRuns?.values() ?? [])]
			.filter((run) => run.sessionId === state.currentSessionId)
			.map((run) => run.runId)
		: [];
	return [...new Set([...state.foregroundControls.keys(), ...remembered])];
}

function hasExactForegroundId(state: SubagentState | undefined, id: string): boolean {
	if (!state) return false;
	if (state.foregroundControls.has(id)) return true;
	const remembered = state.foregroundRuns?.get(id);
	return Boolean(remembered && state.currentSessionId && remembered.sessionId === state.currentSessionId);
}

function nestedScopeFromState(state: SubagentState | undefined): NestedRunResolutionScope | undefined {
	if (!state) return undefined;
	const routes: NestedRoute[] = [];
	const seen = new Set<string>();
	const add = (route: NestedRoute | undefined) => {
		if (!route) return;
		const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
		if (seen.has(key)) return;
		seen.add(key);
		routes.push(route);
	};
	for (const control of state.foregroundControls.values()) add(control.nestedRoute as NestedRoute | undefined);
	for (const job of state.asyncJobs.values()) add(job.nestedRoute as NestedRoute | undefined);
	return { routes };
}

function asyncPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir);
}

export function resolveSubagentRunId(id: string, deps: ResolveSubagentRunIdDeps = {}): ResolvedSubagentRunId | undefined {
	assertSafeNestedId("id", id);
	const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
	const resultsDir = deps.resultsDir ?? DIRS.results;

	const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
	if (hasExactForegroundId(deps.state, id)) return { kind: "foreground", id };
	const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
	if (exactAsync) return { kind: "async", id, location: exactAsync };
	const exactToolCallIdMatches = toolCallIdAsyncLocations(id, asyncDirRoot, resultsDir);
	if (exactToolCallIdMatches.length > 1) throw new Error(`Subagent tool-call id '${id}' is ambiguous across async runs. Use the returned asyncId instead.`);
	if (exactToolCallIdMatches[0]) return { kind: "async", id: exactToolCallIdMatches[0].id, location: exactToolCallIdMatches[0].location };
	const exactNested = findNestedRunMatchesById(id, nestedScope ? { scope: nestedScope } : {});
	if (exactNested.length > 1) throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
	if (exactNested[0]) return { kind: "nested", id, match: exactNested[0] };

	const matches: ResolvedSubagentRunId[] = [];
	for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
		matches.push({ kind: "foreground", id: foregroundId });
	}
	for (const match of asyncPrefixMatches(id, asyncDirRoot, resultsDir)) {
		matches.push({ kind: "async", id: match.id, location: match.location });
	}
	for (const match of toolCallIdAsyncLocations(id, asyncDirRoot, resultsDir, { prefix: true })) {
		matches.push({ kind: "async", id: match.id, location: match.location });
	}
	for (const match of findNestedRunMatchesById(id, nestedScope ? { prefix: true, scope: nestedScope } : { prefix: true })) {
		matches.push({ kind: "nested", id: match.run.id, match });
	}
	const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
	const values = [...unique.values()];
	if (values.length > 1) {
		throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
	}
	return values[0];
}
