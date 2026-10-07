import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
		assert.deepEqual(getInspectorPlugins(owner).map((item) => item.name), ["herdr", "ghostty", "tmux", "test-host"]);
		assert.equal(getInspectorPlugins(otherOwner).length, 3);
		assert.throws(() => registerInspector(consumer, plugin), /already registered/);
		assert.throws(() => registerInspector(consumer, provider("herdr")), /already registered/);
		assert.throws(() => registerInspector(consumer, provider("ghostty")), /already registered/);
		assert.throws(() => registerInspector(consumer, provider("tmux")), /already registered/);
		registration.dispose();
		registerInspector(consumer, plugin);
		registration.dispose();
		assert.equal(getInspectorPlugins(owner).length, 4, "an old disposer must not remove a new registration");
		shutdown();
		assert.equal(getInspectorPlugins(owner).length, 3);
		assert.throws(() => registerInspector(consumer, plugin), /not installed, not ready/);
		t.after(registerInspectorEventListener(owner));
		registerInspector(consumer, plugin);
		shutdown();
		assert.equal(getInspectorPlugins(owner).length, 4, "old runtime cleanup must not clear a replacement");
	});

	it("keeps a registration when a duplicate runtime on the same bus replaces the one that claimed it", () => {
		const events = createEventBus();
		const claimed = { events };
		const replacement = { events };
		const cleanupClaimed = registerInspectorEventListener(claimed);
		const registration = registerInspector({ events }, provider());
		const cleanupReplacement = registerInspectorEventListener(replacement);
		cleanupClaimed();
		assert.deepEqual(getInspectorPlugins(replacement).map((item) => item.name), ["herdr", "ghostty", "tmux", "test-host"]);
		registration.dispose();
		assert.equal(getInspectorPlugins(replacement).length, 3);
		registerInspector({ events }, provider()).dispose();
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
		assert.equal(getInspectorPlugins(owner).length, 3);
	});

	it("routes existing inspector actionsand launch permissions to a registered provider without fallback on failure", async (t) => {
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

describe("inspector open and close serialization", () => {
	const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: { mode: "management" as const, results: [] } });
	const text = (response: Awaited<ReturnType<typeof handleInspectorAction>>) => response.content.map((part) => part.type === "text" ? part.text : "").join("");

	/** A provider that reuses a saved binding and takes a moment between reading and writing it, like a real pane split. */
	function bindingProvider(log: string[], options: { gate?: Promise<void>; throwOnOpen?: () => boolean } = {}) {
		const bindings = new Map<string, string>();
		let panes = 0;
		const key = (context: Parameters<InspectorPlugin["open"]>[0]) => `${context.target.index ?? "root"}`;
		const plugin: InspectorPlugin = {
			name: "binding-host",
			available: () => true,
			owns: (context) => bindings.has(key(context)),
			open: async (context) => {
				const target = key(context);
				log.push(`open ${target} start`);
				if (options.throwOnOpen?.()) throw new Error("host failed");
				const existing = bindings.get(target);
				await (options.gate ?? delay(30));
				if (existing) {
					log.push(`open ${target} end`);
					return reply(`reused ${existing}`);
				}
				const pane = `pane-${++panes}`;
				bindings.set(target, pane);
				log.push(`open ${target} end`);
				return reply(`opened ${pane}`);
			},
			close: async (context) => {
				const target = key(context);
				log.push(`close ${target}`);
				bindings.delete(target);
				return reply("closed");
			},
		};
		return { plugin, bindings, panes: () => panes };
	}

	function runDir(t: { after(fn: () => void): void }) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-inspector-serialize-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		fs.mkdirSync(path.join(root, "run-serial"));
		fs.writeFileSync(path.join(root, "run-serial", "status.json"), JSON.stringify({
			runId: "run-serial", mode: "parallel", state: "running", cwd: root,
			steps: [{ agent: "worker", status: "running" }, { agent: "worker", status: "running" }],
		}));
		return root;
	}

	it("runs concurrent opens of one target one at a time and opens one pane, without holding up other targets", { timeout: 5_000 }, async (t) => {
		const root = runDir(t);
		const log: string[] = [];
		const host = bindingProvider(log);
		const deps = { cwd: root, asyncDirRoot: root, env: {}, plugins: [host.plugin] };
		const responses = await Promise.all([
			handleInspectorAction("inspector.open", { id: "run-serial", index: 0 }, deps),
			handleInspectorAction("inspector.open", { id: "run-serial", index: 0 }, deps),
			handleInspectorAction("inspector.open", { id: "run-serial", index: 1 }, deps),
		]);
		assert.deepEqual(responses.map(text), ["opened pane-1", "reused pane-1", "opened pane-2"]);
		assert.equal(host.panes(), 2);
		const sameTarget = log.filter((entry) => entry.startsWith("open 0"));
		assert.deepEqual(sameTarget, ["open 0 start", "open 0 end", "open 0 start", "open 0 end"]);
		assert.ok(log.indexOf("open 1 start") < log.indexOf("open 0 end"), `another child's open must not wait: ${log.join(", ")}`);
	});

	it("waits for an in-flight open before closing the same target", { timeout: 5_000 }, async (t) => {
		const root = runDir(t);
		const log: string[] = [];
		const host = bindingProvider(log);
		const deps = { cwd: root, asyncDirRoot: root, env: {}, plugins: [host.plugin] };
		const opening = handleInspectorAction("inspector.open", { id: "run-serial", index: 0 }, deps);
		await delay(5);
		const closed = await handleInspectorAction("inspector.close", { id: "run-serial", index: 0 }, deps);
		await opening;
		assert.equal(text(closed), "closed");
		assert.deepEqual(log, ["open 0 start", "open 0 end", "close 0"]);
		assert.equal(host.bindings.size, 0, "the close must remove the binding the open wrote");
	});

	it("refuses to open while another open holds the target past the wait, and releases the target after a failed open", { timeout: 5_000 }, async (t) => {
		const root = runDir(t);
		const log: string[] = [];
		let releaseGate = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		let throwNext = false;
		const host = bindingProvider(log, { gate, throwOnOpen: () => throwNext });
		const deps = { cwd: root, asyncDirRoot: root, env: {}, plugins: [host.plugin] };
		const held = handleInspectorAction("inspector.open", { id: "run-serial" }, deps);
		await delay(5);
		const timedOut = await handleInspectorAction("inspector.open", { id: "run-serial" }, { ...deps, leaseWaitMs: 100 });
		assert.equal(timedOut.isError, true);
		assert.match(text(timedOut), /Another inspector open or close for async run run-serial is still in progress/);
		const aborted = new AbortController();
		aborted.abort();
		const cancelled = await handleInspectorAction("inspector.close", { id: "run-serial" }, { ...deps, signal: aborted.signal });
		assert.equal(cancelled.isError, true);
		assert.match(text(cancelled), /cancelled while waiting/);
		assert.deepEqual(log, ["open root start"], "neither waiting call may reach the provider");
		releaseGate();
		assert.equal(text(await held), "opened pane-1");

		throwNext = true;
		await assert.rejects(handleInspectorAction("inspector.open", { id: "run-serial" }, deps), /host failed/);
		throwNext = false;
		const afterFailure = await handleInspectorAction("inspector.open", { id: "run-serial" }, { ...deps, leaseWaitMs: 0 });
		assert.equal(text(afterFailure), "reused pane-1");
	});

	it("does not open for a caller cancelled while it waited, even when the target frees up at the same moment", { timeout: 5_000 }, async (t) => {
		const root = runDir(t);
		const log: string[] = [];
		let releaseGate = () => {};
		const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
		const host = bindingProvider(log, { gate });
		const deps = { cwd: root, asyncDirRoot: root, env: {}, plugins: [host.plugin] };
		const held = handleInspectorAction("inspector.open", { id: "run-serial" }, deps);
		await delay(5);
		const controller = new AbortController();
		const waiting = handleInspectorAction("inspector.open", { id: "run-serial" }, { ...deps, signal: controller.signal });
		await delay(5);
		controller.abort();
		releaseGate();
		assert.equal(text(await held), "opened pane-1");
		assert.match(text(await waiting), /cancelled while waiting/);
		assert.deepEqual(log.filter((entry) => entry.endsWith("start")), ["open root start"]);
	});
});
