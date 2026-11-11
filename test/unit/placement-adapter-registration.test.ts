import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ChildSession, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createPlacementAwareChildSessionFactory } from "../../src/runs/shared/herdr-placed-run.ts";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { placementAdapters } from "../../src/runs/shared/placement-registry.ts";
import { registerPlacementAdapter, registerPlacementEventListener, type PlacementAdapterV1 } from "../../src/api/placement.ts";

const runtime = { runId: "run", agent: "worker", childIndex: 0, fanoutChild: false, depth: 1, maxDepth: 1, inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: false, fast: false, waitTool: { enabled: true } };
const child: ChildSession = { subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, abort: async () => {}, dispose: async () => {}, messages: [], sessionFile: undefined, sessionId: "native", modelId: "provider/model" };
function spiketestAdapter(overrides: Partial<PlacementAdapterV1> = {}): PlacementAdapterV1 {
	return { kind: "pi-subagents.placement-adapter", version: 1, provider: "spiketest", async createPlacedPiSession() { return child; }, ...overrides };
}

describe("external placement adapter registration", () => {
	it("registers through the owner's event bus, rejects duplicates, and disposes", (t) => {
		const owner = { events: createEventBus() };
		const consumer = { events: owner.events };
		t.after(registerPlacementEventListener(owner));
		const adapter = spiketestAdapter();
		const registration = registerPlacementAdapter(consumer, adapter);
		assert.ok(placementAdapters().includes(adapter), "the owner registry must hold the event-registered adapter");
		assert.throws(() => registerPlacementAdapter(consumer, spiketestAdapter()), /already registered/u);
		registration.dispose();
		assert.ok(!placementAdapters().includes(adapter), "dispose must remove the adapter");
	});

	it("rejects version, shape, provider id, and before-target problems through the result slot", (t) => {
		const events = createEventBus();
		const consumer = { events };
		t.after(registerPlacementEventListener(consumer));
		assert.throws(() => registerPlacementAdapter(consumer, spiketestAdapter({ version: 2 as never })), /version/u);
		assert.throws(() => registerPlacementAdapter(consumer, { ...spiketestAdapter(), createPlacedPiSession: undefined as never }), /createPlacedPiSession/u);
		assert.throws(() => registerPlacementAdapter(consumer, spiketestAdapter(), { before: "nosuch" }), /unknown provider/u);
		assert.throws(() => registerPlacementAdapter(consumer, spiketestAdapter({ provider: "Bad Id" })), /provider id/u);
	});

	it("throws an actionable error when no owner runtime listens on the bus", () => {
		assert.throws(() => registerPlacementAdapter({ events: createEventBus() }, spiketestAdapter()), /not installed, not ready/u);
	});

	it("resolves and routes a third-party machine through an event-registered adapter, ordered ahead of herdr", async (t) => {
		const events = createEventBus();
		const consumer = { events };
		t.after(registerPlacementEventListener(consumer));
		let routed = 0;
		const registration = registerPlacementAdapter(consumer, spiketestAdapter({
			resolveMachinePlacement: ({ machine }) => machine === "spike" ? { machine: { provider: "spiketest", id: machine, cwd: "/spike-root" } } : undefined,
			createPlacedPiSession: async (launch: ChildSessionLaunch) => { routed++; assert.equal(launch.machine?.provider, "spiketest"); return child; },
		}), { before: "herdr" });
		t.after(() => registration.dispose());
		const resolved = resolveMachinePlacement({ machine: "spike", cwd: "/repo", settings: {} });
		assert.deepEqual(resolved.machine, { provider: "spiketest", id: "spike", cwd: "/spike-root" });
		assert.deepEqual(placementAdapters().map((adapter) => adapter.provider), ["rex", "spiketest", "herdr"]);
		const factory = createPlacementAwareChildSessionFactory({ create: async () => { throw new Error("local factory must not see a placed launch"); }, dispose: async () => {}, disposeForParent: async () => {} } as never);
		const placed = await factory.create({ cwd: "/fuzz", machine: resolved.machine, remoteResources: { agent: "worker" }, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: true, hooks: [], noSkills: true, noContextFiles: true, tools: ["read"], runtime });
		assert.equal(placed, child);
		assert.equal(routed, 1);
	});
});
