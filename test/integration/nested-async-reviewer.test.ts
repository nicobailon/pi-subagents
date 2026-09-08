import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createDefaultChildSessionFactory, setChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { DIRS, TEMP_ROOT_DIR } from "../../src/shared/types.ts";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { nestedRunScope } from "../../src/runs/shared/nested-events.ts";
import { makeAgent } from "../support/helpers.ts";

const skip = !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT ? "Opt in with native-peer-loader.mjs and PI_SUBAGENTS_NATIVE_PI_ROOT" : false;

async function until(predicate: () => boolean, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "native fixture condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function ownedRuns(root: string) {
	const scopes = [DIRS.async];
	const nested = path.join(TEMP_ROOT_DIR, "nested-subagent-runs");
	if (fs.existsSync(nested)) for (const id of fs.readdirSync(nested)) scopes.push(nestedRunScope(id).asyncDirRoot);
	return scopes.flatMap((asyncDirRoot) => listAsyncRuns(asyncDirRoot, { includeNested: false, reconcile: false }))
		.filter((run) => run.sessionId?.startsWith(`${root}${path.sep}`));
}

for (const scenario of ["normal", "direct-stop", "direct-interrupt", "workflow-stop", "workflow-interrupt", "direct-timeout", "direct-failure", "direct-unresponsive-stop"]) {
	it(`native nested reviewer lifecycle: ${scenario}`, { skip, timeout: 60000 }, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-reviewer-"));
		const agentDir = path.join(root, "agent");
		const savedEnv = { ...process.env };
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
		process.env.PI_SUBAGENTS_NATIVE_SCENARIO = scenario;
		process.env.PI_SUBAGENTS_NATIVE_AUDIT = path.join(root, "audit.jsonl");
		const auditPath = process.env.PI_SUBAGENTS_NATIVE_AUDIT;
		const extension = fileURLToPath(new URL("../fixtures/native-nested-provider.ts", import.meta.url));
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		for (const name of ["arm-a", "arm-b", "persona"]) fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), [
			"---", `name: ${name}`, "description: Deterministic native smoke", `model: nested-fixture/${name}`,
			`tools: ${name === "persona" ? "read" : "subagent, bg_wait"}`, `extensions: ${extension}`,
			"inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "---", "Complete only the fixture task.",
		].join("\n"));
		const factory = createDefaultChildSessionFactory();
		setChildSessionFactory(factory);
		try {
			const controller = new AbortController();
			const reviewer = makeAgent("reviewer", { model: "nested-fixture/reviewer", tools: ["subagent", "bg_wait"], extensions: [extension], inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false });
			const running = runSync(root, [reviewer], "reviewer", "Review with two model arms and persona children", {
				runId: "native-root-reviewer", sessionDir: path.join(root, "sessions"), share: true, maxSubagentDepth: 4,
				timeoutMs: scenario.endsWith("timeout") ? 2500 : 45000, waitToolDefaultTimeoutMs: 30000, childSessionFactory: factory,
				...(scenario.endsWith("interrupt") ? { interruptSignal: controller.signal } : { signal: controller.signal }),
			});
			let cancellationStarted: number | undefined;
			if (scenario !== "normal" && !scenario.endsWith("timeout") && !scenario.endsWith("failure")) {
				await until(() => fs.existsSync(auditPath) && fs.readFileSync(auditPath, "utf8").split("\n").filter((line) => line.includes('"phase":"request","model":"persona"')).length >= (scenario.startsWith("workflow") ? 2 : 1));
				cancellationStarted = Date.now();
				controller.abort();
			}
			const result = await running;
			if (scenario === "direct-unresponsive-stop") assert.ok(Date.now() - cancellationStarted! < 7000, "unresponsive descendant cannot turn teardown into a 30-minute wait");
			if (scenario === "normal") {
				assert.equal(result.exitCode, 0, result.error);
				assert.equal(result.finalOutput, "RECONCILED_reviewer: PERSONA_EVIDENCE");
				const audit = fs.readFileSync(auditPath, "utf8");
				for (const name of ["reviewer", "arm-a", "arm-b"]) {
					assert.ok(audit.includes(`PREMATURE_${name}`), `${name} attempted an early final`);
					assert.ok(audit.includes(`RECONCILED_${name}`), `${name} consumed descendant evidence`);
				}
				assert.equal(audit.split("\n").filter((line) => line.includes('"phase":"response","model":"persona"')).length, 2);
			} else if (scenario.endsWith("failure")) {
				assert.equal(result.exitCode, 1);
				assert.match(result.error ?? "", /failed|PERSONA_FAILURE_EVIDENCE/);
			} else if (scenario.endsWith("interrupt")) assert.equal(result.interrupted, true);
			else {
				assert.equal(result.exitCode, 1);
				assert.equal(scenario.endsWith("timeout") ? result.timedOut : result.stopped, true);
			}
			await until(() => ownedRuns(root).every((run) => run.state !== "queued" && run.state !== "running"));
			const runs = ownedRuns(root);
			assert.ok(runs.some((run) => run.asyncDir.includes("nested-subagent-runs")), "native nested namespace was exercised");
			if (scenario === "direct-timeout") assert.ok(runs.every((run) => run.steps.some((step) => step.timedOut)), "timeout semantics propagate to native descendants");
			if (scenario === "direct-interrupt") assert.ok(runs.every((run) => run.state === "paused"), JSON.stringify(runs.map(({ id, state }) => ({ id, state }))));
			if (scenario.endsWith("stop")) assert.ok(runs.every((run) => run.state === "stopped" || run.state === "failed"), JSON.stringify(runs.map(({ id, state }) => ({ id, state }))));
			for (const run of runs) assert.ok(fs.existsSync(path.join(run.asyncDir, "status.json")), "durable outcome retained");
		} finally {
			await factory.dispose();
			setChildSessionFactory(undefined);
			for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_NATIVE_SCENARIO", "PI_SUBAGENTS_NATIVE_AUDIT"]) {
				if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
