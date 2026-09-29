import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerOrchestrationMode } from "../../src/extension/orchestration-mode.ts";

type Handler = (...args: any[]) => any;

function makeHarness() {
	const userAgentNames = ["worker", "reviewer", "scout", "experiment-spot-cpu", "experiment-spot-gpu"];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const branch: Array<{ type: string; customType: string; data: unknown }> = [];
	const notifications: string[] = [];
	const allTools = [
		"read", "bash", "edit", "write", "grep", "find", "ls", "watchdog_diff",
		"subagent", "subagent_supervisor", "contact_supervisor", "bg_wait",
		"question", "todo", "todo_read", "todo_write",
	];
	let activeTools = [...allTools];
	let flag = false;
	const pi = {
		getAllTools: () => allTools.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		appendEntry: (customType: string, data: unknown) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
		registerFlag: () => {},
		getFlag: (name: string) => name === "orchestrate" ? flag : undefined,
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec),
		on: (name: string, handler: Handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	const ctx = {
		cwd: process.cwd(),
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getBranch: () => branch },
	};
	registerOrchestrationMode(pi as never, { discoverUserAgentNames: () => [...userAgentNames] });
	return {
		pi,
		ctx,
		commands,
		handlers,
		entries,
		branch,
		notifications,
		allTools,
		get activeTools() { return activeTools; },
		setFlag(value: boolean) { flag = value; },
	};
}

async function emit(harness: ReturnType<typeof makeHarness>, event: string, payload: unknown): Promise<any[]> {
	const results: any[] = [];
	for (const handler of harness.handlers.get(event) ?? []) results.push(await handler(payload, harness.ctx));
	return results;
}

describe("orchestration mode", () => {
	it("leaves normal Pi sessions unrestricted until explicitly enabled", async () => {
		const h = makeHarness();
		assert.deepEqual(h.activeTools, h.allTools);
		const before = await emit(h, "before_agent_start", { systemPrompt: "base" });
		assert.deepEqual(before, [undefined]);
		const tool = await emit(h, "tool_call", { toolName: "bash", input: { command: "pwd" } });
		assert.deepEqual(tool, [undefined]);
	});

	it("narrows the current session, blocks execution escapes, and restores normal tools", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);

		assert.ok(h.activeTools.includes("subagent"));
		assert.ok(h.activeTools.includes("read"));
		assert.ok(h.activeTools.includes("bg_wait"));
		assert.ok(h.activeTools.includes("watchdog_diff"));
		for (const leaf of ["bash", "edit", "write"]) assert.equal(h.activeTools.includes(leaf), false, leaf);

		const prompt = (await emit(h, "before_agent_start", { systemPrompt: "base" }))[0];
		assert.match(prompt.systemPrompt, /<orchestration_mode>/);
		assert.match(prompt.systemPrompt, /what material evidence is still missing/i);
		assert.match(prompt.systemPrompt, /do not delegate merely because a semantic role exists/i);
		assert.match(prompt.systemPrompt, /do not treat a launch or dispatch receipt as completion/i);
		assert.match(prompt.systemPrompt, /worker remains the sole implementation writer/i);
		assert.match(prompt.systemPrompt, /resume the most recent writer by default/i);
		assert.match(prompt.systemPrompt, /do not add review ceremony solely because a mutation occurred/i);
		assert.match(prompt.systemPrompt, /re-establish affected evidence after repair/i);
		assert.match(prompt.systemPrompt, /semantic mechanism, contract, evidence generator, validation boundary, or population\/coverage assumption/i);
		assert.match(prompt.systemPrompt, /mechanical rerun alone is insufficient/i);

		const guideInput: Record<string, unknown> = { action: "guide", topic: "workflows" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: guideInput }))[0], undefined);
		assert.equal(guideInput.topic, "orchestration");

		const directInput: Record<string, unknown> = { agent: "worker", task: "Implement the bounded fix" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: directInput }))[0], undefined);
		assert.equal(directInput.agentScope, "user");
		assert.deepEqual((directInput.capabilityCeiling as { allowedAgents?: string[] }).allowedAgents, ["experiment-spot-cpu", "experiment-spot-gpu", "reviewer", "scout", "worker"]);

		for (const input of [
			{ agent: "worker", task: "x", model: "other/model" },
			{ workflowScript: "return runs.run('x', {agent:'worker'})" },
			{ workflowScriptPath: "/tmp/workflow.js" },
			{ agent: "reviewer", task: "x", gate: "echo unsafe" },
			{ agent: "reviewer", task: "x", acceptance: { verify: [{ command: "echo unsafe" }] } },
			{ agent: "worker", task: "x", share: true },
			{ agent: "worker", task: "x", sessionDir: "/tmp/escape" },
			{ agent: "reviewer", task: "x", output: "/tmp/escape" },
			{ agent: "reviewer", task: "x", outputMode: "file-only" },
		]) {
			const result = (await emit(h, "tool_call", { toolName: "subagent", input }))[0];
			assert.equal(result?.block, true, JSON.stringify(input));
		}

		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: { action: "status" } }))[0], undefined);

		for (const input of [
			{ action: "resume", id: "run-1", message: "continue", chain: [{ agent: "worker", task: "escape" }] },
			{ action: "resume", id: "run-1", message: "continue", acceptance: { verify: [{ command: "echo unsafe" }] } },
			{ action: "steer", id: "run-1", message: "continue", workflow: "escape" },
		]) {
			const result = (await emit(h, "tool_call", { toolName: "subagent", input }))[0];
			assert.equal(result?.block, true, JSON.stringify(input));
		}

		const steerInput: Record<string, unknown> = { action: "steer", id: "run-1", message: "focus" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: steerInput }))[0], undefined);
		assert.equal(steerInput.agentScope, "user");
		assert.equal(steerInput.steeringRecovery, false);

		const runtimeRole = (await emit(h, "tool_call", { toolName: "subagent", input: { agent: "runtime-writer", task: "escape" } }))[0];
		assert.equal(runtimeRole?.block, true);

		await h.commands.get("orchestrate")!.handler("off", h.ctx);
		assert.deepEqual(h.activeTools, h.allTools);
		assert.ok(h.entries.some((entry) => (entry.data as { enabled?: boolean }).enabled === true));
		assert.ok(h.entries.some((entry) => (entry.data as { enabled?: boolean }).enabled === false));
	});

	it("restores orchestration mode when a persisted session is resumed", async () => {
		const h = makeHarness();
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: true, normalTools: h.allTools } });
		await emit(h, "session_start", { reason: "resume" });
		assert.ok(h.activeTools.includes("subagent"));
		assert.equal(h.activeTools.includes("bash"), false);
		await h.commands.get("orchestrate")!.handler("off", h.ctx);
		assert.deepEqual(h.activeTools, h.allTools);
	});

	it("supports the --orchestrate startup flag", async () => {
		const h = makeHarness();
		h.setFlag(true);
		await emit(h, "session_start", { reason: "startup" });
		assert.equal(h.activeTools.includes("bash"), false);
		assert.ok(h.notifications.some((message) => /orchestration mode ON/.test(message)));
	});
});
