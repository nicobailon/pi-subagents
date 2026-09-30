import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createBashToolDefinition, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createChildCommandRuntime, controlChildCommand, readChildCommandState } from "../../src/runs/shared/child-commands.ts";

const ctx = { sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined } } as ExtensionContext;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!predicate()) { assert.ok(Date.now() < deadline, "condition did not become true"); await delay(10); }
}
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function serviceCommand(pidFile: string) {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('ready'); setInterval(() => {}, 1000);`)}`;
}

describe("child commands using Pi's real bash backend", () => {
	it("yields a live process, runs another command, and cancels only the selected process", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-commands-"));
		const commands = createChildCommandRuntime(dir);
		const bash = commands.wrap(createBashToolDefinition(dir));
		try {
			const firstPid = path.join(dir, "first.pid");
			const secondPid = path.join(dir, "second.pid");
			const first = await bash.execute("first", { command: serviceCommand(firstPid), yieldTimeMs: 0 }, undefined, undefined, ctx);
			assert.match(first.content[0].text, /not a successful exit/);
			await bash.execute("second", { command: serviceCommand(secondPid), yieldTimeMs: 0 }, undefined, undefined, ctx);
			await until(() => fs.existsSync(firstPid) && fs.existsSync(secondPid));
			const pid1 = Number(fs.readFileSync(firstPid));
			const pid2 = Number(fs.readFileSync(secondPid));
			const continued = await bash.execute("continue", { command: "printf continued" }, undefined, undefined, ctx);
			assert.equal(continued.content[0].text, "continued");
			const cancelled = await controlChildCommand(dir, "cancel", "first");
			assert.equal(cancelled.commands[0].toolCallId, "first");
			assert.ok(["cancel_requested", "cancelled"].includes(cancelled.commands[0].state));
			await until(() => commands.operate("status", "first").commands[0].state === "cancelled");
			await until(() => !processAlive(pid1));
			assert.equal(processAlive(pid2), true, "sibling command must remain alive");
			assert.equal(commands.operate("status", "second").commands[0].state, "yielded");
			await controlChildCommand(dir, "cancel", "second");
			await commands.shutdown();
			await until(() => !processAlive(pid2));
			assert.equal(readChildCommandState(dir)?.closed, true);
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("lets the supervisor yield a bash call that was already blocking", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-yield-"));
		const commands = createChildCommandRuntime(dir);
		try {
			const pidFile = path.join(dir, "service.pid");
			const pending = commands.wrap(createBashToolDefinition(dir)).execute("blocked", { command: serviceCommand(pidFile) }, undefined, undefined, ctx);
			await until(() => fs.existsSync(pidFile));
			assert.equal(commands.state().commands[0].state, "running");
			await controlChildCommand(dir, "yield", "blocked");
			assert.match((await pending).content[0].text, /still running/);
			assert.equal(processAlive(Number(fs.readFileSync(pidFile))), true);
			await controlChildCommand(dir, "cancel", "blocked");
			await commands.shutdown();
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("returns command failures and per-command timeouts without poisoning the session", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-errors-"));
		const commands = createChildCommandRuntime(dir);
		const bash = commands.wrap(createBashToolDefinition(dir));
		try {
			await assert.rejects(bash.execute("fail", { command: "exit 7" }, undefined, undefined, ctx), /code 7/);
			await assert.rejects(bash.execute("timeout", { command: "sleep 10", timeout: 0.05 }, undefined, undefined, ctx), /timed out/);
			assert.equal(commands.operate("status", "timeout").commands[0].state, "failed");
			const result = await bash.execute("recover", { command: "printf recovered" }, undefined, undefined, ctx);
			assert.equal(result.content[0].text, "recovered");
			await commands.finish();
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("cancels unfinished background work and fails closed when the child finishes", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-finish-"));
		const commands = createChildCommandRuntime(dir);
		try {
			const pidFile = path.join(dir, "service.pid");
			await commands.wrap(createBashToolDefinition(dir)).execute("unfinished", { command: serviceCommand(pidFile), yieldTimeMs: 0 }, undefined, undefined, ctx);
			await until(() => fs.existsSync(pidFile));
			const pid = Number(fs.readFileSync(pidFile));
			await assert.rejects(commands.finish(), /unfinished commands: unfinished/);
			await until(() => !processAlive(pid));
			assert.equal(commands.state().commands[0].state, "cancelled");
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});
});


describe("Pi agent loop command cancellation", () => {
	it("continues the same agent turn after the supervisor cancels a blocking command", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-agent-"));
		const commands = createChildCommandRuntime(dir);
		const pidFile = path.join(dir, "agent.pid");
		const responses = [
			fauxAssistantMessage(fauxToolCall("bash", { command: serviceCommand(pidFile) }, { id: "blocked" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf continued" }, { id: "after-cancel" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		];
		const agent = new Agent({
			initialState: { tools: [commands.wrap(createBashToolDefinition(dir, { exposeSessionEnvironment: false }))] },
			streamFn: () => {
				const message = responses.shift()!;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
				return stream;
			},
		});
		try {
			const run = agent.prompt("Run the commands");
			await until(() => fs.existsSync(pidFile));
			await controlChildCommand(dir, "cancel", "blocked");
			await run;
			await commands.finish();
			const results = agent.state.messages.filter((message) => message.role === "toolResult");
			assert.equal(results[0].toolCallId, "blocked");
			assert.equal(results[0].isError, true);
			assert.equal(results[1].toolCallId, "after-cancel");
			assert.equal(results[1].content[0].text, "continued");
			assert.equal(agent.state.errorMessage, undefined);
		} finally { agent.abort(); await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});
	it("continues after a yielded command and observes targeted cancellation through the child tool", { timeout: 10_000 }, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-command-yield-agent-"));
		const commands = createChildCommandRuntime(dir);
		const responses = [
			fauxAssistantMessage(fauxToolCall("bash", { command: serviceCommand(path.join(dir, "service.pid")), yieldTimeMs: 0 }, { id: "service" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("bash", { command: "printf continued" }, { id: "continue" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("subagent_command", { action: "cancel", toolCallId: "service", waitMs: 1000 }, { id: "cancel-service" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		];
		const agent = new Agent({
			initialState: { tools: [commands.wrap(createBashToolDefinition(dir, { exposeSessionEnvironment: false })), commands.tool()] },
			streamFn: () => {
				const message = responses.shift()!;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: message.stopReason, message }));
				return stream;
			},
		});
		try {
			await agent.prompt("Start the service, continue, and cancel the service");
			await commands.finish();
			const results = agent.state.messages.filter((message) => message.role === "toolResult");
			assert.match(results[0].content[0].text, /still running/);
			assert.equal(results[1].content[0].text, "continued");
			assert.equal(results[2].isError, false);
			assert.equal(JSON.parse(results[2].content[0].text).commands[0].state, "cancelled");
			assert.equal(agent.state.errorMessage, undefined);
			await commands.shutdown();
			assert.deepEqual((await controlChildCommand(dir, "status", "service")).commands.map(({ toolCallId }) => toolCallId), ["service"]);
			await assert.rejects(controlChildCommand(dir, "status", "unknown"), /No retained command/);
		} finally { agent.abort(); await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

});

describe("command identities and bounded observation", () => {
	it("does not cancel a newer command when an old id is supplied, and preserves a custom backend", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-identity-"));
		const commands = createChildCommandRuntime(dir);
		let signal: AbortSignal | undefined;
		const custom: ToolDefinition = {
			name: "bash", label: "Custom shell", description: "Custom execution", parameters: Type.Object({ command: Type.String() }),
			async execute(_id, _params, inputSignal, update) {
				signal = inputSignal;
				update?.({ content: [{ type: "text", text: "x".repeat(16_384) }], details: undefined });
				await new Promise<void>((_resolve, reject) => { inputSignal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
				return { content: [], details: undefined };
			},
		};
		try {
			await commands.wrap(custom).execute("new", { command: "custom", yieldTimeMs: 0 }, undefined, undefined, ctx);
			await assert.rejects(controlChildCommand(dir, "cancel", "old"), /No retained command 'old'/);
			assert.equal(signal?.aborted, false);
			assert.equal(Buffer.byteLength(commands.state().commands[0].output), 8192);
			assert.equal(commands.operate("status", "new").commands[0].state, "yielded");
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("retains the native run abort signal after yielding", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-abort-"));
		const commands = createChildCommandRuntime(dir);
		const controller = new AbortController();
		try {
			await commands.wrap(createBashToolDefinition(dir)).execute("run-abort", { command: "sleep 10", yieldTimeMs: 0 }, controller.signal, undefined, ctx);
			controller.abort();
			await until(() => commands.state().commands[0].endedAt !== undefined);
			assert.equal(commands.state().commands[0].state, "failed", "run abort is distinct from command cancellation");
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});

	it("disables yielding when the command observation tool is not granted", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-ceiling-"));
		const commands = createChildCommandRuntime(dir, false);
		try {
			const bash = commands.wrap(createBashToolDefinition(dir));
			assert.equal(bash.parameters.properties.yieldTimeMs, undefined);
			await assert.rejects(bash.execute("not-granted", { command: "sleep 10", yieldTimeMs: 0 }, undefined, undefined, ctx), /requires subagent_command/);
		} finally { await commands.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
