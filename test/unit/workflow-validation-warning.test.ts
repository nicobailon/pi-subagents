import assert from "node:assert/strict";
import * as os from "node:os";
import { it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { makeMinimalCtx } from "../support/helpers.ts";

it("does not notify a dynamic launch count when a workflow launches", async () => {
	const executor = createSubagentExecutor({
		pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as never,
		state: createChildSafeState(),
		config: { maxSubagentDepth: 2, control: {}, intercomBridge: {} } as never,
		asyncByDefault: false,
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: () => os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [{ name: "worker" }] as never }),
	});
	const notices: Array<[string, string]> = [];
	const ctx = { ...makeMinimalCtx(os.tmpdir()), hasUI: true, ui: { notify: (message: string, level: string) => void notices.push([message, level]) } };
	const consoleWarnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => void consoleWarnings.push(args.map(String).join(" "));
	try {
		// The invalid acceptance level stops the call right after the warnings, before any child launches.
		await executor.execute("warn", {
			workflowScript: `const key = args.key;\nreturn await runs.run(key, { agent: "worker", task: "Reply OK." });`,
			args: { key: "a" },
			acceptance: "bogus",
		} as never, new AbortController().signal, undefined, ctx as never);
	} finally {
		console.warn = originalWarn;
	}
	assert.deepEqual(consoleWarnings.filter((line) => line.includes("dynamic child launches")), []);
	assert.deepEqual(notices.filter(([message]) => message.includes("dynamic child launches")), []);
});
