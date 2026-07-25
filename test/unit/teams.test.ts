import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	expandTeamToTasks,
	findTeam,
	parseTeam,
	resolveTeamRequest,
	splitFrontmatter,
	validateRoster,
	type TeamConfig,
	type TeamMember,
} from "../../src/agents/teams.ts";

function teamFile(frontmatter: string, body = ""): string {
	return `---\n${frontmatter}\n---\n${body}`;
}

const BUILD_TEAM = `name: build
description: Implementation writer plus independent review
goal: Ship the approved plan with evidence
members:
  - agent: terra
    role: writer
    exclusive: true
  - agent: reviewer
    role: reviewer
    context: fresh
  - agent: scout
    role: validator
    toolBudget: { soft: 25, hard: 40 }
concurrency: 3`;

describe("splitFrontmatter", () => {
	it("splits frontmatter from body", () => {
		const { frontmatter, body } = splitFrontmatter("---\nname: x\n---\nhello\n");
		assert.equal(frontmatter.trim(), "name: x");
		assert.equal(body, "hello");
	});

	it("treats a file with no frontmatter as all body", () => {
		const { frontmatter, body } = splitFrontmatter("just text");
		assert.equal(frontmatter, "");
		assert.equal(body, "just text");
	});

	it("treats an unterminated frontmatter block as all body", () => {
		const { frontmatter } = splitFrontmatter("---\nname: x\nno end marker");
		assert.equal(frontmatter, "");
	});
});

describe("parseTeam", () => {
	it("parses a full roster", () => {
		const { team, error } = parseTeam(teamFile(BUILD_TEAM, "Shared conventions."), "/t/build.md", "user");
		assert.equal(error, undefined);
		assert.ok(team);
		assert.equal(team.name, "build");
		assert.equal(team.goal, "Ship the approved plan with evidence");
		assert.equal(team.concurrency, 3);
		assert.equal(team.sharedDir, true, "sharedDir defaults to true");
		assert.equal(team.instructions, "Shared conventions.");
		assert.equal(team.source, "user");
		assert.equal(team.members.length, 3);
		assert.deepEqual(
			team.members.map((m) => m.agent),
			["terra", "reviewer", "scout"],
		);
		assert.equal(team.members[0].exclusive, true);
		assert.equal(team.members[1].context, "fresh");
		assert.equal(team.members[2].toolBudget?.hard, 40);
	});

	it("accepts a bare agent name as shorthand", () => {
		const { team } = parseTeam(teamFile("description: d\nmembers:\n  - scout\n  - oracle"), "/t/x.md", "user");
		assert.deepEqual(team?.members.map((m) => m.agent), ["scout", "oracle"]);
	});

	it("falls back to the filename for a missing name", () => {
		const { team } = parseTeam(teamFile("description: d\nmembers:\n  - scout"), "/t/audit.md", "builtin");
		assert.equal(team?.name, "audit");
	});

	it("requires a description", () => {
		const { error } = parseTeam(teamFile("name: x\nmembers:\n  - scout"), "/t/x.md", "user");
		assert.match(String(error), /missing a description/);
	});

	it("requires a members list", () => {
		const { error } = parseTeam(teamFile("description: d"), "/t/x.md", "user");
		assert.match(String(error), /missing a members list/);
	});

	it("rejects a member with no agent", () => {
		const { error } = parseTeam(teamFile("description: d\nmembers:\n  - role: writer"), "/t/x.md", "user");
		assert.match(String(error), /members\[0\]\.agent is required/);
	});

	it("rejects a non-boolean exclusive", () => {
		const { error } = parseTeam(
			teamFile("description: d\nmembers:\n  - agent: terra\n    exclusive: yep"),
			"/t/x.md",
			"user",
		);
		assert.match(String(error), /exclusive must be a boolean/);
	});

	it("rejects an unknown context value", () => {
		const { error } = parseTeam(
			teamFile("description: d\nmembers:\n  - agent: terra\n    context: inherited"),
			"/t/x.md",
			"user",
		);
		assert.match(String(error), /context must be/);
	});

	it("rejects a bad concurrency", () => {
		const { error } = parseTeam(
			teamFile("description: d\nconcurrency: 0\nmembers:\n  - agent: terra"),
			"/t/x.md",
			"user",
		);
		assert.match(String(error), /concurrency must be an integer >= 1/);
	});

	it("surfaces invalid YAML rather than throwing", () => {
		const { error } = parseTeam("---\ndescription: [unclosed\n---\nbody", "/t/x.md", "user");
		assert.match(String(error), /invalid YAML frontmatter/);
	});

	it("requires frontmatter", () => {
		const { error } = parseTeam("no frontmatter here", "/t/x.md", "user");
		assert.match(String(error), /missing YAML frontmatter/);
	});

	it("honours sharedDir: false", () => {
		const { team } = parseTeam(
			teamFile("description: d\nsharedDir: false\nmembers:\n  - agent: scout"),
			"/t/x.md",
			"user",
		);
		assert.equal(team?.sharedDir, false);
	});
});

describe("validateRoster", () => {
	const member = (agent: string, extra: Partial<TeamMember> = {}): TeamMember => ({ agent, ...extra });

	it("rejects an empty roster", () => {
		assert.match(String(validateRoster([])), /at least one member/);
	});

	it("allows exactly one exclusive writer", () => {
		assert.equal(
			validateRoster([member("terra", { exclusive: true, role: "writer" }), member("reviewer", { role: "rev" })]),
			undefined,
		);
	});

	it("rejects two exclusive writers before anything is spawned", () => {
		const error = validateRoster([
			member("terra", { exclusive: true, role: "a" }),
			member("luna", { exclusive: true, role: "b" }),
		]);
		assert.match(String(error), /only one member may be exclusive/);
		assert.match(String(error), /terra, luna/);
	});

	it("allows the same agent twice with distinct roles", () => {
		assert.equal(
			validateRoster([member("reviewer", { role: "security" }), member("reviewer", { role: "correctness" })]),
			undefined,
		);
	});

	it("rejects an indistinguishable duplicate", () => {
		const error = validateRoster([member("reviewer", { role: "security" }), member("reviewer", { role: "security" })]);
		assert.match(String(error), /duplicate member reviewer/);
	});

	it("does not let concatenation collide distinct members", () => {
		// "ab" + "c" must not be treated as the same key as "a" + "bc".
		assert.equal(validateRoster([member("ab", { role: "c" }), member("a", { role: "bc" })]), undefined);
	});
});

describe("expandTeamToTasks", () => {
	const team = parseTeam(teamFile(BUILD_TEAM, "Team conventions apply."), "/t/build.md", "user").team as TeamConfig;

	it("produces one parallel task per member", () => {
		const tasks = expandTeamToTasks(team, "Implement the plan");
		assert.equal(tasks.length, 3);
		assert.deepEqual(
			tasks.map((t) => t.agent),
			["terra", "reviewer", "scout"],
		);
	});

	it("carries the caller task into every member", () => {
		for (const task of expandTeamToTasks(team, "Implement the plan")) {
			assert.match(task.task, /Implement the plan/);
		}
	});

	it("injects goal, role, and instructions", () => {
		const [writer] = expandTeamToTasks(team, "go");
		assert.match(writer.task, /Team goal: Ship the approved plan with evidence/);
		assert.match(writer.task, /Your role on team 'build': writer/);
		assert.match(writer.task, /Team conventions apply\./);
	});

	it("tells the exclusive member it is the sole writer, and no one else", () => {
		const tasks = expandTeamToTasks(team, "go");
		assert.match(tasks[0].task, /sole writer/);
		assert.doesNotMatch(tasks[1].task, /sole writer/);
		assert.doesNotMatch(tasks[2].task, /sole writer/);
	});

	it("maps role onto label and as, for fleet grouping and {outputs.<role>}", () => {
		const [writer] = expandTeamToTasks(team, "go");
		assert.equal(writer.label, "writer");
		assert.equal(writer.as, "writer");
	});

	it("forwards per-member execution fields", () => {
		const tasks = expandTeamToTasks(team, "go");
		assert.equal(tasks[1].context, "fresh");
		assert.equal(tasks[2].toolBudget?.hard, 40);
	});

	it("mentions the shared dir only when one is provisioned", () => {
		const withDir = expandTeamToTasks(team, "go", "/tmp/team-1");
		assert.match(withDir[0].task, /Team scratch dir: \/tmp\/team-1/);
		assert.match(withDir[0].task, /claims\.json/);
		const withoutDir = expandTeamToTasks(team, "go");
		assert.doesNotMatch(withoutDir[0].task, /Team scratch dir/);
	});

	it("positions the caller task at {task} when a member templates it", () => {
		const templated = parseTeam(
			teamFile("description: d\nmembers:\n  - agent: reviewer\n    task: 'Review only: {task}. No edits.'"),
			"/t/x.md",
			"user",
		).team as TeamConfig;
		const [only] = expandTeamToTasks(templated, "the auth diff");
		assert.match(only.task, /Review only: the auth diff\. No edits\./);
	});

	it("appends the caller task when a member template omits {task}", () => {
		// A member template must never be able to silently drop the assignment.
		const templated = parseTeam(
			teamFile("description: d\nmembers:\n  - agent: reviewer\n    task: Read-only review."),
			"/t/x.md",
			"user",
		).team as TeamConfig;
		const [only] = expandTeamToTasks(templated, "the auth diff");
		assert.match(only.task, /Read-only review\./);
		assert.match(only.task, /the auth diff/);
	});
});

describe("resolveTeamRequest", () => {
	// Rewrites `team:` into `tasks:` in place, before schema validation, so the
	// rest of the executor never learns teams exist. `build` is a shipped builtin.
	const cwd = path.join(import.meta.dirname, "..", "..");

	it("expands a builtin team into a parallel group", () => {
		const args: Record<string, unknown> = { team: "build", task: "Implement the plan" };
		resolveTeamRequest(args, cwd);
		assert.equal(args.team, undefined, "team must be consumed");
		assert.ok(Array.isArray(args.tasks));
		const tasks = args.tasks as { agent: string; task: string }[];
		assert.equal(tasks.length, 3);
		for (const task of tasks) assert.match(task.task, /Implement the plan/);
	});

	it("applies the team's concurrency but never overrides the caller's", () => {
		const fromTeam: Record<string, unknown> = { team: "build", task: "go" };
		resolveTeamRequest(fromTeam, cwd);
		assert.equal(fromTeam.concurrency, 3);

		const fromCaller: Record<string, unknown> = { team: "build", task: "go", concurrency: 1 };
		resolveTeamRequest(fromCaller, cwd);
		assert.equal(fromCaller.concurrency, 1);
	});

	it("is a no-op when no team is requested", () => {
		const args: Record<string, unknown> = { agent: "scout", task: "look" };
		resolveTeamRequest(args, cwd);
		assert.deepEqual(args, { agent: "scout", task: "look" });
	});

	it("rejects team + tasks and team + chain", () => {
		assert.throws(
			() => resolveTeamRequest({ team: "build", task: "go", tasks: [{ agent: "scout", task: "x" }] }, cwd),
			/mutually exclusive/,
		);
		assert.throws(
			() => resolveTeamRequest({ team: "build", task: "go", chain: [{ agent: "scout", task: "x" }] }, cwd),
			/mutually exclusive/,
		);
	});

	it("requires a task", () => {
		assert.throws(() => resolveTeamRequest({ team: "build" }, cwd), /needs a `task`/);
	});

	it("lists available teams when the name is unknown", () => {
		assert.throws(() => resolveTeamRequest({ team: "nope", task: "go" }, cwd), (err: Error) => {
			assert.match(err.message, /no team named 'nope'/);
			assert.match(err.message, /Available: .*build/);
			return true;
		});
	});
});

describe("findTeam", () => {
	const mk = (name: string): TeamConfig => ({
		name,
		description: "d",
		members: [{ agent: "scout" }],
		sharedDir: true,
		instructions: "",
		source: "user",
		filePath: `/t/${name}.md`,
	});

	it("finds case-insensitively and tolerates surrounding space", () => {
		const teams = [mk("build"), mk("audit")];
		assert.equal(findTeam(teams, "BUILD")?.name, "build");
		assert.equal(findTeam(teams, "  audit  ")?.name, "audit");
		assert.equal(findTeam(teams, "missing"), undefined);
	});
});

describe("team files on disk", () => {
	it("parses every shipped builtin team", () => {
		const dir = path.join(import.meta.dirname, "..", "..", "teams");
		if (!fs.existsSync(dir)) return; // no builtin teams shipped yet
		for (const entry of fs.readdirSync(dir)) {
			if (!entry.endsWith(".md")) continue;
			const file = path.join(dir, entry);
			const { team, error } = parseTeam(fs.readFileSync(file, "utf-8"), file, "builtin");
			assert.equal(error, undefined, `${entry} failed to parse: ${error}`);
			assert.ok(team, `${entry} produced no team`);
		}
	});

	it("ignores a directory that does not exist", () => {
		const missing = path.join(os.tmpdir(), `teams-missing-${process.pid}`);
		assert.equal(fs.existsSync(missing), false);
	});
});
