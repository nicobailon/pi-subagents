import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverPlacedBridgeManifest, PLACED_MANIFEST_READ_SCRIPT } from "../../src/runs/shared/placed-run-owner.ts";
import type { PlacementMachineAccess } from "../../src/runs/shared/placement-host.ts";

const runtimeDir = "/tmp/pi-subagents-herdr-run_aaaa/manifest-run";
const runId = "run_aaaaaaaaaaaa";
const manifest = { runId, socketPath: `${runtimeDir}/bridge.sock`, nativeSessionId: "native-1", packageVersion: "1.2.3", protocol: 1 };

/** A machine whose `manifest.json` appears only after `absentReads` empty polls, like a child still booting its extensions. */
function bootingAccess(absentReads: number): { access: PlacementMachineAccess; reads: () => number } {
	let reads = 0;
	const access: PlacementMachineAccess = {
		shellCommand: (script, args) => `${script} ${(args ?? []).join(" ")}`,
		run: () => ({ status: 1, stdout: "", stderr: "" }),
		runAsync: async () => {
			reads += 1;
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

	it("gives up at the deadline instead of polling forever", async () => {
		const { access } = bootingAccess(Number.POSITIVE_INFINITY);
		const started = Date.now();
		await assert.rejects(
			() => discoverPlacedBridgeManifest(access, runId, runtimeDir, "The placed Pi never published its bridge manifest.", 120),
			/The placed Pi never published its bridge manifest\./u,
		);
		assert.ok(Date.now() - started < 5_000, "the deadline bounds the wait");
	});

	it("rejects a manifest that belongs to another run or escapes its runtime directory", async () => {
		const foreign = { ...manifest, runId: "run_bbbbbbbbbbbb" };
		const access = { ...bootingAccess(0).access, runAsync: async () => ({ status: 0, stdout: JSON.stringify(foreign), stderr: "" }) };
		await assert.rejects(() => discoverPlacedBridgeManifest(access, runId, runtimeDir), /identity is incomplete or outside its owned runtime directory/u);
		const escaping = { ...manifest, socketPath: "/tmp/elsewhere/bridge.sock" };
		const escaped = { ...bootingAccess(0).access, runAsync: async () => ({ status: 0, stdout: JSON.stringify(escaping), stderr: "" }) };
		await assert.rejects(() => discoverPlacedBridgeManifest(escaped, runId, runtimeDir), /identity is incomplete or outside its owned runtime directory/u);
	});

	it("reads the manifest through a regular-file check that never follows a symlink", () => {
		assert.equal(PLACED_MANIFEST_READ_SCRIPT, 'p="$1/manifest.json"; test -f "$p" && test ! -L "$p" && cat "$p"');
	});
});
