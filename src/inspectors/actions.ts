import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readMissionBinding } from "../missions/lifecycle.ts";
import { listMissions, missionRecordPath, resolveMissionStoreLocation } from "../missions/store.ts";
import type { MissionStoreConfig } from "../missions/types.ts";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../policy/authority.ts";
import { DIRS, type Details, type SubagentState } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";
import { resolveSubagentRunId } from "../runs/background/run-id-resolver.ts";
import { resolveNodeExecutable } from "../shared/node-executable.ts";
import { encodeSessionRoots } from "./session-roots-codec.ts";
import { formatShellCommand } from "./shell-command.ts";
import type { InspectorAction, InspectorContext, InspectorLaunch, InspectorParams, InspectorPlugin, InspectorTarget } from "./types.ts";

export { INSPECTOR_ACTIONS } from "./types.ts";
export type { InspectorAction, InspectorParams, InspectorPlugin } from "./types.ts";

function result(text: string, isError = false): AgentToolResult<Details> {
	const response: AgentToolResult<Details> = {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
	};
	if (isError) response.isError = true;
	return response;
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}
function trustedDir(dir: string, deps: InspectorDispatcherDeps): boolean {
	try {
		if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) return false;
		const real = fs.realpathSync(dir);
		if ([...(deps.state?.asyncJobs.values() ?? []), ...(deps.state?.fleetJobs?.values() ?? [])].some((job) => {
			try {
				return fs.realpathSync(job.asyncDir) === real;
			} catch {
				return false;
			}
		})) return true;
		const root = deps.asyncDirRoot ?? DIRS.async;
		return fs.existsSync(root) && pathWithin(root, dir) && pathWithin(fs.realpathSync(root), real);
	} catch { return false; }
}
function resolveTarget(params: InspectorParams, deps: InspectorDispatcherDeps): InspectorTarget | { error: string } {
	const requested = params.id ?? params.runId;
	let runId: string;
	let asyncDir: string;
	if (params.dir) {
		asyncDir = path.resolve(params.dir);
		if (!trustedDir(asyncDir, deps)) return { error: `Async run directory '${asyncDir}' is outside trusted run roots.` };
		const status = readStatus(asyncDir);
		if (!status) return { error: `No async run status found in '${asyncDir}'.` };
		if (requested && requested !== status.runId && !status.runId.startsWith(requested)) return { error: `Run '${requested}' does not match status run '${status.runId}'.` };
		runId = status.runId;
	} else {
		if (!requested) return { error: "Inspector actions require id or dir." };
		try {
			const found = resolveSubagentRunId(requested, { state: deps.state, asyncDirRoot: deps.asyncDirRoot ?? DIRS.async, resultsDir: deps.resultsDir ?? DIRS.results });
			if (!found) return { error: `No subagent run found for '${requested}'.` };
			if (found.kind !== "async" || !found.location.asyncDir) return { error: `Run '${found.id}' is not an inspectable async run with lifecycle artifacts.` };
			runId = found.id;
			asyncDir = found.location.asyncDir;
		} catch (cause) {
			return { error: cause instanceof Error ? cause.message : String(cause) };
		}
	}
	const status = readStatus(asyncDir);
	if (!status) return { error: `No lifecycle status exists for async run '${runId}'.` };
	if (params.index !== undefined && (params.index < 0 || params.index >= (status.steps?.length ?? 0))) return { error: `Async run '${runId}' has ${status.steps?.length ?? 0} children. Index ${params.index} is out of range.` };
	const target: InspectorTarget = { runId, asyncDir, status: { cwd: status.cwd, state: status.state, steps: status.steps } };
	if (params.index !== undefined) target.index = params.index;
	return target;
}
function missionFor(target: InspectorTarget, deps: InspectorDispatcherDeps): { id: string; path: string } | undefined {
	try {
		const binding = readMissionBinding(target.asyncDir);
		if (binding) return { id: binding.missionId, path: missionRecordPath(binding.location, binding.missionId) };
		const location = resolveMissionStoreLocation(deps.missions ? { projectRoot: deps.cwd, config: deps.missions } : { projectRoot: deps.cwd });
		const mission = listMissions(location).records.find((record) => record.runs.some((run) => run.runId === target.runId));
		return mission ? { id: mission.id, path: missionRecordPath(location, mission.id) } : undefined;
	} catch {
		return undefined;
	}
}
function launchFor(target: InspectorTarget, deps: InspectorDispatcherDeps): InspectorLaunch {
	const mission = missionFor(target, deps);
	const runnerPath = deps.runnerPath ?? fileURLToPath(new URL("../../inspector-runner.mjs", import.meta.url));
	const job = deps.state?.asyncJobs.get(target.runId) ?? deps.state?.fleetJobs?.get(target.runId);
	const sessionRoots = [...new Set([...(deps.sessionRoots ?? deps.state?.trustedSessionRoots ?? []), ...(job?.sessionRoot ? [job.sessionRoot] : [])])];
	const allowSteer = resolveAuthorityDecision({ action: "steerRun", policy: deps.authorityPolicy }) === "auto";
	const allowStop = resolveAuthorityDecision({ action: "stopRun", policy: deps.authorityPolicy }) === "auto";
	const argv = [runnerPath, "--async-dir", target.asyncDir, "--run-id", target.runId, "--allow-steer", String(allowSteer), "--allow-stop", String(allowStop), "--session-roots", encodeSessionRoots(sessionRoots)];
	if (target.index !== undefined) argv.push("--index", String(target.index));
	if (mission) argv.push("--mission-path", mission.path);
	const executable = resolveNodeExecutable();
	const launch: InspectorLaunch = { executable, argv, displayCommand: formatShellCommand(executable, argv), allowSteer, allowStop, sessionRoots };
	if (mission) launch.mission = mission;
	return launch;
}

export interface InspectorDispatcherDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	missions?: MissionStoreConfig;
	authorityPolicy?: AuthorityPolicyConfig;
	sessionRoots?: string[];
	cwd: string;
	signal?: AbortSignal;
	now?: () => Date;
	runnerPath?: string;
	env?: NodeJS.ProcessEnv;
	plugins?: readonly InspectorPlugin[];
}
export async function handleInspectorAction(action: InspectorAction, params: InspectorParams, deps: InspectorDispatcherDeps): Promise<AgentToolResult<Details>> {
	const target = resolveTarget(params, deps);
	if ("error" in target) return result(target.error, true);
	const context: InspectorContext = {
		cwd: deps.cwd,
		signal: deps.signal,
		env: deps.env ?? process.env,
		target,
	};
	if (deps.now) context.now = deps.now;
	if (action === "inspector.command") return result(launchFor(target, deps).displayCommand);
	const plugins = deps.plugins ?? [];
	if (action === "inspector.open") {
		for (const plugin of plugins) {
			if (await plugin.available(context)) return plugin.open(context, launchFor(target, deps), params);
		}
		return result("No inspector plugin is available. Start a supported inspector host, or use inspector.command for a standalone command.", true);
	}
	const owner = plugins.find((plugin) => plugin.owns(context));
	if (!owner) return result(`No inspector plugin owns this binding for async run ${target.runId}.`);
	if (action === "inspector.status") {
		return owner.status
			? owner.status(context)
			: result(`Inspector plugin '${owner.name}' does not support status for async run ${target.runId}.`, true);
	}
	return owner.close
		? owner.close(context)
		: result(`Inspector plugin '${owner.name}' does not support close for async run ${target.runId}.`, true);
}
