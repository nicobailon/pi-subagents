import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { discoverPlacedBridgeManifest, removePlacedRuntimeDir } from "../../src/runs/shared/placed-run-owner.ts";
import { localMachineAccess } from "../../src/runs/shared/local-machine-access.ts";
import type { PlacementMachineAccess } from "../../src/runs/shared/placement-host.ts";

const runtimeDir = "/tmp/pi-subagents-herdr-run_aaaa/manifest-run";
const runId = "run_aaaaaaaaaaaa";
const manifest = { runId, socketPath: `${runtimeDir}/bridge.sock`, nativeSessionId: "native-1", packageVersion: "1.2.3", protocol: 1 };

/** A machine whose `manifest.json` appears only after `absentReads` empty polls, like a child still booting its extensions; each read takes `readMs`, like a poll over SSH. */
function bootingAccess(absentReads: number, readMs = 0): { access: PlacementMachineAccess; reads: () => number } {
	let reads = 0;
	const access: PlacementMachineAccess = {
		shellCommand: (script, args) => `${script} ${(args ?? []).join(" ")}`,
		run: () => ({ status: 1, stdout: "", stderr: "" }),
		runAsync: async () => {
			reads += 1;
			if (readMs) await new Promise((resolve) => setTimeout(resolve, readMs));
			return reads > absentReads ? { status: 0, stdout: `${JSON.stringify(manifest)}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" };
		},
		openSockets: () => ({ forward: () => [], close: () => {} }) as unknown as ReturnType<PlacementMachineAccess["openSockets"]>,
	};
	return { access, reads: () => reads };
}

describe("placed bridge manifest discovery", () => {
	it("keeps polling until a slow child publishes its manifest", async () => {
		const { access, reads } = bootingAccess(4);
		const { runId: _runId, ...expected } = manifest;
		assert.deepEqual(await discoverPlacedBridgeManifest(access, runId, runtimeDir), expected);
		assert.equal(reads(), 5);
	});

	it("gives up at a wall-clock deadline however long each poll takes", async () => {
		const { access } = bootingAccess(Number.POSITIVE_INFINITY, 100);
		const started = Date.now();
		await assert.rejects(
			() => discoverPlacedBridgeManifest(access, runId, runtimeDir, "The placed Pi never published its bridge manifest.", 120),
			/The placed Pi never published its bridge manifest\./u,
		);
		assert.ok(Date.now() - started < 2_000, "the deadline bounds the wait");
	});

	it("rejects a manifest that belongs to another run or escapes its runtime directory", async () => {
		const foreign = { ...manifest, runId: "run_bbbbbbbbbbbb" };
		const access = { ...bootingAccess(0).access, runAsync: async () => ({ status: 0, stdout: JSON.stringify(foreign), stderr: "" }) };
		await assert.rejects(() => discoverPlacedBridgeManifest(access, runId, runtimeDir), /identity is incomplete or outside its owned runtime directory/u);
		const escaping = { ...manifest, socketPath: "/tmp/elsewhere/bridge.sock" };
		const escaped = { ...bootingAccess(0).access, runAsync: async () => ({ status: 0, stdout: JSON.stringify(escaping), stderr: "" }) };
		await assert.rejects(() => discoverPlacedBridgeManifest(escaped, runId, runtimeDir), /identity is incomplete or outside its owned runtime directory/u);
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
