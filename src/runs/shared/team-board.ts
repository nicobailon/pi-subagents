/**
 * Team shared state: an append-only board and advisory path claims.
 *
 * Provisioned per team run at `<base>/team-<runId>/`, mode 0700, containing:
 *   .team-root    marker identifying the directory as a provisioned team dir
 *   board.md      append-only, attributed, timestamped findings
 *   claims.json   advisory path ownership
 *
 * WHY THE BOARD AND NOT DIRECT PEER MESSAGING
 * Direct member-to-member messaging needs presence, retry, and blocking reads —
 * duplicating the intercom broker and introducing deadlock risk between siblings
 * that are supposed to be making progress. An append-only log cannot deadlock,
 * needs no delivery guarantees, and stays inspectable after the run. Upward
 * coordination remains `contact_supervisor`.
 *
 * WHY CLAIMS ARE ADVISORY
 * `claims.json` is bookkeeping, not a filesystem lock. It catches the common
 * parallel-writer collision early — a second overlapping claim fails fast naming
 * the current owner, instead of surfacing as a merge conflict after both children
 * have finished. It cannot stop a determined writer, and callers must not treat a
 * successful claim as exclusive access.
 *
 * HOW THE DIRECTORY REACHES A MEMBER, AND WHY IT IS TRUSTED
 * The parent provisions the dir in `resolveTeamRequest` and puts it on each
 * expanded task; `pi-args` forwards it to the child as TEAM_DIR_ENV, which both
 * gates registration of `team_note` and supplies its default directory. A
 * non-team child never has the variable set and never sees the tool.
 *
 * `team_note` still accepts an explicit `dir`, and every path — default or
 * explicit — must pass the `.team-root` marker check. That is what makes an
 * argument safe: a child can only read and write inside a directory the parent
 * actually provisioned as a team dir, so an arbitrary path is rejected.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

/** Root for provisioned team dirs, alongside the other per-scope temp roots. */
export const TEAM_DIRS_ROOT = path.join(TEMP_ROOT_DIR, "team-dirs");

/**
 * Set on a child that belongs to a team run, and the gate for registering
 * `team_note`. A non-team child must not see the tool at all — an unused tool is
 * prompt bloat and widens the child's surface for no reason.
 */
export const TEAM_DIR_ENV = "PI_SUBAGENT_TEAM_DIR";

export const TEAM_ROOT_MARKER = ".team-root";
export const TEAM_BOARD_FILE = "board.md";
export const TEAM_CLAIMS_FILE = "claims.json";

/**
 * Hard cap on what a single `read` returns. An unbounded board re-read by every
 * member each turn would dominate their context — the failure mode called out as
 * a risk in the proposal. Mirrors the spirit of the 4 MiB child-protocol bound.
 */
export const BOARD_READ_LIMIT = 200;
/** Cap on one posted note, so a single member cannot flood the shared log. */
export const NOTE_MAX_CHARS = 4000;

export interface TeamRootInfo {
	team: string;
	runId: string;
	createdAt: string;
}

export interface BoardEntry {
	seq: number;
	at: string;
	author: string;
	text: string;
}

export interface PathClaim {
	owner: string;
	patterns: string[];
	at: string;
}

function boardPath(dir: string): string {
	return path.join(dir, TEAM_BOARD_FILE);
}

function claimsPath(dir: string): string {
	return path.join(dir, TEAM_CLAIMS_FILE);
}

/** True when `dir` was provisioned by provisionTeamDir. */
export function isTeamDir(dir: string): boolean {
	try {
		return fs.statSync(path.join(dir, TEAM_ROOT_MARKER)).isFile();
	} catch {
		return false;
	}
}

export function readTeamRoot(dir: string): TeamRootInfo | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, TEAM_ROOT_MARKER), "utf-8")) as Partial<TeamRootInfo>;
		if (typeof parsed.team !== "string" || typeof parsed.runId !== "string") return undefined;
		return { team: parsed.team, runId: parsed.runId, createdAt: parsed.createdAt ?? "" };
	} catch {
		return undefined;
	}
}

/**
 * Create the team directory and its initial files. Idempotent: re-provisioning an
 * existing team dir leaves the board and claims intact so a resumed run keeps its
 * history.
 */
export function provisionTeamDir(baseDir: string, team: string, runId: string): string {
	const dir = path.join(baseDir, `team-${runId}`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!isTeamDir(dir)) {
		writePrivateAtomicJson(path.join(dir, TEAM_ROOT_MARKER), {
			team,
			runId,
			createdAt: new Date().toISOString(),
		} satisfies TeamRootInfo);
	}
	if (!fs.existsSync(boardPath(dir))) {
		fs.writeFileSync(
			boardPath(dir),
			`# Team board — ${team}\n\nAppend-only. One entry per finding. Newest last.\n`,
			{ mode: 0o600 },
		);
	}
	if (!fs.existsSync(claimsPath(dir))) writePrivateAtomicJson(claimsPath(dir), { claims: [] });
	return dir;
}

/**
 * Append an attributed entry. Appends rather than rewriting so concurrent
 * siblings cannot lose each other's notes: O_APPEND writes of a single small
 * buffer do not interleave on local filesystems.
 */
export function postNote(dir: string, author: string, text: string): { ok: true; seq: number } | { ok: false; error: string } {
	if (!isTeamDir(dir)) return { ok: false, error: `not a team directory: ${dir}` };
	const trimmed = text.trim();
	if (trimmed === "") return { ok: false, error: "note is empty" };
	const body = trimmed.length > NOTE_MAX_CHARS ? `${trimmed.slice(0, NOTE_MAX_CHARS)}\n\n[… note truncated]` : trimmed;
	// Must use `total`, not `entries.length`: entries is capped at
	// BOARD_READ_LIMIT, so deriving the sequence from it made every note past the
	// cap collide on the same number.
	const seq = readBoard(dir).total + 1;
	// Blank line before the marker keeps entries separable even if a note body
	// itself contains a line starting with "- [".
	const entry = `\n- [${seq}] ${new Date().toISOString()} — **${author}**\n\n${body
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : `  ${line}`))
		.join("\n")}\n`;
	try {
		fs.appendFileSync(boardPath(dir), entry, { mode: 0o600 });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	return { ok: true, seq };
}

export function readBoard(dir: string, options: { since?: number; limit?: number } = {}): { entries: BoardEntry[]; total: number } {
	let raw: string;
	try {
		raw = fs.readFileSync(boardPath(dir), "utf-8");
	} catch {
		return { entries: [], total: 0 };
	}
	const entries: BoardEntry[] = [];
	const pattern = /^- \[(\d+)\] (\S+) — \*\*(.+?)\*\*$/;
	const lines = raw.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(pattern);
		if (!match) continue;
		const bodyLines: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (pattern.test(lines[j])) break;
			bodyLines.push(lines[j].replace(/^ {2}/, ""));
		}
		entries.push({
			seq: Number(match[1]),
			at: match[2],
			author: match[3],
			text: bodyLines.join("\n").trim(),
		});
	}
	const total = entries.length;
	const since = options.since ?? 0;
	const limit = Math.min(options.limit ?? BOARD_READ_LIMIT, BOARD_READ_LIMIT);
	const filtered = entries.filter((entry) => entry.seq > since);
	// Keep the newest when truncating: a member catching up cares about what
	// happened most recently, not the start of the run.
	return { entries: filtered.slice(-limit), total };
}

export function readClaims(dir: string): PathClaim[] {
	try {
		const parsed = JSON.parse(fs.readFileSync(claimsPath(dir), "utf-8")) as { claims?: unknown };
		if (!Array.isArray(parsed.claims)) return [];
		return parsed.claims.filter(
			(claim): claim is PathClaim =>
				typeof claim === "object" &&
				claim !== null &&
				typeof (claim as PathClaim).owner === "string" &&
				Array.isArray((claim as PathClaim).patterns),
		);
	} catch {
		return [];
	}
}

/**
 * Normalize a claim pattern so `./src/a`, `src/a`, and `src/a/` compare equal.
 * Trailing `/**` and `/` are stripped; the prefix test in `patternsOverlap` then
 * handles subtree containment.
 */
export function normalizeClaimPattern(pattern: string): string {
	return pattern
		.trim()
		.replace(/^\.\//, "")
		.replace(/\/+$/, "")
		.replace(/\/\*\*$/, "")
		.replace(/\/+/g, "/");
}

/**
 * Two patterns overlap when either contains the other as a path prefix. Segment
 * boundaries are respected, so `src/auth` does not overlap `src/authz`.
 */
export function patternsOverlap(a: string, b: string): boolean {
	const left = normalizeClaimPattern(a);
	const right = normalizeClaimPattern(b);
	if (left === right) return true;
	return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

/**
 * Record intended path ownership. Fails naming the current owner when any
 * requested pattern overlaps a claim held by someone else. Re-claiming your own
 * patterns is a no-op success, so a retrying child is not blocked by itself.
 */
export function claimPaths(
	dir: string,
	owner: string,
	patterns: string[],
): { ok: true; claimed: string[] } | { ok: false; error: string; conflictWith?: string } {
	if (!isTeamDir(dir)) return { ok: false, error: `not a team directory: ${dir}` };
	const wanted = [...new Set(patterns.map(normalizeClaimPattern).filter(Boolean))];
	if (wanted.length === 0) return { ok: false, error: "no paths given" };

	const existing = readClaims(dir);
	for (const claim of existing) {
		if (claim.owner === owner) continue;
		for (const held of claim.patterns) {
			const clash = wanted.find((candidate) => patternsOverlap(candidate, held));
			if (clash) {
				return {
					ok: false,
					error: `'${clash}' overlaps '${held}', already claimed by ${claim.owner}`,
					conflictWith: claim.owner,
				};
			}
		}
	}

	const mine = existing.find((claim) => claim.owner === owner);
	const merged = mine
		? existing.map((claim) =>
				claim.owner === owner
					? { ...claim, patterns: [...new Set([...claim.patterns, ...wanted])], at: new Date().toISOString() }
					: claim,
			)
		: [...existing, { owner, patterns: wanted, at: new Date().toISOString() }];
	try {
		writePrivateAtomicJson(claimsPath(dir), { claims: merged });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	return { ok: true, claimed: wanted };
}

/** Render the board for a fleet transcript pane or a status projection. */
export function formatBoard(entries: BoardEntry[]): string {
	if (entries.length === 0) return "(no board entries)";
	return entries.map((entry) => `[${entry.seq}] ${entry.author}: ${entry.text.split("\n")[0]}`).join("\n");
}
