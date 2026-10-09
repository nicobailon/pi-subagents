import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeAsyncChain, executeAsyncSingle } from "../../src/runs/background/async-execution.ts";
import { makeAgent } from "../support/helpers.ts";

// Spawn-boundary tests, not substitutes for the real official Linux loader gate.
for (const [entry, missingBootstrap] of [
	["/$bunfs/root/pi-native", false],
	["/$bunfs/root/pi-native", true],
	["B:/~BUN/root/pi-native.exe", false],
	["B:\\~BUN\\root\\pi-native.exe", false],
	["B:/~BUN/root/pi-native.exe", true],
] as const) {
	test(`compiled background launch ${entry} ${missingBootstrap ? "rejects a missing bootstrap" : "uses Pi's loader without npm aliases"}`, (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "binary-spawn-"));
		const argv1 = process.argv[1];
		const bun = Object.getOwnPropertyDescriptor(process.versions, "bun");
		const env = { ...process.env };
		Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
		process.argv[1] = entry;
		process.env.PI_SUBAGENT_PI_BINARY = path.join(root, "pi-native");
		process.env.PI_PACKAGE_DIR = path.join(root, "release-assets");
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = "/stale/npm-root";
		process.env.JITI_ALIAS = '{"stale":"alias"}';
		process.env.PI_SUBAGENT_PARENT_SESSION = "ambient-other-root";
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("captured binary spawn"); });
		if (missingBootstrap) {
			const exists = fs.existsSync;
			t.mock.method(fs, "existsSync", (file) => String(file).endsWith("binary-bootstrap.ts") ? false : exists(file));
		}
		syncBuiltinESMExports();
		try {
			const result = executeAsyncSingle(`binary-${missingBootstrap}`, {
				agent: "worker", task: "Inspect files", agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "binary-spawn" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
			});
			assert.equal(result.isError, true);
			if (missingBootstrap) {
				assert.match(result.content[0]!.text, /Background runner bootstrap not found/);
				assert.equal(spawn.mock.callCount(), 0);
			} else {
				assert.match(result.content[0]!.text, /captured binary spawn/);
				assert.equal(spawn.mock.callCount(), 1, "no alternate runtime retry");
				const [command, args, options] = spawn.mock.calls[0]!.arguments;
				assert.equal(command, process.env.PI_SUBAGENT_PI_BINARY);
				assert.deepEqual(args.slice(0, -1), ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session", "--mode", "rpc", "--extension"]);
				assert.ok(args.at(-1).endsWith("binary-bootstrap.ts"));
				assert.equal(options.env.JITI_ALIAS, undefined);
				assert.equal(options.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, undefined);
				assert.equal(options.env.PI_PACKAGE_DIR, process.env.PI_PACKAGE_DIR);
				assert.equal(options.env.PI_SUBAGENT_PARENT_SESSION, "binary-spawn");
				assert.ok(path.isAbsolute(options.env.PI_SUBAGENT_RUNNER_CONFIG));
				assert.equal(options.cwd, root);
				assert.equal(options.stdio[0], "ignore");

				const withoutParent = executeAsyncSingle("binary-no-parent", {
					agent: "worker", task: "Inspect files", agentConfig: makeAgent("worker"),
					ctx: { pi: { events: { emit() {} } }, cwd: root },
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
				});
				assert.match(withoutParent.content[0]!.text, /captured binary spawn/);
				assert.equal(spawn.mock.callCount(), 2);
				assert.equal(spawn.mock.calls[1]!.arguments[2].env.PI_SUBAGENT_PARENT_SESSION, undefined);

				const attached = executeAsyncChain("binary-attached", {
					chain: [{ agent: "worker", task: "Continue" }],
					attachRoot: { runId: "source", asyncDir: root, resultPath: path.join(root, "source.json"), index: 0, agent: "worker" },
					agents: [makeAgent("worker")],
					ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "status-session", parentSessionId: "attach-parent" },
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1,
				});
				assert.match(attached.content[0]!.text, /captured binary spawn/);
				assert.equal(spawn.mock.callCount(), 3);
				const attachedOptions = spawn.mock.calls[2]!.arguments[2];
				assert.equal(attachedOptions.env.PI_SUBAGENT_PARENT_SESSION, "attach-parent");
				const attachedConfig = JSON.parse(fs.readFileSync(attachedOptions.env.PI_SUBAGENT_RUNNER_CONFIG, "utf-8"));
				assert.deepEqual(attachedConfig.steps.map((step: { parentSessionId?: string }) => step.parentSessionId), ["attach-parent", "attach-parent"]);

				let parentRead = 0;
				const inconsistent = executeAsyncChain("binary-inconsistent", {
					chain: [{ agent: "worker", task: "Continue" }],
					attachRoot: { runId: "source", asyncDir: root, resultPath: path.join(root, "source.json"), index: 0, agent: "worker" },
					agents: [makeAgent("worker")],
					ctx: {
						pi: { events: { emit() {} } }, cwd: root, currentSessionId: "status-session",
						get parentSessionId() { return ++parentRead === 1 ? "launch-parent-a" : "launch-parent-b"; },
					},
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1,
				});
				assert.equal(inconsistent.isError, true);
				assert.match(inconsistent.content[0]!.text, /inconsistent parent session identities/);
				assert.equal(spawn.mock.callCount(), 3, "inconsistent real or synthetic parents must fail before spawn");
			}
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			process.argv[1] = argv1;
			if (bun) Object.defineProperty(process.versions, "bun", bun);
			else delete process.versions.bun;
			for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
			Object.assign(process.env, env);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
