import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const fetchFixture = async (input, init) => {
	const request = new Request(input, init);
	const routes = {
		"https://api.openai.com/v1/responses": "responses",
		"https://chatgpt.com/backend-api/codex/responses": "codex",
		"https://fixture.invalid/v1/responses": "api-key",
		"https://fixture.invalid/v1/chat/completions": "completions",
	};
	const route = routes[request.url];
	assert.ok(route, `unexpected fetch: ${request.url}`);
	assert.equal(request.method, "POST");
	const body = request.headers.get("content-encoding") === "zstd"
		? JSON.parse(zstdDecompressSync(Buffer.from(await request.arrayBuffer())).toString("utf8"))
		: await request.json();
	const tag = JSON.stringify(body.input ?? body.messages).match(/WIRE_[A-Z0-9_]+/)?.[0];
	assert.ok(tag, "request must contain its case tag");
	const auth = request.headers.get("authorization");
	const fixtureTokens = { responses: tag.startsWith("WIRE_OPENAI_KEY_") ? "fixture-key" : "fixture.chatgpt.token",
		codex: process.env.PI_FAST_WIRE_CODEX_TOKEN, "api-key": "fixture-key", completions: "fixture-key" };
	assert.equal(auth, `Bearer ${fixtureTokens[route]}`);
	appendFileSync(process.env.PI_FAST_WIRE_LOG, JSON.stringify({ tag, route, pid: process.pid, body }) + "\n");
	if (tag.startsWith("WIRE_TIER_DENIED_")) {
		return Response.json({ error: { message: "fixture tier unsupported", type: "invalid_request_error" } }, { status: 400 });
	}
	if (route === "completions") {
		const chunk = { id: "chatcmpl-fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "FAST_WIRE_OK" }, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	}
	const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "FAST_WIRE_OK", annotations: [] }] };
	const response = { id: "resp_fixture", object: "response", model: body.model, status: "completed", service_tier: "default", output: [item],
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
	const events = [
		{ type: "response.created", response: { ...response, output: [], status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "FAST_WIRE_OK" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => fetchFixture, set: () => {} });
