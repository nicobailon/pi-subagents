import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

it("loads the executor and Fleet within seconds of a session starting, not at session_start or on first use", async (t) => {
	const sourceRoot = `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src")}${path.sep}`;
	const loaded = new Set<string>();
	registerHooks({
		load(url, context, nextLoad) {
			if (url.startsWith("file:") && fileURLToPath(url).startsWith(sourceRoot)) loaded.add(fileURLToPath(url));
			return nextLoad(url, context);
		},
	});
	const isLoaded = (suffix: string[]) => [...loaded].some((file) => file.endsWith(`${path.sep}${suffix.join(path.sep)}`));
	const executorLoaded = () => isLoaded(["runs", "foreground", "subagent-executor.ts"]);
	const fleetLoaded = () => isLoaded(["tui", "fleet.ts"]);

	// A top-level session; this test may itself run inside a subagent child.
	delete process.env.PI_SUBAGENT_CHILD;
	const { default: registerSubagentExtension } = await import("../../src/extension/index.ts");
	const { createEventBus } = await import("@earendil-works/pi-coding-agent");
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = new Proxy({
		events: createEventBus(),
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	}, { get: (target, property) => property in target ? target[property as keyof typeof target] : () => undefined });
	const ctx = {
		cwd: process.cwd(), isIdle() { return false; }, hasUI: false, model: undefined,
		ui: { setWidget() {}, theme: { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } },
		sessionManager: { getSessionId: () => "preload-session", getSessionFile: () => null, getEntries: () => [] },
		modelRegistry: { getAvailable: () => [] },
	};

	t.mock.timers.enable({ apis: ["setTimeout"] });
	registerSubagentExtension(pi as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	assert.equal(executorLoaded(), false, "session_start must not load the executor on Pi's startup path");
	assert.equal(fleetLoaded(), false, "session_start must not load Fleet on Pi's startup path");

	t.mock.timers.tick(5_000);
	assert.equal(executorLoaded(), true, "the executor loads within seconds of the session starting");
	assert.equal(fleetLoaded(), true, "Fleet loads within seconds of the session starting");

	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
});
