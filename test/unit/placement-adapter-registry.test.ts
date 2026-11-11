import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import type { ChildSession, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
// Importing herdr-placed-run loads the built-in Herdr and Rex adapters into the registry.
import { createPlacementAwareChildSessionFactory } from "../../src/runs/shared/herdr-placed-run.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { placementAdapters, registerPlacementAdapter, requirePlacementAdapter, type PlacementAdapterV1 } from "../../src/runs/shared/placement-registry.ts";

const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const child: ChildSession = { subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: "native", modelId: "provider/model" };
function spiketestAdapter(overrides: Partial<PlacementAdapterV1> = {}): PlacementAdapterV1 {
	return { kind: "pi-subagents.placement-adapter", version: 1, provider: "spiketest", async createPlacedPiSession() { return child; }, ...overrides };
}

describe("placement adapter registry", () => {
	it("registers the built-in rex and herdr adapters in resolution order", () => {
		assert.deepEqual(placementAdapters().map((adapter) => adapter.provider), ["rex", "herdr"]);
		for (const adapter of placementAdapters()) {
			assert.equal(adapter.kind, "pi-subagents.placement-adapter");
			assert.equal(adapter.version, 1);
			assert.equal(typeof adapter.createPlacedPiSession, "function");
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
		assert.deepEqual(resolved.machine, { provider: "rex", id: "lab", target: "lab.example", cwd: "/remote/root/sub" });
	});

	it("falls through the registry to the herdr catalog for unclaimed names", () => {
		const catalog = JSON.stringify([{ id: "m1", target: "remote.example", enabled: true }]);
		const resolved = resolveMachinePlacement({ machine: "m1", cwd: "/repo", stepCwd: "/remote/repo", catalogJson: catalog });
		assert.deepEqual(resolved.machine, { provider: "herdr", id: "m1", target: "remote.example", cwd: "/remote/repo" });
	});

	it("keeps 'local' reserved for rex panes and rejects a rex ssh entry named local", () => {
		assert.throws(() => resolveMachinePlacement({ machine: "local", cwd: "/repo", settings: { rex: { ssh: "h" } } }), /reserved for a Rex pane/u);
	});

	it("lets a registered adapter claim a machine name the built-ins decline", () => {
		registerPlacementAdapter(spiketestAdapter({ resolveMachinePlacement: ({ machine }) => machine === "fuzzbox" ? { machine: { provider: "spiketest", id: machine, cwd: "/fuzz" } } : undefined }), { before: "herdr" });
		const resolved = resolveMachinePlacement({ machine: "fuzzbox", cwd: "/repo", settings: {} });
		assert.deepEqual(resolved.machine, { provider: "spiketest", id: "fuzzbox", cwd: "/fuzz" });
	});

	it("throws an actionable error when no adapter claims the machine", () => {
		assert.throws(() => resolveMachinePlacement({ machine: "nowhere", cwd: "/repo", catalogJson: "[]" }), /machine 'nowhere' was not found.*Saved machines/u);
	});

	it("routes a placed native launch to the adapter matching its machine provider, and no launch to no adapter", async () => {
		let created = 0;
		registerPlacementAdapter(spiketestAdapter({ provider: "spikeroute", async createPlacedPiSession(launch: ChildSessionLaunch) { created++; assert.equal(launch.machine?.provider, "spikeroute"); return child; } }), { before: "herdr" });
		const local = { create: async () => { throw new Error("local factory must not see a placed launch"); }, dispose: async () => {}, disposeForParent: async () => {} };
		const factory = createPlacementAwareChildSessionFactory(local as never);
		const placed = await factory.create({ cwd: "/fuzz", machine: { provider: "spikeroute", id: "f1", cwd: "/fuzz" }, remoteResources: { agent: "worker" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], runtime });
		assert.equal(placed, child);
		assert.equal(created, 1);
		const noMachine = { ...{ cwd: "/local/repo", storage: { kind: "memory" } as ChildSessionLaunch["storage"] } } as ChildSessionLaunch;
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
