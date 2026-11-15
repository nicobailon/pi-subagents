import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverPlacedBridgeManifest, removePlacedRuntimeDir } from "../../src/runs/shared/placed-run-owner.ts";
import { localMachineAccess } from "../../src/runs/shared/local-machine-access.ts";
import type { PlacementCommandResult, PlacementMachineAccess } from "../../src/runs/shared/placement-host.ts";

const runtimeDir = "/tmp/pi-subagents-herdr-run_aaaa/manifest-run";
const runId = "run_aaaaaaaaaaaa";
const manifest = { runId, socketPath: `${runtimeDir}/bridge.sock`, nativeSessionId: "native-1", packageVersion: "1.2.3", protocol: 1 };

function manifestAccess(read: () => Promise<PlacementCommandResult>): PlacementMachineAccess {
	return { shellCommand: (script) => script, run: () => ({ status: 1, stdout: "", stderr: "" }), runAsync: read, openSockets: () => { throw new Error("unused"); } };
}

describe("placed bridge manifest discovery", () => {
	it("gives up at a wall-clock deadline however long each poll takes", async () => {
		// Each empty poll takes 100 ms, like a read over SSH while the child still boots its extensions.
		const access = manifestAccess(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return { status: 1, stdout: "", stderr: "" }; });
		const started = Date.now();
		await assert.rejects(
			() => discoverPlacedBridgeManifest(access, runId, runtimeDir, "The placed Pi never published its bridge manifest.", 120),
			/The placed Pi never published its bridge manifest\./u,
		);
		assert.ok(Date.now() - started < 2_000, "the deadline bounds the wait");
	});

	it("rejects a manifest that belongs to another run or escapes its runtime directory", async () => {
		for (const foreign of [{ ...manifest, runId: "run_bbbbbbbbbbbb" }, { ...manifest, socketPath: "/tmp/elsewhere/bridge.sock" }]) {
			await assert.rejects(() => discoverPlacedBridgeManifest(manifestAccess(async () => ({ status: 0, stdout: JSON.stringify(foreign), stderr: "" })), runId, runtimeDir), /identity is incomplete or outside its owned runtime directory/u);
		}
	});
});

describe("placed runtime directory removal", { skip: process.platform === "win32" }, () => {
	it("counts a directory the child already removed as removed, and still refuses a path it does not own", () => {
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-placed-rm-"));
		try {
			const owned = path.join(parent, "pi-subagents-herdr-run-gone");
			fs.mkdirSync(owned);
			removePlacedRuntimeDir(localMachineAccess(), owned);
			assert.equal(fs.existsSync(owned), false);
			removePlacedRuntimeDir(localMachineAccess(), owned);
			assert.throws(() => removePlacedRuntimeDir(localMachineAccess(), path.join(parent, "other-dir")), /Could not remove the exact owned remote runtime directory/u);
		} finally { fs.rmSync(parent, { recursive: true, force: true }); }
	});
});
