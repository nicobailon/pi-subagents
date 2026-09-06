import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

test("executeAsyncSingle preloads supplemental server aliases before jiti, but not for complete hosts", async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "async-spawn-preload-")));
	const host = path.join(root, "host");
	const server = "@earendil-works/pi-server";
	const expectedAliases: Record<string, string> = {};
	const hostExports: Record<string, string[]> = {
		"@earendil-works/pi-coding-agent": ["."],
		"@earendil-works/pi-agent-core": [".", "./node"],
		"@earendil-works/chord": [".", "./context"],
		"@earendil-works/pi-tui": ["."],
		"@earendil-works/pi-ai": ["./compat", "./oauth", "./providers/all"],
		"typebox": [".", "./compile", "./value"],
		[server]: [".", "./unix"],
		"@earendil-works/pi-client": ["./unix"],
	};
	// Use real package manifests/targets, as in host-peer-runtime-imports.test.ts.
	function writeHostPackage(pkg: string) {
		const dir = pkg === "@earendil-works/pi-coding-agent" ? host : path.join(host, "node_modules", pkg);
		fs.mkdirSync(dir, { recursive: true });
		const exports = Object.fromEntries(hostExports[pkg]!.map(subpath => {
			const target = `./${subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "-")}.mjs`;
			fs.writeFileSync(path.join(dir, target), "export {};\n");
			expectedAliases[subpath === "." ? pkg : `${pkg}/${subpath.slice(2)}`] = path.join(dir, target);
			if (pkg === "@earendil-works/pi-ai" && subpath === "./compat") expectedAliases[pkg] = path.join(dir, target);
			return [subpath, target];
		}));
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "0.85.0", exports }));
	}
	const originalArgv1 = process.argv[1];
	try {
		for (const pkg of Object.keys(hostExports)) {
			if (pkg !== server) writeHostPackage(pkg);
		}
		for (const specifier of [server, `${server}/unix`]) {
			expectedAliases[specifier] = fileURLToPath(import.meta.resolve(specifier));
		}
		// Production discovers the host from the Pi entrypoint at module load.
		process.argv[1] = expectedAliases["@earendil-works/pi-coding-agent"];
		// helpers -> mock-pi -> child-session -> readonly evidence -> child hooks
		// also loads async-execution. Set the host before importing that graph.
		const { makeAgent } = await import("../support/helpers.ts");
		const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
		const spawn = t.mock.method(childProcess, "spawn", () => {
			// Stop at the only external I/O seam: no fake pid or detached lifecycle.
			throw new Error("spawn boundary captured");
		});
		syncBuiltinESMExports();
		for (const scenario of ["supplemental", "complete", "stable", "missing-stable"]) {
			if (scenario === "complete") writeHostPackage(server);
			if (scenario === "stable") {
				fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1", exports: { ".": "./index.mjs" } }));
				for (const pkg of [server, "@earendil-works/pi-client"]) fs.rmSync(path.join(host, "node_modules", pkg), { recursive: true });
				for (const specifier of [server, `${server}/unix`, "@earendil-works/pi-client/unix"]) delete expectedAliases[specifier];
			}
			if (scenario === "missing-stable") fs.unlinkSync(expectedAliases["@earendil-works/pi-agent-core/node"]!);
			const result = executeAsyncSingle(`spawn-preload-${scenario}`, {
				agent: "worker", task: "Inspect launch wiring", agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "spawn-preload-session" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false, sessionRoot: path.join(root, "sessions"), maxSubagentDepth: 1, acceptance: false,
			});
			assert.equal(result.isError, true);
			if (scenario === "missing-stable") {
				assert.match(result.content[0]!.text, /@earendil-works\/pi-agent-core\/node/);
				assert.equal(spawn.mock.callCount(), 3);
				continue;
			}
			assert.match(result.content[0]!.text, /spawn boundary captured/);
			assert.equal(spawn.mock.callCount(), scenario === "supplemental" ? 1 : scenario === "complete" ? 2 : 3);
			const [command, args, options] = spawn.mock.calls.at(-1)!.arguments;
			assert.ok(path.isAbsolute(command));
			assert.equal(options.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], host);
			const actualAliases = JSON.parse(options.env.JITI_ALIAS) as Record<string, string>;
			assert.deepEqual(Object.fromEntries(Object.entries(actualAliases).map(([key, target]) => [key, fs.realpathSync(target)])), expectedAliases);
			const jitiIndex = scenario === "supplemental" ? 2 : 0;
			if (scenario !== "supplemental") assert.ok(!args.includes("--import"));
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
		fs.rmSync(root, { recursive: true, force: true });
	}
});
