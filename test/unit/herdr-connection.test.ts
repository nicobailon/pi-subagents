import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HerdrRpcError, SocketRpcClient } from "../../src/runs/shared/herdr-connection.ts";

async function withSocketServer<T>(handler: (socket: net.Socket, request: Record<string, unknown>) => void, action: (client: SocketRpcClient) => Promise<T>, ackTimeoutMs = 100): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-rpc-")), socketPath = path.join(dir, "server.sock");
	const server = net.createServer((socket) => { let buffer = ""; socket.on("data", (chunk) => { buffer += chunk; const newline = buffer.indexOf("\n"); if (newline < 0) return; const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>; buffer = buffer.slice(newline + 1); handler(socket, request); }); });
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
	try { return await action(new SocketRpcClient(socketPath, ackTimeoutMs)); }
	finally { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("Herdr socket RPC wire contract", { skip: process.platform === "win32" }, () => {
	it("waits for a fragmented subscription acknowledgement before projecting events and unsubscribes silently", async () => {
		await withSocketServer((socket, request) => { const id = String(request.id); socket.write(line({ id, result: { type: "subscription_started" } }).slice(0, 12)); setImmediate(() => { socket.write(line({ id, result: { type: "subscription_started" } }).slice(12)); socket.write(line({ type: "event", data: { pane_id: "p" } })); }); }, async (client) => {
			const events: unknown[] = [], disconnects: Error[] = []; let resolved = false; const subscribing = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "p" }], (event) => events.push(event), (error) => disconnects.push(error)).then((stop) => { resolved = true; return stop; }); assert.equal(resolved, false); const stop = await subscribing; await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(events.length, 1); stop(); await new Promise<void>((resolve) => setImmediate(resolve)); assert.deepEqual(disconnects, []);
		});
	});
	it("rejects matching application errors with code and request provenance", async () => {
		await withSocketServer((socket, request) => socket.end(line({ id: request.id, error: { code: "permission_denied", message: "denied" } })), async (client) => assert.rejects(client.subscribe([], () => {}), (error) => error instanceof HerdrRpcError && error.code === "permission_denied" && error.requestId === "1"));
	});
	it("rejects Herdr empty-id invalid_request and premature EOF", async () => {
		await withSocketServer((socket) => socket.end(line({ id: "", error: { code: "invalid_request", message: "bad subscription" } })), async (client) => assert.rejects(client.subscribe([], () => {}), (error) => error instanceof HerdrRpcError && error.code === "invalid_request" && error.requestId === ""));
		await withSocketServer((socket) => socket.end(), async (client) => assert.rejects(client.subscribe([], () => {}), /connection was lost/u));
	});
	it("bounds acknowledgement time and notifies one disconnect for error plus close after acknowledgement", async () => {
		await withSocketServer(() => {}, async (client) => assert.rejects(client.subscribe([], () => {}), /acknowledgement timed out/u), 10);
		await withSocketServer((socket, request) => { socket.write(line({ id: request.id, result: { type: "subscription_started" } })); setImmediate(() => socket.write("not-json\n")); }, async (client) => { const disconnects: Error[] = []; await client.subscribe([], () => assert.fail("handshake errors are not events"), (error) => disconnects.push(error)); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(disconnects.length, 1); assert.match(disconnects[0]!.message, /malformed/u); });
	});
	it("reports a post-ack failure from the same buffered turn before subscribe returns", async () => {
		await withSocketServer((socket, request) => socket.write(line({ id: request.id, result: { type: "subscription_started" } }) + line({ id: "event-error", error: { code: "stream_failed", message: "lost after ack" } })), async (client) => { let lost: Error | undefined; const stop = await client.subscribe([], () => assert.fail("error envelopes are not events"), (error) => { lost = error; }); assert.match(lost?.message ?? "", /lost after ack/u); stop(); });
	});
	it("ordinary calls reject premature EOF and retain structured application errors", async () => {
		await withSocketServer((socket) => socket.end(), async (client) => assert.rejects(client.call("agent.get", {}, 100), /ended before a response/u));
		await withSocketServer((socket, request) => socket.end(line({ id: request.id, error: { code: "agent_not_ready", message: "pending" } })), async (client) => assert.rejects(client.call("agent.prompt"), (error) => error instanceof HerdrRpcError && error.code === "agent_not_ready" && error.requestId === "1"));
	});
});
