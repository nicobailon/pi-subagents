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
	const handle = registerOrchestrationMode(pi as never, { discoverUserAgentNames: () => [...userAgentNames] });
	return {
		pi,
		ctx,
		handle,
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
		assert.match(prompt.systemPrompt, /compile the user's prose contract into the existing Pi primitives/i);
		assert.match(prompt.systemPrompt, /reuse the same mission across continuation\/review runs/i);

		const guideInput: Record<string, unknown> = { action: "guide", topic: "workflows" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: guideInput }))[0], undefined);
		assert.equal(guideInput.topic, "orchestration");

		const directInput: Record<string, unknown> = { agent: "worker", task: "Implement the bounded fix" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: directInput }))[0], undefined);
		assert.equal(directInput.agentScope, "user");
		assert.deepEqual((directInput.capabilityCeiling as { allowedAgents?: string[] }).allowedAgents, ["experiment-spot-cpu", "experiment-spot-gpu", "reviewer", "scout", "worker"]);

		for (const input of [
			{ agent: "worker", task: "x", skill: "stationer-sqlmesh-operations", acceptance: { level: "checked", criteria: ["Return exact validation evidence"], evidence: ["commands-run", "residual-risks"], stopRules: ["Stop on an unapproved product decision"] } },
			{ agent: "worker", task: "x", mission: { title: "Ship bounded fix", objective: "Implement and review the bounded fix" } },
			{ agent: "reviewer", task: "x", missionId: "mission-1", output: "reviews/final.md", outputMode: "file-only" },
		]) {
			assert.equal((await emit(h, "tool_call", { toolName: "subagent", input }))[0], undefined, JSON.stringify(input));
		}

		for (const input of [
			{ agent: "worker", task: "x", model: "other/model" },
			{ workflowScript: "return runs.run('x', {agent:'worker'})" },
			{ workflowScriptPath: "/tmp/workflow.js" },
			{ agent: "reviewer", task: "x", gate: "echo unsafe" },
			{ agent: "reviewer", task: "x", acceptance: { verify: [{ command: "echo unsafe" }] } },
			{ agent: "worker", task: "x", share: true },
			{ agent: "worker", task: "x", sessionDir: "/tmp/escape" },
			{ agent: "reviewer", task: "x", output: "/tmp/escape.md", outputMode: "file-only" },
			{ agent: "reviewer", task: "x", output: "../escape.md", outputMode: "file-only" },
			{ agent: "reviewer", task: "x", output: true },
		]) {
			const result = (await emit(h, "tool_call", { toolName: "subagent", input }))[0];
			assert.equal(result?.block, true, JSON.stringify(input));
		}

		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: { action: "status" } }))[0], undefined);
		for (const input of [
			{ action: "mission.list", missionScope: "project" },
			{ action: "mission.show", missionId: "mission-1" },
			{ action: "mission.update", missionId: "mission-1", missionUpdate: { summary: "Review complete" } },
			{ action: "mission.resolve-decision", missionId: "mission-1", id: "decision-1", summary: "Use the existing owner" },
			{ action: "mission.close", missionId: "mission-1", missionStatus: "completed", summary: "Accepted evidence closed" },
		]) {
			assert.equal((await emit(h, "tool_call", { toolName: "subagent", input }))[0], undefined, JSON.stringify(input));
		}

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
		assert.deepEqual((steerInput.capabilityCeiling as { allowedAgents?: string[] }).allowedAgents, ["experiment-spot-cpu", "experiment-spot-gpu", "reviewer", "scout", "worker"]);

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

	it("applies the same policy to slash-shaped workflow requests, clones inputs, and stays idempotent", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);

		// The shared policy boundary used by executeSubagentReady must reject the
		// workflowScript that slash commands (/run, prompt workflows) generate.
		for (const input of [
			{ workflowScript: "return runs.run('run', {agent:'worker'})" },
			{ workflowScriptPath: "/tmp/workflow.js" },
			{ agent: "runtime-writer", task: "escape" },
			{ agent: "worker", task: "x", model: "other/model" },
		]) {
			assert.equal(h.handle.applyPolicy({ ...input }).block?.block, true, JSON.stringify(input));
		}

		// A direct launch that the model hook already normalized must pass the
		// second (execute-time) application unchanged, including the policy fields.
		const direct: Record<string, unknown> = { agent: "worker", task: "Implement the bounded fix" };
		const first = h.handle.applyPolicy(direct);
		assert.equal(first.block, undefined);
		assert.equal(first.params.agentScope, "user");
		assert.deepEqual((first.params.capabilityCeiling as { allowedAgents?: string[] }).allowedAgents, ["experiment-spot-cpu", "experiment-spot-gpu", "reviewer", "scout", "worker"]);
		const second = h.handle.applyPolicy(first.params);
		assert.equal(second.block, undefined);
		assert.equal(second.params.agentScope, "user");

		// Resume/steer normalization is idempotent too.
		const resume: Record<string, unknown> = { action: "resume", id: "run-1", message: "continue" };
		const resumeFirst = h.handle.applyPolicy(resume);
		assert.equal(resumeFirst.block, undefined);
		assert.equal(resumeFirst.params.agentScope, "user");
		const resumeSecond = h.handle.applyPolicy(resumeFirst.params);
		assert.equal(resumeSecond.block, undefined);
		assert.equal(resumeSecond.params.agentScope, "user");
	});

	it("never mutates caller-owned or frozen request objects", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);

		const direct = Object.freeze({ agent: "worker", task: "Implement the bounded fix" });
		const result = h.handle.applyPolicy(direct as unknown as Record<string, unknown>);
		assert.equal(result.block, undefined);
		assert.notEqual(result.params, direct);
		assert.equal(result.params.agentScope, "user");
		assert.deepEqual((result.params.capabilityCeiling as { allowedAgents?: string[] }).allowedAgents, ["experiment-spot-cpu", "experiment-spot-gpu", "reviewer", "scout", "worker"]);
		assert.equal("agentScope" in direct, false);
		assert.equal("capabilityCeiling" in direct, false);

		const frozenGuide = Object.freeze({ action: "guide", topic: "workflows" });
		const guide = h.handle.applyPolicy(frozenGuide as unknown as Record<string, unknown>);
		assert.equal(guide.block, undefined);
		assert.equal(guide.params.topic, "orchestration");
		assert.equal((frozenGuide as { topic?: unknown }).topic, "workflows");

		const frozenResume = Object.freeze({ action: "resume", id: "run-1", message: "continue" });
		const resumed = h.handle.applyPolicy(frozenResume as unknown as Record<string, unknown>);
		assert.equal(resumed.block, undefined);
		assert.equal(resumed.params.agentScope, "user");
		assert.equal("capabilityCeiling" in frozenResume, false);

		// The early tool_call hook must tolerate a frozen event.input without throwing.
		const frozenInput = Object.freeze({ action: "guide", topic: "workflows" });
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: frozenInput }))[0], undefined);
		assert.equal((frozenInput as { topic?: unknown }).topic, "workflows");
	});

	it("returns the caller's object unchanged while orchestration is inactive", () => {
		const h = makeHarness();
		const request = { agent: "worker", task: "unchanged" };
		const result = h.handle.applyPolicy(request);
		assert.equal(result.block, undefined);
		assert.equal(result.params, request);
	});

	it("allows read-only children.list and rejects inherited action names without throwing", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);

		const listInput: Record<string, unknown> = { action: "children.list" };
		assert.equal((await emit(h, "tool_call", { toolName: "subagent", input: listInput }))[0], undefined);
		assert.equal(h.handle.applyPolicy({ action: "children.list" }).block, undefined);
		assert.equal(h.handle.applyPolicy({ action: "children.list", id: "run-1" }).block?.block, true);

		// Inherited object keys must fail closed as unknown actions, not throw when
		// the lookup reaches a prototype value instead of a field set.
		for (const action of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			const result = h.handle.applyPolicy({ action });
			assert.equal(result.block?.block, true, action);
			assert.match(result.block?.reason ?? "", /is not allowed/, action);
		}
	});

	it("restores each persisted orchestration branch's own normal tools on branch switch", async () => {
		const h = makeHarness();
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: true, normalTools: ["read", "bash"] } });
		await emit(h, "session_start", { reason: "resume" });
		assert.equal(h.activeTools.includes("bash"), false);

		// enabled -> enabled switch via session_tree to a branch with its own tools.
		h.branch.length = 0;
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: true, normalTools: ["read", "edit", "write"] } });
		await emit(h, "session_tree", { newLeafId: "leaf-b", oldLeafId: "leaf-a" });
		assert.ok(h.activeTools.includes("subagent"));

		// enabled -> enabled switch via session_start to yet another branch.
		h.branch.length = 0;
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: true, normalTools: ["read", "grep", "find"] } });
		await emit(h, "session_start", { reason: "resume" });
		assert.ok(h.activeTools.includes("subagent"));

		await h.commands.get("orchestrate")!.handler("off", h.ctx);
		assert.ok(h.activeTools.includes("grep"), "adopts the target branch's normal tools");
		assert.ok(h.activeTools.includes("find"));
		assert.equal(h.activeTools.includes("bash"), false, "does not carry the first branch's normal tools");
		assert.equal(h.activeTools.includes("edit"), false, "does not carry the second branch's normal tools");
	});

	it("persists the restored tool set when orchestration is turned off and restores a disabled branch's set", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);
		await h.commands.get("orchestrate")!.handler("off", h.ctx);
		const disabled = [...h.entries].reverse().find((entry) => (entry.data as { enabled?: boolean }).enabled === false);
		assert.ok(disabled, "turning orchestration off must persist a disabled entry");
		assert.deepEqual((disabled!.data as { normalTools?: string[] }).normalTools, h.allTools);

		// enabled -> disabled switch adopts the target branch's own pre-orchestration set.
		h.branch.length = 0;
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: false, normalTools: ["read", "edit", "write"] } });
		await emit(h, "session_tree", { newLeafId: "leaf-b", oldLeafId: "leaf-a" });
		assert.equal(h.handle.isEnabled(), false);
		assert.deepEqual(h.activeTools, ["read", "edit", "write"]);
	});

	it("restores a disabled branch's tool set and re-enables from an enabled branch switch", async () => {
		const h = makeHarness();
		// disabled -> disabled: adopt the target disabled branch's set.
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: false, normalTools: ["read", "bash"] } });
		await emit(h, "session_start", { reason: "resume" });
		assert.equal(h.handle.isEnabled(), false);
		assert.deepEqual(h.activeTools, ["read", "bash"]);

		// disabled -> enabled: enter orchestration and remember the target branch's set.
		h.branch.length = 0;
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: true, normalTools: ["read", "grep", "find"] } });
		await emit(h, "session_tree", { newLeafId: "leaf-d", oldLeafId: "leaf-c" });
		assert.equal(h.handle.isEnabled(), true);
		assert.ok(h.activeTools.includes("subagent"));
		assert.equal(h.activeTools.includes("bash"), false);
		await h.commands.get("orchestrate")!.handler("off", h.ctx);
		assert.deepEqual(h.activeTools, ["read", "grep", "find"]);
	});

	it("keeps the previous live tool set for old disabled entries without normalTools", async () => {
		const h = makeHarness();
		await h.commands.get("orchestrate")!.handler("on", h.ctx);
		h.branch.length = 0;
		h.branch.push({ type: "custom", customType: "pi-subagents-orchestration-mode", data: { enabled: false } });
		await emit(h, "session_tree", { newLeafId: "leaf-f", oldLeafId: "leaf-e" });
		assert.equal(h.handle.isEnabled(), false);
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
