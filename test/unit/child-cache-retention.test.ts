import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { childCacheRetention, childCacheRetentionEnv, pinChildCacheRetention } from "../../src/shared/child-cache-retention.ts";

type StreamOptions = Parameters<StreamFn>[2];

/** Records the options each call receives so tests can assert on the request env. */
function recordingAgent(): { agent: { streamFunction: StreamFn }; calls: StreamOptions[]; original: StreamFn } {
	const calls: StreamOptions[] = [];
	const original = ((_model, _context, options) => {
		calls.push(options);
		return undefined as never;
	}) as StreamFn;
	return { agent: { streamFunction: original }, calls, original };
}

function call(agent: { streamFunction: StreamFn }, options?: StreamOptions): void {
	agent.streamFunction(undefined as never, undefined as never, options);
}

describe("childCacheRetention", () => {
	it("is unset by default so children inherit the parent's retention", () => {
		assert.equal(childCacheRetention({}), undefined);
		assert.equal(childCacheRetention({ PI_SUBAGENT_CACHE_RETENTION: "" }), undefined);
	});

	it("returns the configured tier", () => {
		assert.equal(childCacheRetention({ PI_SUBAGENT_CACHE_RETENTION: "short" }), "short");
		assert.equal(childCacheRetention({ PI_SUBAGENT_CACHE_RETENTION: "long" }), "long");
	});

	it("ignores the parent's own retention", () => {
		assert.equal(childCacheRetention({ PI_CACHE_RETENTION: "long" }), undefined);
	});
});

describe("childCacheRetentionEnv", () => {
	it("contributes nothing when unset so a spawned child inherits the parent value", () => {
		assert.deepEqual(childCacheRetentionEnv({}), {});
		const launchEnv = { ...{ PI_CACHE_RETENTION: "long" }, ...childCacheRetentionEnv({}) };
		assert.equal(launchEnv.PI_CACHE_RETENTION, "long");
	});

	it("overrides the inherited value in a spawned child's launch environment", () => {
		const launchEnv = { ...{ PI_CACHE_RETENTION: "long" }, ...childCacheRetentionEnv({ PI_SUBAGENT_CACHE_RETENTION: "short" }) };
		assert.equal(launchEnv.PI_CACHE_RETENTION, "short");
	});
});

describe("pinChildCacheRetention", () => {
	it("leaves the stream function untouched when no tier is configured", () => {
		const { agent, calls, original } = recordingAgent();
		pinChildCacheRetention(agent, {});
		assert.equal(agent.streamFunction, original);
		call(agent, { env: { PI_CACHE_RETENTION: "long" } });
		assert.deepEqual(calls[0]?.env, { PI_CACHE_RETENTION: "long" });
	});

	it("sets the configured tier on the request env", () => {
		const { agent, calls } = recordingAgent();
		pinChildCacheRetention(agent, { PI_SUBAGENT_CACHE_RETENTION: "short" });
		call(agent);
		assert.equal(calls[0]?.env?.PI_CACHE_RETENTION, "short");
	});

	it("overrides an inherited parent tier on the request env", () => {
		const { agent, calls } = recordingAgent();
		pinChildCacheRetention(agent, { PI_SUBAGENT_CACHE_RETENTION: "short" });
		call(agent, { env: { PI_CACHE_RETENTION: "long" } });
		assert.equal(calls[0]?.env?.PI_CACHE_RETENTION, "short");
	});

	it("preserves other request env values and options", () => {
		const { agent, calls } = recordingAgent();
		pinChildCacheRetention(agent, { PI_SUBAGENT_CACHE_RETENTION: "short" });
		call(agent, { env: { ANTHROPIC_API_KEY: "sk-test" }, headers: { "x-trace": "1" } } as StreamOptions);
		assert.equal(calls[0]?.env?.ANTHROPIC_API_KEY, "sk-test");
		assert.equal(calls[0]?.env?.PI_CACHE_RETENTION, "short");
		assert.deepEqual((calls[0] as { headers?: Record<string, string> })?.headers, { "x-trace": "1" });
	});

	it("scopes the override to this session instead of shared process state", () => {
		const before = process.env.PI_CACHE_RETENTION;
		const { agent } = recordingAgent();
		pinChildCacheRetention(agent, { PI_SUBAGENT_CACHE_RETENTION: "short" });
		call(agent);
		assert.equal(process.env.PI_CACHE_RETENTION, before);
	});

	it("leaves a sibling session's stream function alone", () => {
		const child = recordingAgent();
		const parent = recordingAgent();
		pinChildCacheRetention(child.agent, { PI_SUBAGENT_CACHE_RETENTION: "short" });
		assert.equal(parent.agent.streamFunction, parent.original);
		call(parent.agent, { env: { PI_CACHE_RETENTION: "long" } });
		assert.equal(parent.calls[0]?.env?.PI_CACHE_RETENTION, "long");
	});

	it("does nothing when the session has no agent or stream function", () => {
		assert.doesNotThrow(() => pinChildCacheRetention(undefined, { PI_SUBAGENT_CACHE_RETENTION: "short" }));
		assert.doesNotThrow(() =>
			pinChildCacheRetention({ streamFunction: undefined as unknown as StreamFn }, { PI_SUBAGENT_CACHE_RETENTION: "short" }),
		);
	});
});
