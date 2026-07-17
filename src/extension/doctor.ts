import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgentsAll, type AgentSource } from "../agents/agents.ts";
import { isAsyncAvailable } from "../runs/background/async-execution.ts";
import { formatSpawnBudgetSummary, getSpawnBudgetSnapshot } from "../runs/shared/spawn-budget.ts";
import { diagnoseIntercomBridge, type IntercomBridgeDiagnostic } from "../intercom/intercom-bridge.ts";
import { discoverAvailableSkills, type SkillSource } from "../agents/skills.ts";
import {
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	RESULTS_DIR,
	TEMP_ROOT_DIR,
	type ExtensionConfig,
	type SubagentState,
} from "../shared/types.ts";

interface DoctorPaths {
	tempRootDir: string;
	asyncDir: string;
	resultsDir: string;
	chainRunsDir: string;
}

interface DoctorDeps {
	isAsyncAvailable: () => boolean;
	discoverAgentsAll: typeof discoverAgentsAll;
	discoverAvailableSkills: typeof discoverAvailableSkills;
	diagnoseIntercomBridge: typeof diagnoseIntercomBridge;
}

interface DoctorReportInput {
	cwd: string;
	config: ExtensionConfig;
	state: SubagentState;
	context?: "fresh" | "fork";
	requestedSessionDir?: string;
	currentSessionFile?: string | null;
	currentSessionId?: string | null;
	orchestratorTarget?: string;
	sessionError?: string;
	expandTilde?: (value: string) => string;
	paths?: DoctorPaths;
	deps?: Partial<DoctorDeps>;
}

const DEFAULT_PATHS: DoctorPaths = {
	tempRootDir: TEMP_ROOT_DIR,
	asyncDir: ASYNC_DIR,
	resultsDir: RESULTS_DIR,
	chainRunsDir: CHAIN_RUNS_DIR,
};

const DEFAULT_DEPS: DoctorDeps = {
	isAsyncAvailable,
	discoverAgentsAll,
	discoverAvailableSkills,
	diagnoseIntercomBridge,
};

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function lineFromCheck(label: string, check: () => string): string {
	try {
		return check();
	} catch (error) {
		return `- ${label}: failed — ${errorText(error)}`;
	}
}

function formatExistingDirectory(label: string, dirPath: string): string {
	try {
		if (!fs.existsSync(dirPath)) return `- ${label}: missing (${dirPath})`;
		const stats = fs.statSync(dirPath);
		if (!stats.isDirectory()) throw new Error(`not a directory: ${dirPath}`);
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
		return `- ${label}: ok (${dirPath})`;
	} catch (error) {
		return `- ${label}: failed (${dirPath}) — ${errorText(error)}`;
	}
}

function formatSourceCounts(counts: Record<AgentSource, number>): string {
	return `builtin ${counts.builtin}, package ${counts.package}, user ${counts.user}, project ${counts.project}`;
}

function formatSkillSourceCounts(skills: Array<{ source: SkillSource }>): string {
	const counts = new Map<SkillSource, number>();
	for (const skill of skills) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1);
	const ordered: SkillSource[] = [
		"project",
		"project-settings",
		"project-package",
		"user",
		"user-settings",
		"user-package",
		"extension",
		"builtin",
		"unknown",
	];
	const parts = ordered
		.map((source) => `${source} ${counts.get(source) ?? 0}`)
		.filter((part) => !part.endsWith(" 0"));
	return parts.length > 0 ? parts.join(", ") : "none";
}

function formatConfiguredSessionDir(input: DoctorReportInput): string {
	if (input.requestedSessionDir) {
		return path.resolve(input.expandTilde?.(input.requestedSessionDir) ?? input.requestedSessionDir);
	}
	if (input.config.defaultSessionDir) {
		return path.resolve(input.expandTilde?.(input.config.defaultSessionDir) ?? input.config.defaultSessionDir);
	}
	return "not configured";
}

function formatSessionLines(input: DoctorReportInput): string[] {
	const sessionFile = input.currentSessionFile ?? null;
	const lines = [
		lineFromCheck("configured session dir", () => `- configured session dir: ${formatConfiguredSessionDir(input)}`),
		`- current session file: ${sessionFile ?? "not available"}`,
		`- current session dir: ${sessionFile ? path.dirname(sessionFile) : "not available"}`,
		`- current session id: ${input.currentSessionId ?? input.state.currentSessionId ?? "not available"}`,
	];
	if (input.sessionError) lines.push(`- session manager: failed — ${input.sessionError}`);
	return lines;
}

function formatDiscovery(input: DoctorReportInput, deps: DoctorDeps): string[] {
	return [
		lineFromCheck("agents/chains", () => {
			const discovered = deps.discoverAgentsAll(input.cwd);
			const agentCounts = {
				builtin: discovered.builtin.length,
				package: discovered.package?.length ?? 0,
				user: discovered.user.length,
				project: discovered.project.length,
			};
			const chainCounts = discovered.chains.reduce<Record<AgentSource, number>>((counts, chain) => {
				counts[chain.source] += 1;
				return counts;
			}, { builtin: 0, package: 0, user: 0, project: 0 });
			return [
				`- agents: total ${agentCounts.builtin + agentCounts.package + agentCounts.user + agentCounts.project} (${formatSourceCounts(agentCounts)})`,
				`- chains: total ${discovered.chains.length} (${formatSourceCounts(chainCounts)})`,
			].join("\n");
		}),
		lineFromCheck("skills", () => {
			const skills = deps.discoverAvailableSkills(input.cwd);
			return `- skills: total ${skills.length} (${formatSkillSourceCounts(skills)})`;
		}),
	];
}

function formatIntercomDiagnostic(diagnostic: IntercomBridgeDiagnostic, context: "fresh" | "fork" | undefined): string[] {
	const lines = [
		`- bridge: ${diagnostic.active ? "active" : "inactive"}${diagnostic.reason ? ` (${diagnostic.reason})` : ""}`,
		`- mode: ${diagnostic.mode}; context: ${context ?? "unspecified"}`,
		`- orchestrator target: ${diagnostic.orchestratorTarget ?? "not available"}`,
		`- supervisor channel: ${diagnostic.supervisorChannelAvailable ? "available" : "unavailable"} (${diagnostic.extensionDir})`,
	];
	return lines;
}

function formatSpawnBudgetSection(input: DoctorReportInput): string[] {
	const snapshot = getSpawnBudgetSnapshot(input.state, input.config, input.currentSessionId ?? input.state.currentSessionId);
	return [
		`- usage: ${formatSpawnBudgetSummary(snapshot)}`,
		`- recent grants: ${snapshot.grantHistory.length === 0
			? "none"
			: snapshot.grantHistory.map((grant) => `+${grant.amount} at ${new Date(grant.grantedAt).toISOString()} (${grant.previousLimit} → ${grant.limit})`).join("; ")}`,
		"- reset boundary: a new parent session resets usage and grants; compaction does not",
	];
}

function formatPermissionSystemSection(): string[] {
	const lines: string[] = [];
	const parentSession = process.env["PI_SUBAGENT_PARENT_SESSION"] ?? "";
	const trimmed = parentSession.trim();
	if (trimmed) {
		lines.push(`- parent session: set (${trimmed})`);
	} else {
		lines.push("- parent session: not set — ask forwarding from subprocess children will not reach a parent UI");
	}
	const isChild = process.env["PI_SUBAGENT_CHILD"] === "1";
	lines.push(`- subagent process: ${isChild ? "yes (PI_SUBAGENT_CHILD=1)" : "no"}`);
	// Whether pi-permission-system is installed and where it stores config is
	// outside pi-subagents' control, so we only report the forwarding signal we
	// own. Run `pi list` to confirm the permission extension is installed.
	return lines;
}

export function buildDoctorReport(input: DoctorReportInput): string {
	const paths = input.paths ?? DEFAULT_PATHS;
	const deps = { ...DEFAULT_DEPS, ...input.deps };
	const lines = [
		"Subagents doctor report",
		"",
		"Runtime",
		`- cwd: ${input.cwd}`,
		lineFromCheck("async support", () => `- async support: ${deps.isAsyncAvailable() ? "available" : "unavailable"}`),
		...formatSessionLines(input),
		"",
		"Filesystem",
		formatExistingDirectory("temp root", paths.tempRootDir),
		formatExistingDirectory("async runs", paths.asyncDir),
		formatExistingDirectory("results", paths.resultsDir),
		formatExistingDirectory("chain runs", paths.chainRunsDir),
		"",
		"Discovery",
		...formatDiscovery(input, deps),
		"",
		"Spawn budget",
		...formatSpawnBudgetSection(input),
		"",
		"Permission system",
		...formatPermissionSystemSection(),
		"",
		"Intercom bridge",
		...lineFromCheck("intercom bridge", () => formatIntercomDiagnostic(deps.diagnoseIntercomBridge({
			config: input.config.intercomBridge,
			context: input.context,
			orchestratorTarget: input.orchestratorTarget,
			cwd: input.cwd,
		}), input.context).join("\n")).split("\n"),
	];
	return lines.join("\n");
}
