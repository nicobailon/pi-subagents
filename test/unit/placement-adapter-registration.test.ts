import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { resolveMachinePlacement } from "../../src/runs/shared/herdr-machine.ts";
import { placementAdapters } from "../../src/runs/shared/placement-registry.ts";
import { registerPlacementAdapter, registerPlacementEventListener, type PlacementAdapterV1 } from "../../src/api/placement.ts";

function spiketestAdapter(overrides: Partial<PlacementAdapterV1> = {}): PlacementAdapterV1 {
	return { kind: "pi-subagents.placement-adapter", version: 1, provider: "spiketest", async openPlacedRun() { throw new Error("unused in this test"); }, ...overrides };
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
		assert.throws(() => registerPlacementAdapter(consumer, { ...spiketestAdapter(), openPlacedRun: undefined as never }), /openPlacedRun/u);
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
		const registration = registerPlacementAdapter(consumer, spiketestAdapter({
			resolveMachinePlacement: ({ machine }) => machine === "spike" ? { machine: { provider: "spiketest", id: machine, cwd: "/spike-root" } } : undefined,
		}), { before: "herdr" });
		t.after(() => registration.dispose());
		const resolved = resolveMachinePlacement({ machine: "spike", cwd: "/repo", settings: {} });
		assert.deepEqual(resolved.machine, { provider: "spiketest", id: "spike", cwd: "/spike-root" });
		assert.deepEqual(placementAdapters().map((adapter) => adapter.provider), ["rex", "spiketest", "herdr"]);
	});
});
