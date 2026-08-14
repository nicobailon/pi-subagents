import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { handleHerdrInspectorAction } from "../../src/inspectors/herdr/actions.ts";
import type { HerdrClient } from "../../src/inspectors/herdr/client.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";

function writeCompletedRun(root: string): { asyncDir: string; status: AsyncStatus } {
	const asyncDir = path.join(root, "run-123");
	fs.mkdirSync(asyncDir, { recursive: true });
	const status: AsyncStatus = {
		runId: "run-123",
		mode: "single",
		state: "completed",
		startedAt: Date.now() - 1_000,
		cwd: root,
		steps: [{ agent: "worker", status: "completed", recentOutput: ["done"] }],
	};
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
	return { asyncDir, status };
}

describe("Herdr inspector bootstrap", () => {
	it("uses ordinary Node for the inspector pane command", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-bootstrap-command-"));
		try {
			writeCompletedRun(root);
			const calls: string[][] = [];
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p9" } } as T };
					return { ok: true, data: {} as T };
				},
			};
			const opened = await handleHerdrInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				resultsDir: path.join(root, "results"),
				client,
			});
			assert.equal(opened.isError, undefined);
			const command = calls.find((args) => args[0] === "pane" && args[1] === "run")?.[3] ?? "";
			assert.equal(command.startsWith("& "), process.platform === "win32");
			assert.doesNotMatch(command, /--experimental-strip-types/);
			assert.match(command, /inspector-runner\.mjs/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses PATH node when Pi is a standalone executable", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-bootstrap-standalone-"));
		const originalExecPath = process.execPath;
		try {
			writeCompletedRun(root);
			process.execPath = path.join(root, process.platform === "win32" ? "pi.exe" : "pi");
			const calls: string[][] = [];
			const client: HerdrClient = {
				run: async <T>(args: string[]) => {
					calls.push(args);
					if (args[0] === "--version") return { ok: true, data: "herdr 0.7.5" as T };
					if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { pane: { pane_id: "w1:p9" } } as T };
					return { ok: true, data: {} as T };
				},
			};
			const opened = await handleHerdrInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				resultsDir: path.join(root, "results"),
				client,
			});
			assert.equal(opened.isError, undefined);
			const command = calls.find((args) => args[0] === "pane" && args[1] === "run")?.[3] ?? "";
			assert.equal(command.startsWith("& "), process.platform === "win32");
			assert.match(command, process.platform === "win32" ? /^& "node\.exe" / : /^node /);
			assert.doesNotMatch(command, /(?:^|[\\/])pi(?:\.exe)?'/);
		} finally {
			process.execPath = originalExecPath;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts the packaged bootstrap with ordinary Node", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-bootstrap-run-"));
		try {
			const { asyncDir, status } = writeCompletedRun(root);
			const bootstrap = fileURLToPath(new URL("../../inspector-runner.mjs", import.meta.url));
			const launched = spawnSync(process.execPath, [bootstrap, "--async-dir", asyncDir, "--run-id", status.runId], { encoding: "utf-8" });
			assert.equal(launched.status, 0, launched.stderr);
			assert.match(launched.stdout, /pi-subagents inspector for run-123/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
