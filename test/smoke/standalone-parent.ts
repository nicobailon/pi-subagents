import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter, parseFrontmatterList } from "../../src/agents/frontmatter.ts";
import registerSubagents from "../../index.ts";
import { requestAsyncInterrupt, requestAsyncSteer, requestAsyncStop } from "../../src/runs/background/control-channel.ts";
import { verifyRevival } from "./standalone-revival.ts";
import { verifySharedRun } from "./standalone-shared.ts";

function waitForFile(file: string, predicate: (text: string) => boolean): Promise<void> {
	// These are test checkpoints, not synthesized completion notifications. Check
	// file state even when directory append events are coalesced; sendMessage is
	// still the independent completion boundary awaited below.
	return new Promise((resolve) => {
		const check = () => {
			if (fs.existsSync(file) && predicate(fs.readFileSync(file, "utf8"))) { fs.unwatchFile(file, check); resolve(); }
		};
		fs.watchFile(file, { interval: 25 }, check);
		check();
	});
}

// Register the real extension against the real host API. Capture its public tool
// and notification boundary only; never replace the runner/session factory.
export default function registerSmoke(pi: ExtensionAPI) {
	let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
	let notifications = 0;
	let notify: (message: unknown) => void = () => {};
	const notification = new Promise<unknown>((resolve) => { notify = resolve; });
	const host = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (definition: Parameters<ExtensionAPI["registerTool"]>[0]) => {
				target.registerTool(definition);
				if (definition.name === "subagent") tool = definition;
			};
			if (key === "sendMessage") return (...args: Parameters<ExtensionAPI["sendMessage"]>) => {
				// Persist normal completion delivery without requesting an unrelated parent model turn.
				target.sendMessage(args[0], { ...args[1], triggerTurn: false });
				if (args[0].customType === "subagent-notify") { notifications++; notify(args[0]); }
			};
			return Reflect.get(target, key);
		},
	});
	registerSubagents(host);
	pi.on("session_start", async (_event, ctx) => {
		const timeout = setTimeout(() => { console.error("Standalone smoke timed out waiting for parent completion"); process.exit(1); }, 45_000);
		try {
			assert.ok(tool, "the real extension must register its public subagent tool");
			const mode = process.env.PI_STANDALONE_SMOKE_MODE ?? "single";
			assert.ok(["single", "workflow", "targeted-controls", "steer", "interrupt", "stop", "child-stop", "child-timeout", "run-timeout", "tool-timeout", "sdk-init-failure", "persistence-failure", "authorization-failure", "missing-bootstrap", "revival", "shared-run", "parallel-stop"].includes(mode), `unimplemented parent smoke mode: ${mode}`);
			const expectedTools = mode === "tool-timeout" ? ["bash"] : [];
			const profile = parseFrontmatter(fs.readFileSync("/stage/work/.pi/agents/binary-smoke.md", "utf8"));
			assert.deepEqual(parseFrontmatterList(profile.frontmatter.tools), expectedTools, "fixture must use the upstream frontmatter syntax, not YAML flow lists");
			const workflow = ["workflow", "targeted-controls", "child-timeout"].includes(mode);
			const expectedState = mode === "interrupt" ? "paused" : mode === "stop" ? "stopped" : mode.endsWith("-timeout") || mode === "child-stop" || mode === "sdk-init-failure" ? "failed" : "complete";
			const request = mode === "workflow" ? {
				workflowScript: `const first = await runs.run("first", { agent: "binary-smoke", task: "Return FIRST." }); const siblings = await runs.all([{ key: "left", agent: "binary-smoke", task: "Return LEFT." }, { key: "right", agent: "binary-smoke", task: "Return RIGHT." }]); return { first, siblings };`,
			} : mode === "targeted-controls" ? {
				workflowScript: `const left = runs.run("left", { agent: "binary-smoke", task: "Return LEFT." }); const right = runs.run("right", { agent: "binary-smoke", task: "Return RIGHT." }); let interrupted; try { interrupted = await right; } catch (error) { interrupted = String(error); } return { left: await left, right: interrupted };`,
			} : mode === "child-timeout" ? {
				workflowScript: `return await runs.run("child-deadline", { agent: "binary-smoke", task: "Wait for cancellation.", timeoutMs: 8000 });`,
			} : { agent: "binary-smoke", task: "Return the scripted response." };
			fs.writeFileSync("/stage/parent-initialized", String(process.pid));
			if (mode === "shared-run" || mode === "parallel-stop") {
				await verifySharedRun(host, ctx, mode, waitForFile, notification);
				assert.equal(notifications, 1);
				console.log(`PASS standalone native async ${mode}: two SDK sessions, one host, observed shutdown`);
				process.exit(0);
			}
			const startupFailure = mode === "persistence-failure" || mode === "authorization-failure";
			if (startupFailure) assert.equal(JSON.parse(fs.readFileSync("/stage/startup-hook-ready.json", "utf8")).pid, process.pid);
			const launching = tool.execute("standalone-smoke", {
				...request, context: "fresh", async: true,
				model: "standalone-smoke/local", acceptance: false, timeoutMs: mode === "run-timeout" ? 8000 : 20000, output: false,
				...(mode === "tool-timeout" ? { toolTimeoutMs: 1000 } : {}),
			}, new AbortController().signal, undefined, ctx);
			if (mode === "missing-bootstrap") {
				assert.ok(fs.existsSync("/stage/withheld-binary-bootstrap.ts"), "asset omission must actually be applied");
				await assert.rejects(launching, /Background runner bootstrap not found/);
				console.log("PASS standalone native async missing-bootstrap: missing asset rejected at the public launch boundary");
				process.exit(0);
			}
			if (startupFailure) {
				// Registered tools reject logical failures; internal execution helpers return isError.
				// Assert the public boundary actually used here, not its internal representation.
				await assert.rejects(launching, (error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, new RegExp(`fixture ${mode} after real spawn`));
					fs.writeFileSync("/stage/launch-error.json", JSON.stringify({ message: error.message }));
					return true;
				});
				assert.ok(fs.existsSync("/stage/failure-injected.json"), "fault must reach the post-spawn persistence/authorization boundary");
				const injected = JSON.parse(fs.readFileSync("/stage/failure-injected.json", "utf8"));
				assert.equal(injected.mode, mode);
				const terminalPath = `${injected.asyncDir}/process-terminal.json`;
				await waitForFile(terminalPath, (text) => JSON.parse(text).instances?.some((instance: { kind: string; closeObservedAt?: number }) => instance.kind === "runner" && typeof instance.closeObservedAt === "number"));
				assert.throws(() => process.kill(injected.pid, 0), { code: "ESRCH" });
				const status = JSON.parse(fs.readFileSync(`${injected.asyncDir}/status.json`, "utf8"));
				assert.equal(status.state, "failed");
				assert.equal(fs.existsSync(`${injected.asyncDir}/runner-startup-proceed.json`), false);
				const events = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
				assert.ok(events.every((event) => event.pid === process.pid), "same real task as the positive control must never enter a child session");
				fs.writeFileSync("/stage/startup-failure.json", JSON.stringify({ ...injected, mode, terminal: JSON.parse(fs.readFileSync(terminalPath, "utf8")) }, null, 2));
				console.log(`PASS standalone native async ${mode}: post-spawn fault observed, no proceed, no child work, runner close observed`);
				process.exit(0);
			}
			const launch = await launching;
			fs.writeFileSync("/stage/launch.json", JSON.stringify(launch, null, 2));
			assert.notEqual(launch.isError, true, JSON.stringify(launch));
			const details = launch.details as { asyncDir: string; asyncId: string };
			if (["steer", "interrupt", "stop", "child-stop"].includes(mode)) {
				await waitForFile("/stage/lifecycle.jsonl", (text) => text.includes('"event":"request"'));
				if (mode === "interrupt") requestAsyncInterrupt(details.asyncDir);
				if (mode === "stop") requestAsyncStop(details.asyncDir);
				if (mode === "child-stop") requestAsyncStop(details.asyncDir, { targetIndex: 0, childId: "step:0" });
				if (mode === "steer") {
					requestAsyncSteer(details.asyncDir, { id: "binary-steer", targetIndex: 0, message: "UNIQUE_STEERING_MARKER" });
					await waitForFile(`${details.asyncDir}/events.jsonl`, (text) => text.includes('"type":"subagent.steer.delivered"'));
					fs.writeFileSync("/stage/release", "go");
				}
			}
			if (mode === "targeted-controls") {
				await waitForFile("/stage/lifecycle.jsonl", (text) => text.split("\n").filter((line) => line.includes('"event":"request"')).length === 2);
				const active = JSON.parse(fs.readFileSync(`${details.asyncDir}/status.json`, "utf8"));
				const [left, right] = active.steps.map((step: { runId: string }) => path.join(path.dirname(details.asyncDir), step.runId));
				requestAsyncSteer(left, { id: "binary-steer", targetIndex: 0, message: "UNIQUE_STEERING_MARKER" });
				await waitForFile(`${left}/events.jsonl`, (text) => text.includes('"type":"subagent.steer.delivered"'));
				requestAsyncInterrupt(right);
				await waitForFile(`${right}/status.json`, (text) => JSON.parse(text).state === "paused");
				assert.equal(JSON.parse(fs.readFileSync(`${left}/status.json`, "utf8")).state, "running", "interrupting right must leave left running");
				fs.writeFileSync("/stage/release", "go");
			}
			if (mode === "tool-timeout") await waitForFile("/stage/tool.pid", (text) => /^\d+\s*$/.test(text));
			const completed = await notification;
			fs.writeFileSync("/stage/notification.json", JSON.stringify(completed, null, 2));
			if (expectedState === "complete") assert.match(JSON.stringify(completed), /standalone child response verified/);
			const lifecycle = fs.readFileSync("/stage/lifecycle.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const parentStatus = JSON.parse(fs.readFileSync(`${details.asyncDir}/status.json`, "utf8"));
			const runIds: string[] = workflow ? parentStatus.steps.map((step: { runId: string }) => step.runId) : [details.asyncId];
			assert.equal(new Set(runIds).size, mode === "workflow" ? 3 : mode === "targeted-controls" ? 2 : 1, "workflow children retain independent run identities");
			for (const runId of runIds) {
				const runDir = path.join(path.dirname(details.asyncDir), runId);
				const status = JSON.parse(fs.readFileSync(`${runDir}/status.json`, "utf8"));
				const runState = mode === "targeted-controls" && runIds.indexOf(runId) === 1 ? "paused" : expectedState;
				const steered = mode === "steer" || (mode === "targeted-controls" && runIds.indexOf(runId) === 0);
				assert.equal(status.state, runState, JSON.stringify(status));
				if (mode === "stop" || mode === "child-stop") assert.equal(status.steps[0].status, "stopped");
				assert.equal(status.sessionId, ctx.sessionManager.getSessionId());
				assert.equal(status.completionOwnerId, parentStatus.completionOwnerId);
				assert.equal(status.steps[0].model, "standalone-smoke/local");
				const descriptor = JSON.parse(fs.readFileSync(`${runDir}/recovery-descriptor.json`, "utf8"));
				assert.deepEqual(descriptor.tools, expectedTools, "actual launch must preserve the parsed tool selection");
				const observed = fs.readFileSync("/stage/bootstrap-observer.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.pid === status.pid);
				assert.deepEqual(observed.map((event) => event.event), mode === "sdk-init-failure" ? ["observer-ready"] : ["observer-ready", "session-start"]);
				if (mode === "sdk-init-failure") {
					assert.equal(JSON.parse(fs.readFileSync("/stage/provider-failure.json", "utf8")).pid, status.pid);
					assert.match(status.error, /Model "standalone-smoke\/local" not found/);
				} else {
				const starts = lifecycle.filter((entry) => entry.event === "start" && entry.pid === status.pid);
				assert.equal(starts.length, 1, "the outer bootstrap must not start an extra provider session");
				assert.deepEqual(starts[0].tools, expectedTools, "the child must retain its explicit tool policy");
				assert.equal(starts[0].provider, "standalone-smoke");
				assert.equal(starts[0].model, "local");
				if (runState === "complete") {
					assert.ok(fs.existsSync(status.steps[0].sessionFile), "completed SDK session artifact must be retained");
					const output = fs.readFileSync(status.steps[0].transcriptPath, "utf8");
					assert.match(output, /standalone child response verified/);
					if (mode === "workflow") assert.ok(output.includes(["FIRST", "LEFT", "RIGHT"][runIds.indexOf(runId)]));
				}
				if (mode.endsWith("-timeout")) {
					assert.equal(status.steps[0].timedOut, true);
					assert.match(status.steps[0].error, mode === "tool-timeout" ? /Tool 'bash' exceeded its timeout of 1000ms/ : /timed out after 8000ms/);
				}
				if (steered) {
					const followup = lifecycle.find((entry) => entry.event === "followup" && entry.pid === status.pid);
					assert.ok(followup && JSON.stringify(followup.messages).includes("UNIQUE_STEERING_MARKER"), "steering must reach the real SDK model context");
				}
				const child = lifecycle.find((entry) => entry.event === "shutdown" && entry.pid === status.pid && entry.calls === (steered ? 2 : 1));
				assert.ok(child, "each real run must prompt and shut down its child session");
				}
				const terminalPath = `${runDir}/process-terminal.json`;
				const atNotification = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
				fs.appendFileSync("/stage/notification-terminal.jsonl", JSON.stringify({ runId, state: atNotification.state }) + "\n");
				// Paused/failed result delivery may precede SDK disposal and process close.
				// Keep that pending evidence truthful; await the close observer, not a poll or sandbox teardown.
				if (atNotification.state !== "observed") await waitForFile(terminalPath, (text) => JSON.parse(text).state === "observed");
				const terminal = JSON.parse(fs.readFileSync(terminalPath, "utf8"));
				assert.equal(terminal.state, "observed", "completion must include actual exit observation, not only a result");
				assert.equal(terminal.runId, runId);
				assert.ok(terminal.instances.some((instance: { kind: string; exitCode: number }) => instance.kind === "runner" && instance.exitCode === 0));
				assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" }, "each runner must exit before sandbox teardown");
			}
			if (mode === "tool-timeout") {
				const toolPid = Number(fs.readFileSync("/stage/tool.pid", "utf8"));
				assert.throws(() => process.kill(toolPid, 0), { code: "ESRCH" }, "the timed-out tool must also exit before sandbox teardown");
			}
			assert.equal(notifications, 1, "one logical parent completion, not an extra bootstrap completion");
			if (mode === "revival") {
				const deliveries: Record<string, number> = {};
				await verifyRevival(tool, ctx, details, waitForFile, (text) => new Promise<void>((resolve) => {
					deliveries[text] = 0;
					notify = (message) => {
						if (JSON.stringify(message).includes(text)) {
							deliveries[text]++;
							fs.appendFileSync("/stage/revival-notifications.jsonl", JSON.stringify(message) + "\n");
							resolve();
						}
					};
				}));
				assert.deepEqual(Object.values(deliveries), [1, 1], "each accepted revival has one normal completion");
			}
			console.log(`PASS standalone native async ${mode}: ${runIds.length} run(s), checked SDK lifecycle, observed exits, parent notification`);
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		} finally {
			clearTimeout(timeout);
		}
	});
}
