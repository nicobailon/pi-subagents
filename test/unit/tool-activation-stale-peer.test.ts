import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("activates against the running Pi when a package-local pi-ai lacks transcript helpers", async () => {
	// Simulate an older pi-ai installed beside this package, not the running host.
	const hook = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === "@earendil-works/pi-ai" && context.parentURL &&
				new URL(context.parentURL).pathname.endsWith("/src/extension/tool-activation.ts")) {
				return { url: "data:text/javascript,export const legacy = true", shortCircuit: true };
			}
			return nextResolve(specifier, context);
		},
	});
	try {
		const { registerSubagentToolActivation } = await import("../../src/extension/tool-activation.ts");
		const tools = new Set(["read", "subagent"]);
		const pi = {
			getAllTools: () => [...tools].map((name) => ({ name })),
			getActiveTools: () => ["read", "subagent"],
			setActiveTools() {},
			registerTool: (tool: { name: string }) => { tools.add(tool.name); },
			on: () => () => {},
		};
		// SAFETY: activation calls only the five Pi methods supplied by this fixture.
		registerSubagentToolActivation(pi as never, { advertisedPrompt: () => undefined });
		assert.ok(tools.has("subagents_enable"), "host API should enable the self-service loader");
	} finally {
		hook.deregister();
	}
});
