/**
 * Agent teams: a named roster of agents with a shared goal and shared scratch
 * space, launched and observed as one unit.
 *
 * A team is deliberately NOT a new runner. `expandTeamToTasks` turns a roster
 * into the parallel-task shape the executor already understands, so agent
 * discovery, model resolution and fallback, spawn-budget preflight, artifacts,
 * async status, and the fleet view all keep working unchanged. Ordering still
 * belongs to chains; a team is a roster plus shared state.
 *
 * Discovery mirrors agents: builtin `<pkg>/teams`, user `~/.pi/agent/teams`,
 * project `<project>/.pi/teams`, with later scopes overriding earlier ones by
 * name.
 *
 * See docs/proposals/agent-teams.md for the design rationale.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { TEAM_DIRS_ROOT, provisionTeamDir } from "../runs/shared/team-board.ts";
import { validateToolBudgetConfig } from "../runs/shared/tool-budget.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";
import type { ResolvedToolBudget } from "../shared/types.ts";

export type TeamSource = "builtin" | "user" | "project";
export type TeamScope = "user" | "project" | "both";

export interface TeamMember {
	/** Name of a configured agent. Resolved by the normal agent discovery path. */
	agent: string;
	/** Free-form label surfaced in the fleet and passed to the child as context. */
	role?: string;
	/**
	 * At most one member carrying `exclusive` may be active at a time. This makes
	 * the one-writer invariant declarative and checkable at preflight instead of
	 * restated in prose in every agent file.
	 */
	exclusive?: boolean;
	context?: "fresh" | "fork";
	model?: string;
	toolBudget?: ResolvedToolBudget;
	/** Per-member task template. `{task}` interpolates the caller's task. */
	task?: string;
	/** Output artifact path, same semantics as a parallel task's `output`. */
	output?: string;
}

export interface TeamConfig {
	name: string;
	description: string;
	/** One-line statement of what "done" means, injected into every member. */
	goal?: string;
	members: TeamMember[];
	concurrency?: number;
	/** Provision a shared board + claims directory for the run. Default true. */
	sharedDir: boolean;
	/** Markdown body, appended to every member's runtime instructions. */
	instructions: string;
	source: TeamSource;
	filePath: string;
}

export interface TeamDiscoveryResult {
	teams: TeamConfig[];
	errors: { filePath: string; error: string }[];
}

const BUILTIN_TEAMS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "teams");

/**
 * Split `---`-delimited YAML frontmatter from the markdown body.
 *
 * Teams parse their frontmatter with the real YAML parser rather than the flat
 * key/value reader used for agents: a roster is a list of objects, which the
 * flat reader would hand back as an opaque indented string. Team files are new,
 * so there is no legacy format to stay compatible with.
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: "", body: normalized.trim() };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: "", body: normalized.trim() };
	return { frontmatter: normalized.slice(4, end), body: normalized.slice(end + 4).trim() };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMember(raw: unknown, index: number): { member?: TeamMember; error?: string } {
	const at = `members[${index}]`;
	if (typeof raw === "string") {
		// Shorthand: a bare agent name.
		const agent = asString(raw);
		return agent ? { member: { agent } } : { error: `${at} is empty` };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { error: `${at} must be an agent name or an object` };
	}
	const value = raw as Record<string, unknown>;
	const agent = asString(value.agent);
	if (!agent) return { error: `${at}.agent is required` };

	const member: TeamMember = { agent };
	const role = asString(value.role);
	if (role) member.role = role;
	const task = asString(value.task);
	if (task) member.task = task;
	const output = asString(value.output);
	if (output) member.output = output;
	const model = asString(value.model);
	if (model) member.model = model;

	if (value.exclusive !== undefined) {
		if (typeof value.exclusive !== "boolean") return { error: `${at}.exclusive must be a boolean` };
		member.exclusive = value.exclusive;
	}
	if (value.context !== undefined) {
		if (value.context !== "fresh" && value.context !== "fork") {
			return { error: `${at}.context must be "fresh" or "fork"` };
		}
		member.context = value.context;
	}
	if (value.toolBudget !== undefined) {
		const budget = validateToolBudgetConfig(value.toolBudget, `${at}.toolBudget`);
		if (budget.error) return { error: budget.error };
		member.toolBudget = budget.budget;
	}
	return { member };
}

/**
 * Validate a roster. Returns an error string, or undefined when the roster is
 * launchable.
 *
 * Enforced at parse/preflight rather than at runtime so a bad roster fails
 * before any child process or run artifact exists — matching how static chains
 * already fail before creating partial work.
 */
export function validateRoster(members: TeamMember[]): string | undefined {
	if (members.length === 0) return "a team needs at least one member";
	const exclusive = members.filter((member) => member.exclusive);
	if (exclusive.length > 1) {
		const names = exclusive.map((member) => member.agent).join(", ");
		return `only one member may be exclusive, found ${exclusive.length} (${names})`;
	}
	const seen = new Set<string>();
	for (const member of members) {
		// Same agent twice is legitimate (two reviewers), but only when the roles
		// differ — otherwise the fleet shows two indistinguishable rows and
		// `{outputs.<role>}` references become ambiguous.
		// JSON-encode rather than concatenate: a plain join would make
		// agent "ab" + role "c" collide with agent "a" + role "bc".
		const key = JSON.stringify([member.agent, member.role ?? ""]);
		if (seen.has(key)) {
			return `duplicate member ${member.agent}${member.role ? ` (role ${member.role})` : ""}; give each a distinct role`;
		}
		seen.add(key);
	}
	return undefined;
}

export function parseTeam(
	content: string,
	filePath: string,
	source: TeamSource,
): { team?: TeamConfig; error?: string } {
	const { frontmatter, body } = splitFrontmatter(content);
	if (frontmatter.trim() === "") return { error: "missing YAML frontmatter" };

	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatter);
	} catch (err) {
		return { error: `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "frontmatter must be a YAML mapping" };
	}
	const value = parsed as Record<string, unknown>;

	const name = asString(value.name) ?? path.basename(filePath, ".md");
	const description = asString(value.description);
	if (!description) return { error: `team '${name}' is missing a description` };

	if (!Array.isArray(value.members)) return { error: `team '${name}' is missing a members list` };
	const members: TeamMember[] = [];
	for (let i = 0; i < value.members.length; i++) {
		const { member, error } = parseMember(value.members[i], i);
		if (error || !member) return { error: `team '${name}': ${error}` };
		members.push(member);
	}
	const rosterError = validateRoster(members);
	if (rosterError) return { error: `team '${name}': ${rosterError}` };

	let concurrency: number | undefined;
	if (value.concurrency !== undefined) {
		if (typeof value.concurrency !== "number" || !Number.isInteger(value.concurrency) || value.concurrency < 1) {
			return { error: `team '${name}': concurrency must be an integer >= 1` };
		}
		concurrency = value.concurrency;
	}
	if (value.sharedDir !== undefined && typeof value.sharedDir !== "boolean") {
		return { error: `team '${name}': sharedDir must be a boolean` };
	}

	const team: TeamConfig = {
		name,
		description,
		members,
		sharedDir: value.sharedDir === undefined ? true : (value.sharedDir as boolean),
		instructions: body,
		source,
		filePath,
	};
	const goal = asString(value.goal);
	if (goal) team.goal = goal;
	if (concurrency !== undefined) team.concurrency = concurrency;
	return { team };
}

function loadTeamsFromDir(dir: string, source: TeamSource): TeamDiscoveryResult {
	const result: TeamDiscoveryResult = { teams: [], errors: [] };
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return result; // a missing teams dir is normal, not an error
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (err) {
			result.errors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
			continue;
		}
		const { team, error } = parseTeam(content, filePath, source);
		if (error || !team) result.errors.push({ filePath, error: error ?? "unknown parse failure" });
		else result.teams.push(team);
	}
	return result;
}

/**
 * Discover teams across builtin, user, and project scopes. Later scopes win by
 * name, matching agent precedence.
 */
export function discoverTeams(cwd: string, scope: TeamScope = "both"): TeamDiscoveryResult {
	const dirs: { dir: string; source: TeamSource }[] = [{ dir: BUILTIN_TEAMS_DIR, source: "builtin" }];
	if (scope !== "project") {
		dirs.push({ dir: path.join(getAgentDir(), "teams"), source: "user" });
		dirs.push({ dir: path.join(os.homedir(), ".agents", "teams"), source: "user" });
	}
	if (scope !== "user") {
		dirs.push({ dir: path.join(getProjectConfigDir(cwd), "teams"), source: "project" });
	}

	const byName = new Map<string, TeamConfig>();
	const errors: { filePath: string; error: string }[] = [];
	for (const { dir, source } of dirs) {
		const loaded = loadTeamsFromDir(dir, source);
		errors.push(...loaded.errors);
		for (const team of loaded.teams) byName.set(team.name, team);
	}
	return { teams: [...byName.values()], errors };
}

/**
 * Rewrite a `team:` request into the equivalent `tasks:` parallel request,
 * in place.
 *
 * Called from prepareArguments, before the TypeBox schema check, so downstream
 * code never sees a team — it sees a parallel group it already knows how to run.
 * That is what keeps spawn-budget preflight, artifacts, async status, resume,
 * and the fleet working without modification.
 *
 * Throws with an actionable message; the tool surfaces it to the model.
 */
export function resolveTeamRequest(args: Record<string, unknown>, cwd: string): void {
	const requested = asString(args.team);
	if (!requested) return;

	if (Array.isArray(args.tasks) && args.tasks.length > 0) {
		throw new Error("subagent: `team` and `tasks` are mutually exclusive — a team already is a parallel group.");
	}
	if (Array.isArray(args.chain) && args.chain.length > 0) {
		throw new Error(
			"subagent: `team` and `chain` are mutually exclusive at the top level. To order a team inside a chain, use a chain step with `team`.",
		);
	}
	const task = asString(args.task);
	if (!task) throw new Error(`subagent: team '${requested}' needs a \`task\` describing what the team should do.`);

	const { teams, errors } = discoverTeams(cwd);
	const team = findTeam(teams, requested);
	if (!team) {
		const available = teams.map((candidate) => candidate.name).sort();
		const broken = errors.length > 0 ? ` ${errors.length} team file(s) failed to parse: ${errors.map((e) => `${e.filePath}: ${e.error}`).join("; ")}.` : "";
		throw new Error(
			`subagent: no team named '${requested}'. Available: ${available.length > 0 ? available.join(", ") : "(none)"}.${broken}`,
		);
	}

	// Provision the shared board/claims dir now, in the parent, and hand every
	// member the same path. A generated id is used rather than the run id because
	// this runs in prepareArguments, before a run id exists.
	let teamDir: string | undefined;
	if (team.sharedDir) {
		try {
			teamDir = provisionTeamDir(TEAM_DIRS_ROOT, team.name, randomUUID());
		} catch {
			// A team without shared state is still a usable team; degrade rather than
			// refusing to launch.
			teamDir = undefined;
		}
	}

	const expanded = expandTeamToTasks(team, task, teamDir);
	// teamDir rides on each task so pi-args can put it in the child env, which is
	// what gates and locates `team_note`.
	args.tasks = teamDir ? expanded.map((entry) => ({ ...entry, teamDir })) : expanded;
	delete args.team;
	// The caller's explicit concurrency wins; otherwise use the team's.
	if (args.concurrency === undefined && team.concurrency !== undefined) args.concurrency = team.concurrency;
}

export function findTeam(teams: TeamConfig[], name: string): TeamConfig | undefined {
	const wanted = name.trim().toLowerCase();
	return teams.find((team) => team.name.toLowerCase() === wanted);
}

/** A parallel task, in the shape the existing executor already accepts. */
export interface ExpandedTeamTask {
	agent: string;
	task: string;
	label?: string;
	as?: string;
	model?: string;
	output?: string;
	context?: "fresh" | "fork";
	toolBudget?: ResolvedToolBudget;
}

/**
 * Expand a roster into parallel tasks.
 *
 * This is the whole integration: a team launch becomes a parallel group with a
 * roster attached, so nothing downstream needs to know teams exist. Each member
 * receives the caller's task, plus the team goal and its own role, so a child
 * can act on its assignment without reading team files.
 */
export function expandTeamToTasks(team: TeamConfig, task: string, teamDir?: string): ExpandedTeamTask[] {
	return team.members.map((member) => {
		const context: string[] = [];
		if (team.goal) context.push(`Team goal: ${team.goal}`);
		if (member.role) context.push(`Your role on team '${team.name}': ${member.role}`);
		if (member.exclusive) {
			context.push("You are the team's sole writer. No other member may write in this run.");
		}
		if (teamDir) {
			context.push(
				`Team scratch dir: ${teamDir}. Post findings to board.md and claim paths in claims.json before editing them.`,
			);
		}
		if (team.instructions) context.push(team.instructions);

		// `{task}` lets a member template position the caller's task; otherwise the
		// caller's task is appended so no member can silently drop it.
		const memberTask = member.task
			? member.task.includes("{task}")
				? member.task.replace("{task}", task)
				: `${member.task}\n\n${task}`
			: task;

		const expanded: ExpandedTeamTask = {
			agent: member.agent,
			task: context.length > 0 ? `${context.join("\n\n")}\n\n---\n\n${memberTask}` : memberTask,
		};
		if (member.role) {
			expanded.label = member.role;
			expanded.as = member.role;
		}
		if (member.model) expanded.model = member.model;
		if (member.output) expanded.output = member.output;
		if (member.context) expanded.context = member.context;
		if (member.toolBudget) expanded.toolBudget = member.toolBudget;
		return expanded;
	});
}
