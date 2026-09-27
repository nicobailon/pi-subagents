import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

test("activates against the running Pi when a package-local pi-ai lacks transcript helpers", async () => {
	const hostRoot = resolveInstalledPiPackageRoot();
	assert.ok(hostRoot, "test needs a real Pi SDK root");
	const previousHost = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = hostRoot;
	delete process.env.PI_PACKAGE_DIR;

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
		if (previousHost === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previousHost;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previousPackageDir;
	}
});
