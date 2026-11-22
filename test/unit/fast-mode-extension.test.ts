import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { BeforeProviderRequestEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentFastModeExtension, { rewriteFastModeProviderRequest } from "../../src/runs/shared/fast-mode-extension.ts";

let agentDir = "";
let oldAgentDir: string | undefined;

function providerRequestAfterRegistration(config: Record<string, unknown> | undefined): unknown {
	if (config) {
		const configPath = path.join(agentDir, "extensions", "subagent", "config.json");
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
	}
	let handler: ((event: BeforeProviderRequestEvent) => unknown) | undefined;
	registerSubagentFastModeExtension({ on: (event: string, fn: typeof handler) => { if (event === "before_provider_request") handler = fn; } } as unknown as ExtensionAPI);
	assert.ok(handler);
	return handler({ type: "before_provider_request", payload: { model: "gpt-5.6-luna" } });
}

describe("fast mode provider request", () => {
	beforeEach(() => {
		oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fast-mode-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("returns the rewritten provider payload without a wrapper", () => {
		const payload = {
			model: "gpt-5.6-luna",
			input: [{ role: "user", content: "test" }],
		};

		assert.deepEqual(
			rewriteFastModeProviderRequest({ type: "before_provider_request", payload }, "priority"),
			{
				...payload,
				service_tier: "priority",
			},
		);
	});

	it("preserves a non-object provider payload", () => {
		assert.equal(
			rewriteFastModeProviderRequest({ type: "before_provider_request", payload: "request" }, "priority"),
			"request",
		);
	});

	it("requests the configured fastServiceTier, defaulting to priority", () => {
		assert.deepEqual(providerRequestAfterRegistration(undefined), { model: "gpt-5.6-luna", service_tier: "priority" });
		assert.deepEqual(providerRequestAfterRegistration({ fastServiceTier: "priority" }), { model: "gpt-5.6-luna", service_tier: "priority" });
		assert.deepEqual(providerRequestAfterRegistration({ fastServiceTier: "ultrafast" }), { model: "gpt-5.6-luna", service_tier: "ultrafast" });
	});
});
