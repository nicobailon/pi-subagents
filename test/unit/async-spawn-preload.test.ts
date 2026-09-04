import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_PEER_ALIASES } from "../../src/runs/background/runner-aliases.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

test("executeAsyncSingle preloads supplemental server aliases before jiti, but not for complete hosts", async (t) => {
	const root = fs.realpathSync(createTempDir("async-spawn-preload-"));
	const host = path.join(root, "host");
	const server = "@earendil-works/pi-server";
	const expectedAliases: Record<string, string> = {};
	// Use real package manifests/targets, as in host-peer-runtime-imports.test.ts.
	function writeHostPackage(pkg: string) {
		const dir = pkg === "@earendil-works/pi-coding-agent" ? host : path.join(host, "node_modules", pkg);
		fs.mkdirSync(dir, { recursive: true });
		const exports = Object.fromEntries(HOST_PEER_ALIASES.filter(entry => entry.pkg === pkg).map(entry => {
			const target = `./${entry.subpath === "." ? "index" : entry.subpath.slice(2).replaceAll("/", "-")}.mjs`;
			fs.writeFileSync(path.join(dir, target), "export {};\n");
			expectedAliases[entry.specifier] = path.join(dir, target);
			return [entry.subpath, target];
		}));
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "0.85.0", exports }));
	}
	const originalArgv1 = process.argv[1];
	try {
		for (const pkg of new Set(HOST_PEER_ALIASES.map(entry => entry.pkg))) {
			if (pkg !== server) writeHostPackage(pkg);
		}
		for (const specifier of [server, `${server}/unix`]) {
			expectedAliases[specifier] = fileURLToPath(import.meta.resolve(specifier));
		}
		// Production discovers the host from the Pi entrypoint at module load.
		process.argv[1] = expectedAliases["@earendil-works/pi-coding-agent"];
		const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
		const spawn = t.mock.method(childProcess, "spawn", () => {
			// Stop at the only external I/O seam: no fake pid or detached lifecycle.
			throw new Error("spawn boundary captured");
		});
		syncBuiltinESMExports();
		for (const complete of [false, true]) {
			if (complete) writeHostPackage(server);
			const result = executeAsyncSingle(`spawn-preload-${complete}`, {
				agent: "worker", task: "Inspect launch wiring", agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "spawn-preload-session" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
			});
			assert.equal(result.isError, true);
			assert.match(result.content[0]!.text, /spawn boundary captured/);
			assert.equal(spawn.mock.callCount(), complete ? 2 : 1);
			const [command, args, options] = spawn.mock.calls.at(-1)!.arguments;
			assert.ok(path.isAbsolute(command));
			assert.equal(options.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], host);
			assert.deepEqual(JSON.parse(options.env.JITI_ALIAS), expectedAliases);
			const jitiIndex = complete ? 0 : 2;
			if (complete) assert.ok(!args.includes("--import"));
			else {
				assert.equal(args[0], "--import");
				assert.equal(args[1], new URL("../../runner-server-preload.mjs", import.meta.url).href);
				assert.ok(fs.existsSync(fileURLToPath(args[1])));
			}
			assert.match(args[jitiIndex], /[/\\]jiti-cli\.mjs$/);
			assert.match(args[jitiIndex + 1], /[/\\]subagent-runner\.ts$/);
			assert.equal(args.length, jitiIndex + 3);
		}
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (originalArgv1 === undefined) delete process.argv[1];
		else process.argv[1] = originalArgv1;
		removeTempDir(root);
	}
});
