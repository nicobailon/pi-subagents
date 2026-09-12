import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagents from "../../index.ts";
import { requestAsyncStop } from "../../src/runs/background/control-channel.ts";
import { getActiveAsyncCapacitySnapshot } from "../../src/runs/background/active-async-capacity.ts";

async function waitJson(file: string, predicate: (value: any) => boolean): Promise<any> {
	return new Promise((resolve) => {
		const check = () => {
			try { const value = JSON.parse(fs.readFileSync(file, "utf8")); if (predicate(value)) { fs.unwatchFile(file, check); resolve(value); } } catch {}
		};
		fs.watchFile(file, { interval: 50 }, check); check();
	});
}

export default function localInferenceRegression(pi: ExtensionAPI) {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	const host = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				target.registerTool(definition); if (definition.name === "subagent") tool = definition;
			};
			if (key === "sendMessage") return (...args: Parameters<ExtensionAPI["sendMessage"]>) => target.sendMessage(args[0], { ...args[1], triggerTurn: false });
			return Reflect.get(target, key);
		},
	});
	registerSubagents(host);
	pi.on("session_start", async (_event, ctx) => {
		const root = process.env.PI_LOCAL_AI_TEST_ROOT!;
		try {
			assert.ok(tool);
			const invoke = (input: unknown) => tool!.execute("local-ai-regression", input as never, new AbortController().signal, undefined, ctx);
			const launch = await invoke({
				workflowScript: `return await runs.all([
					{ key: "headers", agent: "local-fixture", task: "TEST_HEADERS", timeoutMs: 1, output: false, acceptance: false },
					{ key: "body", agent: "local-fixture", task: "TEST_BODY", timeoutMs: 1, output: false, acceptance: false }
				]);`, async: true, timeoutMs: 1, model: "local-fixture/local-test:xhigh", context: "fresh", output: false, acceptance: false,
			});
			fs.writeFileSync(path.join(root, "launch.json"), JSON.stringify(launch, null, 2));
			assert.notEqual(launch.isError, true, JSON.stringify(launch));
			const details = launch.details as { asyncDir: string; asyncId: string };
			assert.ok(details.asyncDir, JSON.stringify(launch));
			const status = await waitJson(path.join(details.asyncDir, "status.json"), (s) => !["queued", "running"].includes(s.state));
			assert.equal(status.state, "complete", JSON.stringify(status));
			for (const step of status.steps) {
				const dir = path.join(path.dirname(details.asyncDir), step.runId);
				await waitJson(path.join(dir, "process-terminal.json"), (s) => s.state === "observed");
				const child = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
				assert.equal(child.state, "complete", JSON.stringify(child));
				assert.equal(child.timeoutMs, undefined);
				assert.equal(child.deadlineAt, undefined);
				assert.ok(child.totalTokens.output > 0);
				assert.match(fs.readFileSync(child.sessionFile, "utf8"), /pi-subagents:local-inference-policy/);
			}
			assert.equal(getActiveAsyncCapacitySnapshot(status.sessionId, 1).used, 0, "completed workflow must release capacity");
			console.log("PASS local-AI detached workflow: delayed headers/body, short agent deadlines ignored, capacity released");

			const foreground = await invoke({ agent: "local-fixture", task: "TEST_QUICK", async: false, timeoutMs: 1, context: "fresh", output: false, acceptance: false });
			assert.notEqual(foreground.isError, true, JSON.stringify(foreground));
			assert.match(JSON.stringify(foreground), /FIXTURE_OK/);
			console.log("PASS local-AI foreground: short deadline ignored");

			const cancel = await invoke({ agent: "local-fixture", task: "TEST_CANCEL", async: true, timeoutMs: 1, context: "fresh", output: false, acceptance: false });
			assert.notEqual(cancel.isError, true, JSON.stringify(cancel));
			const cancelDetails = cancel.details as { asyncDir: string };
			await waitJson(path.join(root, "cancel-received.json"), () => true);
			requestAsyncStop(cancelDetails.asyncDir);
			const cancelled = await waitJson(path.join(cancelDetails.asyncDir, "status.json"), (s) => !["queued", "running"].includes(s.state));
			assert.equal(cancelled.state, "stopped", JSON.stringify(cancelled));
			await waitJson(path.join(cancelDetails.asyncDir, "process-terminal.json"), (s) => s.state === "observed");
			assert.equal(getActiveAsyncCapacitySnapshot(cancelled.sessionId, 1).used, 0, "operator stop must release capacity");
			await waitJson(path.join(root, "cancel-closed.json"), () => true);
			console.log("PASS local-AI operator stop: HTTP disconnected, runner exited, capacity released");
			fs.writeFileSync(path.join(root, "passed.json"), JSON.stringify({ workflow: details.asyncId, policy: "unbounded", cancelled: true, capacityReleased: true }));
			process.exit(0);
		} catch (error) { console.error(error); process.exit(1); }
	});
}
