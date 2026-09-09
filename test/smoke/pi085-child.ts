import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";

const state = globalThis.__pi085Smoke = { AgentSession, BACKGROUND_CONTEXT, createModels, started: 0, stopped: 0, faux: undefined };
// Exercise the runner's reachable watchdog graph, including its runtime TUI import.
await import(pathToFileURL(`${process.env.SMOKE_EXTENSION}/src/watchdog/tool-actions.ts`).href);
const { loadRunnerChildSessionFactory } = await import(pathToFileURL(`${process.env.SMOKE_EXTENSION}/src/runs/background/runner-child-sessions.ts`).href);
const factory = await loadRunnerChildSessionFactory({});
const errors = [];
let started = 0, stopped = 0;
try {
	const child = await factory.create({
		cwd: process.cwd(), storage: { kind: "memory" }, model: "pi085-smoke/local", tools: [],
		extensionPaths: [`${process.cwd()}/pi085-extension.ts`], ambientExtensions: false,
		noSkills: true, noContextFiles: true, runtime: {},
		hooks: [{ name: "lifecycle", factory(pi) {
			pi.on("session_start", () => { started++; });
			pi.on("session_shutdown", () => { stopped++; });
		} }], onExtensionError(error) { errors.push(error); },
	});
	try {
		assert.equal(child.modelId, "pi085-smoke/local");
		await child.prompt("Return the local scripted response.");
		assert.equal(state.faux.state.callCount, 1);
		assert.ok(child.messages.some(m => m.role === "assistant" && m.content.some(c => c.type === "text" && c.text === "local response verified")));
	} finally { await child.dispose(); }
	assert.deepEqual([started, stopped, state.started, state.stopped], [1, 1, 1, 1]);
	assert.deepEqual(errors, []);
	console.log("PASS public SDK/default child factory: local prompt, API identity, startup/shutdown");
	const { buildInProcessChildLaunch } = await import(pathToFileURL(`${process.env.SMOKE_EXTENSION}/src/runs/shared/child-launch.ts`).href);
	for (const tools of [
		["read", "subagent", "contact_supervisor", "subagent_supervisor"],
		["read", "subagent", "contact_supervisor"],
		["read", "contact_supervisor"],
	]) {
		const launch = buildInProcessChildLaunch({
			host: "runner", cwd: process.cwd(), childAgentName: "coordinator-smoke", childIndex: 0,
			sessionEnabled: false, model: "pi085-smoke/local", tools, hostAvailableBuiltins: ["read"],
			runId: `coordination-${tools.length}`, parentSessionId: "root-A", orchestratorIntercomTarget: "root-A",
			extensions: [`${process.cwd()}/pi085-extension.ts`],
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
		});
		let snapshot;
		launch.session.hooks.push({ name: "coordination-tools", factory(pi) {
			pi.on("session_start", () => { snapshot = { registered: pi.getAllTools().map(tool => tool.name), active: pi.getActiveTools() }; });
		} });
		const coordinated = await factory.create(launch.session);
		try {
			assert.deepEqual(new Set(snapshot.registered), new Set(tools));
			assert.deepEqual(new Set(snapshot.active), new Set(tools));
		} finally { await coordinated.dispose(); }
	}
	console.log("PASS native coordinator/leaf tools: real SDK registration and explicit allowlists");
} finally { await factory.dispose(); }
