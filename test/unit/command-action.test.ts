import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandAction } from "../../src/runs/foreground/command-action.ts";
import { createChildCommandRuntime } from "../../src/runs/shared/child-commands.ts";
import { supervisorChannelDir } from "../../src/runs/shared/child-tool-plan.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const ctx = { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined } } as ExtensionContext;
function liveState(runId: string): SubagentState {
	const state = { currentSessionId: "session-1", foregroundControls: new Map(), foregroundRuns: new Map() } as SubagentState;
	state.currentSessionId = "session-1";
	state.foregroundControls.set(runId, {
		runId, sessionId: "session-1", mode: "parallel", startedAt: Date.now(), updatedAt: Date.now(),
		activeChildren: new Map([0, 1].map((index) => [index, { index, agent: "worker", startedAt: Date.now(), updatedAt: Date.now() }])),
	});
	return state;
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
function exited(pid: number): boolean {
	try { process.kill(pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

describe("supervisor command actions", () => {
	for (const kind of ["foreground", "async"] as const) {
		it(`targets one command in a ${kind} child`, async () => {
			const runId = `command-action-${randomUUID()}`;
			const channel = supervisorChannelDir(runId, "worker", 1);
			const commands = createChildCommandRuntime(channel);
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-action-"));
			const state = liveState(runId);
			const target = kind === "foreground" ? { kind, id: runId } : { kind, id: runId, location: { resolvedId: runId, asyncDir: dir, resultPath: null } };
			if (kind === "async") fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId, sessionId: "session-1", state: "running", steps: [{ agent: "worker", status: "running" }, { agent: "worker", status: "running" }] }));
			// On Windows, Pi ends a cancelled command with a taskkill it does not await.
			const pidFile = path.join(dir, "command.pid");
			fs.writeFileSync(path.join(dir, "hold.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10_000);`);
			let pid: number | undefined;
			try {
				await commands.wrap(createBashToolDefinition(dir)).execute("selected-command", { command: `${JSON.stringify(process.execPath)} hold.cjs`, yieldTimeMs: 0 }, undefined, undefined, ctx);
				await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0, "the command to start");
				pid = Number(fs.readFileSync(pidFile, "utf8"));
				await assert.rejects(commandAction({ state, target, operation: "cancel", toolCallId: "selected-command" }), /explicit child index/);
				await assert.rejects(commandAction({ state, target, operation: "cancel", index: 1 }), /exact toolCallId/);
				const result = await commandAction({ state, target, operation: "status", index: 1, toolCallId: "selected-command" });
				assert.equal(result.details.commands?.[0].state, "yielded");
				state.currentSessionId = "different-session";
				await assert.rejects(commandAction({ state, target, operation: "cancel", index: 1, toolCallId: "selected-command" }), /not owned by this session/);
				state.currentSessionId = "session-1";
				await commandAction({ state, target, operation: "cancel", index: 1, toolCallId: "selected-command" });
				await commands.shutdown();
				const terminal = await commandAction({ state, target, operation: "status", index: 1 });
				assert.equal(terminal.details.commands?.[0].state, "cancelled");
			} finally {
				await commands.shutdown();
				if (pid !== undefined) await until(() => exited(pid!), `command process ${pid} to exit`);
				fs.rmSync(channel, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
			}
		});
	}
});
