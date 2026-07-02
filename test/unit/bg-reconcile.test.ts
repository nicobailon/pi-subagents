/**
 * Generic provider health checks: subagent_wait runs registered providers' reconcile()
 * on every poll tick, and reconcileBackgroundWork drives them. A reconcile that
 * resolves a wedged unit (drops liveCount) unblocks subagent_wait instead of hanging.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	registerBackgroundWorkProvider,
	reconcileBackgroundWork,
} from "../../src/runs/background/bg-providers.ts";
import { waitForSubagents, type SubagentWaitDeps } from "../../src/runs/background/subagent-wait.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const REGISTRY_KEY = "__pi_bg_work_providers_v1";
function resetRegistry() {
	delete (globalThis as Record<string, unknown>)[REGISTRY_KEY];
}

function makeState(sessionId: string | null): SubagentState {
	return {
		baseCwd: "", currentSessionId: sessionId, asyncJobs: new Map(),
		foregroundControls: new Map(), lastForegroundControlId: null,
		cleanupTimers: new Map(), lastUiContext: null, poller: null,
		completionSeen: new Map(), watcher: null, watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as SubagentState;
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content.map((c) => c.text ?? "").join("");

function emptyRunsDeps(root: string, state: SubagentState, overrides: Partial<SubagentWaitDeps>): SubagentWaitDeps {
	return {
		state,
		asyncDirRoot: path.join(root, "runs"),
		resultsDir: path.join(root, "results"),
		kill: () => true,
		pollIntervalMs: 5,
		...overrides,
	};
}

describe("reconcileBackgroundWork", () => {
	afterEach(resetRegistry);

	it("calls each provider's reconcile with the given clock", () => {
		resetRegistry();
		let seen = -1;
		registerBackgroundWorkProvider({ name: "p", liveCount: () => 0, reconcile: (n) => { seen = n; } });
		reconcileBackgroundWork(12345);
		assert.equal(seen, 12345);
	});

	it("ignores a throwing reconcile", () => {
		resetRegistry();
		registerBackgroundWorkProvider({ name: "bad", liveCount: () => 0, reconcile: () => { throw new Error("x"); } });
		registerBackgroundWorkProvider({ name: "ok", liveCount: () => 0, reconcile: () => {} });
		assert.doesNotThrow(() => reconcileBackgroundWork(1));
	});
});

describe("subagent_wait × provider reconcile", () => {
	afterEach(resetRegistry);

	it("runs reconcile every poll tick and unblocks when it resolves a wedged unit", async () => {
		resetRegistry();
		// A wedged provider: 1 unit live, and it never finishes on its own — only
		// its reconcile() can resolve it (mimicking terminating a hung job).
		let live = 1;
		let reconciles = 0;
		registerBackgroundWorkProvider({
			name: "wedged",
			liveCount: () => live,
			reconcile: () => { reconciles += 1; if (reconciles >= 2) live = 0; },
		});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-recon-"));
		try {
			const r = await waitForSubagents({ all: true }, undefined, emptyRunsDeps(root, makeState("s1"), {}));
			assert.equal(r.isError, undefined);
			assert.match(textOf(r), /1 of 1 background job\(s\) finished\./);
			assert.ok(reconciles >= 2, `reconcile ran each tick until resolved (ran ${reconciles})`);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("would hang without reconcile — a live unit with no reconcile keeps wait waiting", async () => {
		resetRegistry();
		registerBackgroundWorkProvider({ name: "stuck", liveCount: () => 1 }); // no reconcile
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-recon2-"));
		try {
			// Bounded timeout so the test itself doesn't hang; proves it does NOT
			// finish (times out with the unit still in flight).
			const r = await waitForSubagents({ all: true, timeoutMs: 40 }, undefined,
				emptyRunsDeps(root, makeState("s1"), { pollIntervalMs: 5 }));
			assert.equal(r.isError, true);
			assert.match(textOf(r), /timed out/i);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
