import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { captureWatchdogDiffBaseline, createWatchdogDiffTool, WATCHDOG_DIFF_MAX_CHARS } from "../../src/watchdog/diff-tool.ts";

let repo = "";

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

async function run(tool: ReturnType<typeof createWatchdogDiffTool>, params: { path?: string; stat?: boolean } = {}): Promise<string> {
	const result = await tool.execute("call", params, undefined as never, undefined as never, undefined as never);
	return result.content.map((part) => (part as { text?: string }).text ?? "").join("\n");
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
		const baseline = captureWatchdogDiffBaseline(path.join(repo, "src"));
		assert.ok(baseline);
		assert.equal(fs.realpathSync.native(baseline.root), fs.realpathSync.native(repo), "git expands Windows 8.3 short names; compare native real paths");
		assert.equal(baseline.ref, git("rev-parse", "HEAD").trim());
		assert.match(await run(createWatchdogDiffTool(baseline)), /^No changes since baseline/);
		assert.equal(captureWatchdogDiffBaseline(os.tmpdir()), undefined);
	});

	it("shows tracked changes since the baseline, including later commits, and lists untracked paths", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf-8");
		git("commit", "-q", "-am", "child commit");
		fs.writeFileSync(path.join(repo, "src", "b.ts"), "export const b = 1;\n", "utf-8");
		const tool = createWatchdogDiffTool(baseline);

		const full = await run(tool);
		assert.match(full, /-export const a = 1;/);
		assert.match(full, /\+export const a = 2;/);
		assert.match(full, /Untracked files \(use read to inspect\):\n src\/b\.ts/);
		assert.doesNotMatch(full, /export const b = 1;/);

		const stat = await run(tool, { stat: true });
		assert.match(stat, /src\/a\.ts \|/);
		assert.match(stat, /Untracked files \(use read to inspect\):\n src\/b\.ts/);

		const narrowed = await run(tool, { path: "README.md" });
		assert.doesNotMatch(narrowed, /a\.ts|b\.ts/);
	});

	it("shows staged and unstaged launch-HEAD changes while honestly excluding earlier commits", async () => {
		fs.writeFileSync(path.join(repo, "README.md"), "committed before reviewer launch\n", "utf-8");
		git("commit", "-q", "-am", "review target already committed");
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline, { workingTreeAtLaunch: true });

		const clean = await run(tool);
		assert.match(clean, /^No working-tree changes against reviewer-launch HEAD/);
		assert.match(clean, /Committed changes are not included\./);
		assert.doesNotMatch(clean, /committed before reviewer launch/);
		assert.match(tool.description, /Committed ranges are not included/);

		fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n", "utf-8");
		git("add", "src/a.ts");
		fs.writeFileSync(path.join(repo, "README.md"), "unstaged after reviewer launch\n", "utf-8");
		fs.writeFileSync(path.join(repo, "untracked.txt"), "inspect with read\n", "utf-8");
		const changed = await run(tool);
		assert.match(changed, /\+export const a = 2;/, "staged changes are included");
		assert.match(changed, /\+unstaged after reviewer launch/, "unstaged changes are included");
		assert.match(changed, /Untracked files \(use read to inspect\):\n untracked\.txt/);
		assert.equal(git("rev-parse", "HEAD").trim(), baseline.ref, "inspection does not move HEAD");
		assert.equal(git("status", "--short"), " M README.md\nM  src/a.ts\n?? untracked.txt\n", "inspection preserves staged, unstaged, and untracked state");
	});

	it("fails closed when HEAD advances after reviewer launch", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline, { workingTreeAtLaunch: true });
		fs.writeFileSync(path.join(repo, "README.md"), "committed after reviewer launch\n", "utf-8");
		git("commit", "-q", "-am", "advance HEAD");

		const result = await run(tool);
		assert.match(result, /^Reviewer-launch HEAD changed or is unavailable\./);
		assert.match(result, /Committed changes are unsupported; relaunch the reviewer or supply a diff artifact\./);
		assert.doesNotMatch(result, /committed after reviewer launch/);
	});

	it("rejects traversal and option-like paths and bounds large diffs", async () => {
		const baseline = captureWatchdogDiffBaseline(repo)!;
		const tool = createWatchdogDiffTool(baseline);
		await assert.rejects(() => run(tool, { path: "../etc" }), /must not contain '\.\.'/);
		await assert.rejects(() => run(tool, { path: "-R" }), /must not start with '-'/);
		await assert.rejects(() => run(tool, { path: "/etc/hosts" }), /relative/);

		fs.writeFileSync(path.join(repo, "src", "a.ts"), `${"export const line = 1;\n".repeat(3_000)}`, "utf-8");
		const bounded = await run(tool);
		assert.ok(bounded.length <= WATCHDOG_DIFF_MAX_CHARS, `bounded output was ${bounded.length}`);
		assert.match(bounded, /characters omitted; call again with a narrower path/);

		for (let index = 0; index < 52; index++) fs.writeFileSync(path.join(repo, `untracked-${String(index).padStart(2, "0")}.txt`), "x", "utf-8");
		const inventory = await run(tool, { stat: true });
		assert.match(inventory, /\.\.\. 2 more untracked files/);
		assert.equal((inventory.match(/^ untracked-/gm) ?? []).length, 50);
	});
});
