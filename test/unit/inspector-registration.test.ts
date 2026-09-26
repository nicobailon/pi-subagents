import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { INSPECTOR_REGISTER_EVENT, registerInspector, type InspectorPlugin, type InspectorRegistrationRequest } from "../../src/api/inspectors.ts";
import { handleInspectorAction } from "../../src/inspectors/actions.ts";
import { getInspectorPlugins, registerInspectorEventListener } from "../../src/inspectors/plugins.ts";

function provider(name = "test-host"): InspectorPlugin {
	return {
		name,
		available: () => true,
		owns: () => false,
		open: async () => ({ content: [{ type: "text", text: "opened" }], details: { mode: "management", results: [] } }),
	};
}

describe("external inspector registration", () => {
	it("registers through the owner, preserves built-in preference, and disposes across reloads", (t) => {
		const owner = { events: createEventBus() };
		const consumer = { events: owner.events };
		const otherOwner = { events: createEventBus() };
		const shutdown = registerInspectorEventListener(owner);
		t.after(shutdown);
		t.after(registerInspectorEventListener(otherOwner));
		const plugin = provider();
		const registration = registerInspector(consumer, plugin);
		assert.deepEqual(getInspectorPlugins(owner).map((item) => item.name), ["herdr", "ghostty", "test-host"]);
		assert.equal(getInspectorPlugins(otherOwner).length, 2);
		assert.throws(() => registerInspector(consumer, plugin), /already registered/);
		assert.throws(() => registerInspector(consumer, provider("herdr")), /already registered/);
		assert.throws(() => registerInspector(consumer, provider("ghostty")), /already registered/);
		registration.dispose();
		registerInspector(consumer, plugin);
		registration.dispose();
		assert.equal(getInspectorPlugins(owner).length, 3, "an old disposer must not remove a new registration");
		shutdown();
		assert.equal(getInspectorPlugins(owner).length, 2);
		assert.throws(() => registerInspector(consumer, plugin), /not installed, not ready/);
		t.after(registerInspectorEventListener(owner));
		registerInspector(consumer, plugin);
		shutdown();
		assert.equal(getInspectorPlugins(owner).length, 3, "old runtime cleanup must not clear a replacement");
	});

	it("keeps a registration when a duplicate runtime on the same bus replaces the one that claimed it", () => {
		const events = createEventBus();
		const claimed = { events };
		const replacement = { events };
		const cleanupClaimed = registerInspectorEventListener(claimed);
		const cleanupReplacement = registerInspectorEventListener(replacement);
		const registration = registerInspector({ events }, provider());
		cleanupClaimed();
		assert.deepEqual(getInspectorPlugins(replacement).map((item) => item.name), ["herdr", "ghostty", "test-host"]);
		registration.dispose();
		assert.equal(getInspectorPlugins(replacement).length, 2);
		cleanupReplacement();
	});

	it("rejects malformed event requests without registering callbacks", (t) => {
		const owner = { events: createEventBus() };
		t.after(registerInspectorEventListener(owner));
		const invalid = [
			{ version: 2, plugin: provider() },
			{ version: 1 },
			{ version: 1, plugin: provider("invalid name") },
			{ version: 1, plugin: { ...provider(), open: "not callable" } },
			{ version: 1, plugin: { ...provider(), close: false } },
		];
		for (const input of invalid) {
			// SAFETY: undefined is a valid initial result; the synchronous owner fills it during emit.
			const request = { ...input, result: undefined as InspectorRegistrationRequest["result"] };
			owner.events.emit(INSPECTOR_REGISTER_EVENT, request);
			assert.equal(request.result?.ok, false);
			if (request.result?.ok === false) assert.ok(request.result.error instanceof Error);
		}
		assert.equal(getInspectorPlugins(owner).length, 2);
	});

	it("routes existing inspector actions and launch permissions to a registered provider without fallback on failure", async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspector-registration-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		const asyncDir = path.join(root, "run-provider");
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
			runId: "run-provider", mode: "single", state: "running", cwd: root,
			steps: [{ agent: "worker", status: "running" }],
		}));
		const owner = { events: createEventBus() };
		t.after(registerInspectorEventListener(owner));
		const calls: string[] = [];
		const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { mode: "management" as const, results: [] } });
		registerInspector(owner, { ...provider("unavailable"), available: () => false, open: async () => assert.fail("unavailable provider opened") });
		const registration = registerInspector(owner, {
			...provider(),
			owns: (context) => context.target.runId === "run-provider",
			open: async (context, launch, params) => {
				assert.equal(context.target.index, 0);
				assert.equal(params.focus, true);
				assert.equal(launch.allowSteer, false);
				assert.equal(launch.allowStop, false);
				assert.ok(launch.argv.includes(asyncDir));
				calls.push("open");
				return reply("opened");
			},
			status: async () => { calls.push("status"); return reply("present"); },
			close: async () => { calls.push("close"); return reply("closed"); },
		});
		const deps = () => ({
			cwd: root, asyncDirRoot: root, env: {}, plugins: getInspectorPlugins(owner),
			authorityPolicy: { steerRun: "forbid" as const, stopRun: "forbid" as const },
		});
		const params = { id: "run-provider", index: 0, focus: true };
		await handleInspectorAction("inspector.command", params, deps());
		assert.deepEqual(calls, [], "standalone command generation must not invoke a provider");
		for (const action of ["inspector.open", "inspector.status", "inspector.close"] as const) {
			assert.notEqual((await handleInspectorAction(action, params, deps())).isError, true);
		}
		assert.deepEqual(calls, ["open", "status", "close"]);
		registration.dispose();
		registerInspector(owner, { ...provider("failing"), open: async () => { throw new Error("host failed after opening"); } });
		registerInspector(owner, { ...provider("fallback"), open: async () => assert.fail("must not open a second pane after failure") });
		await assert.rejects(handleInspectorAction("inspector.open", params, deps()), /host failed after opening/);
	});
});
