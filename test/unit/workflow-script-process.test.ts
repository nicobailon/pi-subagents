import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { runWorkflowScript, WorkflowScriptError } from "../../src/workflows/scripted-workflow.ts";
import { WorkflowScriptProcess } from "../../src/workflows/workflow-script-worker.ts";

const acornPath = createRequire(import.meta.url).resolve("acorn");
const host = {
	async launch(key: string) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
	async status(key: string) { return { key, ok: true, output: "ok", artifactPaths: [] }; },
};

describe("restricted Node workflow process", { skip: Boolean(process.versions.bun) }, () => {
	it("denies file writes, unrelated reads, child processes and nested workers outside the vm", { timeout: 10_000 }, async (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-permission-"));
		t.after(() => fs.rmSync(root, { recursive: true, force: true }));
		// The process cwd is the parser's directory, which worker threads can read, so keep the probes outside it.
		fs.mkdirSync(path.join(root, "parser"));
		const parser = path.join(root, "parser", "parser-probe.cjs");
		const secret = path.join(root, "outside.txt");
		const canary = path.join(root, "must-not-write.txt");
		const supervisor = new URL("../../workflow-script-process.cjs", import.meta.url);
		const packageManifest = new URL("../../package.json", import.meta.url);
		fs.writeFileSync(secret, "fixture, not a credential");
		// A controlled parser fixture runs directly in the real script thread, outside its VM.
		// This probes the actual launch permissions without needing a VM escape or a second profile.
		fs.writeFileSync(parser, `
			const { parentPort, Worker } = require("node:worker_threads");
			const denied = fn => { try { fn(); return "ALLOWED"; } catch (error) { return error.code; } };
			parentPort.postMessage({
				read: denied(() => require("node:fs").readFileSync(${JSON.stringify(secret)})),
				readUrl: denied(() => require("node:fs").readFileSync(new URL(${JSON.stringify(pathToFileURL(secret).href)}))),
				supervisor: denied(() => require("node:fs").readFileSync(new URL(${JSON.stringify(supervisor.href)}))),
				packageManifest: denied(() => require("node:fs").readFileSync(new URL(${JSON.stringify(packageManifest.href)}))),
				write: denied(() => require("node:fs").writeFileSync(${JSON.stringify(canary)}, "bad")),
				spawn: denied(() => require("node:child_process").spawnSync(process.execPath, ["-e", ""])),
				worker: denied(() => new Worker("", { eval: true })),
				inheritedEnvironment: Object.keys(process.env).filter(key => key.toLowerCase() !== "systemroot"),
			});
			module.exports.parse = () => ({ type: "Program", body: [] });
		`);
		const worker = new WorkflowScriptProcess(parser);
		const [proof] = await once(worker, "message");
		// Windows cannot remove the temp root while the process still runs in it.
		await worker.terminate();
		assert.deepEqual(proof, { read: "ERR_ACCESS_DENIED", readUrl: "ERR_ACCESS_DENIED", supervisor: "ALLOWED", packageManifest: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED", inheritedEnvironment: [] });
		assert.equal(fs.existsSync(canary), false);
	});

	it("does not inherit Node startup flags from the host", async () => {
		const previous = process.env.NODE_OPTIONS;
		try {
			process.env.NODE_OPTIONS = "--not-a-node-option";
			const result = await runWorkflowScript({ ...host, script: 'emit(args.value); return (await runs.run("check", {agent:"worker",task:"check"})).output;', args: { value: [1, null, "kept"] } });
			assert.equal(result.value, "ok");
			assert.deepEqual(result.emits, [[1, null, "kept"]]);
		} finally {
			if (previous === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previous;
		}
	});

	it("can kill a busy script at timeout or abort", async () => {
		for (const abort of [false, true]) {
			const controller = new AbortController();
			const timer = abort ? setTimeout(() => controller.abort(new Error("Stop busy workflow")), 250) : undefined;
			try {
				await assert.rejects(runWorkflowScript({ ...host, script: "while (true) {}", signal: controller.signal, ...(abort ? {} : { timeoutMs: 250 }) }),
					(error: unknown) => error instanceof WorkflowScriptError && (abort ? error.message === "Stop busy workflow" : error.errorKind === "timeout"));
			} finally { if (timer) clearTimeout(timer); }
		}
	});

	it("exits on parent IPC disconnect even when the script thread is busy", { timeout: 10_000 }, async (t) => {
		const worker = new WorkflowScriptProcess(acornPath);
		t.after(() => worker.terminate());
		const entered = once(worker, "message");
		worker.postMessage({ type: "start", script: 'emit("entered"); while (true) {}' });
		assert.deepEqual((await entered)[0], { type: "emit", value: "entered" });
		const closed = once(worker, "exit");
		worker.child.disconnect();
		assert.equal((await closed)[0], 0);
	});
});
