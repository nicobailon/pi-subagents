import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBuiltinInspectorPlugins } from "../../src/inspectors/plugins.ts";
import { GHOSTTY_APPLESCRIPT } from "../../src/inspectors/ghostty/actions.ts";
import { createGhosttyInspectorPlugin } from "../../src/inspectors/ghostty/plugin.ts";
import type { InspectorContext, InspectorLaunch } from "../../src/inspectors/types.ts";

function context(env: NodeJS.ProcessEnv = { TERM_PROGRAM: "Ghostty" }): InspectorContext {
	return {
		cwd: "/project",
		env,
		target: { runId: "run-1", asyncDir: "/tmp/run-1", status: { cwd: "/target", state: "running" } },
	};
}
const launch: InspectorLaunch = {
	executable: "node",
	argv: [],
	displayCommand: "node runner.mjs --run-id run-1",
	allowSteer: false,
	allowStop: false,
	sessionRoots: [],
};
function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("Ghostty inspector", () => {
	it("matches only macOS and TERM_PROGRAM=ghostty, case-insensitively", async () => {
		assert.equal(await createGhosttyInspectorPlugin({ platform: "darwin" }).available(context()), true);
		assert.equal(await createGhosttyInspectorPlugin({ platform: "darwin" }).available(context({ TERM_PROGRAM: "GHOSTTY" })), true);
		assert.equal(await createGhosttyInspectorPlugin({ platform: "darwin" }).available(context({ TERM_PROGRAM: "iTerm.app" })), false);
		assert.equal(await createGhosttyInspectorPlugin({ platform: "linux" }).available(context()), false);
		assert.equal(await createGhosttyInspectorPlugin({ platform: "darwin" }).available(context({})), false);
	});

	it("registers after Herdr", () => {
		assert.deepEqual(createBuiltinInspectorPlugins().map((plugin) => plugin.name), ["herdr", "ghostty"]);
	});

	it("uses a static script and separate command, cwd, and focus arguments", async () => {
		const calls: { args: readonly string[]; options: object }[] = [];
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: async (args, options) => {
			calls.push({ args, options });
			return { stdout: "terminal-42\n", stderr: "" };
		} });
		const opened = await plugin.open(context(), launch, {});
		assert.equal(opened.isError, undefined);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].args[0], "-e");
		assert.equal(calls[0].args[1], GHOSTTY_APPLESCRIPT);
		assert.equal(calls[0].args[2], "--");
		assert.deepEqual(calls[0].args.slice(3), [launch.displayCommand, "/target", "false"]);
		assert.match(GHOSTTY_APPLESCRIPT, /set sourceWindow to front window/);
		assert.match(GHOSTTY_APPLESCRIPT, /set sourceTab to selected tab of sourceWindow/);
		assert.match(GHOSTTY_APPLESCRIPT, /set sourceTerminal to focused terminal of sourceTab/);
		assert.doesNotMatch(GHOSTTY_APPLESCRIPT, /tell front window/);
		assert.match(GHOSTTY_APPLESCRIPT, /selected tab/);
		assert.match(GHOSTTY_APPLESCRIPT, /new surface configuration/);
		assert.match(GHOSTTY_APPLESCRIPT, /initial working directory of surfaceConfiguration/);
		assert.match(GHOSTTY_APPLESCRIPT, /command of surfaceConfiguration/);
		assert.match(GHOSTTY_APPLESCRIPT, /split sourceTerminal direction right/);
		assert.match(GHOSTTY_APPLESCRIPT, /focus sourceTerminal/);
		assert.deepEqual(calls[0].options, { signal: undefined, timeout: 15_000, encoding: "utf8", maxBuffer: 64 * 1024 });

		calls.length = 0;
		const focused = await plugin.open(context(), launch, { focus: true });
		assert.equal(focused.isError, undefined);
		assert.match(GHOSTTY_APPLESCRIPT, /focus newTerminal/);
		assert.deepEqual(calls[0].args, ["-e", GHOSTTY_APPLESCRIPT, "--", launch.displayCommand, "/target", "true"]);
		assert.doesNotMatch(GHOSTTY_APPLESCRIPT, /node runner\.mjs|\/target/);
		assert.match(text(focused), /terminal-42/);
	});

	it("does not own lifecycle and reports execution and empty-id failures", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: async () => { throw new Error("osascript denied"); } });
		assert.equal(plugin.owns(context()), false);
		assert.equal(plugin.status, undefined);
		assert.equal(plugin.close, undefined);
		const failed = await plugin.open(context(), launch, {});
		assert.equal(failed.isError, true);
		assert.match(text(failed), /Ghostty 1\.3\+.*Automation permission/);
		const empty = await createGhosttyInspectorPlugin({ platform: "darwin", runner: async () => ({ stdout: "  \n", stderr: "" }) }).open(context(), launch, {});
		assert.equal(empty.isError, true);
		assert.match(text(empty), /empty terminal id/);
	});
});
