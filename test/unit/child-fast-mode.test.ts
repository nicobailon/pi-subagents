import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installChildFastMode } from "../../src/runs/shared/child-fast-mode.ts";

const responses = { api: "openai-responses", provider: "fixture", id: "new-model" } as NonNullable<AgentSession["model"]>;
const completions = { ...responses, api: "openai-completions" } as const;
const runtime = { getRegisteredNativeProvider: () => undefined, getRegisteredProviderConfig: () => undefined };

type RequestHooks = Pick<AgentSession["agent"], "onPayload" | "prepareRequest">;
function sessionWith(hooks: RequestHooks, model: AgentSession["model"] = responses): Pick<AgentSession, "model" | "agent"> {
	return { model, agent: hooks as AgentSession["agent"] };
}

it("adds Priority after existing payload transforms, preserving explicit tiers and the original body", async () => {
	const session = sessionWith({ onPayload: async (body) => ({ ...(body as object), extra: true }) });
	installChildFastMode(session, runtime);
	const body = { model: "new-model" };
	assert.deepEqual(await session.agent.onPayload!(body, responses), { ...body, extra: true, service_tier: "priority" });
	assert.deepEqual(body, { model: "new-model" });
	assert.deepEqual(await session.agent.onPayload!({ ...body, service_tier: "flex" }, responses), { ...body, extra: true, service_tier: "flex" });
	await assert.rejects(() => Promise.resolve(session.agent.onPayload!(body, completions)), /openai-completions.*fast: false/);
});

it("rejects bad payloads instead of silently omitting the requested tier", async () => {
	const session = sessionWith({ onPayload: () => "not a request body" });
	installChildFastMode(session, runtime);
	await assert.rejects(() => Promise.resolve(session.agent.onPayload!({}, responses)), /did not produce an object payload.*fast: false/);
});

it("rejects unverified selections and custom streams even if the API id looks compatible", () => {
	const customRuntime: typeof runtime | Pick<ModelRuntime, "getRegisteredNativeProvider" | "getRegisteredProviderConfig"> = {
		...runtime, getRegisteredProviderConfig: () => ({ api: "openai-responses", streamSimple() { throw new Error("must not dispatch"); } }),
	};
	assert.throws(() => installChildFastMode(sessionWith({}, { ...responses, api: "pi-virtual" }), runtime), /pi-virtual.*fast: false/);
	assert.throws(() => installChildFastMode(sessionWith({}), customRuntime), /unverified custom stream.*fast: false/);
});

it("checks the prepared request model before dispatch even if the original selection was compatible", async () => {
	const session = sessionWith({ prepareRequest: async () => ({ model: completions }) });
	installChildFastMode(session, runtime);
	await assert.rejects(() => Promise.resolve(session.agent.prepareRequest!({
		model: responses, context: { messages: [], systemPrompt: "", tools: [] }, thinkingLevel: "off",
	}, new AbortController().signal)), /openai-completions.*fast: false/);
});
