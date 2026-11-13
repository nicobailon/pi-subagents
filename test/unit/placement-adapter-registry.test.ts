import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildSession } from "../../src/runs/shared/child-session.ts";
// Importing herdr-placed-run loads the built-in Herdr and Rex adapters into the registry.
import { createPlacementAwareChildSessionFactory } from "../../src/runs/shared/herdr-placed-run.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { placementAdapters, placementEditsLocalDisk, placementSupportsExternalCli, registerPlacementAdapter, requirePlacementAdapter, type PlacementAdapterSettings, type PlacementAdapterV1 } from "../../src/runs/shared/placement-registry.ts";

const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const child: ChildSession = { subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: "native", modelId: "provider/model" };
function spiketestAdapter(overrides: Partial<PlacementAdapterV1> = {}): PlacementAdapterV1 {
	return { kind: "pi-subagents.placement-adapter", version: 1, provider: "spiketest", async openPlacedRun() { throw new Error("unused in this test"); }, ...overrides };
}

describe("placement adapter registry", () => {
	it("registers the built-in rex and herdr adapters in resolution order", () => {
		assert.deepEqual(placementAdapters().map((adapter) => adapter.provider), ["rex", "herdr"]);
		for (const adapter of placementAdapters()) {
			assert.equal(adapter.kind, "pi-subagents.placement-adapter");
			assert.equal(adapter.version, 1);
			assert.equal(typeof adapter.openPlacedRun, "function");
		}
	});

	it("refuses duplicate, wrong-kind, and wrong-version registrations", () => {
		registerPlacementAdapter(spiketestAdapter({ provider: "spikedup" }));
		assert.throws(() => registerPlacementAdapter(spiketestAdapter({ provider: "spikedup" })), /already registered/u);
		assert.throws(() => registerPlacementAdapter({ ...spiketestAdapter(), provider: "spike-two", kind: "other" as never }), /kind/u);
		assert.throws(() => registerPlacementAdapter({ ...spiketestAdapter(), provider: "spike-two", version: 2 as never }), /version/u);
		assert.throws(() => registerPlacementAdapter({ ...spiketestAdapter(), provider: "Bad Id" }), /provider id/u);
	});

	it("resolves a rex ssh machine from settings through the registry", () => {
		const resolved = resolveMachinePlacement({ machine: "lab", cwd: "/repo", stepCwd: "sub", settings: { rex: { ssh: "lab.example" }, cwd: "/remote/root" } });
		assert.deepEqual(resolved.machine, { provider: "rex", id: "lab", target: "lab.example", localDisk: false, cwd: "/remote/root/sub" });
	});

	it("falls through the registry to the herdr catalog for unclaimed names", () => {
		const catalog = JSON.stringify([{ id: "m1", target: "remote.example", enabled: true }]);
		const resolved = resolveMachinePlacement({ machine: "m1", cwd: "/repo", stepCwd: "/remote/repo", catalogJson: catalog });
		assert.deepEqual(resolved.machine, { provider: "herdr", id: "m1", target: "remote.example", localDisk: false, externalCli: true, cwd: "/remote/repo" });
	});

	it("keeps 'local' reserved for rex panes and rejects a rex ssh entry named local", () => {
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: "/repo", settings: { rex: { ssh: "h" } } }), /reserved for a Rex pane/u);
	});

	it("lets a registered adapter claim a machine name the built-ins decline", () => {
		registerPlacementAdapter(spiketestAdapter({ resolveMachinePlacement: ({ machine }) => machine === "fuzzbox" ? { machine: { provider: "spiketest", id: machine, localDisk: true, cwd: "/fuzz" } } : undefined }), { before: "herdr" });
		const resolved = resolveMachinePlacement({ machine: "fuzzbox", cwd: "/repo", settings: {} });
		assert.deepEqual(resolved.machine, { provider: "spiketest", id: "fuzzbox", localDisk: true, cwd: "/fuzz" });
	});

	it("hands adapter-declared machine settings and env to the claiming adapter opaquely", () => {
		let seen: unknown;
		registerPlacementAdapter(spiketestAdapter({
			provider: "stubpipe",
			resolveMachinePlacement: (request) => {
				if (request.machine !== "pipetest") return undefined;
				seen = request.settings;
				return { machine: { provider: "stubpipe", id: request.machine, localDisk: true, cwd: "/fuzz" }, env: (request.settings as { env?: Record<string, string> })?.env };
			},
		}), { before: "herdr" });
		const resolved = resolveMachinePlacement({ machine: "pipetest", cwd: "/repo", settings: { cwd: "/repo", env: { FOO: "1" }, tmux: { ssh: "u@host" } } as PlacementAdapterSettings });
		assert.deepEqual(seen, { cwd: "/repo", env: { FOO: "1" }, tmux: { ssh: "u@host" } });
		assert.deepEqual(resolved.env, { FOO: "1" });
	});

	it("answers the local-disk question without comparing providers", () => {
		const catalog = JSON.stringify([{ id: "m1", target: "remote.example", enabled: true }]);
		assert.equal(placementEditsLocalDisk(resolveMachinePlacement({ machine: "m1", cwd: "/repo", stepCwd: "/remote/repo", catalogJson: catalog }).machine), false);
		const previous = { REX_SESSION: process.env.REX_SESSION, REX_BIN_DIR: process.env.REX_BIN_DIR, PATH: process.env.PATH };
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "placement-disk-"));
		fs.writeFileSync(path.join(binDir, "rex"), `#!/bin/sh\nfor arg in "$@"; do case "$arg" in %*) printf '{"session_id":"%s"}' "$arg" ;; esac; done\nexit 0\n`, { mode: 0o755 });
		process.env.REX_SESSION = "%test";
		process.env.REX_BIN_DIR = binDir;
		try {
			assert.equal(placementEditsLocalDisk(resolveMachinePlacement({ machine: "local", cwd: binDir }).machine), true);
			assert.equal(placementSupportsExternalCli(resolveMachinePlacement({ machine: "local", cwd: binDir }).machine), false);
		} finally {
			fs.rmSync(binDir, { recursive: true, force: true });
			for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		}
		assert.equal(placementEditsLocalDisk(resolveMachinePlacement({ machine: "lab", cwd: "/repo", settings: { rex: { ssh: "lab.example" }, cwd: "/remote/root" } }).machine), false);
		// The external-CLI capability rides the same field answer: herdr machines opt in, everything else stays out.
		assert.equal(placementSupportsExternalCli(resolveMachinePlacement({ machine: "m1", cwd: "/repo", stepCwd: "/remote/repo", catalogJson: catalog }).machine), true);
		assert.equal(placementSupportsExternalCli(undefined), false);
		assert.equal(placementEditsLocalDisk(undefined), false);
	});

	it("throws an actionable error when no adapter claims the machine", () => {
		assert.throws(() => resolveMachinePlacement({ machine: "nowhere", cwd: "/repo", catalogJson: "[]" }), /machine 'nowhere' was not found.*Saved machines/u);
	});

	it("routes a placed native launch through the adapter matching its machine provider", async () => {
		const spikeroute = spiketestAdapter({ provider: "spikeroute", async openPlacedRun(machine) { assert.equal((machine as { id: string }).id, "f1"); throw new Error("not driven here"); } });
		registerPlacementAdapter(spikeroute, { before: "herdr" });
		assert.equal(requirePlacementAdapter("spikeroute"), spikeroute);
		const noMachine = { cwd: "/local/repo", storage: { kind: "memory" } } as never;
		const seen: string[] = [];
		const second = createPlacementAwareChildSessionFactory({ create: async () => { seen.push("local"); return child; }, dispose: async () => {}, disposeForParent: async () => {} } as never);
		await second.create(noMachine);
		assert.deepEqual(seen, ["local"]);
	});

	it("rejects a machine whose provider has no adapter, naming the registered providers", () => {
		assert.throws(() => requirePlacementAdapter("unheardof"), /No placement adapter for machine provider 'unheardof'.*Registered providers/u);
	});

	it("keeps provider branches out of the core dispatch", () => {
		const machineSource = fs.readFileSync(new URL("../../src/runs/shared/herdr-machine.ts", import.meta.url), "utf8");
		const resolveBody = machineSource.slice(machineSource.indexOf("export function resolveMachinePlacement"), machineSource.indexOf("A placed Pi keeps its transcript"));
		assert.equal(/provider\s*===|"rex"|"herdr"/u.test(resolveBody), false);
		const placedRunSource = fs.readFileSync(new URL("../../src/runs/shared/herdr-placed-run.ts", import.meta.url), "utf8");
		const dispatchBody = placedRunSource.slice(placedRunSource.indexOf("function createPlacedPiSession"), placedRunSource.indexOf("createPlacementAwareChildSessionFactory"));
		assert.equal(/provider\s*===/u.test(dispatchBody), false);
	});
});
