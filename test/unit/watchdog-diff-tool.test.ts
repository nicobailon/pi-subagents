import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsDefault from "node:fs";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureWatchdogDiffBaseline, createWatchdogDiffTool, type WatchdogDiffBaseline, WATCHDOG_DIFF_MAX_CHARS } from "../../src/watchdog/diff-tool.ts";

let repo = "";

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

async function run(tool: ReturnType<typeof createWatchdogDiffTool>, params: { path?: string; stat?: boolean } = {}): Promise<string> {
	const result = await tool.execute("call", params, undefined as never, undefined as never, undefined as never);
	return result.content.map((part) => (part as { text?: string }).text ?? "").join("\n");
}

function captureBaseline(cwd: string): WatchdogDiffBaseline | undefined {
	return captureWatchdogDiffBaseline(cwd);
}

describe("watchdog diff tool", () => {
	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-"));
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test User");
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n", "utf-8");
		fs.writeFileSync(path.join(repo, "README.md"), "readme\n", "utf-8");
		git("add", ".");
		git("commit", "-q", "-m", "base");
	});

	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("captures the session baseline and reports no changes when clean", async () => {
		const baseline = captureBaseline(path.join(repo, "src"));
		assert.ok(baseline);
		assert.equal(baseline.root, fs.realpathSync(repo));
		const rootStats = fs.statSync(repo);
		assert.equal(baseline.rootDevice, rootStats.dev);
		assert.equal(baseline.rootInode, rootStats.ino);
		assert.equal(baseline.ref, git("rev-parse", "HEAD").trim());
		assert.match(await run(createWatchdogDiffTool(baseline)), /^No changes since baseline/);
		assert.equal(captureBaseline(os.tmpdir()), undefined);
	});

	it("captures the physical repository root from a symlinked subdirectory cwd", { skip: process.platform === "win32" ? "symlink creation is not portable on Windows CI" : undefined }, async () => {
		const link = `${repo}-src-link`;
		fs.symlinkSync(path.join(repo, "src"), link, "dir");
		try {
			const baseline = captureBaseline(link);
			assert.ok(baseline);
			assert.equal(baseline.root, fs.realpathSync(repo));
			fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf-8");

			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /\+\+\+ src\/b\.ts \(untracked\)\n\+export const b = 1;/);
		} finally {
			fs.unlinkSync(link);
		}
	});

	it("shows tracked changes since the baseline, including later commits, plus untracked files", async () => {
		const baseline = captureBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf-8");
		git("commit", "-q", "-am", "child commit");
		fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf-8");
		const tool = createWatchdogDiffTool(baseline);

		const full = await run(tool);
		assert.match(full, /-export const a = 1;/);
		assert.match(full, /\+export const a = 2;/);
		assert.match(full, /\+\+\+ src\/b\.ts \(untracked\)\n\+export const b = 1;/);

		const stat = await run(tool, { stat: true });
		assert.match(stat, /src\/a\.ts \|/);
		assert.match(stat, /Untracked files:\n src\/b\.ts \(new\)/);

		const narrowed = await run(tool, { path: "README.md" });
		assert.doesNotMatch(narrowed, /a\.ts|b\.ts/);
	});

	it("omits untracked symlinks instead of reading their target", { skip: process.platform === "win32" ? "symlink creation is not portable on Windows CI" : undefined }, async () => {
		const baseline = captureBaseline(repo)!;
		const outside = path.join(os.tmpdir(), `watchdog-diff-secret-${process.pid}`);
		fs.writeFileSync(outside, "external secret\n", "utf-8");
		try {
			fs.symlinkSync(outside, path.join(repo, "leak.txt"));
			const full = await run(createWatchdogDiffTool(baseline));
			assert.match(full, /\+\+\+ leak\.txt \(untracked, symlink omitted\)/);
			assert.doesNotMatch(full, /external secret/);
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("rejects a captured repository root replaced by another checkout", { skip: process.platform === "win32" ? "the pinned git runner holds the checkout cwd on Windows" : undefined }, async () => {
		const baseline = captureBaseline(repo)!;
		const original = `${repo}-original`;
		const replacement = `${repo}-replacement`;
		execFileSync("git", ["clone", "-q", repo, replacement], { stdio: "ignore" });
		fs.writeFileSync(path.join(replacement, "secret.txt"), "EXTERNAL_SECRET\n", "utf-8");
		fs.renameSync(repo, original);
		fs.renameSync(replacement, repo);
		try {
			await assert.rejects(() => run(createWatchdogDiffTool(baseline)), /repository root changed since the baseline was captured/);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
			fs.renameSync(original, repo);
			fs.rmSync(replacement, { recursive: true, force: true });
		}
	});

	it("binds tracked git diffs to the captured checkout during root path ABA replacement", { skip: process.platform === "win32" ? "POSIX rename race reproduction" : undefined }, async () => {
		const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
		const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-git-wrapper-"));
		const wrapper = path.join(wrapperDir, "git");
		const original = `${repo}-original-aba`;
		const replacement = `${repo}-replacement-aba`;
		execFileSync(realGit, ["clone", "-q", repo, replacement], { stdio: "ignore" });
		fs.writeFileSync(path.join(replacement, "src", "a.ts"), "EXTERNAL_SECRET\n", "utf-8");
		fs.writeFileSync(wrapper, `#!/bin/sh
swapped=0
restore() {
	status=$?
	if [ "$swapped" = "1" ]; then
		rm -rf "$WATCHDOG_DIFF_ABA_REPLACEMENT"
		mv "$WATCHDOG_DIFF_ABA_ROOT" "$WATCHDOG_DIFF_ABA_REPLACEMENT"
		mv "$WATCHDOG_DIFF_ABA_ORIGINAL" "$WATCHDOG_DIFF_ABA_ROOT"
	fi
	exit $status
}
trap restore EXIT INT TERM
if [ "\${1:-}" = "diff" ] || { [ "\${1:-}" = "-C" ] && [ "\${3:-}" = "diff" ]; }; then
	rm -rf "$WATCHDOG_DIFF_ABA_ORIGINAL"
	mv "$WATCHDOG_DIFF_ABA_ROOT" "$WATCHDOG_DIFF_ABA_ORIGINAL"
	mv "$WATCHDOG_DIFF_ABA_REPLACEMENT" "$WATCHDOG_DIFF_ABA_ROOT"
	swapped=1
fi
"$WATCHDOG_DIFF_REAL_GIT" "$@"
exit $?
`, "utf-8");
		fs.chmodSync(wrapper, 0o755);
		const previousEnv = {
			PATH: process.env.PATH,
			WATCHDOG_DIFF_ABA_ROOT: process.env.WATCHDOG_DIFF_ABA_ROOT,
			WATCHDOG_DIFF_ABA_ORIGINAL: process.env.WATCHDOG_DIFF_ABA_ORIGINAL,
			WATCHDOG_DIFF_ABA_REPLACEMENT: process.env.WATCHDOG_DIFF_ABA_REPLACEMENT,
			WATCHDOG_DIFF_REAL_GIT: process.env.WATCHDOG_DIFF_REAL_GIT,
		};
		process.env.PATH = `${wrapperDir}${path.delimiter}${process.env.PATH ?? ""}`;
		process.env.WATCHDOG_DIFF_ABA_ROOT = repo;
		process.env.WATCHDOG_DIFF_ABA_ORIGINAL = original;
		process.env.WATCHDOG_DIFF_ABA_REPLACEMENT = replacement;
		process.env.WATCHDOG_DIFF_REAL_GIT = realGit;
		try {
			const baseline = captureBaseline(repo)!;

			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /^No changes since baseline/);
			assert.doesNotMatch(full, /EXTERNAL_SECRET/);
		} finally {
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (fs.existsSync(original)) {
				fs.rmSync(repo, { recursive: true, force: true });
				fs.renameSync(original, repo);
			}
			fs.rmSync(replacement, { recursive: true, force: true });
			fs.rmSync(wrapperDir, { recursive: true, force: true });
		}
	});

	it("ignores external diff drivers, clean filters, and config env while rendering tracked diffs", { skip: process.platform === "win32" ? "shell helper reproduction" : undefined }, async () => {
		const helper = path.join(repo, "external-diff.sh");
		const outside = path.join(os.tmpdir(), `watchdog-diff-driver-secret-${process.pid}`);
		fs.writeFileSync(outside, "EXTERNAL_SECRET\n", "utf-8");
		fs.writeFileSync(helper, `#!/bin/sh
cat "$WATCHDOG_DIFF_DRIVER_SECRET"
`, "utf-8");
		fs.chmodSync(helper, 0o755);
		git("config", "diff.external", helper);
		git("config", "filter.leak.clean", helper);
		git("config", "filter.leak.required", "true");
		const previousEnv = {
			GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
			GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
			WATCHDOG_DIFF_DRIVER_SECRET: process.env.WATCHDOG_DIFF_DRIVER_SECRET,
		};
		process.env.GIT_EXTERNAL_DIFF = helper;
		process.env.GIT_CONFIG_COUNT = "bogus";
		process.env.WATCHDOG_DIFF_DRIVER_SECRET = outside;
		try {
			const baseline = captureBaseline(repo)!;
			fs.writeFileSync(path.join(repo, ".gitattributes"), "*.ts filter=leak\n", "utf-8");
			fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 333;\n", "utf-8");

			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /\+export const a = 333;/);
			assert.doesNotMatch(full, /EXTERNAL_SECRET/);
		} finally {
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(outside, { force: true });
		}
	});

	it("ignores clean filters added after diff setup starts", { skip: process.platform === "win32" ? "shell helper reproduction" : undefined }, async () => {
		const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
		const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-raced-filter-"));
		const wrapper = path.join(wrapperDir, "git");
		const helper = path.join(wrapperDir, "raced-filter.sh");
		const outside = path.join(os.tmpdir(), `watchdog-diff-raced-filter-secret-${process.pid}`);
		fs.writeFileSync(outside, "RACED_FILTER_SECRET\n", "utf-8");
		fs.writeFileSync(helper, `#!/bin/sh
cat "$WATCHDOG_DIFF_RACED_FILTER_SECRET"
`, "utf-8");
		fs.chmodSync(helper, 0o755);
		fs.writeFileSync(path.join(repo, ".gitattributes"), "*.ts filter=raced\n", "utf-8");
		git("add", ".gitattributes");
		git("commit", "-q", "-m", "add attributes");
		fs.writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
	if [ "$arg" = "diff" ]; then
		"$WATCHDOG_DIFF_REAL_GIT" -C "$WATCHDOG_DIFF_REPO" config filter.raced.clean "$WATCHDOG_DIFF_FILTER_HELPER"
		"$WATCHDOG_DIFF_REAL_GIT" -C "$WATCHDOG_DIFF_REPO" config filter.raced.required true
		break
	fi
done
exec "$WATCHDOG_DIFF_REAL_GIT" "$@"
`, "utf-8");
		fs.chmodSync(wrapper, 0o755);
		const previousEnv = {
			PATH: process.env.PATH,
			WATCHDOG_DIFF_FILTER_HELPER: process.env.WATCHDOG_DIFF_FILTER_HELPER,
			WATCHDOG_DIFF_RACED_FILTER_SECRET: process.env.WATCHDOG_DIFF_RACED_FILTER_SECRET,
			WATCHDOG_DIFF_REAL_GIT: process.env.WATCHDOG_DIFF_REAL_GIT,
			WATCHDOG_DIFF_REPO: process.env.WATCHDOG_DIFF_REPO,
		};
		try {
			const baseline = captureBaseline(repo)!;
			process.env.PATH = `${wrapperDir}${path.delimiter}${process.env.PATH ?? ""}`;
			process.env.WATCHDOG_DIFF_FILTER_HELPER = helper;
			process.env.WATCHDOG_DIFF_RACED_FILTER_SECRET = outside;
			process.env.WATCHDOG_DIFF_REAL_GIT = realGit;
			process.env.WATCHDOG_DIFF_REPO = repo;
			fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 4;\n", "utf-8");

			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /\+export const a = 4;/);
			assert.doesNotMatch(full, /RACED_FILTER_SECRET/);
		} finally {
			for (const [key, value] of Object.entries(previousEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(outside, { force: true });
			fs.rmSync(wrapperDir, { recursive: true, force: true });
		}
	});

	it("omits an untracked file replaced between validation and open", async (t) => {
		const baseline = captureBaseline(repo)!;
		const fullPath = path.join(baseline.root, "race.txt");
		fs.writeFileSync(fullPath, "original evidence\n", "utf-8");
		const originalOpen = fsDefault.openSync.bind(fsDefault);
		let swapped = false;
		t.mock.method(fsDefault, "openSync", ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
			if (!swapped && path.resolve(String(target)) === fullPath) {
				swapped = true;
				fs.rmSync(fullPath);
				fs.writeFileSync(fullPath, "replacement secret\n", "utf-8");
			}
			return originalOpen(target, flags, mode);
		}) as typeof fsDefault.openSync);
		syncBuiltinESMExports();
		try {
			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /race\.txt: changed during read omitted/);
			assert.doesNotMatch(full, /replacement secret/);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});

	it("keeps symlink omissions visible ahead of large untracked bodies", { skip: process.platform === "win32" ? "symlink creation is not portable on Windows CI" : undefined }, async () => {
		const baseline = captureBaseline(repo)!;
		const outside = path.join(os.tmpdir(), `watchdog-diff-late-secret-${process.pid}`);
		fs.writeFileSync(outside, "late external secret\n", "utf-8");
		try {
			for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(repo, `a-${i}.txt`), `${"x".repeat(5_000)}\n`, "utf-8");
			fs.symlinkSync(outside, path.join(repo, "z-link.txt"));

			const full = await run(createWatchdogDiffTool(baseline));

			assert.ok(full.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${full.length}`);
			assert.match(full, /z-link\.txt: symlink omitted/);
			assert.doesNotMatch(full, /late external secret/);
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("reads untracked paths with unicode, newlines, and leading dots", { skip: process.platform === "win32" ? "Windows paths cannot contain newline characters" : undefined }, async () => {
		const baseline = captureBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "é.txt"), "unicode evidence\n", "utf-8");
		fs.writeFileSync(path.join(repo, "odd\nname.txt"), "newline evidence\n", "utf-8");
		fs.writeFileSync(path.join(repo, "..evidence.txt"), "dot evidence\n", "utf-8");

		const full = await run(createWatchdogDiffTool(baseline));

		assert.match(full, /\+\+\+ é\.txt \(untracked\)\n\+unicode evidence/);
		assert.match(full, /\+\+\+ odd\\nname\.txt \(untracked\)\n\+newline evidence/);
		assert.match(full, /\+\+\+ \.\.evidence\.txt \(untracked\)\n\+dot evidence/);
		assert.doesNotMatch(full, /outside repository omitted/);
	});

	it("omits a nested untracked path when its ancestor is replaced by a symlink", { skip: process.platform === "win32" ? "directory symlink creation is not portable on Windows CI" : undefined }, async (t) => {
		const baseline = captureBaseline(repo)!;
		const dir = path.join(baseline.root, "dir");
		const fullPath = path.join(dir, "file.txt");
		const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-diff-ancestor-"));
		fs.mkdirSync(dir);
		fs.writeFileSync(fullPath, "inside evidence\n", "utf-8");
		fs.writeFileSync(path.join(outsideDir, "file.txt"), "ancestor external secret\n", "utf-8");
		const originalLstat = fsDefault.lstatSync.bind(fsDefault);
		let swapped = false;
		t.mock.method(fsDefault, "lstatSync", ((target: fs.PathLike, options?: fs.StatOptions) => {
			if (!swapped && path.resolve(String(target)) === fullPath) {
				swapped = true;
				fs.rmSync(dir, { recursive: true, force: true });
				fs.symlinkSync(outsideDir, dir, "dir");
			}
			return originalLstat(target, options as never);
		}) as typeof fsDefault.lstatSync);
		syncBuiltinESMExports();
		try {
			const full = await run(createWatchdogDiffTool(baseline));

			assert.match(full, /dir\/file\.txt: ancestor symlink omitted/);
			assert.doesNotMatch(full, /ancestor external secret/);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			fs.rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("bounds untracked file reads before rendering them", async () => {
		const baseline = captureBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "large.txt"), `${"x".repeat(32_000)}\n`, "utf-8");
		const full = await run(createWatchdogDiffTool(baseline));

		assert.ok(full.length < 8_000, `untracked output was ${full.length}`);
		assert.match(full, /\+\.\.\. \(truncated at 4000 characters\)/);
	});

	it("keeps the untracked omission count ahead of bounded file bodies", async () => {
		const baseline = captureBaseline(repo)!;
		for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(repo, `untracked-${String(i).padStart(2, "0")}.txt`), `${"x".repeat(1_000)}\n`, "utf-8");

		const full = await run(createWatchdogDiffTool(baseline));

		assert.ok(full.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${full.length}`);
		assert.match(full, /Untracked files detected: 55; inspected first 50, 5 beyond the 50-file render limit\./);
	});

	it("keeps untracked evidence visible when the tracked diff is bounded", async () => {
		const baseline = captureBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "src", "a.ts"), `${"export const changed = true;\n".repeat(3_000)}`, "utf-8");
		fs.writeFileSync(path.join(repo, "new.ts"), "export const untracked = true;\n", "utf-8");

		const full = await run(createWatchdogDiffTool(baseline));

		assert.ok(full.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${full.length}`);
		assert.match(full, /Untracked files detected: 1\./);
		assert.match(full, /\+\+\+ new\.ts \(untracked\)\n\+export const untracked = true;/);
	});

	it("keeps tracked evidence visible when untracked files are bounded", async () => {
		const baseline = captureBaseline(repo)!;
		for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(repo, `large-${i}.txt`), `${"x".repeat(4_000)}\n`, "utf-8");
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const tracked = true;\n", "utf-8");

		const full = await run(createWatchdogDiffTool(baseline));

		assert.ok(full.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${full.length}`);
		assert.match(full, /omitted from untracked files/);
		assert.match(full, /\+export const tracked = true;/);
	});

	it("rejects traversal and option-like paths and bounds large diffs", async () => {
		const baseline = captureBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline);
		await assert.rejects(() => run(tool, { path: "../etc" }), /must not contain '\.\.'/);
		await assert.rejects(() => run(tool, { path: "-R" }), /must not start with '-'/);
		await assert.rejects(() => run(tool, { path: "/etc/hosts" }), /relative/);

		fs.writeFileSync(path.join(repo, "src", "a.ts"), `${"export const line = 1;\n".repeat(3_000)}`, "utf-8");
		const bounded = await run(tool);
		assert.ok(bounded.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${bounded.length}`);
		assert.match(bounded, /characters omitted; call again with a narrower path/);
	});
});
