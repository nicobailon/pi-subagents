import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GhosttyRunner } from "../../src/inspectors/ghostty/actions.ts";
import { createGhosttyInspectorPlugin } from "../../src/inspectors/ghostty/plugin.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams } from "../../src/inspectors/types.ts";

function ctx(env: NodeJS.ProcessEnv = {}): InspectorContext {
	return {
		cwd: "/tmp",
		env,
		target: {
			runId: "run-1",
			asyncDir: "/tmp/run-1",
			status: { cwd: "/tmp", state: "running", steps: [] },
		},
	};
}

function launch(): InspectorLaunch {
	return { executable: "node", argv: ["x"], displayCommand: "node x", allowSteer: true, allowStop: true, sessionRoots: [] };
}

function runnerReturning(stdout: string): GhosttyRunner {
	return async () => ({ stdout, stderr: "" });
}

function failingRunner(error: Error): GhosttyRunner {
	return async () => {
		throw error;
	};
}

describe("Ghostty inspector availability", () => {
	it("does not take over on non-darwin", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "linux", runner: runnerReturning("1.3.2") });
		assert.equal(await plugin.available(ctx({ TERM_PROGRAM: "ghostty" })), false);
	});

	it("does not take over when TERM_PROGRAM is not ghostty", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: runnerReturning("1.3.2") });
		assert.equal(await plugin.available(ctx({ TERM_PROGRAM: "xterm-256color" })), false);
		assert.equal(await plugin.available(ctx({})), false);
	});

	it("takes over when a real Ghostty app responds with a version", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: runnerReturning("1.3.2\n") });
		assert.equal(await plugin.available(ctx({ TERM_PROGRAM: "Ghostty" })), true);
	});

	it("does not take over when osascript fails (cmux with stale Ghostty registration, -1728)", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: failingRunner(new Error("execution error: -1728")) });
		assert.equal(await plugin.available(ctx({ TERM_PROGRAM: "ghostty" })), false);
	});

	it("does not take over when the app returns an empty version", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: runnerReturning("  \n") });
		assert.equal(await plugin.available(ctx({ TERM_PROGRAM: "ghostty" })), false);
	});
});

describe("Ghostty inspector open", () => {
	it("returns the terminal id when osascript succeeds", async () => {
		const calls: string[][] = [];
		const runner: GhosttyRunner = async (args) => {
			calls.push([...args]);
			return { stdout: "surf-42\n", stderr: "" };
		};
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner });
		const res = await plugin.open(ctx({ TERM_PROGRAM: "ghostty" }), launch(), {} as InspectorParams);
		assert.equal(res.isError, undefined);
		assert.match(res.content[0]?.text ?? "", /surf-42/);
		assert.ok(calls[0]?.includes("-e"));
	});

	it("reports an error when osascript fails", async () => {
		const plugin = createGhosttyInspectorPlugin({ platform: "darwin", runner: failingRunner(new Error("execution error: -2741")) });
		const res = await plugin.open(ctx({ TERM_PROGRAM: "ghostty" }), launch(), {} as InspectorParams);
		assert.equal(res.isError, true);
		assert.match(res.content[0]?.text ?? "", /-2741/);
	});
});
