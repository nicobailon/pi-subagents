import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	BOARD_READ_LIMIT,
	NOTE_MAX_CHARS,
	TEAM_ROOT_MARKER,
	claimPaths,
	formatBoard,
	isTeamDir,
	normalizeClaimPattern,
	patternsOverlap,
	postNote,
	provisionTeamDir,
	readBoard,
	readClaims,
	readTeamRoot,
} from "../../src/runs/shared/team-board.ts";

function tmpBase(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "team-board-"));
}

describe("provisionTeamDir", () => {
	it("creates the marker, board, and claims", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "run1");
		assert.equal(isTeamDir(dir), true);
		assert.equal(fs.existsSync(path.join(dir, "board.md")), true);
		assert.deepEqual(readClaims(dir), []);
		const info = readTeamRoot(dir);
		assert.equal(info?.team, "build");
		assert.equal(info?.runId, "run1");
	});

	it("is private to the owner", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "run1");
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(dir, TEAM_ROOT_MARKER)).mode & 0o777, 0o600);
	});

	it("preserves existing history when re-provisioned (resume)", () => {
		const base = tmpBase();
		const dir = provisionTeamDir(base, "build", "run1");
		postNote(dir, "writer", "first finding");
		claimPaths(dir, "writer", ["src/auth"]);
		const again = provisionTeamDir(base, "build", "run1");
		assert.equal(again, dir);
		assert.equal(readBoard(dir).total, 1);
		assert.equal(readClaims(dir).length, 1);
	});

	it("rejects a directory it did not provision", () => {
		const plain = tmpBase();
		assert.equal(isTeamDir(plain), false);
		assert.equal(postNote(plain, "a", "x").ok, false);
		assert.equal(claimPaths(plain, "a", ["src"]).ok, false);
	});
});

describe("board", () => {
	it("appends attributed, sequenced entries", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		assert.deepEqual(postNote(dir, "writer", "did a thing"), { ok: true, seq: 1 });
		assert.deepEqual(postNote(dir, "reviewer", "found a bug"), { ok: true, seq: 2 });
		const { entries, total } = readBoard(dir);
		assert.equal(total, 2);
		assert.deepEqual(
			entries.map((e) => [e.seq, e.author, e.text]),
			[
				[1, "writer", "did a thing"],
				[2, "reviewer", "found a bug"],
			],
		);
	});

	it("round-trips a multi-line note", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		postNote(dir, "reviewer", "line one\n\nline three");
		assert.equal(readBoard(dir).entries[0].text, "line one\n\nline three");
	});

	it("survives a note containing a line that looks like an entry marker", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		postNote(dir, "writer", "quoting: this is fine");
		postNote(dir, "reviewer", "second");
		const { entries } = readBoard(dir);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].author, "writer");
	});

	it("rejects an empty note", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		assert.equal(postNote(dir, "writer", "   ").ok, false);
	});

	it("truncates a flooding note instead of accepting it whole", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		postNote(dir, "writer", "x".repeat(NOTE_MAX_CHARS + 500));
		const text = readBoard(dir).entries[0].text;
		assert.match(text, /note truncated/);
		assert.ok(text.length < NOTE_MAX_CHARS + 200);
	});

	it("supports incremental reads with since", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		postNote(dir, "a", "one");
		postNote(dir, "b", "two");
		postNote(dir, "c", "three");
		const { entries, total } = readBoard(dir, { since: 1 });
		assert.equal(total, 3, "total reflects the whole board");
		assert.deepEqual(entries.map((e) => e.seq), [2, 3]);
	});

	it("caps a read and keeps the newest entries", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		for (let i = 0; i < BOARD_READ_LIMIT + 10; i++) postNote(dir, "a", `note ${i}`);
		const { entries, total } = readBoard(dir);
		assert.equal(total, BOARD_READ_LIMIT + 10);
		assert.equal(entries.length, BOARD_READ_LIMIT);
		assert.equal(entries[entries.length - 1].seq, BOARD_READ_LIMIT + 10);
	});

	it("never exceeds the hard cap even when a larger limit is requested", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		for (let i = 0; i < BOARD_READ_LIMIT + 5; i++) postNote(dir, "a", `n${i}`);
		assert.equal(readBoard(dir, { limit: 10_000 }).entries.length, BOARD_READ_LIMIT);
	});

	it("reads an absent board as empty rather than throwing", () => {
		assert.deepEqual(readBoard(tmpBase()), { entries: [], total: 0 });
	});
});

describe("claim patterns", () => {
	it("normalizes equivalent spellings", () => {
		for (const variant of ["src/a", "./src/a", "src/a/", "src/a/**", "src//a"]) {
			assert.equal(normalizeClaimPattern(variant), "src/a");
		}
	});

	it("treats subtrees as overlapping", () => {
		assert.equal(patternsOverlap("src", "src/auth"), true);
		assert.equal(patternsOverlap("src/auth", "src"), true);
		assert.equal(patternsOverlap("src/auth", "src/auth/token.ts"), true);
	});

	it("respects segment boundaries", () => {
		// The bug a naive startsWith would introduce.
		assert.equal(patternsOverlap("src/auth", "src/authz"), false);
		assert.equal(patternsOverlap("src/a", "src/ab"), false);
	});

	it("treats unrelated paths as disjoint", () => {
		assert.equal(patternsOverlap("src/auth", "src/ui"), false);
	});
});

describe("claims", () => {
	it("records a claim", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		const result = claimPaths(dir, "writer", ["src/auth/**"]);
		assert.deepEqual(result, { ok: true, claimed: ["src/auth"] });
		assert.equal(readClaims(dir)[0].owner, "writer");
	});

	it("fails a conflicting claim and names the owner", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		claimPaths(dir, "writer", ["src/auth"]);
		const clash = claimPaths(dir, "other", ["src/auth/token.ts"]);
		assert.equal(clash.ok, false);
		if (!clash.ok) {
			assert.equal(clash.conflictWith, "writer");
			assert.match(clash.error, /already claimed by writer/);
		}
	});

	it("lets the same owner re-claim and extend without conflict", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		claimPaths(dir, "writer", ["src/auth"]);
		assert.equal(claimPaths(dir, "writer", ["src/auth"]).ok, true, "re-claiming own path must succeed");
		assert.equal(claimPaths(dir, "writer", ["src/api"]).ok, true);
		assert.deepEqual(readClaims(dir).find((c) => c.owner === "writer")?.patterns, ["src/auth", "src/api"]);
	});

	it("allows disjoint owners", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		assert.equal(claimPaths(dir, "writer", ["src/core"]).ok, true);
		assert.equal(claimPaths(dir, "ui", ["src/ui"]).ok, true);
		assert.equal(readClaims(dir).length, 2);
	});

	it("rejects an empty claim list", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		assert.equal(claimPaths(dir, "writer", ["  ", ""]).ok, false);
	});

	it("tolerates a corrupt claims file rather than throwing", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		fs.writeFileSync(path.join(dir, "claims.json"), "{not json");
		assert.deepEqual(readClaims(dir), []);
		assert.equal(claimPaths(dir, "writer", ["src"]).ok, true);
	});
});

describe("formatBoard", () => {
	it("summarises one line per entry", () => {
		const dir = provisionTeamDir(tmpBase(), "build", "r");
		postNote(dir, "writer", "first line\nsecond line");
		assert.equal(formatBoard(readBoard(dir).entries), "[1] writer: first line");
	});

	it("has an empty state", () => {
		assert.equal(formatBoard([]), "(no board entries)");
	});
});
