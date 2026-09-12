import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import OpenAI from "openai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createLocalInferenceTransport } from "../../src/runs/shared/local-inference-transport.ts";

// Use the real SDK and HTTP stack: a unit mock of the option object would miss
// the regression (the SDK and Undici have independent abort controllers).
test("local transport survives an SDK deadline, streams a delayed body, and honors operator abort", async () => {
	const server = createServer((req, res) => {
		if (req.url?.includes("cancel-body")) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"waiting":'); return; }
		if (req.url?.includes("cancel")) return;
		setTimeout(() => {
			if (res.destroyed) return;
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"id":"');
			setTimeout(() => res.end('survived"}'), 80);
		}, 80);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const transport = createLocalInferenceTransport();
	try {
		const ordinary = new OpenAI({ apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}`, timeout: 1, maxRetries: 0 });
		await assert.rejects(ordinary.get("/delayed"), /timed out/i, "negative control: the ordinary SDK must enforce the short deadline");
		let result: Promise<unknown> | undefined;
		const original = ((_model, _context, options) => {
			const extended = options as typeof options & { fetch: typeof fetch; timeoutMs: number };
			const client = new OpenAI({ apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}`, fetch: extended.fetch, timeout: extended.timeoutMs, maxRetries: 0 });
			result = client.get("/delayed", { signal: options?.signal });
			return undefined;
		}) as unknown as StreamFn;
		transport.wrap(original)({} as never, { messages: [] }, { timeoutMs: 1 } as never);
		assert.deepEqual(await result, { id: "survived" });
		for (const endpoint of ["/cancel", "/cancel-body"]) {
		const controller = new AbortController();
		const cancelling = ((_model, _context, options) => {
			const extended = options as typeof options & { fetch: typeof fetch; timeoutMs: number };
			const client = new OpenAI({ apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}`, fetch: extended.fetch, timeout: extended.timeoutMs, maxRetries: 0 });
			result = client.get(endpoint, { signal: options?.signal });
			return undefined;
		}) as unknown as StreamFn;
		transport.wrap(cancelling)({} as never, { messages: [] }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(result!, /abort/i);
		}
	} finally {
		server.closeAllConnections();
		await transport.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
